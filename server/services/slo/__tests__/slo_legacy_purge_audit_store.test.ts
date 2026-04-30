/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SavedObjectsClientContract, SavedObject } from '../../../../../../src/core/server';
import {
  SLO_LEGACY_PURGE_AUDIT_SO_TYPE,
  SloLegacyPurgeAuditAttributes,
  sloLegacyPurgeAuditId,
} from '../../../saved_objects/slo_legacy_purge_audit';
import { MAX_LIMIT, SloLegacyPurgeAuditStore } from '../slo_legacy_purge_audit_store';

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

type Stored = SavedObject<SloLegacyPurgeAuditAttributes>;

function makeFakeClient() {
  const byId = new Map<string, Stored>();
  let versionCounter = 0;

  const client = ({
    async bulkCreate(
      objects: Array<{
        type: string;
        id: string;
        attributes: SloLegacyPurgeAuditAttributes;
      }>,
      _options?: { overwrite?: boolean }
    ): Promise<{ saved_objects: Stored[] }> {
      const out: Stored[] = [];
      for (const o of objects) {
        const stored: Stored = {
          id: o.id,
          type: SLO_LEGACY_PURGE_AUDIT_SO_TYPE,
          attributes: { ...o.attributes },
          references: [],
          version: `v${++versionCounter}`,
        };
        byId.set(o.id, stored);
        out.push(stored);
      }
      return { saved_objects: out };
    },
    async find<T>(opts: {
      type: string;
      filter?: string;
      page?: number;
      perPage?: number;
      sortField?: string;
      sortOrder?: 'asc' | 'desc';
    }): Promise<{
      saved_objects: Array<SavedObject<T>>;
      total: number;
      page: number;
      per_page: number;
    }> {
      let matches = Array.from(byId.values());
      const filter = opts.filter ?? '';
      // Apply each KQL clause in the filter string.
      for (const clause of filter.split(' AND ')) {
        const wsMatch = clause.match(/workspaceId: "([^"]+)"/);
        if (wsMatch) {
          matches = matches.filter((s) => s.attributes.workspaceId === wsMatch[1]);
        }
        const dsMatch = clause.match(/datasourceId: "([^"]+)"/);
        if (dsMatch) {
          matches = matches.filter((s) => s.attributes.datasourceId === dsMatch[1]);
        }
        const gnMatch = clause.match(/groupName: "([^"]+)"/);
        if (gnMatch) {
          matches = matches.filter((s) => s.attributes.groupName === gnMatch[1]);
        }
        const sinceMatch = clause.match(/requestedAt >= "([^"]+)"/);
        if (sinceMatch) {
          const cutoff = Date.parse(sinceMatch[1]);
          matches = matches.filter((s) => Date.parse(s.attributes.requestedAt) >= cutoff);
        }
        const beforeMatch = clause.match(/requestedAt < "([^"]+)"/);
        if (beforeMatch) {
          const cutoff = Date.parse(beforeMatch[1]);
          matches = matches.filter((s) => Date.parse(s.attributes.requestedAt) < cutoff);
        }
      }
      if (opts.sortField === 'requestedAt') {
        matches.sort((a, b) => {
          const order = opts.sortOrder === 'asc' ? 1 : -1;
          return (
            order * (Date.parse(a.attributes.requestedAt) - Date.parse(b.attributes.requestedAt))
          );
        });
      }
      const perPage = opts.perPage ?? matches.length;
      const page = opts.page ?? 1;
      const start = (page - 1) * perPage;
      const pageMatches = matches.slice(start, start + perPage);
      return {
        saved_objects: (pageMatches as unknown) as Array<SavedObject<T>>,
        total: matches.length,
        page,
        per_page: perPage,
      };
    },
    async delete(_type: string, id: string): Promise<{}> {
      if (!byId.has(id)) throw new StatusError(404, `not found ${id}`);
      byId.delete(id);
      return {};
    },
  } as unknown) as SavedObjectsClientContract;

  return { client, byId };
}

function makeStore() {
  const fake = makeFakeClient();
  return { store: new SloLegacyPurgeAuditStore(fake.client), byId: fake.byId };
}

function auditRecord(
  overrides: Partial<SloLegacyPurgeAuditAttributes> = {}
): SloLegacyPurgeAuditAttributes {
  return {
    workspaceId: 'ws-1',
    datasourceId: 'ds-1',
    namespace: 'slo-generated-ds-1',
    groupName: 'slo:foo_abcdef12',
    outcome: 'purged',
    requestedAt: '2026-04-29T10:00:00.000Z',
    requestedBy: 'admin',
    schemaVersion: 1,
    ...overrides,
  };
}

describe('SloLegacyPurgeAuditStore', () => {
  describe('writeMany', () => {
    it('writes N records in one bulk call and uses the deterministic id format', async () => {
      const { store, byId } = makeStore();
      const r1 = auditRecord({ groupName: 'slo:foo_abcdef12' });
      const r2 = auditRecord({ groupName: 'slo:bar_cafebabe', outcome: 'failed' });
      await store.writeMany([r1, r2]);
      expect(byId.size).toBe(2);
      expect(byId.has(sloLegacyPurgeAuditId(r1.requestedAt, r1.datasourceId, r1.groupName))).toBe(
        true
      );
      expect(byId.has(sloLegacyPurgeAuditId(r2.requestedAt, r2.datasourceId, r2.groupName))).toBe(
        true
      );
    });

    it('no-ops on an empty input', async () => {
      const { store, byId } = makeStore();
      await store.writeMany([]);
      expect(byId.size).toBe(0);
    });
  });

  describe('list', () => {
    it('filters by datasourceId', async () => {
      const { store } = makeStore();
      await store.writeMany([
        auditRecord({ datasourceId: 'ds-1', groupName: 'slo:a_11111111' }),
        auditRecord({ datasourceId: 'ds-2', groupName: 'slo:b_22222222' }),
      ]);
      const { records } = await store.list({ datasourceId: 'ds-1' });
      expect(records.map((r) => r.attributes.datasourceId)).toEqual(['ds-1']);
    });

    it('filters by groupName', async () => {
      const { store } = makeStore();
      await store.writeMany([
        auditRecord({ groupName: 'slo:a_11111111' }),
        auditRecord({ groupName: 'slo:b_22222222' }),
      ]);
      const { records } = await store.list({ groupName: 'slo:a_11111111' });
      expect(records.map((r) => r.attributes.groupName)).toEqual(['slo:a_11111111']);
    });

    it('filters by since (inclusive lower bound)', async () => {
      const { store } = makeStore();
      await store.writeMany([
        auditRecord({ groupName: 'old', requestedAt: '2026-01-01T00:00:00.000Z' }),
        auditRecord({ groupName: 'mid', requestedAt: '2026-04-01T00:00:00.000Z' }),
        auditRecord({ groupName: 'new', requestedAt: '2026-04-20T00:00:00.000Z' }),
      ]);
      const { records } = await store.list({ since: '2026-04-01T00:00:00.000Z' });
      expect(records.map((r) => r.attributes.groupName).sort()).toEqual(['mid', 'new']);
    });

    it('sorts by requestedAt descending', async () => {
      const { store } = makeStore();
      await store.writeMany([
        auditRecord({ groupName: 'first', requestedAt: '2026-04-01T00:00:00.000Z' }),
        auditRecord({ groupName: 'second', requestedAt: '2026-04-20T00:00:00.000Z' }),
        auditRecord({ groupName: 'third', requestedAt: '2026-04-10T00:00:00.000Z' }),
      ]);
      const { records } = await store.list({});
      expect(records.map((r) => r.attributes.groupName)).toEqual(['second', 'third', 'first']);
    });

    it('caps result set at MAX_LIMIT and sets truncated=true', async () => {
      const { store } = makeStore();
      // Seed MAX_LIMIT + 5 records; distinct requestedAt timestamps to avoid
      // id collisions (id includes requestedAt).
      const records: SloLegacyPurgeAuditAttributes[] = [];
      for (let i = 0; i < MAX_LIMIT + 5; i++) {
        records.push(
          auditRecord({
            groupName: `slo:g${i}_deadbeef`,
            requestedAt: new Date(2026, 3, 29, 10, 0, i).toISOString(),
          })
        );
      }
      await store.writeMany(records);
      const result = await store.list({ limit: 10_000 });
      expect(result.records).toHaveLength(MAX_LIMIT);
      expect(result.truncated).toBe(true);
    });

    it('respects a lower user-supplied limit and reports truncation when the result exceeds it', async () => {
      const { store } = makeStore();
      await store.writeMany([
        auditRecord({ groupName: 'a', requestedAt: '2026-04-01T00:00:00.000Z' }),
        auditRecord({ groupName: 'b', requestedAt: '2026-04-02T00:00:00.000Z' }),
        auditRecord({ groupName: 'c', requestedAt: '2026-04-03T00:00:00.000Z' }),
      ]);
      const result = await store.list({ limit: 2 });
      expect(result.records).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });
  });

  describe('deleteBefore', () => {
    it('deletes records with requestedAt < cutoff and returns the count', async () => {
      const { store, byId } = makeStore();
      await store.writeMany([
        auditRecord({ groupName: 'keep', requestedAt: '2026-04-20T00:00:00.000Z' }),
        auditRecord({ groupName: 'expire-1', requestedAt: '2026-01-01T00:00:00.000Z' }),
        auditRecord({ groupName: 'expire-2', requestedAt: '2026-02-15T00:00:00.000Z' }),
      ]);
      const deleted = await store.deleteBefore('2026-04-01T00:00:00.000Z');
      expect(deleted).toBe(2);
      const remaining = Array.from(byId.values()).map((s) => s.attributes.groupName);
      expect(remaining).toEqual(['keep']);
    });

    it('returns 0 when nothing is old enough to expire', async () => {
      const { store } = makeStore();
      await store.writeMany([auditRecord({ requestedAt: '2026-04-29T00:00:00.000Z' })]);
      const deleted = await store.deleteBefore('2026-04-01T00:00:00.000Z');
      expect(deleted).toBe(0);
    });
  });
});
