/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSD route adapter for SLO CRUD. Routes are versioned under
 * `${OBSERVABILITY_BASE}/v1/slos` so a future schema change can coexist
 * with v1 behind a new prefix.
 */

import { schema } from '@osd/config-schema';
import type { IRouter, Logger, RequestHandlerContext } from '../../../../../src/core/server';
import { OBSERVABILITY_BASE } from '../../../common/constants/shared';
import type { SloDeployContext } from '../../../common/slo/slo_service';
import { SloService } from '../../../common/slo/slo_service';
import type { AlertingOSClient, Datasource } from '../../../common/types/alerting/types';
import type { InMemoryDatasourceService } from '../../services/alerting/datasource_service';
import type { RulerClient } from '../../services/slo/ruler_client';
import {
  handleCreateSLO,
  handleDeleteSLO,
  handleDisableSLO,
  handleEnableSLO,
  handleGetSLO,
  handleGetSLOStatuses,
  handleListSLOs,
  handlePreviewSLORules,
  handleUpdateSLO,
} from './handlers';

/**
 * OSD context type with the optional `dataSource` plugin extension. Same
 * shape used by the alerting routes — declared here so SLO routes don't
 * reach into the alerting tree for it.
 */
type SloHandlerContext = RequestHandlerContext & {
  dataSource?: {
    opensearch: {
      getClient: (id: string) => Promise<AlertingOSClient>;
    };
  };
};

const SLO_BASE = `${OBSERVABILITY_BASE}/v1/slos`;

// ============================================================================
// @osd/config-schema shapes for validation at the boundary.
// Note: `{ unknowns: 'allow' }` on nested objects lets us accept reserved P2
// fields without validation churn as the schema evolves.
// ============================================================================

const dimensionSchema = schema.object({
  name: schema.string({ minLength: 1, maxLength: 128 }),
  value: schema.string({ minLength: 1, maxLength: 256 }),
});

const burnRateSchema = schema.object({
  shortWindow: schema.string({ minLength: 1 }),
  longWindow: schema.string({ minLength: 1 }),
  burnRateMultiplier: schema.number({ min: 0.001, max: 1000 }),
  severity: schema.string({ minLength: 1 }),
  createAlarm: schema.boolean(),
  forDuration: schema.string({ minLength: 1 }),
});

const objectiveSchema = schema.object(
  {
    name: schema.string({ minLength: 1, maxLength: 64 }),
    displayName: schema.maybe(schema.string({ maxLength: 128 })),
    target: schema.number({ min: 0.5, max: 0.99999 }),
    latencyThreshold: schema.maybe(schema.number({ min: 0 })),
    timeSliceTarget: schema.maybe(schema.number({ min: 0, max: 1 })),
    compositeWeight: schema.maybe(schema.number({ min: 0 })),
    thresholdBound: schema.maybe(
      schema.object({
        operator: schema.oneOf([
          schema.literal('<'),
          schema.literal('<='),
          schema.literal('>'),
          schema.literal('>='),
        ]),
        value: schema.number(),
      })
    ),
  },
  { unknowns: 'allow' }
);

const prometheusSliSchema = schema.object(
  {
    backend: schema.literal('prometheus'),
    type: schema.oneOf([
      schema.literal('availability'),
      schema.literal('latency_threshold'),
      schema.literal('custom'),
    ]),
    calcMethod: schema.oneOf([
      schema.literal('events'),
      schema.literal('periods'),
      schema.literal('ratio_periods'),
    ]),
    metric: schema.maybe(schema.string()),
    goodEventsFilter: schema.maybe(schema.string()),
    periodLength: schema.maybe(schema.string()),
    latencyThresholdUnit: schema.maybe(
      schema.oneOf([schema.literal('seconds'), schema.literal('milliseconds')])
    ),
    customExpr: schema.maybe(
      schema.oneOf([
        schema.object({
          mode: schema.literal('events'),
          goodQuery: schema.string({ minLength: 1 }),
          totalQuery: schema.string({ minLength: 1 }),
        }),
        schema.object({
          mode: schema.literal('raw'),
          errorRatioQuery: schema.string({ minLength: 1 }),
        }),
      ])
    ),
  },
  { unknowns: 'allow' }
);

const sliNodeSchema = schema.object(
  {
    type: schema.oneOf([schema.literal('single'), schema.literal('composite')]),
    // Single arm — keys below. Composite reserved for P2; let the service layer reject.
    definition: schema.maybe(prometheusSliSchema),
    dimensions: schema.maybe(schema.arrayOf(dimensionSchema)),
    // Composite arm keys (reserved)
    operator: schema.maybe(schema.oneOf([schema.literal('all'), schema.literal('any')])),
    members: schema.maybe(schema.arrayOf(schema.object({}, { unknowns: 'allow' }))),
  },
  { unknowns: 'allow' }
);

const windowSchema = schema.object(
  {
    type: schema.oneOf([schema.literal('rolling'), schema.literal('calendar')]),
    duration: schema.maybe(schema.string()),
    period: schema.maybe(
      schema.oneOf([schema.literal('week'), schema.literal('month'), schema.literal('quarter')])
    ),
    timezone: schema.maybe(schema.string()),
    startDay: schema.maybe(schema.number()),
  },
  { unknowns: 'allow' }
);

const alertingSchema = schema.object(
  {
    strategy: schema.literal('mwmbr'),
    burnRates: schema.arrayOf(burnRateSchema),
  },
  { unknowns: 'allow' }
);

const alarmsSchema = schema.object({
  sliHealth: schema.object({ enabled: schema.boolean() }),
  attainmentBreach: schema.object({ enabled: schema.boolean() }),
  budgetWarning: schema.object({ enabled: schema.boolean() }),
  noData: schema.object({ enabled: schema.boolean(), forDuration: schema.string() }),
  resolved: schema.object({ enabled: schema.boolean() }),
});

const exclusionWindowSchema = schema.object(
  {
    name: schema.string(),
    reason: schema.maybe(schema.string()),
    schedule: schema.oneOf([
      schema.object({
        type: schema.literal('cron'),
        expression: schema.string(),
        timezone: schema.string(),
        duration: schema.string(),
      }),
      schema.object({
        type: schema.literal('oneoff'),
        start: schema.string(),
        end: schema.string(),
      }),
    ]),
  },
  { unknowns: 'allow' }
);

const budgetWarningThresholdSchema = schema.object({
  threshold: schema.number({ min: 0.01, max: 0.99 }),
  severity: schema.string({ minLength: 1 }),
});

const sloSpecSchema = schema.object(
  {
    datasourceId: schema.string({ minLength: 1 }),
    name: schema.string({ minLength: 1, maxLength: 128 }),
    description: schema.maybe(schema.string()),
    enabled: schema.boolean(),
    mode: schema.oneOf([schema.literal('active'), schema.literal('shadow')]),
    service: schema.string({ minLength: 1 }),
    owner: schema.object({
      teams: schema.arrayOf(schema.string(), { minSize: 1 }),
      primaryUser: schema.maybe(schema.string()),
    }),
    tier: schema.maybe(schema.string()),
    sli: sliNodeSchema,
    objectives: schema.arrayOf(objectiveSchema, { minSize: 1 }),
    budgetWarningThresholds: schema.arrayOf(budgetWarningThresholdSchema),
    window: windowSchema,
    alerting: alertingSchema,
    alarms: alarmsSchema,
    exclusionWindows: schema.arrayOf(exclusionWindowSchema),
    labels: schema.recordOf(
      schema.string(),
      schema.oneOf([schema.string(), schema.arrayOf(schema.string())])
    ),
    annotations: schema.recordOf(schema.string(), schema.string()),
  },
  { unknowns: 'allow' }
);

const createBody = schema.object({
  id: schema.maybe(schema.string()),
  spec: sloSpecSchema,
});

// Update accepts a partial spec — consumer supplies only the fields they're changing
// plus the version for optimistic concurrency.
const updateBody = schema.object({
  version: schema.number({ min: 1 }),
  spec: schema.object({}, { unknowns: 'allow' }),
});

// ============================================================================
// Registration
// ============================================================================

/**
 * Build the per-request SloDeployContext the service needs to dual-write to
 * the ruler on create/update/delete. Returns `undefined` (no ruler call) when:
 *   - the ruler client isn't configured (legacy / offline dev),
 *   - the datasource service hasn't discovered `datasourceId` yet,
 *   - the datasource has no `directQueryName` (not a DirectQuery Prometheus).
 *
 * TODO(W1.5): derive `workspaceId` from OSD's workspace scope once the SLO
 * spec carries a workspace reference. For now the datasource ID doubles as a
 * tenant discriminator — safe because `slo-generated-<ds>` is deterministic
 * and unique per Prometheus connection. Cross-ref memo §Workspace → Cortex
 * tenant mapping.
 */
async function buildDeployContext(
  ctx: SloHandlerContext,
  datasourceId: string | undefined,
  rulerClient: RulerClient | undefined,
  datasourceService: InMemoryDatasourceService | undefined,
  logger: Logger
): Promise<SloDeployContext | undefined> {
  if (!rulerClient || !datasourceService || !datasourceId) return undefined;

  const ds = await datasourceService.get(datasourceId);
  if (!ds) {
    logger.debug(`SLO deploy context unavailable: datasource "${datasourceId}" not known`);
    return undefined;
  }
  if (!ds.directQueryName) {
    logger.debug(
      `SLO deploy context unavailable: datasource "${datasourceId}" has no directQueryName`
    );
    return undefined;
  }

  // Local-cluster fallback (no MDS) — the alerting routes use the same pattern.
  const client: AlertingOSClient =
    ds.mdsId && ctx.dataSource
      ? await ctx.dataSource.opensearch.getClient(ds.mdsId)
      : ctx.core.opensearch.client.asCurrentUser;

  return {
    ruler: rulerClient,
    client,
    datasource: ds as Datasource,
    // TODO: pull real workspaceId from OSD request scope once plumbed.
    workspaceId: datasourceId,
  };
}

export function registerSloRoutes(
  router: IRouter,
  sloService: SloService,
  logger: Logger,
  rulerClient?: RulerClient,
  datasourceService?: InMemoryDatasourceService
) {
  router.get(
    {
      path: SLO_BASE,
      validate: {
        query: schema.object({
          page: schema.maybe(schema.string()),
          pageSize: schema.maybe(schema.string()),
          datasourceId: schema.maybe(schema.string()),
          state: schema.maybe(schema.string()),
          sliBackend: schema.maybe(schema.string()),
          sliLeafType: schema.maybe(schema.string()),
          service: schema.maybe(schema.string()),
          team: schema.maybe(schema.string()),
          tier: schema.maybe(schema.string()),
          enabled: schema.maybe(schema.string()),
          mode: schema.maybe(schema.string()),
          search: schema.maybe(schema.string()),
        }),
      },
    },
    async (_ctx, req, res) => {
      const q = req.query;
      const filters = {
        page: q.page ? parseInt(q.page, 10) : undefined,
        pageSize: q.pageSize ? parseInt(q.pageSize, 10) : undefined,
        datasourceId: q.datasourceId,
        state: q.state
          ? (q.state.split(',') as Array<
              'breached' | 'warning' | 'ok' | 'no_data' | 'stale' | 'disabled'
            >)
          : undefined,
        sliBackend: q.sliBackend
          ? (q.sliBackend.split(',') as Array<'prometheus' | 'opensearch'>)
          : undefined,
        sliLeafType: q.sliLeafType ? q.sliLeafType.split(',') : undefined,
        service: q.service ? q.service.split(',') : undefined,
        team: q.team ? q.team.split(',') : undefined,
        tier: q.tier ? q.tier.split(',') : undefined,
        enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
        mode: q.mode ? (q.mode.split(',') as Array<'active' | 'shadow'>) : undefined,
        search: q.search,
      };
      const result = await handleListSLOs(sloService, filters, logger);
      if (result.status >= 400) {
        return res.customError({
          statusCode: result.status,
          body: { message: String((result.body as { error?: string }).error ?? 'Failed') },
        });
      }
      return res.ok({ body: result.body });
    }
  );

  router.post({ path: SLO_BASE, validate: { body: createBody } }, async (ctx, req, res) => {
    // TODO: once request auth context is wired, pull from req.auth.
    const deploy = await buildDeployContext(
      ctx as SloHandlerContext,
      req.body?.spec?.datasourceId,
      rulerClient,
      datasourceService,
      logger
    );
    const result = await handleCreateSLO(sloService, req.body, 'osd-user', logger, deploy);
    if (result.status === 201) return res.ok({ body: result.body });
    return res.customError({
      statusCode: result.status,
      body: {
        message: String((result.body as { error?: string }).error ?? 'Create failed'),
        attributes: result.body,
      },
    });
  });

  router.post(
    { path: `${SLO_BASE}/preview`, validate: { body: createBody } },
    async (_ctx, req, res) => {
      const result = await handlePreviewSLORules(sloService, req.body, logger);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: {
          message: String((result.body as { error?: string }).error ?? 'Preview failed'),
          attributes: result.body,
        },
      });
    }
  );

  router.post(
    {
      path: `${SLO_BASE}/statuses`,
      validate: { body: schema.object({ ids: schema.arrayOf(schema.string()) }) },
    },
    async (_ctx, req, res) => {
      const result = await handleGetSLOStatuses(sloService, req.body.ids, logger);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: { message: String((result.body as { error?: string }).error ?? 'Failed') },
      });
    }
  );

  router.get(
    {
      path: `${SLO_BASE}/{id}`,
      validate: { params: schema.object({ id: schema.string() }) },
    },
    async (_ctx, req, res) => {
      const result = await handleGetSLO(sloService, req.params.id, logger);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: { message: String((result.body as { error?: string }).error ?? 'Not found') },
      });
    }
  );

  router.put(
    {
      path: `${SLO_BASE}/{id}`,
      validate: {
        params: schema.object({ id: schema.string() }),
        body: updateBody,
      },
    },
    async (ctx, req, res) => {
      // The update body may not carry datasourceId (partial spec); fetch the
      // existing doc to resolve the datasource for the deploy context.
      const existing = await sloService.get(req.params.id);
      const deploy = await buildDeployContext(
        ctx as SloHandlerContext,
        existing?.spec.datasourceId,
        rulerClient,
        datasourceService,
        logger
      );
      const result = await handleUpdateSLO(
        sloService,
        req.params.id,
        req.body,
        'osd-user',
        logger,
        deploy
      );
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: {
          message: String((result.body as { error?: string }).error ?? 'Update failed'),
          attributes: result.body,
        },
      });
    }
  );

  router.delete(
    {
      path: `${SLO_BASE}/{id}`,
      validate: { params: schema.object({ id: schema.string() }) },
    },
    async (ctx, req, res) => {
      const existing = await sloService.get(req.params.id);
      const deploy = await buildDeployContext(
        ctx as SloHandlerContext,
        existing?.spec.datasourceId,
        rulerClient,
        datasourceService,
        logger
      );
      const result = await handleDeleteSLO(sloService, req.params.id, logger, deploy);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: { message: String((result.body as { error?: string }).error ?? 'Delete failed') },
      });
    }
  );

  router.post(
    {
      path: `${SLO_BASE}/{id}/enable`,
      validate: { params: schema.object({ id: schema.string() }) },
    },
    async (ctx, req, res) => {
      const existing = await sloService.get(req.params.id);
      const deploy = await buildDeployContext(
        ctx as SloHandlerContext,
        existing?.spec.datasourceId,
        rulerClient,
        datasourceService,
        logger
      );
      const result = await handleEnableSLO(sloService, req.params.id, 'osd-user', logger, deploy);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: { message: String((result.body as { error?: string }).error ?? 'Enable failed') },
      });
    }
  );

  router.post(
    {
      path: `${SLO_BASE}/{id}/disable`,
      validate: { params: schema.object({ id: schema.string() }) },
    },
    async (ctx, req, res) => {
      const existing = await sloService.get(req.params.id);
      const deploy = await buildDeployContext(
        ctx as SloHandlerContext,
        existing?.spec.datasourceId,
        rulerClient,
        datasourceService,
        logger
      );
      const result = await handleDisableSLO(sloService, req.params.id, 'osd-user', logger, deploy);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: { message: String((result.body as { error?: string }).error ?? 'Disable failed') },
      });
    }
  );
}
