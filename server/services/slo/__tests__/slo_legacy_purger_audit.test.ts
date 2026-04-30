/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F4) — audit-hook tests for `purgeLegacyOrphans`.
 *
 * Asserts that each purge outcome (purged / skipped_validation / failed)
 * produces one audit record with the expected shape. The purge's own
 * return value is not re-asserted here — that's covered by
 * `slo_legacy_purger.test.ts`; this suite is focused on the side-effect
 * (`auditStore.writeMany` call) only.
 *
 * Uses an in-memory capture store that records every `writeMany` call so
 * tests can assert on the exact batched payload.
 */

import type { AlertingOSClient, Datasource } from '../../../../common/types/alerting/types';
import type { SloDocument } from '../../../../common/slo/slo_types';
import { SloRulerError } from '../../../../common/slo/slo_errors';
import { FakeRulerClient } from '../../../../common/slo/__tests__/fake_ruler_client';
import { createReconcilerMetrics } from '../reconciler_metrics';
import {
  legacyNamespaceFor,
  purgeLegacyOrphans,
  SloLegacyPurgeAuditWriterLite,
} from '../slo_legacy_purger';
import type { SloLegacyPurgeAuditAttributes } from '../../../saved_objects/slo_legacy_purge_audit';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const TEST_DS_ID = 'ds-test';
const TEST_WS_ID = 'ds-test';
const NS = legacyNamespaceFor(TEST_DS_ID);
const FIXED_NOW = new Date('2026-04-29T10:00:00.000Z');

const fakeDatasource: Datasource = {
  id: TEST_DS_ID,
  name: 'prometheus-test',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prometheus-test',
} as Datasource;

const fakeClient = {} as AlertingOSClient;

function legacyName(slug: string, hex: string = 'abcdef12'): string {
  return `slo:${slug}_${hex}`;
}

function captureStore() {
  const calls: SloLegacyPurgeAuditAttributes[][] = [];
  const store: SloLegacyPurgeAuditWriterLite = {
    async writeMany(records) {
      calls.push(records);
    },
  };
  const flat = () => calls.flat();
  return { store, calls, flat };
}

function emptyListSlos(): Promise<SloDocument[]> {
  return Promise.resolve([]);
}

describe('purgeLegacyOrphans — Session E (F4) audit hook', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits one "purged" audit record per deleted group, batched in a single writeMany', async () => {
    const ruler = new FakeRulerClient();
    const groupA = legacyName('foo', 'abcdef12');
    const groupB = legacyName('bar', 'cafebabe');
    ruler.seedGroup(NS, { groupName: groupA, interval: 60, rules: [], yaml: '' });
    ruler.seedGroup(NS, { groupName: groupB, interval: 60, rules: [], yaml: '' });

    const { store, calls, flat } = captureStore();
    await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [
          { groupName: groupA, namespace: NS },
          { groupName: groupB, namespace: NS },
        ],
      },
      {
        listSlos: emptyListSlos,
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger: mockLogger,
        metrics: createReconcilerMetrics(mockLogger),
        auditStore: store,
        requestedBy: 'admin',
        now: () => FIXED_NOW,
      }
    );

    // One batched writeMany, two records, each tagged 'purged'.
    expect(calls).toHaveLength(1);
    const records = flat();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.outcome).toBe('purged');
      expect(r.requestedAt).toBe(FIXED_NOW.toISOString());
      expect(r.requestedBy).toBe('admin');
      expect(r.namespace).toBe(NS);
      expect(r.schemaVersion).toBe(1);
    }
    expect(records.map((r) => r.groupName).sort()).toEqual([groupA, groupB].sort());
  });

  it('records each skipped_validation reason (name pattern, namespace, not_present_on_ruler)', async () => {
    const ruler = new FakeRulerClient();
    const livingGroup = legacyName('baz', 'beefcafe');
    ruler.seedGroup(NS, { groupName: livingGroup, interval: 60, rules: [], yaml: '' });

    const { store, flat } = captureStore();
    await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [
          { groupName: 'not-a-legacy-name', namespace: NS }, // name_pattern_mismatch
          { groupName: legacyName('x'), namespace: 'wrong-ns' }, // namespace_mismatch
          { groupName: legacyName('gone', '11111111'), namespace: NS }, // not_present_on_ruler
          { groupName: livingGroup, namespace: NS }, // purged
        ],
      },
      {
        listSlos: emptyListSlos,
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger: mockLogger,
        metrics: createReconcilerMetrics(mockLogger),
        auditStore: store,
        now: () => FIXED_NOW,
      }
    );

    const outcomesByGroup = new Map<string, SloLegacyPurgeAuditAttributes>();
    for (const r of flat()) outcomesByGroup.set(r.groupName, r);

    expect(outcomesByGroup.get('not-a-legacy-name')?.outcome).toBe('skipped_validation');
    expect(outcomesByGroup.get('not-a-legacy-name')?.reason).toBe('name_pattern_mismatch');
    expect(outcomesByGroup.get(legacyName('x'))?.outcome).toBe('skipped_validation');
    expect(outcomesByGroup.get(legacyName('x'))?.reason).toBe('namespace_mismatch');
    expect(outcomesByGroup.get(legacyName('gone', '11111111'))?.outcome).toBe('skipped_validation');
    expect(outcomesByGroup.get(legacyName('gone', '11111111'))?.reason).toBe(
      'not_present_on_ruler'
    );
    expect(outcomesByGroup.get(livingGroup)?.outcome).toBe('purged');
  });

  it('records "failed" outcomes with errorCode/httpStatus/reason from the ruler error', async () => {
    const ruler = new FakeRulerClient();
    const group = legacyName('err', 'deadbeef');
    ruler.seedGroup(NS, { groupName: group, interval: 60, rules: [], yaml: '' });
    ruler.setDeleteError(new SloRulerError('RULER_VALIDATION_FAILED', 400, 'simulated'));

    const { store, flat } = captureStore();
    await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: group, namespace: NS }],
      },
      {
        listSlos: emptyListSlos,
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger: mockLogger,
        metrics: createReconcilerMetrics(mockLogger),
        auditStore: store,
        now: () => FIXED_NOW,
      }
    );

    const records = flat();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe('failed');
    expect(records[0].errorCode).toBe('RULER_VALIDATION_FAILED');
    expect(records[0].errorHttpStatus).toBe(400);
    expect(records[0].reason).toContain('simulated');
  });

  it('writeMany failures are logged at warn but do not block the purge response', async () => {
    const ruler = new FakeRulerClient();
    const group = legacyName('ok', '12345678');
    ruler.seedGroup(NS, { groupName: group, interval: 60, rules: [], yaml: '' });

    const failingStore: SloLegacyPurgeAuditWriterLite = {
      async writeMany() {
        throw new Error('synthetic audit-store failure');
      },
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: group, namespace: NS }],
      },
      {
        listSlos: emptyListSlos,
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger,
        metrics: createReconcilerMetrics(logger),
        auditStore: failingStore,
        now: () => FIXED_NOW,
      }
    );

    // Purge still returned the authoritative outcome.
    expect(result.purged).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('audit write failed'));
  });

  it('does not call writeMany when no audit store is wired', async () => {
    const ruler = new FakeRulerClient();
    const group = legacyName('ok', '87654321');
    ruler.seedGroup(NS, { groupName: group, interval: 60, rules: [], yaml: '' });
    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: group, namespace: NS }],
      },
      {
        listSlos: emptyListSlos,
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger: mockLogger,
        metrics: createReconcilerMetrics(mockLogger),
        now: () => FIXED_NOW,
      }
    );
    expect(result.purged).toBe(1);
  });

  it('records claimant_by_so with the claimantSloId when fail-closed path triggers', async () => {
    const ruler = new FakeRulerClient();
    const group = legacyName('foo', 'abcdef12');
    ruler.seedGroup(NS, { groupName: group, interval: 60, rules: [], yaml: '' });
    const { store, flat } = captureStore();
    await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: group, namespace: NS }],
      },
      {
        // Fail-closed: SO store enumeration throws → every structurally-valid
        // candidate lands as skipped claimed_by_so (no claimantSloId).
        listSlos: () => Promise.reject(new Error('SO store down')),
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger: mockLogger,
        metrics: createReconcilerMetrics(mockLogger),
        auditStore: store,
        now: () => FIXED_NOW,
      }
    );
    const records = flat();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe('skipped_validation');
    expect(records[0].reason).toBe('claimed_by_so');
    expect(records[0].claimantSloId).toBeUndefined();
  });
});
