/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 4 (W4.6) — SLO rule-adoption HTTP endpoints.
 *
 *   GET  /api/observability/v1/slos/_orphans
 *   POST /api/observability/v1/slos/_recover
 *
 * Both are admin-gated by the combination of two feature flags:
 *   - `observability.slo.ruleDedup.enabled`   (Phase 3)
 *   - `observability.slo.ruleAdoption.enabled` (Phase 4)
 *
 * When either flag is off, the endpoint returns HTTP 412 Precondition Failed
 * with an envelope that names the missing flag(s). The gate runs first on
 * every request — before schema validation and before any deploy-context
 * resolution — so the precondition failure is cheap and deterministic.
 *
 * Service-call + error-code translation lives in the framework-agnostic
 * handlers (`handlers.ts`). This module owns:
 *   - route registration + schema validation
 *   - the 412 feature-flag gate
 *   - deploy-context construction (same `buildDeployContext` pattern used
 *     by create/update/delete — shared here via a private helper that
 *     mirrors the one in `index.ts`)
 *
 * External dashboards: intentionally none. This plugin emits
 * Prometheus-compatible rule groups and the orphan adoption surface reads
 * those groups only; no external visualization product is in scope.
 */

import { schema } from '@osd/config-schema';
import type { IRouter, Logger, RequestHandlerContext } from '../../../../../src/core/server';
import { OBSERVABILITY_BASE } from '../../../common/constants/shared';
import type { SloDeployContext } from '../../../common/slo/slo_service';
import { SloService, SloValidationError } from '../../../common/slo/slo_service';
import type { AlertingOSClient, Datasource } from '../../../common/types/alerting/types';
import type { InMemoryDatasourceService } from '../../services/alerting/datasource_service';
import type { DatasourceDiscoveryService } from '../../services/alerting/datasource_discovery';
import type { RulerClient } from '../../services/slo/ruler_client';
import type { SloReconciler } from '../../services/slo/reconciler';
import type { ReconcilerMetrics } from '../../services/slo/reconciler_metrics';
import { handleListOrphans, handlePurgeLegacy, handleRecoverSlo } from './handlers';
import type {
  PurgeLegacyInputLite,
  PurgeLegacyResultLite,
  RecoverSloInputLite,
  SloAdoptionServiceLite,
  SloReconcilerLite,
} from './handlers';
import { purgeLegacyOrphans } from '../../services/slo/slo_legacy_purger';
import type { SloLegacyPurgeAuditStore } from '../../services/slo/slo_legacy_purge_audit_store';

const SLO_BASE = `${OBSERVABILITY_BASE}/v1/slos`;

/** Context type mirroring the one in `index.ts` — kept local so the
 * adoption module doesn't re-export the internal type just for a side
 * import. */
type SloHandlerContext = RequestHandlerContext & {
  dataSource?: {
    opensearch: {
      getClient: (id: string) => Promise<AlertingOSClient>;
    };
  };
};

/**
 * Envelope returned by the 412 feature-flag gate. `missingFlags` is
 * populated with whichever one(s) are disabled — the caller UI can render
 * the exact flag name the operator needs to flip. Order is deterministic
 * (`ruleDedup` before `ruleAdoption`) so snapshot tests don't flake.
 */
interface PreconditionFailure {
  error: 'PRECONDITION_FAILED';
  message: string;
  missingFlags: Array<'ruleDedup' | 'ruleAdoption'>;
}

function buildPreconditionFailure(
  ruleDedupEnabled: boolean,
  ruleAdoptionEnabled: boolean
): PreconditionFailure | null {
  const missingFlags: Array<'ruleDedup' | 'ruleAdoption'> = [];
  if (!ruleDedupEnabled) missingFlags.push('ruleDedup');
  if (!ruleAdoptionEnabled) missingFlags.push('ruleAdoption');
  if (missingFlags.length === 0) return null;
  return {
    error: 'PRECONDITION_FAILED',
    message:
      'Orphan adoption requires observability.slo.ruleDedup.enabled and observability.slo.ruleAdoption.enabled',
    missingFlags,
  };
}

export interface RegisterSloAdoptionRoutesOptions {
  router: IRouter;
  sloService: SloService;
  logger: Logger;
  rulerClient?: RulerClient;
  datasourceService?: InMemoryDatasourceService;
  discoveryService?: DatasourceDiscoveryService;
  reconciler?: SloReconciler;
  ruleDedupEnabled: boolean;
  ruleAdoptionEnabled: boolean;
  /**
   * Session C — `observability.slo.legacyOrphanPurge.enabled`. Default false.
   * Gates the `_purge_legacy` admin endpoint: when off, the route handler
   * returns 404 so the endpoint appears "not registered" to the client (per
   * the feature-flag decision D1).
   */
  legacyOrphanPurgeEnabled?: boolean;
  /**
   * Session C — metrics bank the purger reports to. Optional so offline-dev
   * / test wiring can omit it.
   */
  reconcilerMetrics?: ReconcilerMetrics;
  /**
   * Session E (F4) — lazy getter for the legacy-purge audit store.
   * `undefined` until `start()` wires the SO-backed store; the purge
   * handler reads it per-request and passes it to the purger when
   * available. The audit-list endpoint returns 503 when still unavailable.
   */
  legacyPurgeAuditStoreGetter?: () => SloLegacyPurgeAuditStore | undefined;
}

/**
 * Build a `SloDeployContext` for the adoption endpoints. Pattern mirrors
 * `buildDeployContext` in `server/routes/slo/index.ts` but pared down to
 * what recover/clone need. Throws `SloValidationError` when the datasource
 * is missing or isn't a DirectQuery Prometheus connection — the route
 * adapter catches and returns 400.
 */
async function buildAdoptionDeployContext(
  ctx: SloHandlerContext,
  datasourceId: string,
  workspaceId: string | undefined,
  rulerClient: RulerClient | undefined,
  datasourceService: InMemoryDatasourceService | undefined,
  discoveryService: DatasourceDiscoveryService | undefined
): Promise<SloDeployContext> {
  if (!rulerClient) {
    throw new SloValidationError({
      'spec.datasourceId': 'Ruler client not configured; cannot reach the ruler.',
    });
  }
  if (!datasourceService) {
    throw new SloValidationError({
      'spec.datasourceId': 'Datasource service not configured; cannot resolve datasource.',
    });
  }
  if (discoveryService) {
    await discoveryService.ensure(ctx);
  }
  const ds = await datasourceService.get(datasourceId);
  if (!ds) {
    throw new SloValidationError({
      'spec.datasourceId': `Datasource "${datasourceId}" is not registered. Pick one from /api/alerting/datasources.`,
    });
  }
  if (!ds.directQueryName) {
    throw new SloValidationError({
      'spec.datasourceId': `Datasource "${ds.name}" is not a DirectQuery Prometheus connection; SLO rules can only be deployed to Prometheus-backed datasources.`,
    });
  }
  const client: AlertingOSClient =
    ds.mdsId && ctx.dataSource
      ? await ctx.dataSource.opensearch.getClient(ds.mdsId)
      : ctx.core.opensearch.client.asCurrentUser;
  return {
    ruler: rulerClient,
    client,
    datasource: ds as Datasource,
    // workspaceId === datasourceId shorthand until W3-follow-up wires real
    // workspace scoping (matches the pattern in `index.ts#buildDeployContext`).
    workspaceId: workspaceId ?? datasourceId,
  };
}

/**
 * Register the three W4.6 adoption endpoints. Each handler applies the
 * 412 gate up front; unflagged plugins still see the endpoints (so UI
 * error surfaces don't have to branch on 404-vs-412) but get a consistent
 * 412 envelope back.
 */
export function registerSloAdoptionRoutes(options: RegisterSloAdoptionRoutesOptions): void {
  const {
    router,
    sloService,
    logger,
    rulerClient,
    datasourceService,
    discoveryService,
    reconciler,
    ruleDedupEnabled,
    ruleAdoptionEnabled,
    legacyOrphanPurgeEnabled = false,
    reconcilerMetrics,
    legacyPurgeAuditStoreGetter,
  } = options;

  // The structural service interface that the handlers consume. SloService
  // grows `recover` + `clone` in B2A (W4.4/W4.5); until that lands the
  // cast keeps typecheck quiet. Once B2A ships, the cast becomes a no-op.
  const adoptionService = (sloService as unknown) as SloAdoptionServiceLite;

  // --------------------------------------------------------------------------
  // GET /api/observability/v1/slos/_orphans
  // --------------------------------------------------------------------------
  router.get(
    {
      path: `${SLO_BASE}/_orphans`,
      validate: {
        query: schema.object({
          datasourceId: schema.maybe(schema.string()),
        }),
      },
    },
    async (_ctx, req, res) => {
      const precondition = buildPreconditionFailure(ruleDedupEnabled, ruleAdoptionEnabled);
      if (precondition) {
        return res.customError({
          statusCode: 412,
          body: {
            message: precondition.message,
            attributes: precondition,
          },
        });
      }
      const result = await handleListOrphans(
        reconciler as SloReconcilerLite | undefined,
        req.query.datasourceId,
        logger
      );
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: {
          message: String((result.body as { error?: string }).error ?? 'List orphans failed'),
          attributes: result.body as Record<string, unknown>,
        },
      });
    }
  );

  // --------------------------------------------------------------------------
  // POST /api/observability/v1/slos/_recover
  // --------------------------------------------------------------------------
  const recoverBody = schema.object({
    sloId: schema.string({ minLength: 1 }),
    datasourceId: schema.string({ minLength: 1 }),
    workspaceId: schema.maybe(schema.string()),
    acknowledgeTombstone: schema.maybe(schema.boolean()),
  });

  router.post(
    {
      path: `${SLO_BASE}/_recover`,
      validate: { body: recoverBody },
    },
    async (ctx, req, res) => {
      const precondition = buildPreconditionFailure(ruleDedupEnabled, ruleAdoptionEnabled);
      if (precondition) {
        return res.customError({
          statusCode: 412,
          body: {
            message: precondition.message,
            attributes: precondition,
          },
        });
      }
      const input: RecoverSloInputLite = {
        sloId: req.body.sloId,
        datasourceId: req.body.datasourceId,
        workspaceId: req.body.workspaceId,
        acknowledgeTombstone: req.body.acknowledgeTombstone,
      };
      let deploy: SloDeployContext;
      try {
        deploy = await buildAdoptionDeployContext(
          ctx as SloHandlerContext,
          input.datasourceId,
          input.workspaceId,
          rulerClient,
          datasourceService,
          discoveryService
        );
      } catch (e) {
        if (e instanceof SloValidationError) {
          return res.customError({
            statusCode: 400,
            body: {
              message: 'Validation failed',
              attributes: { error: 'Validation failed', errors: e.errors },
            },
          });
        }
        throw e;
      }
      const result = await handleRecoverSlo(adoptionService, input, deploy, logger);
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: {
          message: String((result.body as { error?: string }).error ?? 'Recover failed'),
          attributes: result.body as Record<string, unknown>,
        },
      });
    }
  );

  // --------------------------------------------------------------------------
  // POST /api/observability/v1/slos/_purge_legacy  (Session C)
  //
  // Admin-only. Gated on `observability.slo.legacyOrphanPurge.enabled`; when
  // off the handler returns 404 so the endpoint appears unregistered to
  // clients (decision D1). Independent of the other two flags — legacy
  // groups exist because dedup wasn't on at create time, so the purge has
  // to work regardless of `ruleDedup` / `ruleAdoption`.
  //
  // The server-side purger enforces every safety invariant (name pattern,
  // namespace shape, no-owning-SO, currently-on-ruler). The client is not
  // trusted; a client request that would pass its own checks but fail
  // server-side (e.g. an SO claiming a group the client didn't know about)
  // must land in `skipped_validation`, not be deleted.
  // --------------------------------------------------------------------------
  const purgeLegacyBody = schema.object({
    datasourceId: schema.string({ minLength: 1 }),
    groups: schema.arrayOf(
      schema.object({
        groupName: schema.string({ minLength: 1 }),
        namespace: schema.string({ minLength: 1 }),
      }),
      { minSize: 1 }
    ),
  });

  router.post(
    {
      path: `${SLO_BASE}/_purge_legacy`,
      validate: { body: purgeLegacyBody },
    },
    async (ctx, req, res) => {
      // Access to this endpoint is intentionally open to any authenticated
      // caller in the workspace. SLOs are pre-GA and the feature flag
      // (observability.slo.legacyOrphanPurge.enabled /
      // observability.slo.ruleDedup.enabled) is the only gate today. A
      // runtime admin-role check may be added later once a real
      // multi-user threat model exists; until then, don't introduce one.
      if (!legacyOrphanPurgeEnabled) {
        return res.customError({
          statusCode: 404,
          body: {
            message: 'Not Found',
            attributes: { error: 'NOT_FOUND' },
          },
        });
      }
      // Resolve deploy context just for the datasource + ruler + OS client;
      // the purger doesn't need a workspaceId beyond the
      // workspaceId-equals-datasourceId convention this plugin already
      // uses. Reuse `buildAdoptionDeployContext` so the same 400 surface
      // fires on unknown / non-Prometheus datasources.
      let deploy: SloDeployContext;
      try {
        deploy = await buildAdoptionDeployContext(
          ctx as SloHandlerContext,
          req.body.datasourceId,
          undefined,
          rulerClient,
          datasourceService,
          discoveryService
        );
      } catch (e) {
        if (e instanceof SloValidationError) {
          return res.customError({
            statusCode: 400,
            body: {
              message: 'Validation failed',
              attributes: { error: 'Validation failed', errors: e.errors },
            },
          });
        }
        throw e;
      }
      if (!rulerClient) {
        return res.customError({
          statusCode: 501,
          body: {
            message: 'Ruler client not configured',
            attributes: { error: 'RULER_NOT_CONFIGURED' },
          },
        });
      }
      const input: PurgeLegacyInputLite = {
        datasourceId: req.body.datasourceId,
        workspaceId: deploy.workspaceId,
        candidates: req.body.groups,
      };
      // Session E (F4) — best-effort username extraction for audit
      // records. OSD's request headers carry the admin's user id via
      // x-proxy-user on direct-proxy setups; when absent, leave the
      // field undefined on the audit record.
      const requestedBy =
        (typeof req.headers?.['x-proxy-user'] === 'string'
          ? (req.headers['x-proxy-user'] as string)
          : undefined) ?? undefined;
      const auditStore = legacyPurgeAuditStoreGetter?.();
      const result = await handlePurgeLegacy(
        async (i) => {
          const purged = await purgeLegacyOrphans(
            {
              datasourceId: i.datasourceId,
              workspaceId: i.workspaceId,
              candidates: i.candidates,
            },
            {
              listSlos: (dsId) => sloService.listRawByDatasource(dsId),
              ruler: rulerClient,
              client: deploy.client,
              datasource: deploy.datasource,
              logger,
              metrics: reconcilerMetrics,
              auditStore,
              requestedBy,
            }
          );
          // Widen the typed arrays to Record<string, unknown>[] so the
          // framework-agnostic handler surface stays decoupled from the
          // concrete purger module's types. Shape is preserved verbatim.
          return (purged as unknown) as PurgeLegacyResultLite;
        },
        input,
        logger
      );
      if (result.status === 200) return res.ok({ body: result.body });
      return res.customError({
        statusCode: result.status,
        body: {
          message: String((result.body as { error?: string }).error ?? 'Purge failed'),
          attributes: result.body as Record<string, unknown>,
        },
      });
    }
  );

  // --------------------------------------------------------------------------
  // GET /api/observability/v1/slos/_purge_legacy/audit  (Session E F4)
  //
  // Read-only. Gated on the same `legacyOrphanPurge.enabled` flag as the
  // purge endpoint itself — if purge is off, audit is unreachable. No
  // separate flag; audit is part of the purge feature.
  //
  // Returns `{ records, truncated }`. Default `since` is 7 days ago; all
  // query params are optional. `truncated: true` signals the result
  // exceeded the configured limit (capped at MAX_LIMIT=500 server-side).
  // --------------------------------------------------------------------------
  router.get(
    {
      path: `${SLO_BASE}/_purge_legacy/audit`,
      validate: {
        query: schema.object({
          datasourceId: schema.maybe(schema.string()),
          groupName: schema.maybe(schema.string()),
          since: schema.maybe(schema.string()),
          limit: schema.maybe(schema.number({ min: 1 })),
        }),
      },
    },
    async (_ctx, req, res) => {
      if (!legacyOrphanPurgeEnabled) {
        return res.customError({
          statusCode: 404,
          body: {
            message: 'Not Found',
            attributes: { error: 'NOT_FOUND' },
          },
        });
      }
      const auditStore = legacyPurgeAuditStoreGetter?.();
      if (!auditStore) {
        return res.customError({
          statusCode: 503,
          body: {
            message: 'Legacy-orphan audit store not yet wired',
            attributes: { error: 'AUDIT_STORE_UNAVAILABLE' },
          },
        });
      }
      const defaultSinceMs = Date.now() - 7 * 24 * 60 * 60_000;
      const since = req.query.since ?? new Date(defaultSinceMs).toISOString();
      try {
        const result = await auditStore.list({
          datasourceId: req.query.datasourceId,
          groupName: req.query.groupName,
          since,
          limit: req.query.limit,
        });
        // Flatten SO docs to a public-friendly shape. `attributes` carry
        // the audit fields; the id is omitted from the public envelope
        // because it's fully derivable from (requestedAt, ds, groupName).
        return res.ok({
          body: {
            records: result.records.map((d) => d.attributes),
            truncated: result.truncated,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Legacy-audit list failed: ${message}`);
        return res.customError({
          statusCode: 500,
          body: {
            message,
            attributes: { error: 'AUDIT_LIST_FAILED' },
          },
        });
      }
    }
  );
}
