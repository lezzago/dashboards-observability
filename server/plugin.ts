/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { first } from 'rxjs/operators';
import {
  CoreSetup,
  CoreStart,
  ILegacyClusterClient,
  Logger,
  Plugin,
  PluginInitializerContext,
  SavedObject,
  SavedObjectsType,
  UiSettingScope,
} from '../../../src/core/server';
import { DataSourcePluginSetup } from '../../../src/plugins/data_source/server/types';
import { DataSourceManagementPlugin } from '../../../src/plugins/data_source_management/public/plugin';
import { observabilityPanelsID } from '../common/constants/shared';
import { migrateV1IntegrationToV2Integration } from './adaptors/integrations/migrations';
import { OpenSearchObservabilityPlugin } from './adaptors/opensearch_observability_plugin';
import { PPLPlugin } from './adaptors/ppl_plugin';
import { PPLParsers } from './parsers/ppl_parser';
import { registerObservabilityUISettings } from './plugin_helper/register_settings';
import { setupRoutes } from './routes/index';
import {
  getSearchSavedObject,
  getVisualizationSavedObject,
  notebookSavedObject,
} from './saved_objects/observability_saved_object';
import { SloService } from '../common/slo/slo_service';
import { InMemorySloStore } from '../common/slo/slo_store';
import type { ISloStore, SloDocument } from '../common/slo/slo_types';
import { SavedObjectSloStore } from './services/slo/slo_saved_object_store';
import { DirectQueryStatusAggregator } from './services/slo/status_aggregator';
import { DirectQueryRulerClient } from './services/slo/ruler_client';
import { createRuleHealthChecker, RuleHealthChecker } from './services/slo/rule_health_checker';
import { createSloReconciler, SloReconciler } from './services/slo/reconciler';
import { createReconcilerMetrics } from './services/slo/reconciler_metrics';
import { sloRuleRefType } from './saved_objects/slo_rule_ref';
import { SLO_V2_MIGRATION_VERSION, sloV2Migration } from './saved_objects/migrations/slo_v2';
import type { InMemoryDatasourceService } from './services/alerting/datasource_service';
import { AssistantPluginSetup, ObservabilityPluginSetup, ObservabilityPluginStart } from './types';

export interface ObservabilityPluginSetupDependencies {
  dataSourceManagement: ReturnType<DataSourceManagementPlugin['setup']>;
  dataSource: DataSourcePluginSetup;
}

/**
 * Phase-2 reconciler wiring state kept on the plugin instance.
 *
 * `setup()` builds the ruler client, the rule-health checker (shared with
 * route handlers), the reconciler itself (so the admin `_reconcile` route can
 * hold a reference from day one), and two mutable refs that `start()`
 * populates with CoreStart-only state (internal OS client + SO-backed store).
 * `stop()` halts the reconciler interval.
 */
interface ReconcilerWiring {
  ruler: DirectQueryRulerClient;
  healthChecker: RuleHealthChecker;
  /**
   * Mutable reference to the store the reconciler reads from. `start()` swaps
   * `.current` to the SavedObject-backed store at the same moment
   * `SloService.setStore` does, so the reconciler and the service share one
   * persistence backend.
   */
  storeRef: { current: ISloStore };
  /**
   * Mutable reference to the OS client the reconciler uses to talk to the
   * ruler. Populated in `start()` with `core.opensearch.client.asInternalUser`
   * — until then the reconciler is constructed but `start()` is not called, so
   * timer sweeps never run without a real client.
   */
  clientRef: {
    current: import('../common/types/alerting/types').AlertingOSClient | undefined;
  };
}

export class ObservabilityPlugin
  implements Plugin<ObservabilityPluginSetup, ObservabilityPluginStart> {
  private readonly logger: Logger;
  private sloService?: SloService;
  private ruleHealthChecker?: RuleHealthChecker;
  private reconciler?: SloReconciler;
  private reconcilerWiring?: ReconcilerWiring;

  constructor(private readonly initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }

  public async setup(
    core: CoreSetup,
    deps: {
      assistantDashboards?: AssistantPluginSetup;
      dataSource: ObservabilityPluginSetupDependencies;
      investigationDashboards?: unknown;
    }
  ) {
    const { assistantDashboards, dataSource } = deps;
    this.logger.debug('Observability: Setup');
    const router = core.http.createRouter();

    // Read plugin config up-front so downstream wiring (reconciler interval,
    // alertManager flag) can read from one materialized object.
    const observabilityConfig = await this.initializerContext.config
      .create<{
        alertManager?: { enabled: boolean };
        slo?: {
          reconcilerIntervalMs: number;
          ruleDedup?: { enabled: boolean };
        };
      }>()
      .pipe(first())
      .toPromise();

    // Phase 3 (W3.6): dedup flag. Default-on; mirrors the schema default so
    // offline/dev paths that skip config resolution still get the new
    // codepath.
    const ruleDedupEnabled = observabilityConfig.slo?.ruleDedup?.enabled ?? true;

    const dataSourceEnabled = !!dataSource;
    const openSearchObservabilityClient: ILegacyClusterClient = core.opensearch.legacy.createClient(
      'opensearch_observability',
      {
        plugins: [PPLPlugin, OpenSearchObservabilityPlugin],
      }
    );
    if (dataSourceEnabled) {
      dataSource.registerCustomApiSchema(PPLPlugin);
      dataSource.registerCustomApiSchema(OpenSearchObservabilityPlugin);
    }
    // @ts-ignore
    core.http.registerRouteHandlerContext('observability_plugin', (_context, _request) => {
      return {
        logger: this.logger,
        observabilityClient: openSearchObservabilityClient,
      };
    });

    const obsPanelType: SavedObjectsType = {
      name: 'observability-panel',
      hidden: false,
      namespaceType: 'single',
      mappings: {
        dynamic: false,
        properties: {
          title: {
            type: 'text',
          },
          description: {
            type: 'text',
          },
        },
      },
      management: {
        importableAndExportable: true,
        getInAppUrl(obj) {
          return {
            path: dataSourceEnabled ? '' : `/app/${observabilityPanelsID}#/${obj.id}`,
            uiCapabilitiesPath: 'advancedSettings.show',
          };
        },
        getTitle(obj) {
          return `Observability Settings [${obj.id}]`;
        },
      },
      migrations: {
        '3.0.0': (doc) => ({ ...doc, description: '' }),
        '3.0.1': (doc) => ({ ...doc, description: 'Some Description Text' }),
        '3.0.2': (doc) => ({
          ...doc,
          dateCreated: parseInt((doc as { dateCreated?: string }).dateCreated || '0', 10),
        }),
      },
    };

    const integrationInstanceType: SavedObjectsType = {
      name: 'integration-instance',
      hidden: false,
      namespaceType: 'single',
      management: {
        importableAndExportable: true,
        getInAppUrl(obj: SavedObject<IntegrationInstance>) {
          return {
            path: `/app/integrations#/installed/${obj.id}`,
            uiCapabilitiesPath: 'advancedSettings.show',
          };
        },
        getTitle(obj: SavedObject<IntegrationInstance>) {
          return obj.attributes.name;
        },
      },
      mappings: {
        dynamic: false,
        properties: {
          name: {
            type: 'text',
          },
          templateName: {
            type: 'text',
          },
          dataSource: {
            type: 'text',
          },
          creationDate: {
            type: 'date',
          },
          assets: {
            type: 'nested',
          },
        },
      },
    };

    const integrationTemplateType: SavedObjectsType = {
      name: 'integration-template',
      hidden: false,
      namespaceType: 'single',
      management: {
        importableAndExportable: true,
        getInAppUrl(obj: SavedObject<SerializedIntegration>) {
          return {
            path: `/app/integrations#/available/${obj.attributes.name}`,
            uiCapabilitiesPath: 'advancedSettings.show',
          };
        },
        getTitle(obj: SavedObject<SerializedIntegration>) {
          return obj.attributes.displayName ?? obj.attributes.name;
        },
      },
      mappings: {
        dynamic: false,
        properties: {
          name: {
            type: 'text',
          },
          version: {
            type: 'text',
          },
          displayName: {
            type: 'text',
          },
          license: {
            type: 'text',
          },
          type: {
            type: 'text',
          },
          labels: {
            type: 'text',
          },
          author: {
            type: 'text',
          },
          description: {
            type: 'text',
          },
          sourceUrl: {
            type: 'text',
          },
          statics: {
            type: 'nested',
          },
          components: {
            type: 'nested',
          },
          assets: {
            type: 'nested',
          },
          sampleData: {
            type: 'nested',
          },
        },
      },
      migrations: {
        '3.0.0': migrateV1IntegrationToV2Integration,
      },
    };

    core.savedObjects.registerType(obsPanelType);
    core.savedObjects.registerType(integrationInstanceType);
    core.savedObjects.registerType(integrationTemplateType);

    // Register the SLO saved-object type. Persists the full { spec, status }
    // document; the listing page filters against the top-level projections
    // populated by SavedObjectSloStore on write. See design §4.
    //
    // Note on mapping shape: `spec` and `status` are stored as opaque JSON
    // (`enabled: false`). OpenSearch refuses to declare dotted sub-paths like
    // `spec.name` alongside a disabled parent object — it parses the dotted
    // key as a path *into* `spec` and rejects the mapping with
    // `the [enabled] parameter can't be updated`. All indexed projections
    // therefore live at the top level under non-dotted keys; the store is
    // responsible for duplicating values out of `spec`/`status` on write.
    const sloDefinitionType: SavedObjectsType = {
      name: 'slo-definition',
      hidden: false,
      namespaceType: 'single',
      mappings: {
        properties: {
          // Indexed projections derived from spec on write
          name: { type: 'text' },
          description: { type: 'text' },
          datasourceId: { type: 'keyword' },
          enabled: { type: 'boolean' },
          mode: { type: 'keyword' },
          service: { type: 'keyword' },
          ownerTeams: { type: 'keyword' },
          ownerPrimaryUser: { type: 'keyword' },
          tier: { type: 'keyword' },

          // Duplicated discriminators
          primaryOwnerTeam: { type: 'keyword' },
          sliNodeType: { type: 'keyword' },
          sliBackend: { type: 'keyword' },
          sliLeafType: { type: 'keyword' },
          dimensionNames: { type: 'keyword' },
          dimensionValues: { type: 'keyword' },
          objectiveCount: { type: 'integer' },
          worstTarget: { type: 'float' },
          labelKeys: { type: 'keyword' },
          labelValues: { type: 'keyword' },

          // Audit projections
          version: { type: 'integer' },
          createdAt: { type: 'date' },
          createdBy: { type: 'keyword' },
          updatedAt: { type: 'date' },
          updatedBy: { type: 'keyword' },

          // Opaque JSON payloads — must be declared AFTER their scalar
          // projections so dotted keys aren't interpreted as paths inside them.
          spec: { type: 'object', enabled: false },
          status: { type: 'object', enabled: false },
        },
      },
      // Phase 3 (W3.5): slo_v2 migration extends status.provisioning with
      // `recordingFingerprints`, `alertGroupName`, and `needsRedeploy`. Runs
      // unconditionally — it's additive and preserves the old `ruleGroupName`
      // during the dedup flag's rollout window.
      migrations: {
        [SLO_V2_MIGRATION_VERSION]: sloV2Migration,
      },
      management: {
        importableAndExportable: true,
        getInAppUrl(obj) {
          return {
            path: `/app/observability-apm-slo#/slos/${obj.id}`,
            uiCapabilitiesPath: 'advancedSettings.show',
          };
        },
        getTitle(obj) {
          const attrs = obj.attributes as { name?: string; spec?: { name?: string } };
          return String(attrs.name ?? attrs.spec?.name ?? obj.id);
        },
      },
    };
    core.savedObjects.registerType(sloDefinitionType);

    // Phase 3 (W3.2): refcount registry — one SO per unique (workspace,
    // datasource, fingerprint) tuple. Consumed by `SloRuleRefStore` and the
    // reconciler's W3.11 grace-period sweep.
    core.savedObjects.registerType(sloRuleRefType);

    // SLO service — starts with InMemorySloStore; upgraded to SavedObjectSloStore in start().
    const sloLogger = {
      info: (msg: string) => this.logger.info(msg),
      warn: (msg: string) => this.logger.warn(msg),
      error: (msg: string) => this.logger.error(msg),
      debug: (msg: string) => this.logger.debug(msg),
    };
    // Explicitly construct the in-memory bootstrap store so the reconciler can
    // share the same instance before `start()` swaps it for the SO-backed one.
    // Without this, the reconciler would need a reference to SloService's
    // private `store` field.
    const initialStore: ISloStore = new InMemorySloStore();
    const sloService = new SloService(sloLogger, initialStore);
    sloService.setDedupEnabled(ruleDedupEnabled);
    // Live-status aggregator (W3.1). DirectQuery-backed — queries the ruler
    // through the SQL plugin for recording-rule values + firing alerts.
    // Offline dev paths (no aggregator) fall through to the stub automatically.
    sloService.setStatusAggregator(new DirectQueryStatusAggregator(sloLogger));
    this.sloService = sloService;

    // Phase 2: hoist the DirectQuery ruler + rule-health checker here so both
    // the route handlers (W1.5 repair / rule_health) and the Phase 2
    // reconciler can share the same singleton — critical for the checker's
    // TTL cache, and required for the reconciler's invalidate() hook to
    // actually affect the probe results the UI sees.
    const rulerClient = new DirectQueryRulerClient(this.logger);
    const ruleHealthChecker = createRuleHealthChecker(rulerClient, this.logger);
    this.ruleHealthChecker = ruleHealthChecker;

    // Alerting datasource registry is built inside `setupRoutes` and shared
    // with the reconciler (below) so a cold-start sweep doesn't report every
    // SLO as "datasource not registered" before the first user request
    // hydrated discovery.
    //
    // The reconciler has to exist *before* `setupRoutes` runs so the admin
    // `_reconcile` route can hold a live reference; `setupRoutes` forwards it
    // into `registerSloRoutes`. The order is therefore: build ruler/checker →
    // build reconciler (with deferred client/store refs) → setupRoutes(...,
    // reconciler) → populate refs in `start()`.
    const reconcilerIntervalMs = observabilityConfig.slo?.reconcilerIntervalMs ?? 300_000;
    const reconcilerMetrics = createReconcilerMetrics(this.logger);
    const reconcilerStoreRef: { current: ISloStore } = { current: initialStore };
    const reconcilerClientRef: {
      current: import('../common/types/alerting/types').AlertingOSClient | undefined;
    } = { current: undefined };
    const storeProxy: ISloStore = {
      list: (datasourceIds?: string[]) => reconcilerStoreRef.current.list(datasourceIds),
      get: (id: string) => reconcilerStoreRef.current.get(id),
      save: (doc: SloDocument) => reconcilerStoreRef.current.save(doc),
      delete: (id: string) => reconcilerStoreRef.current.delete(id),
    };

    // Placeholder datasource service forwarded to the reconciler until
    // setupRoutes returns the real one. Swapped below via ref update.
    const datasourceServiceRef: { current: InMemoryDatasourceService | undefined } = {
      current: undefined,
    };

    const reconciler = createSloReconciler({
      store: storeProxy,
      ruler: rulerClient,
      healthChecker: ruleHealthChecker,
      // Lazy resolver — setupRoutes populates datasourceServiceRef before any
      // timer sweep fires (start() kicks the interval). If a sweep ever runs
      // before that (admin endpoint called mid-setup), the reconciler surfaces
      // an error entry per datasource instead of crashing.
      datasourceService: new Proxy({} as InMemoryDatasourceService, {
        get(_target, prop) {
          const real = datasourceServiceRef.current;
          if (!real) {
            throw new Error(
              'SLO reconciler: alerting datasource service not yet wired (setupRoutes has not completed)'
            );
          }
          const value = ((real as unknown) as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? value.bind(real) : value;
        },
      }),
      logger: this.logger,
      metrics: reconcilerMetrics,
      // One shared internal OS client — populated in `start()`. Throws from
      // the reconciler's own error-handling path if a sweep fires before
      // `start()` wired the client, which is the correct behavior: the admin
      // endpoint responds with an error entry per datasource, nothing dies.
      buildClient: () => {
        const client = reconcilerClientRef.current;
        if (!client) {
          throw new Error(
            'SLO reconciler: internal OS client not yet wired (plugin start() has not completed)'
          );
        }
        return client;
      },
      intervalMs: reconcilerIntervalMs,
    });
    this.reconciler = reconciler;

    // Register server side APIs (routes receive the reconciler so the admin
    // `_reconcile` endpoint is wired on day one).
    const { alertingDatasourceService } = setupRoutes({
      router,
      client: openSearchObservabilityClient,
      dataSourceEnabled,
      logger: this.logger,
      sloService,
      ruleHealthChecker,
      rulerClient,
      reconciler,
      ruleDedupEnabled,
    });
    datasourceServiceRef.current = alertingDatasourceService;

    this.reconcilerWiring = {
      ruler: rulerClient,
      healthChecker: ruleHealthChecker,
      storeRef: reconcilerStoreRef,
      clientRef: reconcilerClientRef,
    };

    core.savedObjects.registerType(getVisualizationSavedObject(dataSourceEnabled));
    core.savedObjects.registerType(getSearchSavedObject(dataSourceEnabled));
    if (!deps.investigationDashboards) {
      core.savedObjects.registerType(notebookSavedObject);
    }
    core.capabilities.registerProvider(() => ({
      observability: {
        show: true,
      },
    }));

    assistantDashboards?.registerMessageParser(PPLParsers);

    registerObservabilityUISettings(
      core.uiSettings,
      observabilityConfig.alertManager?.enabled ?? false
    );

    core.uiSettings.register({
      'observability:defaultDashboard': {
        name: 'Observability default dashboard',
        value: '',
        description: 'The default dashboard to display in Observability overview page',
        schema: schema.string(),
        scope: core.workspace.isWorkspaceEnabled()
          ? UiSettingScope.WORKSPACE
          : UiSettingScope.GLOBAL,
      },
    });

    core.uiSettings.register({
      'observability:overviewCardsDisplay': {
        name: 'Observability overview cards',
        value: true,
        description: 'Show the Observability overview page cards',
        schema: schema.boolean(),
        scope: core.workspace.isWorkspaceEnabled()
          ? UiSettingScope.WORKSPACE
          : UiSettingScope.GLOBAL,
      },
    });

    return {};
  }

  public start(core: CoreStart) {
    this.logger.debug('Observability: Started');

    // Upgrade SLO storage to saved objects for persistence across restarts.
    // Gracefully falls back to the in-memory store if the repository can't be created.
    if (this.sloService) {
      try {
        const repository = core.savedObjects.createInternalRepository(['slo-definition']);
        const soStore = new SavedObjectSloStore(repository);
        this.sloService.setStore(soStore);
        // Swap the reconciler's store reference to the same backend — they
        // MUST share persistence; otherwise the reconciler sweeps an empty
        // in-memory store while user-created SLOs live in saved objects.
        if (this.reconcilerWiring) {
          this.reconcilerWiring.storeRef.current = soStore;
        }
        this.logger.info('Observability: SLO storage upgraded to SavedObjects');
      } catch (err: unknown) {
        this.logger.warn(
          `Observability: Failed to create SavedObjectSloStore, using in-memory fallback: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Populate the reconciler's deferred internal-client ref and start its
    // interval. The reconciler instance itself was built in `setup()` so the
    // admin `_reconcile` route could hold a live reference from day one; here
    // we just finish wiring and kick the sweep timer.
    //
    // One shared internal client is fine for Phase 2 — MDS-per-datasource
    // routing requires a request context we don't have on a timer, and lands
    // with Phase 3.
    if (this.reconciler && this.reconcilerWiring) {
      try {
        const internalClient = core.opensearch.client.asInternalUser;
        const asAlertingClient = (internalClient as unknown) as import('../common/types/alerting/types').AlertingOSClient;
        this.reconcilerWiring.clientRef.current = asAlertingClient;
        this.reconciler.start();
        this.logger.info('Observability: SLO reconciler started');
      } catch (err: unknown) {
        this.logger.warn(
          `Observability: Failed to start SLO reconciler: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    return {};
  }

  public stop() {
    // Stop the reconciler and await any in-flight sweep so plugin teardown
    // doesn't race a late log write. Fire-and-log the promise — OSD's
    // `Plugin.stop` is sync in the public typing, but the underlying
    // lifecycle tolerates async cleanup started here.
    if (this.reconciler) {
      this.reconciler.stop().catch((err: unknown) => {
        this.logger.warn(
          `Observability: SLO reconciler shutdown error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
      this.reconciler = undefined;
    }
  }
}
