/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F3) — saved-object type for the legacy-orphan observation
 * registry.
 *
 * One SO per distinct (workspaceId, datasourceId, groupName) tuple. The SO
 * records two timestamps:
 *   - `firstSeenAt` — ISO time the reconciler first classified this group as
 *     a legacy orphan. Never changes once set; the Age column on the
 *     Legacy-orphans tab renders this relative to now.
 *   - `lastSeenAt`  — ISO time the reconciler most recently observed the
 *     group on the ruler. Updated every sweep. Lets future ops tooling
 *     distinguish "persisted for days, admin just hasn't purged yet" from
 *     "flapped in and out".
 *
 * The reconciler deletes the SO when a sweep finds the corresponding group
 * no longer present on the ruler — that covers both admin purges (Session C)
 * and out-of-band deletes (operator edited Cortex directly). The purger does
 * NOT write observation deletes; the sweep-based rule is the single source
 * of truth, which keeps the purger from having to know about this registry.
 *
 * Namespace is not part of the SO id because legacy namespace is always
 * `slo-generated-<datasourceId>` (enforced by the purger's invariant 1b) and
 * derivable from `datasourceId`. Persisting it as an attribute is defensive
 * — filters can still match on namespace without parsing the id.
 */

import type { SavedObjectsType } from '../../../../src/core/server';

export const SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE = 'slo-legacy-orphan-observation';

/**
 * Attribute shape of a `slo-legacy-orphan-observation` saved object.
 *
 * `schemaVersion` is always 1 today; carried explicitly so a future version
 * can add fields without retrofitting a migration into existing data.
 */
export interface SloLegacyOrphanObservationAttributes {
  workspaceId: string;
  datasourceId: string;
  namespace: string;
  groupName: string;
  firstSeenAt: string;
  lastSeenAt: string;
  schemaVersion: 1;
}

/**
 * Build the canonical SO id for a (workspace, datasource, groupName) tuple.
 *
 * Separator `:` is not legal inside workspace/datasource (both are OSD SO
 * ids, so kebab/alphanumeric) or inside the legacy group name (matches
 * `^slo:[a-z0-9_]+_[0-9a-f]{8}$`). The group name contains one `:` — the
 * literal `slo:` prefix — which is fine; the id is split by consumers by
 * prefix match, not by separator count.
 */
export function sloLegacyOrphanObservationId(
  workspaceId: string,
  datasourceId: string,
  groupName: string
): string {
  return `legacy-orphan-obs:${workspaceId}:${datasourceId}:${groupName}`;
}

export const sloLegacyOrphanObservationType: SavedObjectsType = {
  name: SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
  hidden: false,
  namespaceType: 'single',
  mappings: {
    properties: {
      workspaceId: { type: 'keyword' },
      datasourceId: { type: 'keyword' },
      namespace: { type: 'keyword' },
      groupName: { type: 'keyword' },
      firstSeenAt: { type: 'date' },
      lastSeenAt: { type: 'date' },
      schemaVersion: { type: 'integer' },
    },
  },
  management: {
    importableAndExportable: false,
  },
};
