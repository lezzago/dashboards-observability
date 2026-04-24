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
import { SavedObjectSloStore } from './services/slo/slo_saved_object_store';
import { DirectQueryStatusAggregator } from './services/slo/status_aggregator';
import { AssistantPluginSetup, ObservabilityPluginSetup, ObservabilityPluginStart } from './types';

export interface ObservabilityPluginSetupDependencies {
  dataSourceManagement: ReturnType<DataSourceManagementPlugin['setup']>;
  dataSource: DataSourcePluginSetup;
}

export class ObservabilityPlugin
  implements Plugin<ObservabilityPluginSetup, ObservabilityPluginStart> {
  private readonly logger: Logger;
  private sloService?: SloService;

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

    // SLO service — starts with InMemorySloStore; upgraded to SavedObjectSloStore in start().
    const sloLogger = {
      info: (msg: string) => this.logger.info(msg),
      warn: (msg: string) => this.logger.warn(msg),
      error: (msg: string) => this.logger.error(msg),
      debug: (msg: string) => this.logger.debug(msg),
    };
    const sloService = new SloService(sloLogger);
    // Live-status aggregator (W3.1). DirectQuery-backed — queries the ruler
    // through the SQL plugin for recording-rule values + firing alerts.
    // Offline dev paths (no aggregator) fall through to the stub automatically.
    sloService.setStatusAggregator(new DirectQueryStatusAggregator(sloLogger));
    this.sloService = sloService;

    // Register server side APIs
    setupRoutes({
      router,
      client: openSearchObservabilityClient,
      dataSourceEnabled,
      logger: this.logger,
      sloService,
    });

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

    const observabilityConfig = await this.initializerContext.config
      .create<{ alertManager: { enabled: boolean } }>()
      .pipe(first())
      .toPromise();
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
        this.sloService.setStore(new SavedObjectSloStore(repository));
        this.logger.info('Observability: SLO storage upgraded to SavedObjects');
      } catch (err: unknown) {
        this.logger.warn(
          `Observability: Failed to create SavedObjectSloStore, using in-memory fallback: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    return {};
  }

  public stop() {}
}
