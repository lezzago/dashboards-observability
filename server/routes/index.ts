/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ILegacyClusterClient, IRouter, Logger } from '../../../../src/core/server';
import { DSLFacet } from '../services/facets/dsl_facet';
import { PPLFacet } from '../services/facets/ppl_facet';
import SavedObjectFacet from '../services/facets/saved_objects';
import { QueryService } from '../services/queryService';
import { registerAppAnalyticsRouter } from './application_analytics/app_analytics_router';
import { PanelsRouter } from './custom_panels/panels_router';
import { VisualizationsRouter } from './custom_panels/visualizations_router';
import { registerDataConnectionsRoute } from './data_connections/data_connections_router';
import { registerDatasourcesRoute } from './datasources/datasources_router';
import { registerDslRoute } from './dsl';
import { registerEventAnalyticsRouter } from './event_analytics/event_analytics_router';
import { registerGettingStartedRoutes } from './getting_started/getting_started_router';
import { registerIntegrationsRoute } from './integrations/integrations_router';
import { registerMetricsRoute } from './metrics/metrics_rounter';
import { registerNoteRoute } from './notebooks/noteRouter';
import { registerParaRoute } from './notebooks/paraRouter';
import { registerSqlRoute } from './notebooks/sqlRouter';
import { registerVizRoute } from './notebooks/vizRouter';
import { registerPplRoute } from './ppl';
import { registerQueryAssistRoutes } from './query_assist/routes';
import { MLCommonsRCFFacet } from '../services/facets/ml_commons_rcf_facet';
import { registerMLCommonsRCFRoute } from './ml_commons_rcf';
import { registerTraceAnalyticsDslRouter } from './trace_analytics_dsl_router';
import { registerAlertingRoutes } from './alerting';
import {
  InMemoryDatasourceService,
  MultiBackendAlertService,
  HttpOpenSearchBackend,
  DirectQueryPrometheusBackend,
  DatasourceDiscoveryService,
} from '../services/alerting';
import { PrometheusMetadataService } from '../services/alerting/prometheus_metadata_service';
import { registerSloRoutes } from './slo';
import type { SloService } from '../../common/slo/slo_service';
import type { RulerClient } from '../services/slo/ruler_client';
import type { RuleHealthChecker } from '../services/slo/rule_health_checker';
import type { SloReconciler } from '../services/slo/reconciler';

/**
 * Wiring returned from `setupRoutes` so the plugin-level orchestrator
 * (`server/plugin.ts`) can reuse internals — specifically the alerting
 * `InMemoryDatasourceService` — when constructing the Phase 2 reconciler.
 *
 * The reconciler needs the *same* datasource registry the routes populate,
 * otherwise a cold-start reconciler sweep would see an empty map and every
 * SLO's datasource would be reported as "not registered" until the first
 * user request hydrated discovery.
 */
export interface SetupRoutesResult {
  alertingDatasourceService: InMemoryDatasourceService;
}

export function setupRoutes({
  router,
  client,
  dataSourceEnabled,
  logger,
  sloService,
  ruleHealthChecker,
  rulerClient,
  reconciler,
  ruleDedupEnabled,
  ruleAdoptionEnabled,
}: {
  router: IRouter;
  client: ILegacyClusterClient;
  dataSourceEnabled: boolean;
  logger: Logger;
  sloService?: SloService;
  /**
   * Phase 2 hoisted the RuleHealthChecker singleton out of this file so the
   * reconciler can share the same TTL cache. When omitted, SLO repair/health
   * routes still register but their handlers will surface 501 — matches the
   * existing offline-dev fallback.
   */
  ruleHealthChecker?: RuleHealthChecker;
  /** Shared DirectQuery ruler client. Optional for the same offline-dev reason. */
  rulerClient?: RulerClient;
  /**
   * Reserved for the admin `_reconcile` route registered by peer agent W2.4.
   * Forwarded into `registerSloRoutes` so W2.4 can wire it without reaching
   * back into plugin.ts. Unused here until W2.4 extends
   * `registerSloRoutes`' signature — the parameter is preserved as a pass-
   * through so the plugin-level wiring doesn't need to change twice.
   */
  reconciler?: SloReconciler;
  /**
   * Phase 3 (W3.6) — `observability.slo.ruleDedup.enabled`. Forwarded into
   * `registerSloRoutes` so the per-request status context carries it and
   * the aggregator (W3.9) picks fingerprint-keyed selectors when true.
   */
  ruleDedupEnabled?: boolean;
  /**
   * Phase 4 (W4.6) — `observability.slo.ruleAdoption.enabled`. Forwarded
   * into `registerSloRoutes` so the adoption endpoints (`_orphans`,
   * `_recover`, `_clone`) can apply the 412 feature-flag gate.
   */
  ruleAdoptionEnabled?: boolean;
}): SetupRoutesResult {
  PanelsRouter(router);
  VisualizationsRouter(router);
  registerPplRoute({ router, facet: new PPLFacet(client) });
  registerDslRoute({ router, facet: new DSLFacet(client) }, dataSourceEnabled);
  registerEventAnalyticsRouter({ router, savedObjectFacet: new SavedObjectFacet(client) });
  registerAppAnalyticsRouter(router);

  // TODO remove trace analytics route when DSL route for autocomplete is added
  registerTraceAnalyticsDslRouter(router, dataSourceEnabled);

  // notebooks routes
  registerParaRoute(router);
  registerNoteRoute(router);
  registerVizRoute(router, dataSourceEnabled);
  const queryService = new QueryService(client, logger);
  registerSqlRoute(router, queryService, dataSourceEnabled);

  registerMetricsRoute(router, dataSourceEnabled);
  registerIntegrationsRoute(router);
  registerDataConnectionsRoute(router, dataSourceEnabled);
  registerDatasourcesRoute(router, dataSourceEnabled);

  // query assist is part of log explorer, which will be disabled if datasource is enabled
  if (!dataSourceEnabled) {
    registerQueryAssistRoutes(router);
  }

  registerGettingStartedRoutes(router);
  registerMLCommonsRCFRoute({ router, facet: new MLCommonsRCFFacet() });

  // Alerting routes — OSD scoped client handles auth automatically
  const alertingDatasourceService = new InMemoryDatasourceService(logger);
  const alertingAlertService = new MultiBackendAlertService(alertingDatasourceService, logger);

  const osBackend = new HttpOpenSearchBackend(logger);
  alertingAlertService.registerOpenSearch(osBackend);

  const promBackend = new DirectQueryPrometheusBackend(logger);
  alertingAlertService.registerPrometheus(promBackend);
  alertingDatasourceService.setPrometheusBackend(promBackend);

  const metadataService = new PrometheusMetadataService(
    promBackend,
    alertingDatasourceService,
    logger
  );

  // Shared registry hydration. Used by both alerting routes (for browse /
  // manage) and SLO CRUD routes (so DELETE/UPDATE/CREATE don't spuriously
  // reject a datasourceId because the registry hasn't been populated yet).
  const datasourceDiscoveryService = new DatasourceDiscoveryService(
    alertingDatasourceService,
    logger
  );

  registerAlertingRoutes(
    router,
    alertingDatasourceService,
    alertingAlertService,
    datasourceDiscoveryService,
    logger,
    metadataService
  );

  if (sloService) {
    // Real ruler writes go through the same DirectQuery proxy the read path
    // already uses. Pass the shared discovery service so SLO routes hydrate
    // the datasource registry from OSD saved objects before any lookup —
    // otherwise a DELETE arriving before the first /api/alerting/* call
    // would see an empty map and reject with "Datasource ds-N is not
    // registered" even though the datasource exists.
    //
    // Phase 2: the ruler client and rule-health checker are hoisted to
    // `server/plugin.ts` so the reconciler can share the same TTL cache.
    // `reconciler` threads through to the admin `_reconcile` route registered
    // inside `registerSloRoutes`.
    // Phase 4 W4.6 converted `registerSloRoutes` to an options bag so new
    // routes (adoption endpoints) don't extend a positional signature that
    // had already grown to 10 args.
    registerSloRoutes({
      router,
      sloService,
      logger,
      rulerClient,
      datasourceService: alertingDatasourceService,
      discoveryService: datasourceDiscoveryService,
      prometheusBackend: promBackend,
      ruleHealthChecker,
      reconciler,
      ruleDedupEnabled,
      ruleAdoptionEnabled,
    });
  }

  return { alertingDatasourceService };
}
