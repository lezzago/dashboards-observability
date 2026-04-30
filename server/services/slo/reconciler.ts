/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SloReconciler (Phase 2, W2.1 + W2.3) — background sweep that compares the
 * recording/alert rule groups each SLO saved object *expects* against what the
 * Prometheus-compatible ruler (Cortex / Mimir) actually hosts, then:
 *
 *   - Classifies every expected group as either `present` or `missing`.
 *   - Classifies every actual group that no SLO claims as an `orphan`, and
 *     (via the peer `detectOrphanDiff` helper in `orphan_detector.ts`) splits
 *     orphans into `adoptable` vs `unknown` using provenance rules that are
 *     stubbed in Phase 2 and completed in Phase 4.
 *   - Calls `healthChecker.invalidate(ws, ds, sloId)` for every SLO that showed
 *     up in `missingBySlo` so the next UI probe recomputes fresh instead of
 *     waiting for the 30s TTL. This is the W2.3 hook — splitting it into its
 *     own agent would force two workstreams to serialize on this file.
 *   - Emits metric counters per sweep (`sweeps`, `missing_rule_groups`,
 *     `orphans`, `errors`) via the injected `ReconcilerMetrics` surface. Phase
 *     2 intentionally emits from the raw diff counts — NOT the merged
 *     `SloHealthState` — so rate-of-change alerts on "rule groups vanished
 *     unexpectedly" fire off the distinct `rulerErrorCode` rather than the
 *     aggregator's priority-merged bucket.
 *
 * Algorithm note: the reconciler is read-only in Phase 2. It does NOT delete
 * orphans, repair missing groups, or mutate the ruler. Surfacing the diff is
 * enough for Phase 1's repair UX; Phase 3/4 bolt destructive actions on top.
 *
 * Lifecycle:
 *   - `start()` schedules a timer. First sweep fires *after* `intervalMs` —
 *     never on start — so plugin boot isn't paying for a Cortex round trip.
 *   - A sweep that's still running when the next tick fires is skipped; this
 *     keeps a slow ruler from queueing up overlapping sweeps that all hit the
 *     same already-slow endpoint.
 *   - `stop()` clears the interval AND awaits any in-flight sweep, so tests
 *     and plugin teardown don't race a late log write.
 *
 * All timer side-effects are isolated behind the returned `SloReconciler`
 * interface so consumers never see a raw NodeJS.Timeout handle.
 */

import type { AlertingOSClient, Datasource, Logger } from '../../../common/types/alerting/types';
import type { ISloStore, SloDocument } from '../../../common/slo/slo_types';
import { deriveExpectedGroups, sloRulerNamespaceFor } from '../../../common/slo/slo_service';
import { dedupRecordingGroupName } from '../../../common/slo/slo_promql_generator';
import { SloRulerError } from '../../../common/slo/slo_errors';
import type { InMemoryDatasourceService } from '../alerting/datasource_service';
import type { RulerClient } from './ruler_client';
import type { RuleHealthChecker } from './rule_health_checker';
import { detectOrphanDiff } from './orphan_detector';
import type { OrphanEntry } from './orphan_detector';
import type { ReconcilerMetrics } from './reconciler_metrics';
import type { SloRuleRefStore } from './slo_rule_ref_store';

// Re-export for ergonomic consumers of the reconciler — they can pull the
// metrics surface from one place without knowing it's physically defined by
// the peer W2.5 module.
export type { ReconcilerMetrics } from './reconciler_metrics';

// ============================================================================
// Public API
// ============================================================================

export interface ReconcileMissingEntry {
  sloId: string;
  datasourceId: string;
  namespace: string;
  missingGroups: string[];
}

/**
 * Phase 4 W4.2 — same shape as `OrphanEntry` from `orphan_detector.ts`. Kept
 * as its own alias so consumers of the reconciler don't have to reach into
 * the detector module.
 */
export type ReconcileOrphanEntry = OrphanEntry;

/** Re-export for ergonomic Phase 4 consumers. */
export type { SpecIntegrity } from './orphan_detector';

/**
 * Phase 4 W4.2 — minimal shape the reconciler needs to read tombstones. The
 * real SO-backed tombstone store (owned by W4.1) structurally satisfies
 * this interface. Kept here rather than imported so this file compiles
 * regardless of W4.1's exact export layout at sync time.
 */
export interface SloTombstoneReaderLite {
  get(sloId: string): Promise<{ createdAt: string } | null>;
}

/**
 * Session E (F3) — minimal observation-store contract the reconciler needs.
 * The real SO-backed `SloLegacyOrphanObservationStore` structurally
 * satisfies this interface; kept here (not imported) so the reconciler
 * compiles even when F3 wiring is absent (pre-start or tests).
 *
 * Semantics:
 *   - `observe(...)` — upsert. First call sets firstSeenAt=lastSeenAt=now;
 *     subsequent calls refresh lastSeenAt only.
 *   - `listForDatasource(...)` — enumerate observations for cross-checking
 *     against the sweep's current set, so vanished groups can be cleaned up.
 *   - `remove(...)` — delete the observation for a group that disappeared.
 *
 * All three are best-effort from the reconciler's point of view; failures
 * log at warn and don't block orphan surfacing.
 */
export interface SloLegacyOrphanObservationStoreLite {
  observe(input: {
    workspaceId: string;
    datasourceId: string;
    namespace: string;
    groupName: string;
    now?: () => Date;
  }): Promise<{
    doc: { attributes: { firstSeenAt: string; lastSeenAt: string } };
    created: boolean;
  }>;
  listForDatasource(
    workspaceId: string,
    datasourceId: string
  ): Promise<
    Array<{
      attributes: { groupName: string; firstSeenAt: string; lastSeenAt: string };
    }>
  >;
  remove(workspaceId: string, datasourceId: string, groupName: string): Promise<boolean>;
}

/**
 * Diagnostic tag the orphan detector assigns to pre-Phase-3 rule layouts.
 * Session E (F3) gates observation tracking on this exact string so we don't
 * write observations for every unknown-bucket entry (e.g. recording-only
 * orphans, unsupported schemaVersion), only true legacy groups.
 *
 * Kept in sync with `orphan_detector.ts:318`. If the detector changes the
 * string the unit tests here will catch the drift (reconciler test asserts
 * observation writes go through only on matching diagnostic).
 */
export const LEGACY_ORPHAN_DIAGNOSTIC = 'pre-Phase-3 rule layout; not eligible for adoption';

/**
 * Session E (F4) — minimal read-side contract for the audit store's
 * retention sweep. The real `SloLegacyPurgeAuditStore` structurally
 * satisfies this interface.
 */
export interface SloLegacyPurgeAuditRetentionLite {
  deleteBefore(cutoff: string): Promise<number>;
}

export interface ReconcileErrorEntry {
  datasourceId: string;
  namespace: string;
  message: string;
}

export interface ReconcileDanglingRefEntry {
  workspaceId: string;
  datasourceId: string;
  fingerprint: string;
  refcount: number;
}

export interface ReconcileGraceDeletionEntry {
  workspaceId: string;
  datasourceId: string;
  fingerprint: string;
  namespace: string;
  groupName: string;
}

export interface ReconcileResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  datasourceIds: string[];
  missingBySlo: ReconcileMissingEntry[];
  orphans: ReconcileOrphanEntry[];
  adoptableOrphans: ReconcileOrphanEntry[];
  unknownOrphans: ReconcileOrphanEntry[];
  errors: ReconcileErrorEntry[];
  /** Phase 3 W3.11 — ref-registry entries with refcount > 0 that no SO claims. */
  danglingRefs: ReconcileDanglingRefEntry[];
  /** Phase 3 W3.11 — zero-ref recording groups deleted this sweep. */
  graceDeletions: ReconcileGraceDeletionEntry[];
}

export interface SloReconciler {
  start(): void;
  stop(): Promise<void>;
  /** Run one sweep and return the diff. Safe to call from tests / admin endpoint. */
  reconcileOnce(opts?: { datasourceIds?: string[] }): Promise<ReconcileResult>;
}

export interface SloReconcilerDeps {
  store: ISloStore;
  ruler: RulerClient;
  healthChecker: RuleHealthChecker;
  datasourceService: InMemoryDatasourceService;
  logger: Logger;
  metrics: ReconcilerMetrics;
  /**
   * Build the OS client used to talk to the ruler for a given datasource.
   * The reconciler runs on a timer without a request context, so it cannot
   * use the usual per-request `asCurrentUser` client — the plugin wires an
   * internal (`asInternalUser`) client in here at `start()`.
   */
  buildClient: (ds: Datasource) => AlertingOSClient;
  /**
   * workspaceId ⇄ datasourceId mapping. Today the datasourceId doubles as
   * the tenant discriminator (matches `buildDeployContext` in
   * `server/routes/slo/index.ts`); Phase 3+ replaces this with real
   * workspace scoping.
   */
  workspaceIdForDatasource?: (datasourceId: string) => string;
  /**
   * Phase 3 W3.11 — optional ref-registry. When wired, the reconciler emits
   * dangling-ref metrics and runs the zero-ref grace-period sweep.
   */
  refStore?: SloRuleRefStore;
  /**
   * Phase 3 W3.11 — grace period before a zero-ref recording group is
   * deleted. Defaults to 24 hours (`observability.slo.recordingGraceMs`).
   */
  recordingGraceMs?: number;
  /**
   * Phase 4 W4.2 — optional tombstone reader. Gated on presence, just like
   * `refStore`: when absent, every orphan's `tombstoned` field is left
   * `undefined`. The detector doesn't read this — the reconciler enriches
   * adoptable + unknown orphans post-diff.
   */
  tombstoneStore?: SloTombstoneReaderLite;
  /**
   * Phase 4 W4.2 — optional TTL override for tests. Defaults to 30 days
   * (matching `SLO_TOMBSTONE_TTL_MS` in `slo_tombstone_store.ts`).
   * Tombstones older than the TTL are treated as if they never existed
   * for adoption purposes — the orphan surfaces with `tombstoned: false`.
   */
  tombstoneTtlMs?: number;
  /**
   * Session E (F3) — optional observation store. When wired, the reconciler
   * upserts `firstSeenAt` / `lastSeenAt` for every legacy orphan it
   * surfaces this sweep, and deletes observations whose group has since
   * vanished from the ruler. Absent: orphans surface without timestamps
   * (UI renders "Unknown" in the Age column).
   */
  legacyOrphanObservationStore?: SloLegacyOrphanObservationStoreLite;
  /**
   * Session E (F4) — optional audit store for the retention sweep. When
   * wired, the reconciler deletes audit records older than
   * `legacyOrphanAuditRetentionMs` once per sweep. Absent: no retention —
   * audit records accumulate until some external process cleans them up.
   */
  legacyPurgeAuditStore?: SloLegacyPurgeAuditRetentionLite;
  /**
   * Session E (F4) — retention window for audit records. Defaults to 30d.
   * Records with `requestedAt + retentionMs <= now` are deleted.
   */
  legacyOrphanAuditRetentionMs?: number;
  /** Injected for deterministic tests. */
  now?: () => Date;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RECORDING_GRACE_MS = 24 * 60 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_LEGACY_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Factory. Keeps `setInterval` / in-flight state encapsulated so consumers only
 * see the `SloReconciler` contract.
 */
export function createSloReconciler(deps: SloReconcilerDeps): SloReconciler {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? (() => new Date());
  const recordingGraceMs = deps.recordingGraceMs ?? DEFAULT_RECORDING_GRACE_MS;
  const tombstoneTtlMs = deps.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
  const legacyOrphanAuditRetentionMs =
    deps.legacyOrphanAuditRetentionMs ?? DEFAULT_LEGACY_AUDIT_RETENTION_MS;
  const workspaceIdFor = deps.workspaceIdForDatasource ?? ((datasourceId: string) => datasourceId);

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<ReconcileResult> | undefined;

  async function reconcileOnce(opts?: { datasourceIds?: string[] }): Promise<ReconcileResult> {
    const startDate = now();
    const startedAt = startDate.toISOString();
    const startMs = startDate.getTime();

    const all = await deps.store.list();

    // Group SLOs by datasourceId. The optional caller-supplied filter applies
    // *before* the per-datasource loop so the admin endpoint can sweep a
    // single datasource without touching the others.
    const filter =
      opts?.datasourceIds && opts.datasourceIds.length > 0
        ? new Set(opts.datasourceIds)
        : undefined;

    const byDatasource = new Map<string, SloDocument[]>();
    for (const doc of all) {
      const dsId = doc.spec.datasourceId;
      if (filter && !filter.has(dsId)) continue;
      const bucket = byDatasource.get(dsId);
      if (bucket) bucket.push(doc);
      else byDatasource.set(dsId, [doc]);
    }

    // If the caller filtered to datasources that have no SLOs (e.g. the
    // "sweep this datasource so we surface its orphans" path), we still want
    // the sweep to visit them — add every filtered datasource to the map
    // with an empty SLO list so the loop below sees it.
    if (filter) {
      for (const id of filter) {
        if (!byDatasource.has(id)) byDatasource.set(id, []);
      }
    } else {
      // No filter — sweep every enabled Prometheus datasource, not just those
      // with live SOs. Without this, a datasource whose SOs were all lost
      // out-of-band would never surface its orphan rule groups via the
      // sweep-all path (`GET /_orphans` with no query). We tolerate a
      // datasource-service failure by leaving the map as-is; the per-slice
      // error handling below still reports errors for datasources we *do*
      // know about.
      try {
        const registered = await deps.datasourceService.list();
        for (const ds of registered) {
          if (ds.enabled === false) continue;
          if (!ds.directQueryName) continue;
          if (!byDatasource.has(ds.id)) byDatasource.set(ds.id, []);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn(
          `SloReconciler: datasource enumeration failed during sweep-all — ${message}`
        );
      }
    }

    const missingBySlo: ReconcileMissingEntry[] = [];
    const orphans: ReconcileOrphanEntry[] = [];
    const adoptableOrphans: ReconcileOrphanEntry[] = [];
    const unknownOrphans: ReconcileOrphanEntry[] = [];
    const errors: ReconcileErrorEntry[] = [];
    const sweptDatasources: string[] = [];
    const danglingRefs: ReconcileDanglingRefEntry[] = [];
    const graceDeletions: ReconcileGraceDeletionEntry[] = [];

    for (const [datasourceId, docs] of byDatasource.entries()) {
      const workspaceId = workspaceIdFor(datasourceId);
      const namespace = sloRulerNamespaceFor(workspaceId);

      let datasource: Datasource | null;
      try {
        datasource = await deps.datasourceService.get(datasourceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ datasourceId, namespace, message });
        continue;
      }
      if (!datasource) {
        errors.push({
          datasourceId,
          namespace,
          message: `Datasource "${datasourceId}" is not registered`,
        });
        continue;
      }
      if (!datasource.directQueryName) {
        errors.push({
          datasourceId,
          namespace,
          message: `Datasource "${datasource.name}" is not a DirectQuery Prometheus connection`,
        });
        continue;
      }

      const client = deps.buildClient(datasource);

      let actualGroups;
      try {
        actualGroups = await deps.ruler.listRuleGroups(client, datasource, namespace);
      } catch (err) {
        const message =
          err instanceof SloRulerError
            ? `${err.code} (HTTP ${err.httpStatus}): ${err.rawBody}`
            : err instanceof Error
            ? err.message
            : String(err);
        errors.push({ datasourceId, namespace, message });
        continue;
      }

      sweptDatasources.push(datasourceId);

      // Build `expectedGroupsBySlo` from every SLO targeting this datasource.
      // Non-prometheus / un-provisioned SLOs return `[]` and never contribute
      // to the diff — keeping them in the map would confuse orphan detection.
      const expectedGroupsBySlo: Record<string, string[]> = {};
      for (const doc of docs) {
        const expected = deriveExpectedGroups(doc);
        if (expected.length > 0) expectedGroupsBySlo[doc.id] = expected;
      }

      const actualGroupNames = actualGroups.map((g) => g.groupName);

      // Phase 4 W4.2 — pass the full group objects so the detector can read
      // `osd_slo_provenance` annotations and split orphans into
      // adoptable / unknown buckets.
      const diff = detectOrphanDiff({
        expectedGroupsBySlo,
        actualGroupNames,
        actualGroups,
        datasourceId,
        namespace,
      });

      for (const entry of diff.missingBySlo) {
        missingBySlo.push({
          sloId: entry.sloId,
          datasourceId: entry.datasourceId,
          namespace: entry.namespace,
          missingGroups: entry.missingGroups,
        });
        // W2.3 hook — invalidate the cache so the next UI probe returns
        // `rules_missing` immediately instead of waiting for the 30s TTL.
        deps.healthChecker.invalidate(workspaceId, datasourceId, entry.sloId);
      }

      // Phase 4 W4.2 — enrich each adoptable/unknown orphan that has a
      // resolved `sourceSloId` with tombstone presence. Runs only when a
      // tombstone store is wired; failures are logged at warn and treated
      // as "no tombstone" so a tombstone-store outage doesn't block the
      // orphan sweep.
      if (deps.tombstoneStore) {
        const enrichable = [...diff.adoptableOrphans, ...diff.unknownOrphans];
        const nowMs = now().getTime();
        for (const entry of enrichable) {
          if (!entry.sourceSloId) continue;
          try {
            const tombstone = await deps.tombstoneStore.get(entry.sourceSloId);
            if (!tombstone) continue;
            const createdAtMs = Date.parse(tombstone.createdAt);
            const isExpired =
              !Number.isFinite(createdAtMs) || createdAtMs + tombstoneTtlMs <= nowMs;
            if (isExpired) {
              entry.tombstoned = false;
            } else {
              entry.tombstoned = true;
              entry.tombstoneCreatedAt = tombstone.createdAt;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger.warn(
              `SloReconciler: tombstone lookup failed for slo=${entry.sourceSloId} — ${message}`
            );
          }
        }
      }

      // Session E (F3) — legacy-orphan observation tracking. Runs inside the
      // per-datasource loop so observations stay scoped to the datasource
      // whose groups we just read. Two-phase:
      //   1. Upsert an observation SO for every orphan carrying the legacy
      //      diagnostic. Mutate the entry with firstSeenAt/lastSeenAt so the
      //      response carries them (same reference appears in both
      //      `diff.orphans` and `diff.unknownOrphans`, so mutating here
      //      propagates downstream without re-plumbing).
      //   2. Cross-check against observations already on disk; delete ones
      //      whose group is no longer present in the sweep's legacy set.
      //      Covers admin purges (Session C) and out-of-band deletes.
      //
      // Failures at any step log at warn; the sweep continues with a
      // best-effort result (orphans without `firstSeenAt` render as
      // "Unknown" in the UI).
      if (deps.legacyOrphanObservationStore) {
        const obsStore = deps.legacyOrphanObservationStore;
        const legacyOrphansThisSlice: OrphanEntry[] = [];
        for (const entry of diff.orphans) {
          if (entry.diagnostic === LEGACY_ORPHAN_DIAGNOSTIC) {
            legacyOrphansThisSlice.push(entry);
          }
        }
        const currentLegacyNames = new Set<string>(legacyOrphansThisSlice.map((e) => e.groupName));

        for (const entry of legacyOrphansThisSlice) {
          try {
            const { doc } = await obsStore.observe({
              workspaceId,
              datasourceId,
              namespace,
              groupName: entry.groupName,
              now,
            });
            entry.firstSeenAt = doc.attributes.firstSeenAt;
            entry.lastSeenAt = doc.attributes.lastSeenAt;
            deps.metrics.incLegacyObservationsWritten();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger.warn(
              `SloReconciler: legacy-orphan observation write failed ds=${datasourceId} group=${entry.groupName} — ${message}`
            );
          }
        }

        // Phase 2: delete observations that no longer correspond to a live
        // legacy orphan. List-then-diff keeps the sweep simple; N is bounded
        // by the number of legacy groups a datasource has ever had.
        try {
          const existing = await obsStore.listForDatasource(workspaceId, datasourceId);
          for (const obs of existing) {
            if (currentLegacyNames.has(obs.attributes.groupName)) continue;
            try {
              const deleted = await obsStore.remove(
                workspaceId,
                datasourceId,
                obs.attributes.groupName
              );
              if (deleted) deps.metrics.incLegacyObservationsDeleted();
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              deps.logger.warn(
                `SloReconciler: legacy-orphan observation delete failed ds=${datasourceId} group=${obs.attributes.groupName} — ${message}`
              );
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.warn(
            `SloReconciler: legacy-orphan observation list failed ds=${datasourceId} — ${message}`
          );
        }
      }

      for (const entry of diff.orphans) {
        orphans.push(entry);
      }
      for (const entry of diff.adoptableOrphans) {
        adoptableOrphans.push(entry);
      }
      for (const entry of diff.unknownOrphans) {
        unknownOrphans.push(entry);
      }

      // Phase 3 W3.11 — ref-registry sweep. Runs only when a refStore is
      // wired. Compares the registry's live fingerprints-in-use against what
      // the SO set claims; fingerprints no SO references are "dangling".
      // Zero-ref entries whose grace period has elapsed are deleted (both
      // the ref SO and the recording group on the ruler).
      if (deps.refStore) {
        const claimedFingerprints = new Set<string>();
        for (const doc of docs) {
          const prov = doc.status.provisioning;
          if (prov.backend !== 'prometheus') continue;
          if (!prov.recordingFingerprints) continue;
          for (const fp of Object.values(prov.recordingFingerprints)) {
            claimedFingerprints.add(fp);
          }
        }
        let registryEntries;
        try {
          registryEntries = await deps.refStore.listByDatasource(workspaceId, datasourceId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ datasourceId, namespace, message });
          registryEntries = undefined;
        }
        if (registryEntries) {
          const cutoffMs = now().getTime() - recordingGraceMs;
          for (const entry of registryEntries) {
            const attrs = entry.attributes;
            if (attrs.refcount > 0 && !claimedFingerprints.has(attrs.fingerprint)) {
              danglingRefs.push({
                workspaceId,
                datasourceId,
                fingerprint: attrs.fingerprint,
                refcount: attrs.refcount,
              });
            }
            if (attrs.refcount === 0 && attrs.zeroSinceAt) {
              const zeroSinceMs = Date.parse(attrs.zeroSinceAt);
              if (Number.isFinite(zeroSinceMs) && zeroSinceMs <= cutoffMs) {
                const groupName = attrs.groupName || dedupRecordingGroupName(attrs.fingerprint);
                // Delete the recording group first, then the ref SO. 404 on
                // the ruler is swallowed by the client; any other failure
                // leaves the ref SO in place so the next sweep retries.
                try {
                  await deps.ruler.deleteRuleGroup(client, datasource, namespace, groupName);
                  await deps.refStore.remove(workspaceId, datasourceId, attrs.fingerprint);
                  graceDeletions.push({
                    workspaceId,
                    datasourceId,
                    fingerprint: attrs.fingerprint,
                    namespace,
                    groupName,
                  });
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  errors.push({ datasourceId, namespace, message });
                }
              }
            }
          }
        }
      }
    }

    // Session E (F4) — audit retention sweep. Runs once per reconciler
    // sweep, across all datasources (the audit store is not per-datasource;
    // one delete-before-cutoff call expires all matching records in one
    // pass). Best-effort: failures log at warn and don't inflate the error
    // counter.
    if (deps.legacyPurgeAuditStore) {
      const cutoffMs = now().getTime() - legacyOrphanAuditRetentionMs;
      const cutoffIso = new Date(cutoffMs).toISOString();
      try {
        const deletedCount = await deps.legacyPurgeAuditStore.deleteBefore(cutoffIso);
        if (deletedCount > 0) {
          deps.metrics.incLegacyAuditRecordsExpired(deletedCount);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn(`SloReconciler: legacy-audit retention sweep failed — ${message}`);
      }
    }

    const finishedDate = now();
    const finishedAt = finishedDate.toISOString();
    const durationMs = Math.max(0, finishedDate.getTime() - startMs);

    deps.metrics.incSweeps();
    deps.metrics.incMissingRuleGroups(missingBySlo.length);
    deps.metrics.incOrphans(orphans.length);
    deps.metrics.incErrors(errors.length);
    deps.metrics.incDanglingRefs(danglingRefs.length);
    deps.metrics.incGraceDeletions(graceDeletions.length);
    deps.metrics.incAdoptableOrphans(adoptableOrphans.length);
    deps.metrics.incUnknownOrphans(unknownOrphans.length);

    deps.logger.info(
      `SloReconciler: swept ${sweptDatasources.length} datasources, missing=${missingBySlo.length} orphans=${orphans.length} (adoptable=${adoptableOrphans.length} unknown=${unknownOrphans.length}) danglingRefs=${danglingRefs.length} graceDeletions=${graceDeletions.length} errors=${errors.length} in ${durationMs}ms`
    );

    return {
      startedAt,
      finishedAt,
      durationMs,
      datasourceIds: sweptDatasources,
      missingBySlo,
      orphans,
      adoptableOrphans,
      unknownOrphans,
      errors,
      danglingRefs,
      graceDeletions,
    };
  }

  async function runGuarded(): Promise<ReconcileResult> {
    const promise = reconcileOnce();
    inFlight = promise;
    try {
      return await promise;
    } finally {
      // Clear the in-flight marker only if this sweep is still the current
      // one — otherwise a late-finishing sweep would clobber a concurrent
      // admin-triggered `reconcileOnce` call's own tracking.
      if (inFlight === promise) inFlight = undefined;
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        // Re-entrant guard: if the previous sweep hasn't finished, skip this
        // tick. Keeps a slow ruler from queueing up overlapping sweeps.
        if (inFlight) {
          deps.logger.debug('SloReconciler: previous sweep still in flight, skipping this tick');
          return;
        }
        runGuarded().catch((err: unknown) => {
          // Swallow scheduled-sweep errors at WARN so a transient failure
          // doesn't kill the interval. `reconcileOnce` is already partial-
          // error-tolerant per-datasource, so the only way to land here is
          // a catastrophic pre-loop failure (e.g. store.list() throwing).
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.warn(`SloReconciler: scheduled sweep failed — ${message}`);
        });
      }, intervalMs);
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      // Await any in-flight sweep so plugin teardown / tests don't race the
      // final log write. We don't care about its result here — callers that
      // need it used `reconcileOnce` directly.
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged upstream.
        }
      }
    },

    reconcileOnce,
  };
}
