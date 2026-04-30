/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F3) — reconciler legacy-orphan observation hook.
 *
 * Runs the real `createSloReconciler` against a `FakeRulerClient` seeded
 * with a pre-Phase-3 (legacy) rule group — a group whose name matches
 * `slo:<slug>_<8-hex>` and carries no provenance annotation. The detector
 * classifies it as `unknownOrphan` with diagnostic `'pre-Phase-3 rule
 * layout; not eligible for adoption'`; the reconciler's new observation
 * hook upserts a `SloLegacyOrphanObservation` SO per group and mutates the
 * orphan entry with the resulting `firstSeenAt` / `lastSeenAt` timestamps.
 *
 * Covers:
 *   - First observation: SO is created with firstSeenAt=lastSeenAt=now;
 *     entry carries both timestamps.
 *   - Re-observation: firstSeenAt is immutable; lastSeenAt bumps.
 *   - Disappearance: a group observed in sweep N but absent in sweep N+1
 *     has its observation SO deleted; metrics counter bumps.
 *   - Store failure on observe → entry.firstSeenAt is undefined; sweep
 *     completes; warn is logged; no error counter bump.
 *   - No observation store wired → orphans surface without timestamps
 *     (pre-F3 deployment path).
 */

import { createSloReconciler } from '../reconciler';
import type { SloLegacyOrphanObservationStoreLite } from '../reconciler';
import { createReconcilerMetrics } from '../reconciler_metrics';
import { FakeRulerClient } from '../../../../common/slo/__tests__/fake_ruler_client';
import type { AlertingOSClient, Datasource, Logger } from '../../../../common/types/alerting/types';
import type {
  GeneratedRule,
  GeneratedRuleGroup,
  ISloStore,
  SloDocument,
} from '../../../../common/slo/slo_types';
import type { RuleHealthChecker } from '../rule_health_checker';
import type { InMemoryDatasourceService } from '../../alerting/datasource_service';

const DS = 'ds-1';
const WS = 'ds-1';
const NS = 'slo-generated-ds-1';

function noopLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function mockClient(): AlertingOSClient {
  return ({
    transport: { request: jest.fn(async () => ({ statusCode: 200, body: {} })) },
  } as unknown) as AlertingOSClient;
}

function mockDatasource(overrides: Partial<Datasource> = {}): Datasource {
  return {
    id: DS,
    name: 'my-cortex',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'my-cortex-connection',
    ...overrides,
  };
}

function legacyGroup(name: string): GeneratedRuleGroup {
  // Single bare alerting rule with NO provenance annotation. That plus the
  // `slo:<slug>_<8-hex>` name is what triggers the detector's "pre-Phase-3
  // rule layout; not eligible for adoption" diagnostic.
  const rule: GeneratedRule = {
    type: 'alerting',
    name,
    expr: 'vector(1) > 0',
    for: '2m',
    labels: {},
    description: name,
  };
  return { groupName: name, interval: 60, rules: [rule], yaml: '' };
}

interface Harness {
  ruler: FakeRulerClient;
  store: jest.Mocked<ISloStore>;
  healthChecker: jest.Mocked<RuleHealthChecker>;
  datasourceService: jest.Mocked<Pick<InMemoryDatasourceService, 'get'>>;
  logger: Logger;
  metrics: ReturnType<typeof createReconcilerMetrics>;
  buildClient: jest.Mock<AlertingOSClient, [Datasource]>;
}

function buildHarness(logger?: Logger): Harness {
  const lg = logger ?? noopLogger();
  return {
    ruler: new FakeRulerClient(),
    store: ({
      list: jest.fn(async () => [] as SloDocument[]),
      get: jest.fn(async () => null),
      save: jest.fn(async () => undefined),
      delete: jest.fn(async () => true),
    } as unknown) as jest.Mocked<ISloStore>,
    healthChecker: ({
      check: jest.fn(),
      invalidate: jest.fn(),
    } as unknown) as jest.Mocked<RuleHealthChecker>,
    datasourceService: ({
      get: jest.fn(async (id: string) => mockDatasource({ id })),
    } as unknown) as jest.Mocked<Pick<InMemoryDatasourceService, 'get'>>,
    logger: lg,
    metrics: createReconcilerMetrics(lg),
    buildClient: jest.fn((_ds: Datasource) => mockClient()),
  };
}

/**
 * In-memory observation store that satisfies the reconciler's
 * `SloLegacyOrphanObservationStoreLite` contract. Keeps state simple so the
 * tests can assert on the stored records directly.
 */
function makeObservationStore(now: () => Date) {
  const byGroup = new Map<string, { groupName: string; firstSeenAt: string; lastSeenAt: string }>();
  const store: SloLegacyOrphanObservationStoreLite = {
    async observe(input) {
      const key = `${input.workspaceId}::${input.datasourceId}::${input.groupName}`;
      const existing = byGroup.get(key);
      const ts = (input.now ?? now)().toISOString();
      if (!existing) {
        const rec = { groupName: input.groupName, firstSeenAt: ts, lastSeenAt: ts };
        byGroup.set(key, rec);
        return { doc: { attributes: rec }, created: true };
      }
      existing.lastSeenAt = ts;
      return { doc: { attributes: existing }, created: false };
    },
    async listForDatasource(workspaceId, datasourceId) {
      const out: Array<{
        attributes: {
          groupName: string;
          firstSeenAt: string;
          lastSeenAt: string;
        };
      }> = [];
      for (const [key, rec] of byGroup.entries()) {
        if (key.startsWith(`${workspaceId}::${datasourceId}::`)) {
          out.push({ attributes: rec });
        }
      }
      return out;
    },
    async remove(workspaceId, datasourceId, groupName) {
      const key = `${workspaceId}::${datasourceId}::${groupName}`;
      return byGroup.delete(key);
    },
  };
  return { store, byGroup };
}

function makeReconciler(
  h: Harness,
  opts: {
    legacyOrphanObservationStore?: SloLegacyOrphanObservationStoreLite;
    now?: () => Date;
  } = {}
) {
  return createSloReconciler({
    store: h.store,
    ruler: h.ruler,
    healthChecker: h.healthChecker,
    datasourceService: (h.datasourceService as unknown) as InMemoryDatasourceService,
    logger: h.logger,
    metrics: h.metrics,
    buildClient: h.buildClient,
    legacyOrphanObservationStore: opts.legacyOrphanObservationStore,
    now: opts.now,
  });
}

describe('SloReconciler — Session E (F3) legacy-orphan observation hook', () => {
  it('first observation: SO is created with firstSeenAt=lastSeenAt=now; entry carries timestamps', async () => {
    const h = buildHarness();
    const legacyName = 'slo:checkout_latency_abcdef01';
    h.ruler.seedGroup(NS, legacyGroup(legacyName));
    const sweepTime = new Date('2026-04-01T09:00:00.000Z');
    const { store, byGroup } = makeObservationStore(() => sweepTime);
    const reconciler = makeReconciler(h, {
      legacyOrphanObservationStore: store,
      now: () => sweepTime,
    });

    const result = await reconciler.reconcileOnce({ datasourceIds: [DS] });

    expect(result.unknownOrphans).toHaveLength(1);
    const entry = result.unknownOrphans[0];
    expect(entry.groupName).toBe(legacyName);
    expect(entry.diagnostic).toBe('pre-Phase-3 rule layout; not eligible for adoption');
    expect(entry.firstSeenAt).toBe(sweepTime.toISOString());
    expect(entry.lastSeenAt).toBe(sweepTime.toISOString());

    const stored = byGroup.get(`${WS}::${DS}::${legacyName}`);
    expect(stored?.firstSeenAt).toBe(sweepTime.toISOString());

    expect(h.metrics.snapshot().legacyObservationsWritten).toBe(1);
    expect(h.metrics.snapshot().legacyObservationsDeleted).toBe(0);
  });

  it('re-observation: firstSeenAt is immutable; lastSeenAt updates; no disappearance-delete', async () => {
    const h = buildHarness();
    const legacyName = 'slo:checkout_latency_abcdef01';
    h.ruler.seedGroup(NS, legacyGroup(legacyName));
    const t1 = new Date('2026-04-01T09:00:00.000Z');
    const t2 = new Date('2026-04-05T14:30:00.000Z');
    let nowRef = t1;
    const { store } = makeObservationStore(() => nowRef);
    const reconciler = makeReconciler(h, {
      legacyOrphanObservationStore: store,
      now: () => nowRef,
    });

    await reconciler.reconcileOnce({ datasourceIds: [DS] });
    nowRef = t2;
    const result = await reconciler.reconcileOnce({ datasourceIds: [DS] });
    const entry = result.unknownOrphans[0];
    expect(entry.firstSeenAt).toBe(t1.toISOString());
    expect(entry.lastSeenAt).toBe(t2.toISOString());
    // Two sweeps wrote one observation each; neither sweep saw a vanished
    // group, so deletions stay at 0.
    expect(h.metrics.snapshot().legacyObservationsWritten).toBe(2);
    expect(h.metrics.snapshot().legacyObservationsDeleted).toBe(0);
  });

  it('disappearance: observation SO is deleted when the group is no longer on the ruler', async () => {
    const h = buildHarness();
    const legacyName = 'slo:checkout_latency_abcdef01';
    h.ruler.seedGroup(NS, legacyGroup(legacyName));
    const sweepTime = new Date('2026-04-01T09:00:00.000Z');
    const { store, byGroup } = makeObservationStore(() => sweepTime);
    const reconciler = makeReconciler(h, {
      legacyOrphanObservationStore: store,
      now: () => sweepTime,
    });

    // Sweep 1 — observe.
    await reconciler.reconcileOnce({ datasourceIds: [DS] });
    expect(byGroup.has(`${WS}::${DS}::${legacyName}`)).toBe(true);

    // Simulate admin purge (or out-of-band delete) between sweeps.
    await h.ruler.deleteRuleGroup(mockClient(), mockDatasource({ id: DS }), NS, legacyName);

    // Sweep 2 — observation should be deleted since the group vanished.
    const result = await reconciler.reconcileOnce({ datasourceIds: [DS] });
    expect(result.unknownOrphans).toHaveLength(0);
    expect(byGroup.has(`${WS}::${DS}::${legacyName}`)).toBe(false);
    expect(h.metrics.snapshot().legacyObservationsDeleted).toBe(1);
  });

  it('observation store error on observe → entry.firstSeenAt undefined; sweep continues; warn logged', async () => {
    const logger = noopLogger();
    const h = buildHarness(logger);
    const legacyName = 'slo:checkout_latency_abcdef01';
    h.ruler.seedGroup(NS, legacyGroup(legacyName));

    const failingStore: SloLegacyOrphanObservationStoreLite = {
      observe: jest.fn(async () => {
        throw new Error('synthetic observation-store failure');
      }),
      listForDatasource: jest.fn(async () => []),
      remove: jest.fn(async () => false),
    };
    const reconciler = makeReconciler(h, {
      legacyOrphanObservationStore: failingStore,
      now: () => new Date('2026-04-01T09:00:00.000Z'),
    });

    const result = await reconciler.reconcileOnce({ datasourceIds: [DS] });
    expect(result.unknownOrphans).toHaveLength(1);
    expect(result.unknownOrphans[0].firstSeenAt).toBeUndefined();
    expect(result.unknownOrphans[0].lastSeenAt).toBeUndefined();
    // Errors counter NOT bumped — best-effort surface logs at warn.
    expect(h.metrics.snapshot().errors).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy-orphan observation write failed')
    );
  });

  it('no observation store wired → orphans surface without timestamps (pre-F3 deployment path)', async () => {
    const h = buildHarness();
    const legacyName = 'slo:checkout_latency_abcdef01';
    h.ruler.seedGroup(NS, legacyGroup(legacyName));
    const reconciler = makeReconciler(h); // no observation store

    const result = await reconciler.reconcileOnce({ datasourceIds: [DS] });
    expect(result.unknownOrphans).toHaveLength(1);
    expect(result.unknownOrphans[0].firstSeenAt).toBeUndefined();
    expect(result.unknownOrphans[0].lastSeenAt).toBeUndefined();
    expect(h.metrics.snapshot().legacyObservationsWritten).toBe(0);
  });

  it('adoptable orphans (non-legacy) do not write observations', async () => {
    const h = buildHarness();
    // Recording-only orphan: name matches slo:rec:<fp> — detector puts it in
    // unknownOrphans with diagnostic 'recording-only orphan; matching alert
    // group missing', which is NOT the legacy diagnostic. Observation hook
    // must skip it.
    const recordingOnly = 'slo:rec:deadbeefcafebabe';
    h.ruler.seedGroup(NS, legacyGroup(recordingOnly));
    const sweepTime = new Date('2026-04-01T09:00:00.000Z');
    const { store, byGroup } = makeObservationStore(() => sweepTime);
    const reconciler = makeReconciler(h, {
      legacyOrphanObservationStore: store,
      now: () => sweepTime,
    });

    const result = await reconciler.reconcileOnce({ datasourceIds: [DS] });
    expect(result.unknownOrphans).toHaveLength(1);
    expect(result.unknownOrphans[0].diagnostic).not.toContain('pre-Phase-3');
    expect(byGroup.size).toBe(0);
    expect(h.metrics.snapshot().legacyObservationsWritten).toBe(0);
  });
});
