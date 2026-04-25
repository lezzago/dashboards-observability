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
import { DirectQueryRulerClient } from '../services/slo/ruler_client';

export function setupRoutes({
  router,
  client,
  dataSourceEnabled,
  logger,
  sloService,
}: {
  router: IRouter;
  client: ILegacyClusterClient;
  dataSourceEnabled: boolean;
  logger: Logger;
  sloService?: SloService;
}) {
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
    const rulerClient = new DirectQueryRulerClient(logger);
    registerSloRoutes(
      router,
      sloService,
      logger,
      rulerClient,
      alertingDatasourceService,
      datasourceDiscoveryService
    );
  }
}
