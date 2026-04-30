/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ReconcilerMetrics — dumb counter bank for the Phase 2 SLO reconciler.
 *
 * The reconciler sweeps rule groups on the Prometheus-compatible ruler (Cortex)
 * against the SLO saved-object inventory and needs a lightweight, in-process
 * way to expose what it found. These counters are the ONLY observability
 * surface Phase 2 ships — no OSD telemetry, no external metrics sink. UI /
 * admin-dump tools poll `snapshot()` out of the reconciler instance.
 *
 * Design notes:
 *   - Counters are monotonic within a process lifetime unless `reset()` is
 *     called. The plan specifies raw counts rather than per-sweep deltas;
 *     callers who want deltas can snapshot-diff on their own schedule.
 *   - This module is intentionally schema-dumb. The W2.1 reconciler is
 *     responsible for how it slices errors vs. missing rule groups (e.g.,
 *     incrementing `errors` per datasource that had a ruler probe failure and
 *     `missingRuleGroups` per actual diff entry — sourced from the distinct
 *     `rulerErrorCode` field on `RuleHealthReport`). This file just tallies.
 *   - Phase 3 extends this module to carry `dangling_refs` and
 *     `grace_deletions`; Phase 4 (W4.2) adds `adoptable_orphans` and
 *     `unknown_orphans`. Adding them later is a pure extension — no existing
 *     counter semantics change. `orphans` continues to track the total
 *     orphan count (= adoptable + unknown) so existing alerts keep firing;
 *     the two new counters let operators graph the adoption-vs-unknown
 *     split separately.
 */

import type { Logger } from '../../../common/types/alerting/types';

/** Immutable snapshot of the counters surfaced by the reconciler. */
export interface ReconcilerMetricsSnapshot {
  sweeps: number;
  orphans: number;
  missingRuleGroups: number;
  errors: number;
  /** Phase 3 W3.11 — ref SOs whose refcount > 0 but no live SLO claims them. */
  danglingRefs: number;
  /**
   * Phase 3 W3.11 — recording groups + ref SOs deleted because the refcount
   * hit zero longer than `observability.slo.recordingGraceMs` ago.
   */
  graceDeletions: number;
  /** Phase 4 W4.2 — orphans whose provenance integrity verified ('ok'). */
  adoptableOrphans: number;
  /**
   * Phase 4 W4.2 — orphans that couldn't be adopted (no provenance, drift,
   * unsupported schema, or recording-only without a paired alert).
   */
  unknownOrphans: number;
  /**
   * Session C — legacy-orphan purge counters. Not reconciler work per se
   * (the purge fires on explicit admin request, not on the sweep timer), but
   * the metrics bank is the existing home for orphan-related counts so the
   * admin dashboard can show purge-related totals alongside orphan counts.
   */
  legacyPurgeRequested: number;
  legacyPurgeSucceeded: number;
  legacyPurgeSkippedValidation: number;
  legacyPurgeFailed: number;
  /**
   * Session E (F3) — legacy-orphan observation SOs written this process
   * lifetime (`observe` calls that succeeded, including updates).
   */
  legacyObservationsWritten: number;
  /**
   * Session E (F3) — legacy-orphan observation SOs deleted because the
   * corresponding group disappeared from the ruler between sweeps.
   */
  legacyObservationsDeleted: number;
  /**
   * Session E (F4) — legacy-purge audit SOs expired by the reconciler's
   * retention sweep (`requestedAt + retentionMs <= now`).
   */
  legacyAuditRecordsExpired: number;
}

/**
 * Counter bank. Create one per server plugin instance via
 * `createReconcilerMetrics(logger)` and inject into the reconciler and any
 * admin endpoints that want to surface the current totals.
 */
export interface ReconcilerMetrics {
  incSweeps(n?: number): void;
  incOrphans(n?: number): void;
  incMissingRuleGroups(n?: number): void;
  incErrors(n?: number): void;
  /** Phase 3 W3.11 — ref-registry SOs with refcount>0 but no SLO claims. */
  incDanglingRefs(n?: number): void;
  /** Phase 3 W3.11 — zero-ref recording groups swept past the grace period. */
  incGraceDeletions(n?: number): void;
  /** Phase 4 W4.2 — alert-group orphans whose provenance integrity verified. */
  incAdoptableOrphans(n?: number): void;
  /** Phase 4 W4.2 — orphans the reconciler refused to classify as adoptable. */
  incUnknownOrphans(n?: number): void;
  /** Session C — one increment per purge request, counted by candidate count. */
  incLegacyPurgeRequested(n?: number): void;
  /** Session C — groups actually deleted (includes 404-already-gone as success). */
  incLegacyPurgeSucceeded(n?: number): void;
  /** Session C — candidates refused by server-side validation (name/ns/claim/presence). */
  incLegacyPurgeSkippedValidation(n?: number): void;
  /** Session C — candidates whose ruler delete raised. */
  incLegacyPurgeFailed(n?: number): void;
  /** Session E (F3) — observation SOs upserted this sweep. */
  incLegacyObservationsWritten(n?: number): void;
  /** Session E (F3) — observation SOs deleted because the group vanished. */
  incLegacyObservationsDeleted(n?: number): void;
  /** Session E (F4) — audit SOs expired by the retention sweep. */
  incLegacyAuditRecordsExpired(n?: number): void;
  /**
   * Return a frozen copy of the current counters. Mutating the returned
   * object does not affect internal state; subsequent `snapshot()` calls
   * still reflect the live totals.
   */
  snapshot(): ReconcilerMetricsSnapshot;
  /**
   * Zero every counter. Tests rely on this; the production plugin lifecycle
   * may also call it during `stop()` so a restart doesn't leak counts from
   * the previous process (though in practice restarts replace the instance
   * entirely, so this is mostly a testing affordance).
   */
  reset(): void;
}

/** The set of counter names this module owns. Used for structured debug logs. */
type CounterName =
  | 'sweeps'
  | 'orphans'
  | 'missingRuleGroups'
  | 'errors'
  | 'danglingRefs'
  | 'graceDeletions'
  | 'adoptableOrphans'
  | 'unknownOrphans'
  | 'legacyPurgeRequested'
  | 'legacyPurgeSucceeded'
  | 'legacyPurgeSkippedValidation'
  | 'legacyPurgeFailed'
  | 'legacyObservationsWritten'
  | 'legacyObservationsDeleted'
  | 'legacyAuditRecordsExpired';

/**
 * Factory. Keeps the counter state in a closure so callers can't reach past
 * the public interface to mutate internals or read the raw map.
 */
export function createReconcilerMetrics(logger: Logger): ReconcilerMetrics {
  const counters: Record<CounterName, number> = {
    sweeps: 0,
    orphans: 0,
    missingRuleGroups: 0,
    errors: 0,
    danglingRefs: 0,
    graceDeletions: 0,
    adoptableOrphans: 0,
    unknownOrphans: 0,
    legacyPurgeRequested: 0,
    legacyPurgeSucceeded: 0,
    legacyPurgeSkippedValidation: 0,
    legacyPurgeFailed: 0,
    legacyObservationsWritten: 0,
    legacyObservationsDeleted: 0,
    legacyAuditRecordsExpired: 0,
  };

  /**
   * Shared increment path. Clamps negative `n` to 0 rather than throwing —
   * a negative delta would silently corrupt monotonic counters and make
   * snapshot diffs meaningless, so surfacing it at debug (not warn/error)
   * keeps it visible to the engineer who introduced the bug without
   * spamming production logs.
   */
  function bump(name: CounterName, n: number): void {
    let delta = n;
    if (delta < 0) {
      logger.debug(
        `ReconcilerMetrics: negative increment clamped to 0 for counter=${name} requested=${n}`
      );
      delta = 0;
    }
    counters[name] += delta;
    logger.debug(`ReconcilerMetrics: ${name} incremented to ${counters[name]}`);
  }

  return {
    incSweeps(n: number = 1): void {
      bump('sweeps', n);
    },
    incOrphans(n: number = 1): void {
      bump('orphans', n);
    },
    incMissingRuleGroups(n: number = 1): void {
      bump('missingRuleGroups', n);
    },
    incErrors(n: number = 1): void {
      bump('errors', n);
    },
    incDanglingRefs(n: number = 1): void {
      bump('danglingRefs', n);
    },
    incGraceDeletions(n: number = 1): void {
      bump('graceDeletions', n);
    },
    incAdoptableOrphans(n: number = 1): void {
      bump('adoptableOrphans', n);
    },
    incUnknownOrphans(n: number = 1): void {
      bump('unknownOrphans', n);
    },
    incLegacyPurgeRequested(n: number = 1): void {
      bump('legacyPurgeRequested', n);
    },
    incLegacyPurgeSucceeded(n: number = 1): void {
      bump('legacyPurgeSucceeded', n);
    },
    incLegacyPurgeSkippedValidation(n: number = 1): void {
      bump('legacyPurgeSkippedValidation', n);
    },
    incLegacyPurgeFailed(n: number = 1): void {
      bump('legacyPurgeFailed', n);
    },
    incLegacyObservationsWritten(n: number = 1): void {
      bump('legacyObservationsWritten', n);
    },
    incLegacyObservationsDeleted(n: number = 1): void {
      bump('legacyObservationsDeleted', n);
    },
    incLegacyAuditRecordsExpired(n: number = 1): void {
      bump('legacyAuditRecordsExpired', n);
    },
    snapshot(): ReconcilerMetricsSnapshot {
      // `Object.freeze` on a fresh object literal prevents the caller from
      // mutating the returned snapshot while leaving `counters` untouched.
      return Object.freeze({
        sweeps: counters.sweeps,
        orphans: counters.orphans,
        missingRuleGroups: counters.missingRuleGroups,
        errors: counters.errors,
        danglingRefs: counters.danglingRefs,
        graceDeletions: counters.graceDeletions,
        adoptableOrphans: counters.adoptableOrphans,
        unknownOrphans: counters.unknownOrphans,
        legacyPurgeRequested: counters.legacyPurgeRequested,
        legacyPurgeSucceeded: counters.legacyPurgeSucceeded,
        legacyPurgeSkippedValidation: counters.legacyPurgeSkippedValidation,
        legacyPurgeFailed: counters.legacyPurgeFailed,
        legacyObservationsWritten: counters.legacyObservationsWritten,
        legacyObservationsDeleted: counters.legacyObservationsDeleted,
        legacyAuditRecordsExpired: counters.legacyAuditRecordsExpired,
      });
    },
    reset(): void {
      counters.sweeps = 0;
      counters.orphans = 0;
      counters.missingRuleGroups = 0;
      counters.errors = 0;
      counters.danglingRefs = 0;
      counters.graceDeletions = 0;
      counters.adoptableOrphans = 0;
      counters.unknownOrphans = 0;
      counters.legacyPurgeRequested = 0;
      counters.legacyPurgeSucceeded = 0;
      counters.legacyPurgeSkippedValidation = 0;
      counters.legacyPurgeFailed = 0;
      counters.legacyObservationsWritten = 0;
      counters.legacyObservationsDeleted = 0;
      counters.legacyAuditRecordsExpired = 0;
    },
  };
}
