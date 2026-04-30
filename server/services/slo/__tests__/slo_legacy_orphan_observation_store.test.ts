/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SavedObjectsClientContract, SavedObject } from '../../../../../../src/core/server';
import {
  SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
  SloLegacyOrphanObservationAttributes,
  sloLegacyOrphanObservationId,
} from '../../../saved_objects/slo_legacy_orphan_observation';
import {
  SloLegacyOrphanObservationConflictError,
  SloLegacyOrphanObservationStore,
} from '../slo_legacy_orphan_observation_store';

class StatusError extends Error {
  public output: { statusCode: number };
  public statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = `StatusError(${status})`;
    this.statusCode = status;
    this.output = { statusCode: status };
  }
}

function notFoundError(type: string, id: string) {
  return new StatusError(404, `Saved object [${type}/${id}] not found`);
}

function conflictError(type: string, id: string) {
  return new StatusError(409, `Saved object [${type}/${id}] conflict`);
}

type Stored = SavedObject<SloLegacyOrphanObservationAttributes>;

interface FakeClientOpts {
  updateConflicts?: number;
  createConflicts?: number;
}

function makeFakeClient(opts: FakeClientOpts = {}) {
  const byId = new Map<string, Stored>();
  let versionCounter = 0;
  let remainingUpdateConflicts = opts.updateConflicts ?? 0;
  let remainingCreateConflicts = opts.createConflicts ?? 0;

  const client = ({
    async get<T>(type: string, id: string): Promise<SavedObject<T>> {
      const hit = byId.get(id);
      if (!hit) throw notFoundError(type, id);
      return ({ ...hit, attributes: { ...hit.attributes } } as unknown) as SavedObject<T>;
    },
    async create<T>(_type: string, attrs: T, options?: { id?: string }): Promise<SavedObject<T>> {
      const id = options?.id ?? `auto-${++versionCounter}`;
      if (remainingCreateConflicts > 0) {
        remainingCreateConflicts--;
        throw conflictError(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      }
      if (byId.has(id)) {
        throw conflictError(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      }
      const stored: Stored = {
        id,
        type: SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE,
        attributes: (attrs as unknown) as SloLegacyOrphanObservationAttributes,
        references: [],
        version: `v${++versionCounter}`,
      };
      byId.set(id, stored);
      return ({ ...stored, attributes: { ...stored.attributes } } as unknown) as SavedObject<T>;
    },
    async update<T>(
      _type: string,
      id: string,
      attrs: Partial<T>,
      options?: { version?: string }
    ): Promise<SavedObject<T>> {
      const hit = byId.get(id);
      if (!hit) throw notFoundError(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      if (remainingUpdateConflicts > 0) {
        remainingUpdateConflicts--;
        throw conflictError(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      }
      if (options?.version && options.version !== hit.version) {
        throw conflictError(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      }
      const merged: Stored = {
        ...hit,
        attributes: {
          ...hit.attributes,
          ...(attrs as Partial<SloLegacyOrphanObservationAttributes>),
        },
        version: `v${++versionCounter}`,
      };
      byId.set(id, merged);
      return ({ ...merged, attributes: { ...merged.attributes } } as unknown) as SavedObject<T>;
    },
    async delete(_type: string, id: string): Promise<{}> {
      if (!byId.has(id)) throw notFoundError(SLO_LEGACY_ORPHAN_OBSERVATION_SO_TYPE, id);
      byId.delete(id);
      return {};
    },
    async find<T>(findOpts: {
      type: string;
      filter?: string;
    }): Promise<{
      saved_objects: Array<SavedObject<T>>;
      total: number;
      page: number;
      per_page: number;
    }> {
      // Parse the store's filter: (type.attributes.workspaceId: "<ws>" AND type.attributes.datasourceId: "<ds>")
      const wsMatch = findOpts.filter?.match(/workspaceId: "([^"]+)"/);
      const dsMatch = findOpts.filter?.match(/datasourceId: "([^"]+)"/);
      const ws = wsMatch?.[1];
      const ds = dsMatch?.[1];
      const all = Array.from(byId.values()).filter((s) => {
        if (ws && s.attributes.workspaceId !== ws) return false;
        if (ds && s.attributes.datasourceId !== ds) return false;
        return true;
      });
      return {
        saved_objects: (all as unknown) as Array<SavedObject<T>>,
        total: all.length,
        page: 1,
        per_page: all.length,
      };
    },
  } as unknown) as SavedObjectsClientContract;

  return { client, byId };
}

function makeStore(opts: FakeClientOpts = {}) {
  const fake = makeFakeClient(opts);
  return { store: new SloLegacyOrphanObservationStore(fake.client), byId: fake.byId };
}

const FIRST_NOW = new Date('2026-04-01T09:00:00.000Z');
const LATER_NOW = new Date('2026-04-05T14:30:00.000Z');

const BASE_INPUT = {
  workspaceId: 'ws-1',
  datasourceId: 'prom-ds-001',
  namespace: 'slo-generated-prom-ds-001',
  groupName: 'slo:checkout_latency_abcdef01',
};

const expectedId = sloLegacyOrphanObservationId(
  BASE_INPUT.workspaceId,
  BASE_INPUT.datasourceId,
  BASE_INPUT.groupName
);

describe('SloLegacyOrphanObservationStore', () => {
  describe('observe', () => {
    it('creates the observation on first call with firstSeenAt=lastSeenAt=now', async () => {
      const { store, byId } = makeStore();
      const { doc, created } = await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      expect(created).toBe(true);
      expect(doc.attributes.firstSeenAt).toBe(FIRST_NOW.toISOString());
      expect(doc.attributes.lastSeenAt).toBe(FIRST_NOW.toISOString());
      expect(doc.attributes.schemaVersion).toBe(1);
      expect(doc.attributes.namespace).toBe(BASE_INPUT.namespace);
      expect(byId.get(expectedId)?.attributes.groupName).toBe(BASE_INPUT.groupName);
    });

    it('updates lastSeenAt on subsequent calls while keeping firstSeenAt immutable', async () => {
      const { store, byId } = makeStore();
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      const { doc, created } = await store.observe({ ...BASE_INPUT, now: () => LATER_NOW });
      expect(created).toBe(false);
      expect(doc.attributes.firstSeenAt).toBe(FIRST_NOW.toISOString());
      expect(doc.attributes.lastSeenAt).toBe(LATER_NOW.toISOString());
      // Stored side matches the returned doc.
      expect(byId.get(expectedId)?.attributes.firstSeenAt).toBe(FIRST_NOW.toISOString());
      expect(byId.get(expectedId)?.attributes.lastSeenAt).toBe(LATER_NOW.toISOString());
    });

    it('retries version conflicts up to 3 attempts — succeeds on 3rd try', async () => {
      const { store } = makeStore({ updateConflicts: 2 });
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      const { doc } = await store.observe({ ...BASE_INPUT, now: () => LATER_NOW });
      expect(doc.attributes.lastSeenAt).toBe(LATER_NOW.toISOString());
    });

    it('throws SloLegacyOrphanObservationConflictError when OC retries are exhausted', async () => {
      const { store } = makeStore({ updateConflicts: 3 });
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      await expect(store.observe({ ...BASE_INPUT, now: () => LATER_NOW })).rejects.toBeInstanceOf(
        SloLegacyOrphanObservationConflictError
      );
    });

    it('carries create-path conflicts through the same retry budget', async () => {
      const { store } = makeStore({ createConflicts: 2 });
      const { doc, created } = await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      expect(created).toBe(true);
      expect(doc.attributes.firstSeenAt).toBe(FIRST_NOW.toISOString());
    });

    it('refreshes namespace attribute on re-observe (defensive against drift)', async () => {
      const { store } = makeStore();
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      const { doc } = await store.observe({
        ...BASE_INPUT,
        namespace: 'slo-generated-prom-ds-001-renamed',
        now: () => LATER_NOW,
      });
      expect(doc.attributes.namespace).toBe('slo-generated-prom-ds-001-renamed');
    });
  });

  describe('get', () => {
    it('returns the observation when present', async () => {
      const { store } = makeStore();
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      const doc = await store.get(
        BASE_INPUT.workspaceId,
        BASE_INPUT.datasourceId,
        BASE_INPUT.groupName
      );
      expect(doc?.attributes.firstSeenAt).toBe(FIRST_NOW.toISOString());
    });

    it('returns null when absent', async () => {
      const { store } = makeStore();
      const doc = await store.get('ws-1', 'ds-1', 'slo:nope_deadbeef');
      expect(doc).toBeNull();
    });
  });

  describe('remove', () => {
    it('returns true when the observation is present and deletes it', async () => {
      const { store, byId } = makeStore();
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      const ok = await store.remove(
        BASE_INPUT.workspaceId,
        BASE_INPUT.datasourceId,
        BASE_INPUT.groupName
      );
      expect(ok).toBe(true);
      expect(byId.has(expectedId)).toBe(false);
    });

    it('returns false when absent (idempotent remove)', async () => {
      const { store } = makeStore();
      const ok = await store.remove('ws-1', 'ds-1', 'slo:nope_deadbeef');
      expect(ok).toBe(false);
    });
  });

  describe('listForDatasource', () => {
    it('returns only observations for the requested (workspace, datasource) tuple', async () => {
      const { store } = makeStore();
      await store.observe({ ...BASE_INPUT, now: () => FIRST_NOW });
      await store.observe({
        ...BASE_INPUT,
        groupName: 'slo:other_12345678',
        now: () => FIRST_NOW,
      });
      await store.observe({
        workspaceId: 'ws-2',
        datasourceId: 'prom-ds-002',
        namespace: 'slo-generated-prom-ds-002',
        groupName: 'slo:unrelated_fedcba98',
        now: () => FIRST_NOW,
      });
      const list = await store.listForDatasource('ws-1', 'prom-ds-001');
      expect(list.map((d) => d.attributes.groupName).sort()).toEqual([
        'slo:checkout_latency_abcdef01',
        'slo:other_12345678',
      ]);
    });
  });
});
