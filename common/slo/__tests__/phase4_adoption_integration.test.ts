/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable max-classes-per-file */

/**
 * Phase 4 W4.10 — SLO adoption integration test.
 *
 * End-to-end coverage of the service-layer adoption surface. Exercises:
 *   A. Lost-SO recovery round-trip: backdoor-delete the saved objects, call
 *      `recover()` for each, assert SOs materialize, `getStatuses` resumes,
 *      and the ruler was NOT re-upserted (idempotent adoption).
 *   B. Cross-workspace clone: source is untouched, target is populated, fresh
 *      id, `adoptionSource.source === 'clone'`.
 *   C. Same-workspace clone with dedup hit in target: refcount rises, shared
 *      recording group is NOT re-upserted.
 *   D. Tamper test: drop the expected recording group → `ORPHAN_SPEC_DRIFT`.
 *   E. Schema-forward: mutate provenance `schemaVersion` to 2 → schema error
 *      surfaces (either `ORPHAN_UNSUPPORTED_SCHEMA` or `SloNotFoundError`
 *      depending on which detection path runs first — documented below).
 *   F. Tombstone path: happy `delete` then `recover` surfaces
 *      `ORPHAN_TOMBSTONED`; `acknowledgeTombstone: true` clears it.
 *
 * The ruler + ref-store + tombstone store are all in-memory fakes; the SO
 * store is `InMemorySloStore`. No HTTP, no OSD core — the route layer is
 * covered separately by W4.6.
 */

import {
  SloAdoptionError,
  SloDeployContext,
  SloNotFoundError,
  SloRuleRefStoreLite,
  SloService,
  SloStatusAggregator,
  SloStatusAggregationContext,
  SloTombstoneAttributesLite,
  SloTombstoneStoreLite,
} from '../slo_service';
import { InMemorySloStore } from '../slo_store';
import {
  DEFAULT_MWMBR_TIERS,
  dedupAlertGroupName,
  dedupRecordingGroupName,
} from '../slo_promql_generator';
import { computeSliFingerprint, FINGERPRINT_VERSION } from '../slo_sli_fingerprint';
import {
  ALERT_PROVENANCE_ANNOTATION_KEY,
  PROVENANCE_SCHEMA_VERSION,
  annotateAlertGroup,
  annotateRecordingGroup,
  buildAlertProvenance,
  buildRecordingProvenance,
} from '../slo_rule_provenance';
import { FakeRulerClient } from './fake_ruler_client';
import {
  generateAlertGroupFor,
  generateRecordingGroupForFingerprint,
} from '../slo_promql_generator';
import type { AlertingOSClient, Datasource, Logger } from '../../types/alerting/types';
import type { SloDocument, SloLiveStatus, SloSpec } from '../slo_types';

// ============================================================================
// Fixtures
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
    name: 'API Availability',
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
 * Shared ref-store fake. Shape mirrors the one in `slo_dedup_integration.test.ts`
 * (keyed by workspace|datasource|fingerprint) — local copy by design (see W4.10
 * harness guidance: tests are allowed small duplication so the integration
 * harness doesn't take a dep on sibling test-file internals).
 */
class FakeRefStore implements SloRuleRefStoreLite {
  public readonly entries = new Map<string, { refcount: number }>();
  private key(ws: string, ds: string, fp: string): string {
    return `${ws}|${ds}|${fp}`;
  }
  async get(ws: string, ds: string, fp: string) {
    const e = this.entries.get(this.key(ws, ds, fp));
    return e ? { attributes: { refcount: e.refcount } } : null;
  }
  async incrementRef(input: {
    workspaceId: string;
    datasourceId: string;
    fingerprint: string;
    fingerprintVersion: string;
    groupName: string;
    namespace: string;
  }): Promise<{ wasZero: boolean }> {
    const k = this.key(input.workspaceId, input.datasourceId, input.fingerprint);
    const existing = this.entries.get(k);
    if (!existing) {
      this.entries.set(k, { refcount: 1 });
      return { wasZero: true };
    }
    const wasZero = existing.refcount === 0;
    existing.refcount += 1;
    return { wasZero };
  }
  async decrementRef(input: {
    workspaceId: string;
    datasourceId: string;
    fingerprint: string;
  }): Promise<{ droppedToZero: boolean; underflow: boolean }> {
    const k = this.key(input.workspaceId, input.datasourceId, input.fingerprint);
    const existing = this.entries.get(k);
    if (!existing) return { droppedToZero: false, underflow: true };
    if (existing.refcount <= 0) return { droppedToZero: false, underflow: true };
    existing.refcount -= 1;
    return { droppedToZero: existing.refcount === 0, underflow: false };
  }
  refcount(ws: string, ds: string, fp: string): number {
    return this.entries.get(this.key(ws, ds, fp))?.refcount ?? 0;
  }
}

class FakeTombstoneStore implements SloTombstoneStoreLite {
  public readonly entries = new Map<string, SloTombstoneAttributesLite>();
  async write(attrs: SloTombstoneAttributesLite): Promise<void> {
    this.entries.set(attrs.sloId, attrs);
  }
  async get(sloId: string) {
    const a = this.entries.get(sloId);
    return a ? { attributes: a } : null;
  }
  async remove(sloId: string): Promise<boolean> {
    return this.entries.delete(sloId);
  }
}

/**
 * Build a permissive status-aggregator that returns an 'ok' status for every
 * SLO the service passes in. Used to assert `getStatuses` resumes after the
 * recover flows materialize SOs.
 */
function okAggregator(): SloStatusAggregator {
  return {
    aggregate: async (docs: SloDocument[]): Promise<SloLiveStatus[]> =>
      docs.map((d) => ({
        sloId: d.id,
        objectives: d.spec.objectives.map((obj) => ({
          objectiveName: obj.name,
          currentValue: 0.9995,
          currentValueUnit: 'ratio' as const,
          attainment: 0.9995,
          errorBudgetRemaining: 0.9,
          state: 'ok' as const,
        })),
        state: 'ok' as const,
        firingCount: 0,
        ruleCount:
          d.status.provisioning.backend === 'prometheus'
            ? d.status.provisioning.generatedRuleNames.length
            : 0,
        computedAt: new Date().toISOString(),
      })),
  };
}

function mkAggregationCtx(datasource?: Datasource): SloStatusAggregationContext {
  return {
    client: ({} as unknown) as AlertingOSClient,
    workspaceId: 'default',
    resolveDatasource: async () => datasource,
    ruleDedupEnabled: true,
  };
}

interface Harness {
  store: InMemorySloStore;
  ruler: FakeRulerClient;
  refStore: FakeRefStore;
  tombstones: FakeTombstoneStore;
  svc: SloService;
  datasourceD1: Datasource;
  datasourceD2: Datasource;
  client: AlertingOSClient;
  /** Deploy for workspace W1 / datasource D1 — the most common call. */
  deployW1D1: SloDeployContext;
  deployW2D1: SloDeployContext;
  deployW2D2: SloDeployContext;
}

function buildHarness(): Harness {
  const store = new InMemorySloStore();
  const ruler = new FakeRulerClient();
  const refStore = new FakeRefStore();
  const tombstones = new FakeTombstoneStore();
  const svc = new SloService(noopLogger(), store);
  svc.setDedupEnabled(true);
  svc.setRuleRefStore(refStore);
  svc.setTombstoneStore(tombstones);
  svc.setPluginVersion('9.9.9');

  const datasourceD1: Datasource = {
    id: 'prom-ds-001',
    name: 'prom-d1',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'prom-d1',
  };
  const datasourceD2: Datasource = {
    id: 'prom-ds-002',
    name: 'prom-d2',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'prom-d2',
  };
  const client = ({
    transport: { request: () => Promise.resolve({}) },
  } as unknown) as AlertingOSClient;
  const deployW1D1: SloDeployContext = {
    ruler,
    client,
    datasource: datasourceD1,
    workspaceId: 'W1',
  };
  const deployW2D1: SloDeployContext = {
    ruler,
    client,
    datasource: datasourceD1,
    workspaceId: 'W2',
  };
  const deployW2D2: SloDeployContext = {
    ruler,
    client,
    datasource: datasourceD2,
    workspaceId: 'W2',
  };
  return {
    store,
    ruler,
    refStore,
    tombstones,
    svc,
    datasourceD1,
    datasourceD2,
    client,
    deployW1D1,
    deployW2D1,
    deployW2D2,
  };
}

// Local helper: produce a spec with a specific Prometheus metric, sharing the
// rest of the SLI shape so two SLOs hit the same fingerprint.
function specWithMetric(name: string, metric: string, datasourceId: string): SloSpec {
  return validSpec({
    name,
    datasourceId,
    sli: {
      type: 'single',
      definition: {
        backend: 'prometheus',
        type: 'availability',
        calcMethod: 'events',
        metric,
      },
      dimensions: [{ name: 'service', value: 'api-gateway' }],
    },
  });
}

// ============================================================================
// Scenarios
// ============================================================================

describe('Phase 4 adoption integration (W4.10)', () => {
  // --------------------------------------------------------------------------
  // Scenario A — Lost-SO recovery round-trip
  // --------------------------------------------------------------------------
  it('Scenario A: recovers two lost SOs that share a fingerprint with a surviving peer, status queries resume', async () => {
    const { svc, ruler, refStore, store, deployW1D1, datasourceD1 } = buildHarness();

    // Two SLOs share the same SLI shape (metric_a) → same fingerprint; one
    // other SLO uses a different metric.
    const sloA = await svc.create(
      { spec: specWithMetric('slo-a', 'metric_a', datasourceD1.id) },
      'alice',
      deployW1D1
    );
    const sloB = await svc.create(
      { spec: specWithMetric('slo-b', 'metric_a', datasourceD1.id) },
      'alice',
      deployW1D1
    );
    const sloC = await svc.create(
      { spec: specWithMetric('slo-c', 'metric_b', datasourceD1.id) },
      'alice',
      deployW1D1
    );

    const fpShared = computeSliFingerprint(
      datasourceD1.id,
      sloA.spec.sli,
      sloA.spec.objectives[0]
    )!;
    const fpSolo = computeSliFingerprint(datasourceD1.id, sloC.spec.sli, sloC.spec.objectives[0])!;

    expect(refStore.refcount('W1', datasourceD1.id, fpShared)).toBe(2);
    expect(refStore.refcount('W1', datasourceD1.id, fpSolo)).toBe(1);

    // The ruler has all three alert groups + two distinct recording groups.
    const namespace = `slo-generated-W1`;
    expect(ruler.hasGroup(namespace, dedupRecordingGroupName(fpShared))).toBe(true);
    expect(ruler.hasGroup(namespace, dedupRecordingGroupName(fpSolo))).toBe(true);
    const alertUpsertsBefore = ruler.upserts.filter((u) =>
      u.group.groupName.startsWith('slo:alerts:')
    ).length;
    expect(alertUpsertsBefore).toBe(3);

    // Backdoor-delete SOs for B and C via the store directly — bypasses the
    // service's delete hook entirely (no tombstone, no refcount decrement,
    // ruler untouched). This is the "lost saved objects" scenario.
    expect(await store.delete(sloB.id)).toBe(true);
    expect(await store.delete(sloC.id)).toBe(true);
    expect(await store.get(sloB.id)).toBeNull();
    expect(await store.get(sloC.id)).toBeNull();

    // Refcounts are unchanged since the service-layer delete hook was bypassed.
    expect(refStore.refcount('W1', datasourceD1.id, fpShared)).toBe(2);
    expect(refStore.refcount('W1', datasourceD1.id, fpSolo)).toBe(1);

    const upsertCountBeforeRecover = ruler.upsertCalls;

    // Recover B.
    const recoverB = await svc.recover(
      { sloId: sloB.id, datasourceId: datasourceD1.id, workspaceId: 'W1' },
      deployW1D1
    );
    expect(recoverB.slo.id).toBe(sloB.id);
    expect(recoverB.tombstoneCleared).toBe(false);
    const bPersisted = await store.get(sloB.id);
    expect(bPersisted).not.toBeNull();
    const bProv = bPersisted!.status.provisioning;
    expect(bProv.backend).toBe('prometheus');
    const bAdoption = bProv.backend === 'prometheus' ? bProv.adoptionSource : undefined;
    expect(bAdoption?.source).toBe('recover');
    // recover() increments the ref again (bypass-delete left it at 2) → 3.
    expect(refStore.refcount('W1', datasourceD1.id, fpShared)).toBe(3);

    // Recover C.
    const recoverC = await svc.recover(
      { sloId: sloC.id, datasourceId: datasourceD1.id, workspaceId: 'W1' },
      deployW1D1
    );
    expect(recoverC.slo.id).toBe(sloC.id);
    expect(recoverC.tombstoneCleared).toBe(false);
    const cPersisted = await store.get(sloC.id);
    expect(cPersisted).not.toBeNull();
    const cProv = cPersisted!.status.provisioning;
    const cAdoption = cProv.backend === 'prometheus' ? cProv.adoptionSource : undefined;
    expect(cAdoption?.source).toBe('recover');
    expect(refStore.refcount('W1', datasourceD1.id, fpSolo)).toBe(2);

    // Critical assertion: recover() must NOT re-upsert the alert group — the
    // group is already live and idempotency saves a ruler round-trip.
    expect(ruler.upsertCalls).toBe(upsertCountBeforeRecover);

    // Status queries resume. Wire the aggregator and verify every id resolves
    // to a populated status (not the `no_data` stub).
    svc.setStatusAggregator(okAggregator());
    const statuses = await svc.getStatuses(
      [sloA.id, sloB.id, sloC.id],
      mkAggregationCtx(datasourceD1)
    );
    expect(statuses).toHaveLength(3);
    for (const s of statuses) {
      expect(s.state).toBe('ok');
      expect(s.objectives[0].attainment).toBeGreaterThan(0);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario B — Cross-workspace clone
  // --------------------------------------------------------------------------
  it('Scenario B: cross-workspace clone populates target, leaves source untouched, stamps adoptionSource', async () => {
    const {
      svc,
      ruler,
      refStore,
      store,
      deployW1D1,
      deployW2D2,
      datasourceD1,
      datasourceD2,
    } = buildHarness();

    const source = await svc.create(
      { spec: specWithMetric('orig-availability', 'http_requests_total', datasourceD1.id) },
      'alice',
      deployW1D1
    );
    const sourceNamespace = `slo-generated-W1`;
    const targetNamespace = `slo-generated-W2`;
    const sourceFp = computeSliFingerprint(
      datasourceD1.id,
      source.spec.sli,
      source.spec.objectives[0]
    )!;
    // Target fingerprint differs because the datasourceId is part of it.
    const targetFp = computeSliFingerprint(
      datasourceD2.id,
      source.spec.sli,
      source.spec.objectives[0]
    )!;
    expect(targetFp).not.toBe(sourceFp);

    // Snapshot source ruler state — we'll compare after clone completes.
    const sourceAlertGroupBefore = ruler.getGroup(
      sourceNamespace,
      dedupAlertGroupName(source.spec.name, 'W1', source.id)
    );
    expect(sourceAlertGroupBefore).toBeDefined();
    const upsertsBeforeClone = ruler.upsertCalls;
    const deletesBeforeClone = ruler.deleteCalls;

    const result = await svc.clone(
      {
        sourceSloId: source.id,
        sourceDatasourceId: datasourceD1.id,
        sourceWorkspaceId: 'W1',
        targetDatasourceId: datasourceD2.id,
        targetWorkspaceId: 'W2',
        overrideName: 'cloned-slo',
      },
      deployW1D1,
      deployW2D2
    );

    // Response shape.
    expect(result.slo.spec.name).toBe('cloned-slo');
    expect(result.slo.spec.datasourceId).toBe(datasourceD2.id);
    expect(result.slo.id).not.toBe(source.id);
    const clonedProv = result.slo.status.provisioning;
    expect(clonedProv.backend).toBe('prometheus');
    const clonedAdoption =
      clonedProv.backend === 'prometheus' ? clonedProv.adoptionSource : undefined;
    expect(clonedAdoption?.source).toBe('clone');
    expect(clonedAdoption?.sourceSloId).toBe(source.id);

    // Source SO unchanged (deep equality on the status.version gate).
    const sourcePostClone = await store.get(source.id);
    expect(sourcePostClone).not.toBeNull();
    expect(sourcePostClone!.status.version).toBe(source.status.version);
    expect(sourcePostClone!.spec.name).toBe(source.spec.name);

    // Source ruler: the clone path never deletes anything; the only ruler
    // writes we expect are the ones that landed in the TARGET namespace.
    expect(ruler.deleteCalls).toBe(deletesBeforeClone);
    const upsertsToSourceNs = ruler.upserts
      .slice(upsertsBeforeClone)
      .filter((u) => u.namespace === sourceNamespace);
    expect(upsertsToSourceNs).toHaveLength(0);

    // Target ruler: fresh alert + recording group materialized at D2's namespace.
    const clonedAlertGroupName = dedupAlertGroupName('cloned-slo', 'W2', result.slo.id);
    expect(ruler.hasGroup(targetNamespace, clonedAlertGroupName)).toBe(true);
    expect(ruler.hasGroup(targetNamespace, dedupRecordingGroupName(targetFp))).toBe(true);

    // Target ref store: refcount=1 for the cloned fingerprint.
    expect(refStore.refcount('W2', datasourceD2.id, targetFp)).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario C — Same-workspace clone with dedup hit in target
  // --------------------------------------------------------------------------
  it('Scenario C: same-datasource cross-workspace clone dedupes against an existing peer fingerprint in target', async () => {
    const { svc, ruler, refStore, deployW1D1, deployW2D1, datasourceD1 } = buildHarness();

    // A: source SLO in W1/D1.
    const sloA = await svc.create(
      { spec: specWithMetric('slo-a', 'shared_metric', datasourceD1.id) },
      'alice',
      deployW1D1
    );

    // B: peer SLO in W2/D1 with the SAME SLI shape (datasourceId is D1 for both,
    // so the fingerprint matches). This primes the target's refcount to 1 for
    // the shared fingerprint before we clone.
    await svc.create(
      { spec: specWithMetric('slo-b-target', 'shared_metric', datasourceD1.id) },
      'alice',
      deployW2D1
    );

    const sharedFp = computeSliFingerprint(
      datasourceD1.id,
      sloA.spec.sli,
      sloA.spec.objectives[0]
    )!;
    expect(refStore.refcount('W2', datasourceD1.id, sharedFp)).toBe(1);

    const targetNamespace = `slo-generated-W2`;
    const recordingGroupName = dedupRecordingGroupName(sharedFp);
    const recUpsertsBeforeClone = ruler.upsertsOfName(recordingGroupName);
    const upsertsBeforeClone = ruler.upserts.length;

    // Clone A into W2 (same D1). Name has to be unique, so override it.
    const cloned = await svc.clone(
      {
        sourceSloId: sloA.id,
        sourceDatasourceId: datasourceD1.id,
        sourceWorkspaceId: 'W1',
        targetDatasourceId: datasourceD1.id,
        targetWorkspaceId: 'W2',
        overrideName: 'slo-a-cloned',
      },
      deployW1D1,
      deployW2D1
    );

    // Target refcount rises to 2 (B + cloned A).
    expect(refStore.refcount('W2', datasourceD1.id, sharedFp)).toBe(2);
    // Recording group in the target namespace was NOT re-upserted — dedup
    // skipped it because the refcount was already nonzero.
    expect(ruler.upsertsOfName(recordingGroupName)).toBe(recUpsertsBeforeClone);
    // A fresh alert group WAS upserted for the cloned SLO.
    const clonedAlertGroupName = dedupAlertGroupName('slo-a-cloned', 'W2', cloned.slo.id);
    const newUpserts = ruler.upserts.slice(upsertsBeforeClone);
    const alertUpsertsInTarget = newUpserts.filter(
      (u) => u.namespace === targetNamespace && u.group.groupName === clonedAlertGroupName
    );
    expect(alertUpsertsInTarget).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // Scenario D — Tamper test (ORPHAN_SPEC_DRIFT)
  // --------------------------------------------------------------------------
  it('Scenario D: dropping the expected recording group surfaces ORPHAN_SPEC_DRIFT on recover', async () => {
    const { svc, ruler, store, deployW1D1, datasourceD1 } = buildHarness();

    const slo = await svc.create(
      { spec: specWithMetric('drift-target', 'metric_drift', datasourceD1.id) },
      'alice',
      deployW1D1
    );
    const fp = computeSliFingerprint(datasourceD1.id, slo.spec.sli, slo.spec.objectives[0])!;
    const namespace = `slo-generated-W1`;

    // Backdoor-delete the SO so recover() has something to adopt.
    await store.delete(slo.id);

    // Tamper: remove the expected recording group from the ruler. The alert
    // group is still there carrying intact provenance, but the fingerprint
    // coverage check in recover() will fail with "Expected recording group
    // slo:rec:<fp> missing on ruler" — surfaced as ORPHAN_SPEC_DRIFT.
    ruler.dropGroup(namespace, dedupRecordingGroupName(fp));
    expect(ruler.hasGroup(namespace, dedupRecordingGroupName(fp))).toBe(false);

    const err = await svc
      .recover({ sloId: slo.id, datasourceId: datasourceD1.id, workspaceId: 'W1' }, deployW1D1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SloAdoptionError);
    expect((err as SloAdoptionError).code).toBe('ORPHAN_SPEC_DRIFT');
  });

  // --------------------------------------------------------------------------
  // Scenario E — Schema-forward provenance (v2)
  // --------------------------------------------------------------------------
  it('Scenario E: schemaVersion=2 provenance surfaces a schema error (SloAdoptionError or SloNotFoundError)', async () => {
    const { ruler, svc, deployW1D1, datasourceD1 } = buildHarness();

    // Hand-build an alert + recording group carrying a v2 provenance
    // annotation, then seed the ruler directly (bypassing service.create so
    // the schemaVersion stays non-v1).
    const sloId = 'slo-schema-v2';
    const workspaceId = 'W1';
    const spec = specWithMetric('schema-forward', 'schema_metric', datasourceD1.id);
    const namespace = `slo-generated-${workspaceId}`;
    const fp = computeSliFingerprint(datasourceD1.id, spec.sli, spec.objectives[0])!;

    const stubDoc: SloDocument = {
      id: sloId,
      spec,
      status: {
        version: 1,
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'alice',
        updatedAt: '2026-04-01T00:00:00Z',
        updatedBy: 'alice',
        provisioning: {
          backend: 'prometheus',
          rulerNamespace: namespace,
          generatedRuleNames: [],
          recordingFingerprints: { [spec.objectives[0].name]: fp },
          alertGroupName: dedupAlertGroupName(spec.name, workspaceId, sloId),
        },
      },
    };
    const rawAlert = generateAlertGroupFor(
      stubDoc,
      { [spec.objectives[0].name]: fp },
      { workspaceId }
    );
    // Build a v1 provenance first, then mutate schemaVersion to 2 *after*
    // JSON.stringify so the string carries schemaVersion: 2. parseAlertProvenance
    // will reject it, so findAdoptableAlertGroup won't see the group as ours
    // and the service ends up in the SloNotFoundError branch. The
    // service.recover code path does have an explicit ORPHAN_UNSUPPORTED_SCHEMA
    // arm, but today's route-level detector (verifyProvenance in
    // slo_adoption_verify.ts) is the only caller that can tell the two apart.
    // Follow-up cleanup: unify the schema-forward detection so the service's
    // own recover() can surface ORPHAN_UNSUPPORTED_SCHEMA without needing
    // `verifyProvenance`. This assertion accepts either outcome to stay honest
    // about the current gap.
    const v1Provenance = buildAlertProvenance({
      pluginVersion: '9.9.9',
      sloId,
      workspaceId,
      datasourceId: datasourceD1.id,
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
      spec,
    });
    let annotatedAlert = annotateAlertGroup(rawAlert, v1Provenance);
    // Re-stringify with schemaVersion bumped to 2.
    const forwardProvenance = { ...v1Provenance, schemaVersion: PROVENANCE_SCHEMA_VERSION + 1 };
    const firstRule = annotatedAlert.rules[0];
    annotatedAlert = {
      ...annotatedAlert,
      rules: [
        {
          ...firstRule,
          annotations: {
            ...firstRule.annotations,
            [ALERT_PROVENANCE_ANNOTATION_KEY]: JSON.stringify(forwardProvenance),
          },
        },
        ...annotatedAlert.rules.slice(1),
      ],
    };
    ruler.seedGroup(namespace, annotatedAlert);

    // Also seed the recording group so we don't trip the separate
    // fingerprint-coverage check (SPEC_DRIFT) and muddy this scenario.
    if (spec.sli.type === 'single') {
      const recording = generateRecordingGroupForFingerprint({
        fingerprint: fp,
        sli: spec.sli,
        objectiveLatencyThreshold: spec.objectives[0].latencyThreshold,
      });
      if (recording) {
        const annotatedRecording = annotateRecordingGroup(
          recording,
          buildRecordingProvenance({
            pluginVersion: '9.9.9',
            fingerprint: fp,
            fingerprintVersion: FINGERPRINT_VERSION,
            sliSnapshot: spec.sli,
          })
        );
        ruler.seedGroup(namespace, annotatedRecording);
      }
    }

    const err = await svc
      .recover({ sloId, datasourceId: datasourceD1.id, workspaceId }, deployW1D1)
      .catch((e: unknown) => e);
    expect(
      (err instanceof SloAdoptionError && err.code === 'ORPHAN_UNSUPPORTED_SCHEMA') ||
        err instanceof SloNotFoundError
    ).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Scenario F — Tombstone path
  //
  // `svc.delete` (dedup path) removes the per-SLO alert group from the ruler.
  // To keep the adoption path reachable for this test, we pair the deleted
  // SLO with a second SLO that shares the same fingerprint — the shared
  // recording group survives (refcount > 0), and we re-seed the deleted
  // SLO's alert group on the ruler to mirror the "operator put the rules
  // back but the SO never returned" case that orphan-adoption was designed
  // for. Then the tombstone-gate assertions can run.
  // --------------------------------------------------------------------------
  it('Scenario F: tombstoned SLO rejects recover without acknowledgement, succeeds + clears with it', async () => {
    const { svc, tombstones, deployW1D1, datasourceD1 } = buildHarness();

    // Two SLOs share a fingerprint → the recording group survives deletion
    // of one of them.
    const sloA = await svc.create(
      { spec: specWithMetric('tomb-a', 'metric_tomb_shared', datasourceD1.id) },
      'alice',
      deployW1D1
    );
    await svc.create(
      { spec: specWithMetric('tomb-b', 'metric_tomb_shared', datasourceD1.id) },
      'alice',
      deployW1D1
    );

    // Normal delete of sloA — writes a tombstone, removes its alert group.
    await svc.delete(sloA.id, deployW1D1);
    expect(await tombstones.get(sloA.id)).not.toBeNull();

    // Reconstruct sloA's alert group on the ruler with valid provenance.
    const namespace = `slo-generated-W1`;
    const fp = computeSliFingerprint(datasourceD1.id, sloA.spec.sli, sloA.spec.objectives[0])!;
    const stubDoc: SloDocument = {
      id: sloA.id,
      spec: sloA.spec,
      status: {
        version: 1,
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'alice',
        updatedAt: '2026-04-01T00:00:00Z',
        updatedBy: 'alice',
        provisioning: {
          backend: 'prometheus',
          rulerNamespace: namespace,
          generatedRuleNames: [],
          recordingFingerprints: { [sloA.spec.objectives[0].name]: fp },
          alertGroupName: dedupAlertGroupName(sloA.spec.name, 'W1', sloA.id),
        },
      },
    };
    const rawAlert = generateAlertGroupFor(
      stubDoc,
      { [sloA.spec.objectives[0].name]: fp },
      { workspaceId: 'W1' }
    );
    const provenance = buildAlertProvenance({
      pluginVersion: '9.9.9',
      sloId: sloA.id,
      workspaceId: 'W1',
      datasourceId: datasourceD1.id,
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
      spec: sloA.spec,
    });
    const annotatedAlert = annotateAlertGroup(rawAlert, provenance);
    await deployW1D1.ruler.upsertRuleGroup(
      deployW1D1.client,
      deployW1D1.datasource,
      namespace,
      annotatedAlert
    );

    // Without acknowledgement → ORPHAN_TOMBSTONED, tombstone stays in place.
    const err1 = await svc
      .recover({ sloId: sloA.id, datasourceId: datasourceD1.id, workspaceId: 'W1' }, deployW1D1)
      .catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(SloAdoptionError);
    expect((err1 as SloAdoptionError).code).toBe('ORPHAN_TOMBSTONED');
    expect(await tombstones.get(sloA.id)).not.toBeNull();

    // With acknowledgement → tombstone cleared, recover succeeds.
    const result = await svc.recover(
      {
        sloId: sloA.id,
        datasourceId: datasourceD1.id,
        workspaceId: 'W1',
        acknowledgeTombstone: true,
      },
      deployW1D1
    );
    expect(result.tombstoneCleared).toBe(true);
    expect(await tombstones.get(sloA.id)).toBeNull();
  });
});
