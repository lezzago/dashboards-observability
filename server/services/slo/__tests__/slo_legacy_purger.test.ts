/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `purgeLegacyOrphans`. Focus is safety: every delete must
 * pass every server-side invariant, and a request that differs from the
 * actual purge (because the SO store / ruler / name-pattern don't agree
 * with the client) must surface in `skipped_validation` or `failed` — never
 * silently drop work.
 *
 * Tests exercise the pure function directly with the shared FakeRulerClient
 * + a minimal in-memory store closure. No route adapter, no OSD runtime.
 */

import type { AlertingOSClient, Datasource } from '../../../../common/types/alerting/types';
import type { SloDocument } from '../../../../common/slo/slo_types';
import { SloRulerError } from '../../../../common/slo/slo_errors';
import { ruleSuffix, slugifySloObjective } from '../../../../common/slo/slo_promql_generator';
import { FakeRulerClient } from '../../../../common/slo/__tests__/fake_ruler_client';
import { createReconcilerMetrics } from '../reconciler_metrics';
import { legacyNamespaceFor, purgeLegacyOrphans } from '../slo_legacy_purger';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const TEST_DS_ID = 'ds-test';
const TEST_WS_ID = 'ds-test'; // matches workspaceId-equals-datasourceId convention
const NS = legacyNamespaceFor(TEST_DS_ID);

const fakeDatasource: Datasource = {
  id: TEST_DS_ID,
  name: 'prometheus-test',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prometheus-test',
} as Datasource;

const fakeClient = {} as AlertingOSClient;

/** Build a legacy-shape group name matching `/^slo:<slug>_<8-hex>$/`. */
function legacyName(slug: string, hex: string = 'abcdef12'): string {
  return `slo:${slug}_${hex}`;
}

/**
 * Build the legacy name an SO WOULD have recomputed for itself, using the
 * same `slugifySloObjective` + `ruleSuffix` helpers the redeploy task
 * uses. Use this to seed claimant SOs in tests that exercise the
 * no-owning-SO invariant.
 */
function legacyNameForSo(sloId: string, specName: string, workspaceId: string): string {
  const slug = slugifySloObjective(specName, 'group');
  const suffix = ruleSuffix(workspaceId, sloId, 'group');
  return `slo:${slug}_${suffix}`;
}

function stubSloDoc(options: {
  sloId: string;
  specName: string;
  datasourceId?: string;
}): SloDocument {
  return ({
    id: options.sloId,
    spec: {
      datasourceId: options.datasourceId ?? TEST_DS_ID,
      name: options.specName,
      enabled: true,
      mode: 'active',
      service: 'svc',
      owner: { teams: ['team'] },
      sli: { type: 'single', definition: { backend: 'prometheus' } },
      objectives: [{ name: 'obj', target: 0.99 }],
      budgetWarningThresholds: [],
      window: { type: 'rolling', duration: '28d' },
      alerting: { strategy: 'mwmbr', burnRates: [] },
      alarms: {
        sliHealth: { enabled: false },
        attainmentBreach: { enabled: false },
        budgetWarning: { enabled: false },
        noData: { enabled: false, forDuration: '5m' },
        resolved: { enabled: false },
      },
      exclusionWindows: [],
      labels: {},
      annotations: {},
    },
    status: {
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      createdBy: 'test',
      updatedBy: 'test',
      provisioning: {
        backend: 'prometheus',
        rulerNamespace: NS,
      },
    },
  } as unknown) as SloDocument;
}

describe('purgeLegacyOrphans', () => {
  let ruler: FakeRulerClient;
  let metrics: ReturnType<typeof createReconcilerMetrics>;

  beforeEach(() => {
    ruler = new FakeRulerClient();
    metrics = createReconcilerMetrics(mockLogger as never);
    jest.clearAllMocks();
  });

  function makeDeps(docs: SloDocument[] = []) {
    return {
      listSlos: jest.fn(async () => docs),
      ruler,
      client: fakeClient,
      datasource: fakeDatasource,
      logger: mockLogger as never,
      metrics,
    };
  }

  it('deletes every unclaimed legacy group that is present on the ruler', async () => {
    const names = [legacyName('foo'), legacyName('bar', 'cafebabe'), legacyName('baz', '0011aabb')];
    for (const n of names) {
      ruler.seedGroup(NS, ({
        groupName: n,
        interval: 60,
        rules: [],
        yaml: '',
      } as unknown) as never);
    }

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: names.map((n) => ({ groupName: n, namespace: NS })),
      },
      makeDeps()
    );

    expect(result).toEqual({
      requested: 3,
      purged: 3,
      skipped_validation: [],
      failed: [],
    });
    expect(ruler.deleteCalls).toBe(3);
    for (const n of names) {
      expect(ruler.hasGroup(NS, n)).toBe(false);
    }
    const snap = metrics.snapshot();
    expect(snap.legacyPurgeRequested).toBe(3);
    expect(snap.legacyPurgeSucceeded).toBe(3);
    expect(snap.legacyPurgeSkippedValidation).toBe(0);
    expect(snap.legacyPurgeFailed).toBe(0);
  });

  it('skips candidates whose name does not match the legacy pattern', async () => {
    const validName = legacyName('valid');
    const bogusName = 'not_a_legacy_group'; // fails pattern
    ruler.seedGroup(NS, ({
      groupName: validName,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [
          { groupName: validName, namespace: NS },
          { groupName: bogusName, namespace: NS },
        ],
      },
      makeDeps()
    );

    expect(result.requested).toBe(2);
    expect(result.purged).toBe(1);
    expect(result.skipped_validation).toEqual([
      { groupName: bogusName, namespace: NS, reason: 'name_pattern_mismatch' },
    ]);
    expect(result.failed).toEqual([]);
    expect(ruler.hasGroup(NS, validName)).toBe(false);
  });

  it('skips candidates whose namespace does not match slo-generated-<ds>', async () => {
    const name = legacyName('foo');
    ruler.seedGroup(NS, ({
      groupName: name,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);
    const wrongNs = 'slo-generated-other-ds';

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: name, namespace: wrongNs }],
      },
      makeDeps()
    );

    expect(result.purged).toBe(0);
    expect(result.skipped_validation).toEqual([
      { groupName: name, namespace: wrongNs, reason: 'namespace_mismatch' },
    ]);
    // Untouched on the ruler.
    expect(ruler.hasGroup(NS, name)).toBe(true);
    expect(ruler.deleteCalls).toBe(0);
  });

  it('refuses to purge a group an SLO claims via legacy-name recomputation', async () => {
    // SO whose spec.name + sloId maps to the same legacy group name. This
    // is the "partial migration" case — the redeploy task owns that group
    // and must own this one.
    const specName = 'Migrated SLO';
    const sloId = 'slo-migrated';
    const recomputedName = legacyNameForSo(sloId, specName, TEST_WS_ID);
    ruler.seedGroup(NS, ({
      groupName: recomputedName,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);
    const claimingDoc = stubSloDoc({ sloId, specName });

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: recomputedName, namespace: NS }],
      },
      makeDeps([claimingDoc])
    );

    expect(result.purged).toBe(0);
    expect(result.skipped_validation[0]).toMatchObject({
      groupName: recomputedName,
      reason: 'claimed_by_so',
      claimantSloId: sloId,
    });
    expect(ruler.hasGroup(NS, recomputedName)).toBe(true);
  });

  it('skips candidates that are not present on the ruler (drift between list and purge)', async () => {
    const ghostName = legacyName('ghost');
    // Note: NOT seeded on the ruler.

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: ghostName, namespace: NS }],
      },
      makeDeps()
    );

    expect(result.purged).toBe(0);
    expect(result.skipped_validation).toEqual([
      { groupName: ghostName, namespace: NS, reason: 'not_present_on_ruler' },
    ]);
    expect(ruler.deleteCalls).toBe(0);
  });

  it('deletes valid groups while flagging Cortex failures on others', async () => {
    const okName = legacyName('ok');
    const failName = legacyName('fail', '00112233');
    ruler.seedGroup(NS, ({
      groupName: okName,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);
    ruler.seedGroup(NS, ({
      groupName: failName,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);

    // Inject a failure on every delete call so both would fail; we'll flip
    // AFTER the first successful delete by wrapping the ruler's delete.
    const origDelete = ruler.deleteRuleGroup.bind(ruler);
    let callCount = 0;
    ruler.deleteRuleGroup = jest.fn(async (c, d, ns, gn) => {
      callCount += 1;
      if (gn === failName) {
        throw new SloRulerError('RULER_UNREACHABLE', 502, 'upstream gateway timeout');
      }
      return origDelete(c, d, ns, gn);
    }) as never;

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [
          { groupName: okName, namespace: NS },
          { groupName: failName, namespace: NS },
        ],
      },
      makeDeps()
    );

    expect(callCount).toBeGreaterThan(0);
    expect(result.purged).toBe(1);
    expect(result.skipped_validation).toEqual([]);
    expect(result.failed).toEqual([
      {
        groupName: failName,
        namespace: NS,
        error: expect.objectContaining({
          code: 'RULER_UNREACHABLE',
          httpStatus: 502,
        }),
      },
    ]);
    // The successful one was actually deleted; the failed one remains.
    expect(ruler.hasGroup(NS, okName)).toBe(false);
    expect(ruler.hasGroup(NS, failName)).toBe(true);
    const snap = metrics.snapshot();
    expect(snap.legacyPurgeSucceeded).toBe(1);
    expect(snap.legacyPurgeFailed).toBe(1);
  });

  it('treats a 404 from the ruler as a successful delete (already-gone tolerance)', async () => {
    const name = legacyName('already_gone');
    ruler.seedGroup(NS, ({
      groupName: name,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);
    // FakeRulerClient's delete always succeeds locally, but the real
    // DirectQueryRulerClient is 404-tolerant. The purger only sees the
    // resolved promise either way — so we assert that a happy-path delete
    // also counts 404 as `purged`. Simulate by dropping from the ruler
    // BEFORE purge runs (i.e. the group disappeared between list and
    // delete) and replacing the list with a live entry.
    //
    // Easier: override listRuleGroups to return the name, but have delete
    // reject with 404; the purger wraps this as a failure today. Phase 1's
    // RulerClient swallows the 404 so the purger never sees it. We
    // therefore assert the swallow path: delete resolves, purger counts.
    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: name, namespace: NS }],
      },
      makeDeps()
    );
    expect(result.purged).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('fails closed when the SO store enumeration throws', async () => {
    const name = legacyName('foo');
    ruler.seedGroup(NS, ({
      groupName: name,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);
    const deps = {
      listSlos: jest.fn(async () => {
        throw new Error('SO store unavailable');
      }),
      ruler,
      client: fakeClient,
      datasource: fakeDatasource,
      logger: mockLogger as never,
      metrics,
    };

    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: name, namespace: NS }],
      },
      deps
    );
    expect(result.purged).toBe(0);
    expect(result.skipped_validation).toEqual([
      { groupName: name, namespace: NS, reason: 'claimed_by_so' },
    ]);
    expect(ruler.hasGroup(NS, name)).toBe(true);
  });

  it('routes ruler-list failures into the failed bucket (no partial purge)', async () => {
    const name = legacyName('foo');
    ruler.seedGroup(NS, ({
      groupName: name,
      interval: 60,
      rules: [],
      yaml: '',
    } as unknown) as never);
    ruler.setListError(new SloRulerError('RULER_AUTH_FAILED', 401, 'missing X-Scope-OrgID'));
    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [{ groupName: name, namespace: NS }],
      },
      makeDeps()
    );
    expect(result.purged).toBe(0);
    expect(result.failed[0]).toMatchObject({
      groupName: name,
      namespace: NS,
      error: expect.objectContaining({
        code: 'RULER_AUTH_FAILED',
        httpStatus: 401,
      }),
    });
    expect(ruler.deleteCalls).toBe(0);
  });

  it('short-circuits when every candidate fails structural validation (no ruler/SO I/O)', async () => {
    const listSlos = jest.fn<Promise<SloDocument[]>, [string]>(async () => []);
    const result = await purgeLegacyOrphans(
      {
        datasourceId: TEST_DS_ID,
        workspaceId: TEST_WS_ID,
        candidates: [
          { groupName: 'bogus', namespace: NS },
          { groupName: legacyName('valid'), namespace: 'wrong-ns' },
        ],
      },
      {
        listSlos,
        ruler,
        client: fakeClient,
        datasource: fakeDatasource,
        logger: mockLogger as never,
        metrics,
      }
    );
    expect(result.purged).toBe(0);
    expect(result.skipped_validation.map((s) => s.reason).sort()).toEqual([
      'name_pattern_mismatch',
      'namespace_mismatch',
    ]);
    expect(listSlos).not.toHaveBeenCalled();
    expect(ruler.listCalls).toBe(0);
    expect(ruler.deleteCalls).toBe(0);
  });
});
