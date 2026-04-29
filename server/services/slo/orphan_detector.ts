/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orphan / missing diff for a single (datasource, namespace) slice of the
 * Prometheus-compatible ruler.
 *
 * The reconciler feeds this pure function two inputs:
 *   - `expectedGroupsBySlo`: for each SLO saved object that claims rules in
 *     this namespace, the list of ruler group names derived from its SO
 *     (via `deriveExpectedGroups`).
 *   - `actualGroupNames`: the list of ruler group names the ruler actually
 *     reports for the namespace.
 *
 * From that it emits two views of the diff:
 *   - `missingBySlo`: per-SLO, which expected groups are absent. Each SLO
 *     evaluates the diff independently of every other SLO — if two SLOs share
 *     an expected group name (Phase 3 dedup) and the ruler has dropped it,
 *     both SLOs show it as missing.
 *   - `orphans`: ruler groups that no SLO in the input claims. In Phase 2 we
 *     do not yet have per-group provenance plumbed in, so we cannot tell the
 *     difference between an orphan this plugin created (adoptable) and one
 *     produced by some other tool (unknown). Per the plan, every orphan in
 *     this phase lands in `unknownOrphans`; `adoptableOrphans` is always the
 *     empty list. Phase 4 will reshuffle the split once provenance annotation
 *     reads are wired in.
 *
 * The detector is deliberately pure: it performs no I/O, takes no clock, and
 * knows nothing about ruler clients. The datasourceId + namespace it receives
 * are echoed back verbatim on every result entry so the reconciler can flat-
 * map diffs across many slices into a single `ReconcileResult` without having
 * to re-key by (datasource, namespace) upstream.
 */

export interface OrphanDiffInput {
  /** Expected ruler group names per SLO id, as returned by deriveExpectedGroups. */
  expectedGroupsBySlo: Record<string, string[]>;
  /** Ruler group names actually present in the namespace. */
  actualGroupNames: string[];
  /**
   * Namespace and datasourceId for the slice being diffed. The detector is
   * pure — it doesn't know about ruler clients — but it echoes these back in
   * the result entries so the reconciler can build a single flat ReconcileResult
   * without having to re-key by datasource.
   */
  datasourceId: string;
  namespace: string;
}

export interface MissingEntry {
  sloId: string;
  datasourceId: string;
  namespace: string;
  missingGroups: string[];
}

export interface OrphanEntry {
  datasourceId: string;
  namespace: string;
  groupName: string;
}

export interface OrphanDiffResult {
  missingBySlo: MissingEntry[];
  orphans: OrphanEntry[];
  /** Phase 2 stub: categorization. In this phase, every orphan is "unknown" (adoptable == empty) — real provenance check is Phase 4. */
  adoptableOrphans: OrphanEntry[];
  unknownOrphans: OrphanEntry[];
}

export function detectOrphanDiff(input: OrphanDiffInput): OrphanDiffResult {
  const { expectedGroupsBySlo, actualGroupNames, datasourceId, namespace } = input;

  // Defensive dedup: a well-behaved ruler response shouldn't contain dupes,
  // but a misconfigured proxy or a ruler bug could emit the same group name
  // twice. Collapse to a Set before membership checks so orphan computation
  // isn't thrown off by repeats.
  const actualSet = new Set<string>(actualGroupNames);

  // Union of every group any SLO claims. A group is "claimed" if it appears
  // in at least one SLO's expected list — shared names (Phase 3 dedup) count
  // once. Orphans are ruler groups not in this union.
  const claimedSet = new Set<string>();
  for (const groups of Object.values(expectedGroupsBySlo)) {
    for (const name of groups) {
      claimedSet.add(name);
    }
  }

  const missingBySlo: MissingEntry[] = [];
  for (const [sloId, expected] of Object.entries(expectedGroupsBySlo)) {
    const missingGroups: string[] = [];
    for (const groupName of expected) {
      if (!actualSet.has(groupName)) {
        missingGroups.push(groupName);
      }
    }
    if (missingGroups.length > 0) {
      missingBySlo.push({
        sloId,
        datasourceId,
        namespace,
        missingGroups,
      });
    }
  }

  const orphans: OrphanEntry[] = [];
  for (const groupName of actualSet) {
    if (!claimedSet.has(groupName)) {
      orphans.push({
        datasourceId,
        namespace,
        groupName,
      });
    }
  }

  // Phase 2: we don't yet read provenance annotations off the ruler, so we
  // can't distinguish plugin-created orphans (adoptable) from foreign ones
  // (unknown). Everything is reported as "unknown" and `adoptableOrphans`
  // stays empty until Phase 4 wires in the provenance read path.
  const adoptableOrphans: OrphanEntry[] = [];
  const unknownOrphans: OrphanEntry[] = orphans.slice();

  return {
    missingBySlo,
    orphans,
    adoptableOrphans,
    unknownOrphans,
  };
}
