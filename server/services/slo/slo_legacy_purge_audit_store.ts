/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F4) — SavedObject-backed store for the legacy-orphan purge
 * audit trail.
 *
 * Writes: the purger calls `writeMany` with N records (one per group
 * outcome) per purge request. The store batches the creates via
 * `bulkCreate` so a single purge that hits 21 groups (the seed fixture)
 * costs one round-trip instead of 21.
 *
 * Reads: `list({ datasourceId?, groupName?, since?, limit? })` filters
 * records via a KQL-style filter on `_find`. The endpoint layer decides
 * which filters to supply; the store just composes them into one query.
 * Pagination is capped at `MAX_LIMIT` (500) so an unbounded query doesn't
 * drag the SO index down; callers that need more records should narrow by
 * datasource/group first.
 *
 * Retention sweep: the reconciler calls `deleteBefore(cutoff)` with a
 * cutoff ISO timestamp. Everything older is removed. Returns the deleted
 * count so the reconciler can bump its metrics counter.
 */

import type { SavedObject, SavedObjectsClientContract } from '../../../../../src/core/server';
import {
  SLO_LEGACY_PURGE_AUDIT_SO_TYPE,
  SloLegacyPurgeAuditAttributes,
  sloLegacyPurgeAuditId,
} from '../../saved_objects/slo_legacy_purge_audit';

/** Hard cap on a single list call — matches the endpoint's truncation marker. */
export const MAX_LIMIT = 500;

export interface SloLegacyPurgeAuditDoc {
  id: string;
  attributes: SloLegacyPurgeAuditAttributes;
  version?: string;
}

export interface ListAuditFilters {
  workspaceId?: string;
  datasourceId?: string;
  groupName?: string;
  /** ISO timestamp — only records with `requestedAt >= since` are returned. */
  since?: string;
  limit?: number;
}

export interface ListAuditResult {
  records: SloLegacyPurgeAuditDoc[];
  truncated: boolean;
}

function isNotFound(err: unknown): boolean {
  const e = err as { output?: { statusCode?: number }; statusCode?: number } | undefined;
  return e?.output?.statusCode === 404 || e?.statusCode === 404;
}

function toDoc(obj: SavedObject<SloLegacyPurgeAuditAttributes>): SloLegacyPurgeAuditDoc {
  return { id: obj.id, attributes: obj.attributes, version: obj.version };
}

function kqlEscape(v: string): string {
  // Escape backslash first, then double-quote. The SO find API accepts
  // KQL-style filters; this matches what `slo_rule_ref_store.ts` does.
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class SloLegacyPurgeAuditStore {
  constructor(private readonly client: SavedObjectsClientContract) {}

  /**
   * Write N audit records in one call. Records use the client-supplied
   * `attributes` verbatim — the store does not synthesize any fields. The
   * caller owns `requestedAt` (identical for a single purge request) and
   * the id mapping via `sloLegacyPurgeAuditId`.
   *
   * Skips silently on an empty input — the purger sometimes knows upfront
   * it has nothing to audit (e.g. 0 candidates).
   */
  async writeMany(records: SloLegacyPurgeAuditAttributes[]): Promise<void> {
    if (records.length === 0) return;
    const objects = records.map((attrs) => ({
      type: SLO_LEGACY_PURGE_AUDIT_SO_TYPE,
      id: sloLegacyPurgeAuditId(attrs.requestedAt, attrs.datasourceId, attrs.groupName),
      attributes: attrs,
    }));
    await this.client.bulkCreate<SloLegacyPurgeAuditAttributes>(objects, { overwrite: true });
  }

  async list(filters: ListAuditFilters): Promise<ListAuditResult> {
    const requestedLimit = Math.max(1, filters.limit ?? 200);
    const effectiveLimit = Math.min(requestedLimit, MAX_LIMIT);

    const clauses: string[] = [];
    const type = SLO_LEGACY_PURGE_AUDIT_SO_TYPE;
    if (filters.workspaceId) {
      clauses.push(`${type}.attributes.workspaceId: "${kqlEscape(filters.workspaceId)}"`);
    }
    if (filters.datasourceId) {
      clauses.push(`${type}.attributes.datasourceId: "${kqlEscape(filters.datasourceId)}"`);
    }
    if (filters.groupName) {
      clauses.push(`${type}.attributes.groupName: "${kqlEscape(filters.groupName)}"`);
    }
    if (filters.since) {
      // OSD's KQL supports `>=` for range filters on date fields.
      clauses.push(`${type}.attributes.requestedAt >= "${kqlEscape(filters.since)}"`);
    }
    const filter = clauses.length > 0 ? clauses.join(' AND ') : undefined;

    // Request one extra record so we can detect truncation without a
    // separate total-count query.
    const response = await this.client.find<SloLegacyPurgeAuditAttributes>({
      type,
      filter,
      page: 1,
      perPage: effectiveLimit + 1,
      sortField: 'requestedAt',
      sortOrder: 'desc',
    });

    const allDocs = response.saved_objects.map((o) =>
      toDoc(o as SavedObject<SloLegacyPurgeAuditAttributes>)
    );
    const truncated = allDocs.length > effectiveLimit;
    const records = allDocs.slice(0, effectiveLimit);
    return { records, truncated };
  }

  /**
   * Retention sweep: delete every audit record older than `cutoff`.
   * Returns the count actually removed. Paginates through matches in
   * batches of 1000 to keep memory use bounded.
   */
  async deleteBefore(cutoff: string): Promise<number> {
    let deleted = 0;
    const type = SLO_LEGACY_PURGE_AUDIT_SO_TYPE;
    const perPage = 1000;
    while (true) {
      const response = await this.client.find<SloLegacyPurgeAuditAttributes>({
        type,
        filter: `${type}.attributes.requestedAt < "${kqlEscape(cutoff)}"`,
        page: 1,
        perPage,
        sortField: 'requestedAt',
        sortOrder: 'asc',
      });
      if (response.saved_objects.length === 0) break;
      for (const obj of response.saved_objects) {
        try {
          await this.client.delete(type, obj.id);
          deleted++;
        } catch (err) {
          if (isNotFound(err)) continue;
          throw err;
        }
      }
      // When we delete every match under `perPage`, next iteration's find
      // returns empty and the loop exits. When total > perPage we keep
      // iterating — page is always 1 because each sweep shrinks the
      // result set.
    }
    return deleted;
  }
}
