/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SloService.repair — integration tests (W1.10).
 *
 * Wires the real `SloService` against:
 *   - `InMemorySloStore` (no SO-layer mocks)
 *   - A `FakeRulerClient` we control (simulates out-of-band group deletion,
 *     5xx, and 4xx upsert failures)
 *   - The production `createRuleHealthChecker` (unmocked) pointed at the same
 *     fake ruler
 *
 * Unlike the unit-level `slo_service_repair.test.ts`, these tests exercise
 * multiple workstreams stitched together: the probe actually runs against the
 * fake ruler's state, and repair's upsert flips the probe's next answer. That
 * lets us pin end-to-end semantics (restore after out-of-band delete,
 * idempotence, error-propagation) that no single unit test covers.
 */

import {
  SloDeployContext,
  SloNotFoundError,
  SloRepairContext,
  SloRulerClient,
  SloRulerError,
  SloService,
  sloRulerNamespaceFor,
} from '../slo_service';
import { InMemorySloStore } from '../slo_store';
import { DEFAULT_MWMBR_TIERS } from '../slo_promql_generator';
import { createRuleHealthChecker } from '../../../server/services/slo/rule_health_checker';
import type { RulerClient } from '../../../server/services/slo/ruler_client';
import type { AlertingOSClient, Datasource, Logger } from '../../types/alerting/types';
import type { GeneratedRuleGroup, SloSpec } from '../slo_types';

// ============================================================================
// Test doubles
// ============================================================================

function noopLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

function validSpec(overrides: Partial<SloSpec> = {}): SloSpec {
  return {
    datasourceId: 'prom-ds-001',
    name: `API Availability ${Math.random().toString(36).slice(2, 8)}`,
    enabled: true,
    mode: 'active',
    service: 'api-gateway',
    owner: { teams: ['platform'] },
    sli: {
      type: 'single',
      definition: {
        backend: 'prometheus',
        type: 'availability',
        calcMethod: 'events',
        metric: 'http_requests_total',
      },
      dimensions: [{ name: 'service', value: 'api-gateway' }],
    },
    objectives: [{ name: 'availability-99-9', target: 0.999 }],
    budgetWarningThresholds: [{ threshold: 0.5, severity: 'warning' }],
    window: { type: 'rolling', duration: '28d' },
    alerting: { strategy: 'mwmbr', burnRates: DEFAULT_MWMBR_TIERS.map((t) => ({ ...t })) },
    alarms: {
      sliHealth: { enabled: false },
      attainmentBreach: { enabled: false },
      budgetWarning: { enabled: true },
      noData: { enabled: false, forDuration: '10m' },
      resolved: { enabled: false },
    },
    exclusionWindows: [],
    labels: {},
    annotations: {},
    ...overrides,
  };
}

/**
 * Fake ruler backed by an in-memory Map. Shape satisfies both `RulerClient`
 * (for `createRuleHealthChecker`) and `SloRulerClient` (for `SloService`),
 * which is why we keep the same instance on both sides of the wiring.
 *
 * Error injection (`setGetError`, `setUpsertError`, `setDeleteError`) lets
 * individual scenarios flip the fake into a 5xx/4xx posture without tearing
 * down the whole harness. `getGroupShouldReturnNullOnce` models the
 * partial-presence case: the first probe of a specific group answers 'missing'
 * then subsequent probes answer with the stored group.
 */
class FakeRulerClient implements RulerClient, SloRulerClient {
  public upsertCalls = 0;
  public getCalls = 0;
  public deleteCalls = 0;

  private groups = new Map<string, GeneratedRuleGroup>();
  private getError: SloRulerError | null = null;
  private upsertError: SloRulerError | null = null;
  private deleteError: SloRulerError | null = null;
  private nullOnceForGroup: string | null = null;

  private key(ns: string, name: string): string {
    return `${ns}|${name}`;
  }

  setGetError(err: SloRulerError | null): void {
    this.getError = err;
  }
  setUpsertError(err: SloRulerError | null): void {
    this.upsertError = err;
  }
  setDeleteError(err: SloRulerError | null): void {
    this.deleteError = err;
  }

  /** Next `getRuleGroup(…, groupName)` returns null; subsequent calls return the stored group. */
  setNullOnceForGroup(groupName: string): void {
    this.nullOnceForGroup = groupName;
  }

  /** Simulate an out-of-band delete (e.g. someone DELETE'd the group in Cortex directly). */
  dropGroup(namespace: string, groupName: string): void {
    this.groups.delete(this.key(namespace, groupName));
  }

  hasGroup(namespace: string, groupName: string): boolean {
    return this.groups.has(this.key(namespace, groupName));
  }

  async upsertRuleGroup(
    _client: AlertingOSClient,
    _datasource: Datasource,
    namespace: string,
    group: GeneratedRuleGroup
  ): Promise<void> {
    this.upsertCalls += 1;
    if (this.upsertError) throw this.upsertError;
    this.groups.set(this.key(namespace, group.groupName), group);
  }

  async deleteRuleGroup(
    _client: AlertingOSClient,
    _datasource: Datasource,
    namespace: string,
    groupName: string
  ): Promise<void> {
    this.deleteCalls += 1;
    if (this.deleteError) throw this.deleteError;
    // 404-tolerant by design: missing key → no-op success. Mirrors W1.1.
    this.groups.delete(this.key(namespace, groupName));
  }

  async getRuleGroup(
    _client: AlertingOSClient,
    _datasource: Datasource,
    namespace: string,
    groupName: string
  ): Promise<GeneratedRuleGroup | null> {
    this.getCalls += 1;
    if (this.getError) throw this.getError;
    if (this.nullOnceForGroup === groupName) {
      this.nullOnceForGroup = null;
      return null;
    }
    return this.groups.get(this.key(namespace, groupName)) ?? null;
  }

  async listRuleGroups(
    _client: AlertingOSClient,
    _datasource: Datasource,
    namespace: string
  ): Promise<GeneratedRuleGroup[]> {
    const prefix = `${namespace}|`;
    const out: GeneratedRuleGroup[] = [];
    for (const [k, v] of this.groups.entries()) {
      if (k.startsWith(prefix)) out.push(v);
    }
    return out;
  }
}

function makeHarness() {
  const store = new InMemorySloStore();
  const ruler = new FakeRulerClient();
  const logger = noopLogger();
  const svc = new SloService(logger, store);
  const health = createRuleHealthChecker(ruler, logger, { ttlMs: 0 });

  const datasource: Datasource = {
    id: 'prom-ds-001',
    name: 'prom',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'prom-connection',
  };
  const client = ({
    transport: { request: () => Promise.resolve({}) },
  } as unknown) as AlertingOSClient;

  const deploy: SloDeployContext = {
    ruler,
    client,
    datasource,
    workspaceId: 'ws-int',
  };
  const repairCtx: SloRepairContext = { health, deploy };
  const namespace = sloRulerNamespaceFor(deploy.workspaceId);

  return { store, ruler, svc, deploy, repairCtx, namespace, health };
}

// ============================================================================
// Tests
// ============================================================================

describe('SloService.repair — integration (W1.10)', () => {
  it('restores an out-of-band deleted rule group: repaired=true, state=ok, two upserts total, group back on ruler', async () => {
    const { svc, ruler, deploy, repairCtx, namespace } = makeHarness();
    const doc = await svc.create({ spec: validSpec() }, 'alice', deploy);

    const groupName =
      doc.status.provisioning.backend === 'prometheus' && doc.status.provisioning.ruleGroupName
        ? doc.status.provisioning.ruleGroupName
        : '';

    // Sanity: create wrote the group to the fake ruler.
    expect(ruler.hasGroup(namespace, groupName)).toBe(true);
    expect(ruler.upsertCalls).toBe(1);

    // Out-of-band delete: somebody ran `DELETE /api/v1/rules/{ns}/{group}` directly
    // on Cortex. The SO still thinks the group is there; repair should notice.
    ruler.dropGroup(namespace, groupName);
    expect(ruler.hasGroup(namespace, groupName)).toBe(false);

    const result = await svc.repair(doc.id, repairCtx);

    expect(result.sloId).toBe(doc.id);
    expect(result.repaired).toBe(true);
    expect(result.health.state).toBe('ok');
    expect(result.health.missingGroups).toEqual([]);
    expect(result.health.presentGroups).toEqual([groupName]);
    // create + repair = 2 upserts total; no other writes happen along the way.
    expect(ruler.upsertCalls).toBe(2);
    expect(ruler.hasGroup(namespace, groupName)).toBe(true);
  });

  it('idempotent on a healthy SLO: zero extra upserts across two back-to-back repairs', async () => {
    const { svc, ruler, deploy, repairCtx } = makeHarness();
    const doc = await svc.create({ spec: validSpec() }, 'alice', deploy);

    const upsertsAfterCreate = ruler.upsertCalls;

    const first = await svc.repair(doc.id, repairCtx);
    expect(first.repaired).toBe(false);
    expect(first.health.state).toBe('ok');
    expect(ruler.upsertCalls).toBe(upsertsAfterCreate);

    const second = await svc.repair(doc.id, repairCtx);
    expect(second.repaired).toBe(false);
    expect(second.health.state).toBe('ok');
    expect(ruler.upsertCalls).toBe(upsertsAfterCreate);
  });

  it('propagates ruler 5xx as SloRulerError("RULER_UNREACHABLE", …) without upserting', async () => {
    const { svc, ruler, deploy, repairCtx, namespace } = makeHarness();
    const doc = await svc.create({ spec: validSpec() }, 'alice', deploy);

    const groupName =
      doc.status.provisioning.backend === 'prometheus' && doc.status.provisioning.ruleGroupName
        ? doc.status.provisioning.ruleGroupName
        : '';
    ruler.dropGroup(namespace, groupName);

    // Flip the fake into a 5xx posture — the probe should translate this into
    // state='ruler_unreachable', which repair re-throws as SloRulerError.
    ruler.setGetError(new SloRulerError('RULER_UNREACHABLE', 503, 'upstream'));

    const upsertsBefore = ruler.upsertCalls;
    await expect(svc.repair(doc.id, repairCtx)).rejects.toBeInstanceOf(SloRulerError);

    ruler.setGetError(new SloRulerError('RULER_UNREACHABLE', 503, 'upstream'));
    await expect(svc.repair(doc.id, repairCtx)).rejects.toMatchObject({
      name: 'SloRulerError',
      code: 'RULER_UNREACHABLE',
    });

    // No upsert attempted; repair bailed before reaching the write.
    expect(ruler.upsertCalls).toBe(upsertsBefore);
  });

  it('propagates ruler 4xx on upsert during repair and leaves the SO unchanged', async () => {
    const { svc, store, ruler, deploy, repairCtx, namespace } = makeHarness();
    const doc = await svc.create({ spec: validSpec() }, 'alice', deploy);

    const groupName =
      doc.status.provisioning.backend === 'prometheus' && doc.status.provisioning.ruleGroupName
        ? doc.status.provisioning.ruleGroupName
        : '';
    ruler.dropGroup(namespace, groupName);

    // Probe sees the missing group, repair moves to upsert — upsert rejects.
    ruler.setUpsertError(new SloRulerError('RULER_VALIDATION_FAILED', 400, 'bad rule'));

    const storedBefore = await store.get(doc.id);

    await expect(svc.repair(doc.id, repairCtx)).rejects.toMatchObject({
      name: 'SloRulerError',
      code: 'RULER_VALIDATION_FAILED',
    });

    // SO is unchanged (repair never mutates the store; only the ruler).
    const storedAfter = await store.get(doc.id);
    expect(storedAfter).toEqual(storedBefore);
  });

  it('rules_partial branch: probe first returns null then the group; repair upserts once and re-probes to ok', async () => {
    // Phase 1 SLOs persist a single rule group, so the on-disk partial case
    // and the all-missing case collapse to the same `expectedGroups` set of
    // size 1. We exercise the `rules_partial`-style wiring by scripting the
    // fake ruler's `getRuleGroup` to return null on the *first* call for the
    // SLO's group and the real stored group on subsequent calls — which makes
    // the pre-repair probe see 'missing' (1 of 1 absent) and the post-repair
    // probe see 'ok'. The branch under test is "repair upserts, then the
    // post-probe re-reads as healthy"; whether the pre-state was
    // rules_missing or rules_partial is structurally equivalent for Phase 1.
    const { svc, ruler, deploy, repairCtx, namespace } = makeHarness();
    const doc = await svc.create({ spec: validSpec() }, 'alice', deploy);

    const groupName =
      doc.status.provisioning.backend === 'prometheus' && doc.status.provisioning.ruleGroupName
        ? doc.status.provisioning.ruleGroupName
        : '';
    expect(ruler.hasGroup(namespace, groupName)).toBe(true);

    // Pre-probe answers 'missing'; after repair re-upserts and re-probes, the
    // fake has the group back and the post-probe answers 'ok'.
    ruler.setNullOnceForGroup(groupName);

    const result = await svc.repair(doc.id, repairCtx);
    expect(result.repaired).toBe(true);
    expect(result.health.state).toBe('ok');
    expect(result.health.presentGroups).toEqual([groupName]);
    expect(ruler.hasGroup(namespace, groupName)).toBe(true);
  });

  it('throws SloNotFoundError when the SLO id is unknown', async () => {
    const { svc, repairCtx } = makeHarness();
    await expect(svc.repair('no-such-slo', repairCtx)).rejects.toBeInstanceOf(SloNotFoundError);
  });
});
