/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-agnostic SLO handlers. Route adapters translate the returned
 * { status, body } into OSD response shapes.
 */

import type { Logger } from '../../../common/types/alerting/types';
import {
  deriveExpectedGroups,
  SloDeployContext,
  SloNotFoundError,
  SloRepairContext,
  SloRuleHealthProbe,
  SloRulerError,
  SloRulerTeardownRequiredError,
  SloStatusAggregationContext,
  SloValidationError,
  SloVersionConflictError,
  SloService,
  sloRulerNamespaceFor,
} from '../../../common/slo/slo_service';
import type { SloCreateInput, SloListFilters, SloUpdateInput } from '../../../common/slo/slo_types';
import { computeSpecSha256 } from '../../../common/slo/slo_rule_provenance';
import type { HandlerResult } from '../alerting/route_utils';
import { toHandlerResult } from '../alerting/route_utils';

// ============================================================================
// Phase 4 W4.6 — adoption error codes.
//
// The concrete `SloAdoptionError` class is owned by the sibling W4.4/W4.5
// agent in `common/slo/slo_errors.ts`. To stay import-safe before that agent
// lands, we duck-type: the mapper checks `error.name === 'SloAdoptionError'`
// and reads `error.code` — matching the same shape the real class will
// expose. Once B2A's import is available the compiler-enforced path still
// works because the narrow branches only need a structural check; the
// `instanceof` flavor can be a follow-up swap without changing semantics.
// ============================================================================

/** Phase 4 (W4.6) — adoption error codes. Kept local so this file doesn't
 * depend on B2A's `common/slo/slo_adoption_types.ts` (which may not have
 * landed at the point this module is type-checked). The set mirrors the
 * contract called out in the orchestrator plan. */
type AdoptionErrorCodeLite =
  | 'ORPHAN_SPEC_DRIFT'
  | 'ORPHAN_WORKSPACE_MISMATCH'
  | 'ORPHAN_CLAIM_CONFLICT'
  | 'ORPHAN_UNSUPPORTED_SCHEMA'
  | 'ORPHAN_TOMBSTONED'
  | 'CLONE_NAME_COLLISION';

interface SloAdoptionErrorLike {
  name: 'SloAdoptionError';
  code: AdoptionErrorCodeLite;
  message: string;
}

function isSloAdoptionErrorLike(e: unknown): e is SloAdoptionErrorLike {
  if (!e || typeof e !== 'object') return false;
  const rec = e as { name?: unknown; code?: unknown };
  return rec.name === 'SloAdoptionError' && typeof rec.code === 'string';
}

/**
 * Phase 4 W4.6 — map adoption error codes to HTTP status. Pulled out of the
 * generic `toSloError` because the response envelope is different (always
 * echoes `code` + `message`) and the codes are adoption-specific.
 *
 * Status mapping (from W4.6 spec):
 *   ORPHAN_UNSUPPORTED_SCHEMA → 422
 *   ORPHAN_SPEC_DRIFT         → 422
 *   ORPHAN_WORKSPACE_MISMATCH → 422
 *   ORPHAN_CLAIM_CONFLICT     → 409
 *   ORPHAN_TOMBSTONED         → 409  (retry with acknowledgeTombstone: true)
 *   CLONE_NAME_COLLISION      → 409
 */
function toAdoptionErrorResponse(err: SloAdoptionErrorLike): HandlerResult {
  const code = err.code;
  const status =
    code === 'ORPHAN_CLAIM_CONFLICT' ||
    code === 'ORPHAN_TOMBSTONED' ||
    code === 'CLONE_NAME_COLLISION'
      ? 409
      : 422;
  return {
    status,
    body: {
      error: code,
      code,
      message: err.message,
    },
  };
}

function toSloError(e: unknown, logger?: Logger): HandlerResult {
  // Phase 4 W4.6: adoption-specific errors from the recover/clone paths.
  // Checked before the generic typed-error ladder so the envelope stays
  // adoption-shaped (code + message) rather than the legacy validation
  // envelope.
  if (isSloAdoptionErrorLike(e)) {
    if (logger) logger.warn(`SLO adoption error: ${e.code} — ${e.message}`);
    return toAdoptionErrorResponse(e);
  }
  if (e instanceof SloValidationError) {
    if (logger) logger.warn(e.message);
    return { status: 400, body: { error: 'Validation failed', errors: e.errors } };
  }
  if (e instanceof SloNotFoundError) {
    return { status: 404, body: { error: e.message } };
  }
  if (e instanceof SloVersionConflictError) {
    return {
      status: 409,
      body: {
        error: e.message,
        current: e.current,
        attemptedVersion: e.attemptedVersion,
      },
    };
  }
  if (e instanceof SloRulerError) {
    if (logger) logger.warn(`Ruler dual-write failed: ${e.code} (HTTP ${e.httpStatus})`);
    // Surface upstream status verbatim when available (4xx) so the wizard can
    // show Cortex's own diagnostic. 0 (unreachable) maps to 502 — closest
    // semantic match (upstream gateway failure).
    const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 502;
    return {
      status,
      body: {
        error: e.message,
        code: e.code,
        httpStatus: e.httpStatus,
        rawBody: e.rawBody,
      },
    };
  }
  if (e instanceof SloRulerTeardownRequiredError) {
    if (logger) logger.warn(e.message);
    // 409 Conflict — the client's request is valid, but the current state
    // (unresolved datasource, live rule group) prevents completion. UI can
    // point the user at fixing the datasource before retrying.
    return {
      status: 409,
      body: {
        error: e.message,
        code: 'RULER_TEARDOWN_REQUIRED',
        sloId: e.sloId,
        datasourceId: e.datasourceId,
      },
    };
  }
  return toHandlerResult(e, logger);
}

export async function handleListSLOs(
  svc: SloService,
  filters: SloListFilters,
  logger?: Logger,
  statusCtx?: SloStatusAggregationContext
): Promise<HandlerResult> {
  try {
    const result = await svc.getPaginated(filters, statusCtx);
    return { status: 200, body: result };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleCreateSLO(
  svc: SloService,
  input: SloCreateInput,
  createdBy: string,
  logger?: Logger,
  deploy?: SloDeployContext
): Promise<HandlerResult> {
  try {
    const doc = await svc.create(input, createdBy, deploy);
    return { status: 201, body: doc };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleGetSLO(
  svc: SloService,
  id: string,
  logger?: Logger,
  statusCtx?: SloStatusAggregationContext
): Promise<HandlerResult> {
  try {
    const doc = await svc.get(id);
    if (!doc) return { status: 404, body: { error: 'SLO not found' } };
    const liveStatus = await svc.getStatus(id, statusCtx);
    // Phase 3 W3.12 — include the refcount per recording fingerprint so the
    // detail page can render "Shared with N other SLOs". When no ref store
    // is wired (offline / tests / legacy docs) the map is `{}` and the UI
    // treats every fingerprint as unshared.
    const workspaceId = statusCtx?.workspaceId ?? 'default';
    const recordingFingerprintRefcounts = await svc.getFingerprintRefcounts(doc, workspaceId);
    return {
      status: 200,
      body: { ...doc, liveStatus, recordingFingerprintRefcounts },
    };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleUpdateSLO(
  svc: SloService,
  id: string,
  input: SloUpdateInput,
  updatedBy: string,
  logger?: Logger,
  deploy?: SloDeployContext
): Promise<HandlerResult> {
  try {
    const doc = await svc.update(id, input, updatedBy, deploy);
    return { status: 200, body: doc };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleDeleteSLO(
  svc: SloService,
  id: string,
  logger?: Logger,
  deploy?: SloDeployContext
): Promise<HandlerResult> {
  try {
    const result = await svc.delete(id, deploy);
    if (!result.deleted) return { status: 404, body: { error: 'SLO not found' } };
    return { status: 200, body: { deleted: true, generatedRuleNames: result.generatedRuleNames } };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleEnableSLO(
  svc: SloService,
  id: string,
  updatedBy: string,
  logger?: Logger,
  deploy?: SloDeployContext
): Promise<HandlerResult> {
  try {
    const doc = await svc.setEnabled(id, true, updatedBy, deploy);
    return { status: 200, body: doc };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleDisableSLO(
  svc: SloService,
  id: string,
  updatedBy: string,
  logger?: Logger,
  deploy?: SloDeployContext
): Promise<HandlerResult> {
  try {
    const doc = await svc.setEnabled(id, false, updatedBy, deploy);
    return { status: 200, body: doc };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handlePreviewSLORules(
  svc: SloService,
  input: SloCreateInput,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const group = svc.previewRules(input);
    return { status: 200, body: group };
  } catch (e) {
    return toSloError(e, logger);
  }
}

export async function handleGetSLOStatuses(
  svc: SloService,
  ids: string[],
  logger?: Logger,
  statusCtx?: SloStatusAggregationContext
): Promise<HandlerResult> {
  try {
    if (!ids || ids.length === 0) {
      return { status: 400, body: { error: 'ids parameter is required' } };
    }
    const statuses = await svc.getStatuses(ids, statusCtx);
    return { status: 200, body: { statuses } };
  } catch (e) {
    return toSloError(e, logger);
  }
}

// ============================================================================
// W1.5 — Repair + Rule health endpoints
// ============================================================================

/**
 * Context accepted by the W1.5 handlers. The health probe is a structural
 * subset of `RuleHealthChecker` and the deploy context is the same one
 * create/update/delete take — both come from `registerSloRoutes`' closure.
 *
 * When `health` is missing we return 501 instead of silently falling back:
 * the UI already has its own "rule health checker not configured" affordance,
 * and a 200 with a synthetic `ok` would mask genuine rollout regressions.
 */
export interface SloRepairHandlerContext {
  health?: SloRuleHealthProbe;
  deploy?: SloDeployContext;
}

/**
 * `POST /api/observability/v1/slos/{id}/repair` — re-asserts the expected
 * rule groups for an SLO. See `SloService.repair`.
 */
export async function handleRepairSLO(
  svc: SloService,
  id: string,
  logger?: Logger,
  ctx?: SloRepairHandlerContext
): Promise<HandlerResult> {
  try {
    if (!ctx?.health) {
      return {
        status: 501,
        body: { error: 'Rule health checker not configured in this environment' },
      };
    }
    if (!ctx.deploy) {
      return {
        status: 400,
        body: {
          error:
            'Cannot repair SLO: deploy context unavailable (datasource not registered or not a DirectQuery Prometheus connection)',
        },
      };
    }
    const repairCtx: SloRepairContext = { health: ctx.health, deploy: ctx.deploy };
    const result = await svc.repair(id, repairCtx);
    return { status: 200, body: result };
  } catch (e) {
    return toSloError(e, logger);
  }
}

/**
 * `GET /api/observability/v1/slos/{id}/rule_health` — probes the ruler for
 * the SLO's expected rule groups and returns a `RuleHealthResponse`-shaped
 * body (sloId + the rule-health report fields inlined).
 */
export async function handleGetRuleHealth(
  svc: SloService,
  id: string,
  logger?: Logger,
  ctx?: SloRepairHandlerContext
): Promise<HandlerResult> {
  try {
    if (!ctx?.health) {
      return {
        status: 501,
        body: { error: 'Rule health checker not configured in this environment' },
      };
    }
    const doc = await svc.get(id);
    if (!doc) throw new SloNotFoundError(id);

    if (!ctx.deploy) {
      return {
        status: 400,
        body: {
          error:
            'Cannot probe rule health: deploy context unavailable (datasource not registered or not a DirectQuery Prometheus connection)',
        },
      };
    }

    const expectedGroups = deriveExpectedGroups(doc);
    const namespace =
      doc.status.provisioning.backend === 'prometheus'
        ? doc.status.provisioning.rulerNamespace || sloRulerNamespaceFor(ctx.deploy.workspaceId)
        : sloRulerNamespaceFor(ctx.deploy.workspaceId);

    const report = await ctx.health.check({
      workspaceId: ctx.deploy.workspaceId,
      datasource: ctx.deploy.datasource,
      client: ctx.deploy.client,
      sloId: doc.id,
      namespace,
      expectedGroups,
    });

    // Shape matches the public `RuleHealthResponse` in `slo_api_client.ts`:
    // { sloId, state, expectedGroups, presentGroups, missingGroups,
    //   rulerErrorCode?, computedAt }. We spread the report first so the
    // route is a thin pass-through — no hidden field mutation.
    return { status: 200, body: { sloId: doc.id, ...report } };
  } catch (e) {
    return toSloError(e, logger);
  }
}

// ============================================================================
// W4.6 — Adoption endpoints (`_orphans`, `_recover`, `_clone`)
//
// Framework-agnostic handler factories for the adoption endpoints. The 412
// feature-flag gate lives in the route adapter (`adoption_route.ts`) so the
// gate can short-circuit before any dependency resolution; these handlers
// assume the gate already passed and focus on service-call + error-code
// translation.
//
// The `recover` and `clone` service methods are authored by the W4.4/W4.5
// sibling agent on `SloService`. We type their inputs/outputs locally so
// this module can compile before B2A's import surface lands; the shapes
// mirror the orchestrator plan's contract verbatim so a later swap to the
// real types is a mechanical rename.
// ============================================================================

/**
 * Phase 4 (W4.6) — input shape for `SloService.recover`. Mirrors the
 * orchestrator plan's contract; B2A re-exports the same shape from
 * `common/slo/slo_adoption_types.ts` and (transitively) from `slo_service`.
 */
export interface RecoverSloInputLite {
  sloId: string;
  datasourceId: string;
  workspaceId?: string;
  acknowledgeTombstone?: boolean;
}

/**
 * Phase 4 (W4.6) — input shape for `SloService.clone`. Same rationale as
 * `RecoverSloInputLite`.
 */
export interface CloneSloInputLite {
  sourceSloId: string;
  sourceDatasourceId: string;
  sourceWorkspaceId?: string;
  targetDatasourceId: string;
  targetWorkspaceId?: string;
  overrideName?: string;
  overrideId?: string;
}

/**
 * Structural mirror of B2A's `RecoverResult`. The handler treats it as
 * opaque pass-through shape — the service builds the response, we just
 * forward it 200.
 */
export interface RecoverSloResultLite {
  slo: unknown;
  tombstoneCleared: boolean;
  refcountChanges: Array<{ fingerprint: string; previousRefcount: number; newRefcount: number }>;
}

/** Structural mirror of B2A's `CloneResult`. */
export interface CloneSloResultLite {
  slo: unknown;
  sourceSpecSha256: string;
}

/**
 * Service-surface the adoption handlers call. We avoid extending the
 * concrete `SloService` type here because the `recover` / `clone` methods
 * are owned by B2A and may not be on the class at typecheck time. The
 * structural interface lets the handler compile today and seamlessly
 * narrow when B2A's additions land.
 */
export interface SloAdoptionServiceLite {
  recover(input: RecoverSloInputLite, deploy: SloDeployContext): Promise<RecoverSloResultLite>;
  clone(
    input: CloneSloInputLite,
    sourceDeploy: SloDeployContext,
    targetDeploy: SloDeployContext
  ): Promise<CloneSloResultLite>;
}

/**
 * Phase 4 (W4.6) — minimal reconciler contract the `_orphans` handler
 * consumes. A structural subset of `SloReconciler` from
 * `server/services/slo/reconciler.ts`. Defined locally so `handlers.ts`
 * doesn't reach into the server tree (same rationale as
 * `SloTombstoneStoreLite` etc. in `common/slo/slo_service.ts`).
 */
export interface SloReconcilerLite {
  reconcileOnce(opts?: {
    datasourceIds?: string[];
  }): Promise<{
    adoptableOrphans: Array<{
      datasourceId: string;
      namespace: string;
      groupName: string;
      sourceSloId?: string;
      sourceWorkspaceId?: string;
      spec?: Record<string, unknown>;
      fingerprints?: string[];
      tombstoned?: boolean;
      tombstoneCreatedAt?: string;
      specIntegrity?: 'ok' | 'mismatch' | 'unsupported_schema';
      diagnostic?: string;
    }>;
    unknownOrphans: Array<{
      datasourceId: string;
      namespace: string;
      groupName: string;
      diagnostic?: string;
    }>;
  }>;
}

/**
 * `GET /api/observability/v1/slos/_orphans` — returns adoption candidates
 * and unknown orphans from a single reconciler sweep.
 *
 * The route adapter applies the 412 feature-flag gate; this handler assumes
 * the gate passed. When `reconciler` is missing we surface 501 so the route
 * is always present — matches the pattern used by `_reconcile` and repair.
 */
export async function handleListOrphans(
  reconciler: SloReconcilerLite | undefined,
  datasourceId: string | undefined,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    if (!reconciler) {
      return {
        status: 501,
        body: { error: 'Reconciler not configured in this environment' },
      };
    }
    // `datasourceId` is optional. When omitted, the reconciler sweeps all
    // datasources it can see. An empty filter array is normalized to
    // undefined by `reconcileOnce` itself (see `reconcile_route.ts`) — we
    // pass the single-element array straight through.
    const filter = datasourceId ? [datasourceId] : undefined;
    const result = await reconciler.reconcileOnce({ datasourceIds: filter });

    // Map reconciler's rich shape to the public `_orphans` contract. We only
    // surface the fields the UI reads today; extra fields on the entry are
    // dropped so the public envelope stays stable as the reconciler evolves.
    // `specSha256` is derived from the embedded spec when the reconciler
    // didn't carry it — keeps the envelope shape consistent even if
    // upstream hasn't added the field yet.
    const candidates = result.adoptableOrphans.map((o) => ({
      sloId: o.sourceSloId ?? '',
      datasourceId: o.datasourceId,
      workspaceId: o.sourceWorkspaceId ?? o.datasourceId,
      namespace: o.namespace,
      groupName: o.groupName,
      spec: (o.spec ?? {}) as Record<string, unknown>,
      specSha256: computeOrphanSpecSha256(o.spec),
      specIntegrity: o.specIntegrity ?? 'ok',
      fingerprints: o.fingerprints ?? [],
      tombstoned: o.tombstoned ?? false,
      tombstoneCreatedAt: o.tombstoneCreatedAt,
    }));

    const unknowns = result.unknownOrphans.map((o) => ({
      datasourceId: o.datasourceId,
      namespace: o.namespace,
      groupName: o.groupName,
      diagnostic: o.diagnostic,
    }));

    return { status: 200, body: { candidates, unknowns } };
  } catch (e) {
    return toSloError(e, logger);
  }
}

/**
 * `POST /api/observability/v1/slos/_recover` — reclaims an adoptable
 * orphan into a live SLO document, idempotently replaying the dedup-shape
 * deploy so ruler state matches the new claim.
 *
 * Error mapping (per W4.6 spec):
 *   - SloAdoptionError → 422/409 depending on code (see toAdoptionErrorResponse)
 *   - SloNotFoundError → 404
 *   - SloValidationError → 400
 *   - anything else → 500 via toHandlerResult
 */
export async function handleRecoverSlo(
  svc: SloAdoptionServiceLite,
  input: RecoverSloInputLite,
  deploy: SloDeployContext,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const result = await svc.recover(input, deploy);
    return { status: 200, body: result };
  } catch (e) {
    return toSloError(e, logger);
  }
}

/**
 * `POST /api/observability/v1/slos/_clone` — copies a source SLO into a
 * (possibly different) target datasource/workspace, optionally renaming.
 *
 * Returns 201 (Created) on success because a new SLO resource is produced.
 * Source deploy context is read-only; target deploy context is used for
 * the ruler upsert.
 */
export async function handleCloneSlo(
  svc: SloAdoptionServiceLite,
  input: CloneSloInputLite,
  sourceDeploy: SloDeployContext,
  targetDeploy: SloDeployContext,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const result = await svc.clone(input, sourceDeploy, targetDeploy);
    return { status: 201, body: result };
  } catch (e) {
    return toSloError(e, logger);
  }
}

/**
 * Best-effort sha256 of an embedded orphan spec. The reconciler doesn't
 * carry `specSha256` on `OrphanEntry` (the detector verifies the hash but
 * the match bit, not the bytes, is what callers care about), so we recompute
 * here. Returns an empty string when the spec is missing so the envelope
 * stays consistent-shaped for callers that only check `specIntegrity`.
 */
function computeOrphanSpecSha256(spec: Record<string, unknown> | undefined): string {
  if (!spec) return '';
  try {
    return computeSpecSha256(spec as Parameters<typeof computeSpecSha256>[0]);
  } catch {
    return '';
  }
}
