/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F4) — saved-object type for the legacy-orphan purge audit
 * trail.
 *
 * One SO per group per purge outcome. A purge request that nominates N
 * groups produces up to N audit records — each tagged with its own
 * outcome (`purged`, `skipped_validation`, or `failed`). The records
 * share `requestedAt` / `requestedBy` so operators can still group a
 * single "which groups did this purge touch?" view off the audit query.
 *
 * Id format embeds `requestedAt` + `datasourceId` + `groupName`:
 *   `legacy-orphan-purge-audit:<ISO>:<datasourceId>:<groupName>`
 *
 * The separator `:` is not legal inside datasourceId or groupName, and
 * `requestedAt` is an ISO-8601 string whose `:` chars are part of the
 * timestamp format — prefix-matching tolerates them fine. Using this
 * deterministic id avoids taking a uuid dependency and lets admins
 * recognize the id at a glance.
 *
 * Retention: the reconciler's grace sweep deletes records older than
 * `observability.slo.legacyOrphanAuditRetentionMs` (default 30d).
 */

import type { SavedObjectsType } from '../../../../src/core/server';

export const SLO_LEGACY_PURGE_AUDIT_SO_TYPE = 'slo-legacy-purge-audit';

export type SloLegacyPurgeAuditOutcome = 'purged' | 'skipped_validation' | 'failed';

/**
 * Attribute shape of a `slo-legacy-purge-audit` saved object. One SO per
 * group-outcome; optional fields depend on the outcome:
 *   - `purged`             — `reason`/`errorCode`/`errorHttpStatus`/`claimantSloId` are
 *     left undefined.
 *   - `skipped_validation` — `reason` is the skip reason string (matches the
 *     set in `LegacyPurgeSkipReason`); `claimantSloId` populated when reason
 *     is `claimed_by_so`.
 *   - `failed`             — `errorCode`, `errorHttpStatus`, and `reason`
 *     (human message) populated.
 */
export interface SloLegacyPurgeAuditAttributes {
  workspaceId: string;
  datasourceId: string;
  namespace: string;
  groupName: string;
  outcome: SloLegacyPurgeAuditOutcome;
  reason?: string;
  errorCode?: string;
  errorHttpStatus?: number;
  claimantSloId?: string;
  /** Username from the request context; may be absent in offline / internal calls. */
  requestedBy?: string;
  /** ISO timestamp — stable for every record emitted from a single purge call. */
  requestedAt: string;
  schemaVersion: 1;
}

export function sloLegacyPurgeAuditId(
  requestedAt: string,
  datasourceId: string,
  groupName: string
): string {
  return `${SLO_LEGACY_PURGE_AUDIT_SO_TYPE}:${requestedAt}:${datasourceId}:${groupName}`;
}

export const sloLegacyPurgeAuditType: SavedObjectsType = {
  name: SLO_LEGACY_PURGE_AUDIT_SO_TYPE,
  hidden: false,
  namespaceType: 'single',
  mappings: {
    properties: {
      workspaceId: { type: 'keyword' },
      datasourceId: { type: 'keyword' },
      namespace: { type: 'keyword' },
      groupName: { type: 'keyword' },
      outcome: { type: 'keyword' },
      reason: { type: 'text' },
      errorCode: { type: 'keyword' },
      errorHttpStatus: { type: 'integer' },
      claimantSloId: { type: 'keyword' },
      requestedBy: { type: 'keyword' },
      requestedAt: { type: 'date' },
      schemaVersion: { type: 'integer' },
    },
  },
  management: {
    importableAndExportable: false,
  },
};
