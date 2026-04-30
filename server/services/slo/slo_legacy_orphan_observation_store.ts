/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F3) — SavedObject-backed registry for legacy-orphan observation
 * timestamps.
 *
 * The reconciler calls `observe(...)` on every sweep for every group it
 * classified as a legacy orphan. On first sight the store creates an SO with
 * `firstSeenAt = lastSeenAt = now()`; on subsequent sights it updates
 * `lastSeenAt` only. Read-modify-write cycles use optimistic concurrency
 * with a 3-retry budget identical to `SloRuleRefStore` — on exhaustion the
 * caller logs a warning and moves on; the next sweep catches up.
 *
 * The reconciler also calls `remove(...)` when a previously-observed group
 * disappears from the ruler (either admin purge or out-of-band delete). The
 * purger itself does not write observation deletes — sweep-based is the
 * single source of truth.
 *
 * Failures here are best-effort: a backing-store outage must not block the
 * reconciler from surfacing orphans to the client. Callers drop exceptions
 * at warn level.
 */

/* eslint-disable max-classes-per-file */

import type { SavedObject, SavedObjectsClientContract } from '../../../../../src/core/server';
import {
  SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
  SloLegacyOrphanObservationAttributes,
  sloLegacyOrphanObservationId,
} from '../../saved_objects/slo_legacy_orphan_observation';

const MAX_RETRIES = 3;

export class SloLegacyOrphanObservationConflictError extends Error {
  constructor(public readonly id: string) {
    super(`SloLegacyOrphanObservation optimistic-concurrency budget exhausted for ${id}`);
    this.name = 'SloLegacyOrphanObservationConflictError';
  }
}

export interface SloLegacyOrphanObservationDoc {
  id: string;
  attributes: SloLegacyOrphanObservationAttributes;
  version?: string;
}

export interface ObserveInput {
  workspaceId: string;
  datasourceId: string;
  namespace: string;
  groupName: string;
  now?: () => Date;
}

export interface ObserveResult {
  doc: SloLegacyOrphanObservationDoc;
  /** True when the SO was created on this call (first observation). */
  created: boolean;
}

function isNotFound(err: unknown): boolean {
  const e = err as { output?: { statusCode?: number }; statusCode?: number } | undefined;
  return e?.output?.statusCode === 404 || e?.statusCode === 404;
}

function isConflict(err: unknown): boolean {
  const e = err as { output?: { statusCode?: number }; statusCode?: number } | undefined;
  return e?.output?.statusCode === 409 || e?.statusCode === 409;
}

function toDoc(
  obj: SavedObject<SloLegacyOrphanObservationAttributes>
): SloLegacyOrphanObservationDoc {
  return { id: obj.id, attributes: obj.attributes, version: obj.version };
}

export class SloLegacyOrphanObservationStore {
  constructor(private readonly client: SavedObjectsClientContract) {}

  async get(
    workspaceId: string,
    datasourceId: string,
    groupName: string
  ): Promise<SloLegacyOrphanObservationDoc | null> {
    const id = sloLegacyOrphanObservationId(workspaceId, datasourceId, groupName);
    try {
      const obj = await this.client.get<SloLegacyOrphanObservationAttributes>(
        SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
        id
      );
      return toDoc(obj);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listForDatasource(
    workspaceId: string,
    datasourceId: string
  ): Promise<SloLegacyOrphanObservationDoc[]> {
    const results: SloLegacyOrphanObservationDoc[] = [];
    let page = 1;
    const perPage = 1000;
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const filter =
      `(${SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE}.attributes.workspaceId: "${esc(workspaceId)}"` +
      ` AND ${SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE}.attributes.datasourceId: "${esc(
        datasourceId
      )}")`;
    while (true) {
      const response = await this.client.find<SloLegacyOrphanObservationAttributes>({
        type: SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
        page,
        perPage,
        filter,
      });
      for (const obj of response.saved_objects) {
        results.push(toDoc(obj as SavedObject<SloLegacyOrphanObservationAttributes>));
      }
      if (response.saved_objects.length === 0 || results.length >= response.total) break;
      page++;
    }
    return results;
  }

  /**
   * Upsert the observation for a (workspace, datasource, groupName) tuple.
   * On first write: create with firstSeenAt = lastSeenAt = now. On existing:
   * update lastSeenAt only; firstSeenAt is immutable.
   *
   * 3-retry optimistic-concurrency budget; exhaustion throws
   * `SloLegacyOrphanObservationConflictError` so the caller can log and
   * skip this record for the current sweep.
   */
  async observe(input: ObserveInput): Promise<ObserveResult> {
    const now = input.now ?? (() => new Date());
    const id = sloLegacyOrphanObservationId(input.workspaceId, input.datasourceId, input.groupName);
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let existing: SavedObject<SloLegacyOrphanObservationAttributes> | null;
      try {
        existing = await this.client.get<SloLegacyOrphanObservationAttributes>(
          SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
          id
        );
      } catch (err) {
        if (isNotFound(err)) {
          existing = null;
        } else {
          throw err;
        }
      }

      if (existing === null) {
        const nowIso = now().toISOString();
        const attrs: SloLegacyOrphanObservationAttributes = {
          workspaceId: input.workspaceId,
          datasourceId: input.datasourceId,
          namespace: input.namespace,
          groupName: input.groupName,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          schemaVersion: 1,
        };
        try {
          const created = await this.client.create<SloLegacyOrphanObservationAttributes>(
            SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
            attrs,
            { id, overwrite: false }
          );
          return { doc: toDoc(created), created: true };
        } catch (err) {
          if (isConflict(err)) {
            lastErr = err;
            continue;
          }
          throw err;
        }
      }

      const prior = existing.attributes;
      const nextAttrs: SloLegacyOrphanObservationAttributes = {
        ...prior,
        // `namespace` could drift if a group was deleted and re-created under
        // a different legacy namespace, though the purger's invariant makes
        // that impossible in practice. Refresh it so the store is the single
        // source of truth for the current shape.
        namespace: input.namespace,
        lastSeenAt: now().toISOString(),
        schemaVersion: 1,
      };
      try {
        const updated = await this.client.update<SloLegacyOrphanObservationAttributes>(
          SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
          id,
          nextAttrs,
          { version: existing.version }
        );
        return {
          doc: {
            id,
            attributes: { ...prior, ...updated.attributes, ...nextAttrs },
            version: updated.version,
          },
          created: false,
        };
      } catch (err) {
        if (isConflict(err)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }

    const err = new SloLegacyOrphanObservationConflictError(id);
    if (lastErr instanceof Error) err.stack = lastErr.stack;
    throw err;
  }

  async remove(workspaceId: string, datasourceId: string, groupName: string): Promise<boolean> {
    const id = sloLegacyOrphanObservationId(workspaceId, datasourceId, groupName);
    try {
      await this.client.delete(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}
