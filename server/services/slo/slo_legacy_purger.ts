/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session C — admin-only legacy-orphan purge.
 *
 * Pre-Phase-3 SLOs wrote a single monolithic rule group per SLO with the name
 * shape `slo:<slug>_<8-hex>` under namespace `slo-generated-<datasourceId>`.
 * The Phase 3 migration splits every live SLO into a dedup-shape
 * (recording-per-fingerprint + per-SLO alert group) and drops the old group
 * via `SloRedeployTask`. But rule groups whose owning SO was deleted
 * out-of-band before the migration ran — or whose owning SO never existed in
 * this workspace — sit on the ruler forever, surfaced by the reconciler in
 * the "unknowns" bucket with diagnostic
 *   "pre-Phase-3 rule layout; not eligible for adoption"
 * and no way for an admin to clean them up short of hand-rolling a Cortex
 * `DELETE`.
 *
 * This module is the server-side half of a purpose-built purge flow:
 *   1. Caller (the Legacy-orphans tab) sends a list of groups it intends to
 *      delete, keyed on `{ groupName, namespace }`.
 *   2. `purgeLegacyOrphans` re-validates every entry server-side:
 *        a. Name matches the legacy regex.
 *        b. Namespace is exactly `slo-generated-<datasourceId>`.
 *        c. No SLO saved-object in the store claims the group via
 *           legacy-name recomputation from
 *           `slugifySloObjective(spec.name, 'group')` +
 *           `ruleSuffix(workspaceId, sloId, 'group')`.
 *        d. The group is currently present on the ruler.
 *   3. Every entry that passes all four invariants is deleted via the
 *      404-tolerant `RulerClient.deleteRuleGroup`. Entries that fail any
 *      invariant land in `skipped_validation`; entries that raise during
 *      delete land in `failed`.
 *
 * The UI is NOT trusted. The client only nominates candidates; every delete
 * decision is made here.
 *
 * No new error taxonomy — `SloRulerError` codes from Phase 1 flow through to
 * the `failed` bucket verbatim.
 */

import type { AlertingOSClient, Datasource, Logger } from '../../../common/types/alerting/types';
import type { SloDocument } from '../../../common/slo/slo_types';
import { SloRulerError } from '../../../common/slo/slo_errors';
import {
  ruleSuffix,
  slugifySloObjective,
  SLO_RULER_NAMESPACE,
} from '../../../common/slo/slo_promql_generator';
import type { RulerClient } from './ruler_client';
import type { ReconcilerMetrics } from './reconciler_metrics';
import type { SloLegacyPurgeAuditAttributes } from '../../saved_objects/slo_legacy_purge_audit';

/** Shape the pre-Phase-3 monolithic group name must match. */
const LEGACY_GROUP_NAME_PATTERN = /^slo:[a-z0-9_]+_[0-9a-f]{8}$/;

/**
 * Build the expected namespace for a datasource. Mirrors
 * `sloRulerNamespaceFor(workspaceId)` when the caller still uses the
 * workspaceId-equals-datasourceId convention; we inline the format here to
 * keep the legacy purger self-contained (it runs even when the rest of the
 * service layer is not wired).
 */
export function legacyNamespaceFor(datasourceId: string): string {
  return `${SLO_RULER_NAMESPACE}-${datasourceId}`;
}

/**
 * Single entry the client nominates for purging. Identical to the
 * `{ groupName, namespace }` shape the reconciler's unknowns bucket surfaces,
 * which is what the Legacy-orphans tab reads.
 */
export interface LegacyPurgeCandidate {
  groupName: string;
  namespace: string;
}

/** Reason a candidate was refused by server-side validation. */
export type LegacyPurgeSkipReason =
  | 'name_pattern_mismatch'
  | 'namespace_mismatch'
  | 'claimed_by_so'
  | 'not_present_on_ruler';

export interface LegacyPurgeSkippedEntry {
  groupName: string;
  namespace: string;
  reason: LegacyPurgeSkipReason;
  /** When `claimed_by_so`, the SLO id that claims this group — for admin diagnostics. */
  claimantSloId?: string;
}

export interface LegacyPurgeFailureEntry {
  groupName: string;
  namespace: string;
  error: {
    code: SloRulerError['code'] | 'UNKNOWN';
    httpStatus: number;
    message: string;
  };
}

export interface LegacyPurgeResult {
  requested: number;
  purged: number;
  skipped_validation: LegacyPurgeSkippedEntry[];
  failed: LegacyPurgeFailureEntry[];
}

export interface LegacyPurgeInput {
  datasourceId: string;
  /**
   * Workspace identifier used to recompute legacy group names when cross-
   * checking SO claims. Today the workspaceId equals the datasourceId
   * (matches the service layer's convention in `buildDeployContext`). Kept
   * explicit so we don't re-invent the equivalence at a distance.
   */
  workspaceId: string;
  candidates: LegacyPurgeCandidate[];
}

/**
 * Structural SO-lookup surface the purger consumes. A function rather than
 * an interface because the purger only needs the one read path, and we want
 * the route adapter to hand over a closure over `SloService` without
 * having to satisfy the full `ISloStore` contract.
 */
export type ListSlosByDatasource = (datasourceId: string) => Promise<SloDocument[]>;

/**
 * Session E (F4) — minimal write-side contract the purger uses to emit
 * audit records. The concrete `SloLegacyPurgeAuditStore` structurally
 * satisfies this interface; kept as a local type so the purger stays
 * decoupled from the SO layer (offline tests don't need a real store).
 */
export interface SloLegacyPurgeAuditWriterLite {
  writeMany(records: SloLegacyPurgeAuditAttributes[]): Promise<void>;
}

export interface LegacyPurgeDeps {
  listSlos: ListSlosByDatasource;
  ruler: RulerClient;
  client: AlertingOSClient;
  datasource: Datasource;
  logger: Logger;
  metrics?: ReconcilerMetrics;
  /**
   * Session E (F4) — optional audit writer. When wired, every per-group
   * outcome (purged / skipped_validation / failed) emits one record. Write
   * failures are logged at warn and never block the purge response; the
   * client's outcome is always authoritative.
   */
  auditStore?: SloLegacyPurgeAuditWriterLite;
  /**
   * Session E (F4) — username for audit records. May be undefined when the
   * route layer can't extract one (e.g. internal calls); recorded as
   * missing on the resulting SOs.
   */
  requestedBy?: string;
  /** Injected clock for deterministic audit timestamps in tests. */
  now?: () => Date;
}

/**
 * Execute the purge. Pure, single-shot, non-streaming — the admin flow is
 * low-volume (21 groups on the seed fixture; anything larger would still be
 * single-digit round-trips on a fresh cluster).
 *
 * Every validated delete is logged at info with
 *   { datasourceId, namespace, groupName, outcome }
 * so admins can audit the purge after the fact.
 */
export async function purgeLegacyOrphans(
  input: LegacyPurgeInput,
  deps: LegacyPurgeDeps
): Promise<LegacyPurgeResult> {
  const { datasourceId, workspaceId, candidates } = input;
  const { listSlos, ruler, client, datasource, logger, metrics, auditStore, requestedBy } = deps;
  const now = deps.now ?? (() => new Date());

  metrics?.incLegacyPurgeRequested(candidates.length);

  const skipped: LegacyPurgeSkippedEntry[] = [];
  const failed: LegacyPurgeFailureEntry[] = [];
  const expectedNamespace = legacyNamespaceFor(datasourceId);

  // Session E (F4) — shared requestedAt for every audit record emitted by
  // this call. Recording one timestamp per call (instead of per-outcome)
  // lets admins correlate "all N groups this admin touched in one purge"
  // via a single query.
  const requestedAt = now().toISOString();
  const auditRecords: SloLegacyPurgeAuditAttributes[] = [];
  function recordAudit(
    attrs: Omit<
      SloLegacyPurgeAuditAttributes,
      'workspaceId' | 'datasourceId' | 'requestedAt' | 'requestedBy' | 'schemaVersion'
    >
  ) {
    auditRecords.push({
      workspaceId,
      datasourceId,
      requestedAt,
      requestedBy,
      schemaVersion: 1,
      ...attrs,
    });
  }

  // Invariant 1a + 1b: name pattern + namespace shape. Filter the caller's
  // list before any I/O — no reason to enumerate SOs or hit the ruler for a
  // request that's structurally wrong.
  const structurallyValid: LegacyPurgeCandidate[] = [];
  for (const c of candidates) {
    if (!LEGACY_GROUP_NAME_PATTERN.test(c.groupName)) {
      skipped.push({
        groupName: c.groupName,
        namespace: c.namespace,
        reason: 'name_pattern_mismatch',
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'skipped_validation',
        reason: 'name_pattern_mismatch',
      });
      continue;
    }
    if (c.namespace !== expectedNamespace) {
      skipped.push({
        groupName: c.groupName,
        namespace: c.namespace,
        reason: 'namespace_mismatch',
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'skipped_validation',
        reason: 'namespace_mismatch',
      });
      continue;
    }
    structurallyValid.push(c);
  }

  if (structurallyValid.length === 0) {
    metrics?.incLegacyPurgeSkippedValidation(skipped.length);
    await flushAudit(auditStore, auditRecords, logger);
    return {
      requested: candidates.length,
      purged: 0,
      skipped_validation: skipped,
      failed: [],
    };
  }

  // Invariant 1c: no owning SO. Read the SO store once (`datasourceId`-
  // filtered) and index the set of group names any live SO claims via
  // legacy-name recomputation from spec.name + sloId (the deterministic
  // shape the pre-migration SO wrote). We walk EVERY SO in the datasource,
  // not just provisioned ones, because a partially-migrated SO might not
  // yet carry a fully-populated provisioning block.
  let docs: SloDocument[];
  try {
    docs = await listSlos(datasourceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `SloLegacyPurger: SO store enumeration failed for datasource=${datasourceId} — ${message}. ` +
        `Refusing every candidate for safety.`
    );
    // Fail-closed: if we can't read the SO store we can't prove "no owning
    // SO", so every candidate gets flagged skipped with claimed_by_so (the
    // conservative choice — better to surface no-op than delete something
    // still claimed).
    for (const c of structurallyValid) {
      skipped.push({
        groupName: c.groupName,
        namespace: c.namespace,
        reason: 'claimed_by_so',
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'skipped_validation',
        reason: 'claimed_by_so',
      });
    }
    metrics?.incLegacyPurgeSkippedValidation(skipped.length);
    await flushAudit(auditStore, auditRecords, logger);
    return {
      requested: candidates.length,
      purged: 0,
      skipped_validation: skipped,
      failed: [],
    };
  }

  const claimedByName = new Map<string, string>();
  for (const doc of docs) {
    // Recompute the legacy monolithic name from spec + sloId — mirrors
    // `legacyMonolithicGroupName` in slo_redeploy_task.ts.
    const slug = slugifySloObjective(doc.spec.name, 'group');
    const suffix = ruleSuffix(workspaceId, doc.id, 'group');
    const recomputed = `slo:${slug}_${suffix}`;
    if (!claimedByName.has(recomputed)) {
      claimedByName.set(recomputed, doc.id);
    }
  }

  const unclaimed: LegacyPurgeCandidate[] = [];
  for (const c of structurallyValid) {
    const claimant = claimedByName.get(c.groupName);
    if (claimant) {
      skipped.push({
        groupName: c.groupName,
        namespace: c.namespace,
        reason: 'claimed_by_so',
        claimantSloId: claimant,
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'skipped_validation',
        reason: 'claimed_by_so',
        claimantSloId: claimant,
      });
      continue;
    }
    unclaimed.push(c);
  }

  // Invariant 1d: group is currently on the ruler. One `listRuleGroups` call
  // on the expected namespace — cheaper than N `getRuleGroup`s since the
  // DirectQuery proxy only allows namespace-level GET. If the group
  // disappeared between the client's list and this call, we don't delete —
  // we skip it as `not_present_on_ruler` so the admin sees the drift in the
  // response.
  let livingNames: Set<string>;
  try {
    const groups = await ruler.listRuleGroups(client, datasource, expectedNamespace);
    livingNames = new Set(groups.map((g) => g.groupName));
  } catch (err) {
    // Ruler unreachable / auth failure — the per-candidate fail path is the
    // right surface, since a retry might succeed for some but not others.
    // Mark every unclaimed candidate as failed with the upstream diagnostic.
    const failure = toFailureError(err);
    for (const c of unclaimed) {
      failed.push({
        groupName: c.groupName,
        namespace: c.namespace,
        error: failure,
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'failed',
        errorCode: failure.code,
        errorHttpStatus: failure.httpStatus,
        reason: failure.message,
      });
    }
    metrics?.incLegacyPurgeSkippedValidation(skipped.length);
    metrics?.incLegacyPurgeFailed(failed.length);
    await flushAudit(auditStore, auditRecords, logger);
    return {
      requested: candidates.length,
      purged: 0,
      skipped_validation: skipped,
      failed,
    };
  }

  const deletable: LegacyPurgeCandidate[] = [];
  for (const c of unclaimed) {
    if (!livingNames.has(c.groupName)) {
      skipped.push({
        groupName: c.groupName,
        namespace: c.namespace,
        reason: 'not_present_on_ruler',
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'skipped_validation',
        reason: 'not_present_on_ruler',
      });
      continue;
    }
    deletable.push(c);
  }

  let purged = 0;
  for (const c of deletable) {
    try {
      await ruler.deleteRuleGroup(client, datasource, c.namespace, c.groupName);
      purged += 1;
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'purged',
      });
      logger.info(
        `SloLegacyPurger: purged legacy group ds=${datasourceId} ns=${c.namespace} group=${c.groupName} outcome=purged`
      );
    } catch (err) {
      const failure = toFailureError(err);
      failed.push({
        groupName: c.groupName,
        namespace: c.namespace,
        error: failure,
      });
      recordAudit({
        namespace: c.namespace,
        groupName: c.groupName,
        outcome: 'failed',
        errorCode: failure.code,
        errorHttpStatus: failure.httpStatus,
        reason: failure.message,
      });
      logger.warn(
        `SloLegacyPurger: delete failed ds=${datasourceId} ns=${c.namespace} group=${c.groupName} ` +
          `code=${failure.code} httpStatus=${failure.httpStatus} — ${failure.message}`
      );
    }
  }

  metrics?.incLegacyPurgeSucceeded(purged);
  metrics?.incLegacyPurgeSkippedValidation(skipped.length);
  metrics?.incLegacyPurgeFailed(failed.length);

  await flushAudit(auditStore, auditRecords, logger);

  return {
    requested: candidates.length,
    purged,
    skipped_validation: skipped,
    failed,
  };
}

/**
 * Session E (F4) — best-effort audit write. A failure here (SO store down,
 * unexpected 5xx) must not block the purge response — the client already
 * received its authoritative outcome via the return value. We log at warn
 * so the operator still sees the drift.
 */
async function flushAudit(
  auditStore: SloLegacyPurgeAuditWriterLite | undefined,
  records: SloLegacyPurgeAuditAttributes[],
  logger: Logger
): Promise<void> {
  if (!auditStore || records.length === 0) return;
  try {
    await auditStore.writeMany(records);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `SloLegacyPurger: audit write failed (${records.length} records dropped) — ${message}`
    );
  }
}

function toFailureError(err: unknown): LegacyPurgeFailureEntry['error'] {
  if (err instanceof SloRulerError) {
    return {
      code: err.code,
      httpStatus: err.httpStatus,
      message: err.message,
    };
  }
  return {
    code: 'UNKNOWN',
    httpStatus: 0,
    message: err instanceof Error ? err.message : String(err),
  };
}
