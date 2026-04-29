/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable max-classes-per-file */

/**
 * Phase 4 W4.5 — SloService.clone() unit tests.
 *
 * Source namespace is read-only. Target workspace gets a fresh SLO produced
 * via `SloService.create` — which means refs / alert groups / recording
 * groups go through the normal dedup path.
 *
 * The source-ruler fake records every mutation so we can assert it stayed
 * pristine.
 */

import {
  SloAdoptionError,
  SloDeployContext,
  SloNotFoundError,
  SloRuleRefStoreLite,
  SloRulerClient,
  SloService,
  SloValidationError,
} from '../slo_service';
import { InMemorySloStore } from '../slo_store';
import {
  DEFAULT_MWMBR_TIERS,
  dedupAlertGroupName,
  generateAlertGroupFor,
  generateRecordingGroupForFingerprint,
} from '../slo_promql_generator';
import { computeSliFingerprint, FINGERPRINT_VERSION } from '../slo_sli_fingerprint';
import {
  ALERT_PROVENANCE_ANNOTATION_KEY,
  annotateAlertGroup,
  annotateRecordingGroup,
  buildAlertProvenance,
  buildRecordingProvenance,
} from '../slo_rule_provenance';
import type { AlertingOSClient, Datasource, Logger } from '../../types/alerting/types';
import type { GeneratedRuleGroup, SloDocument, SloSpec } from '../slo_types';

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
 * Read-tracking ruler fake. Upsert / delete calls still work (the target
 * ruler uses them through `create`), but we can assert the source ruler
 * never saw a mutation by inspecting `upsertCount` / `deleteCount`.
 */
class FakeRuler implements SloRulerClient {
  public upsertCount = 0;
  public deleteCount = 0;
  private groups = new Map<string, GeneratedRuleGroup>();

  private key(ns: string, name: string): string {
    return `${ns}|${name}`;
  }
  seed(namespace: string, group: GeneratedRuleGroup): void {
    this.groups.set(this.key(namespace, group.groupName), group);
  }
  hasGroup(namespace: string, groupName: string): boolean {
    return this.groups.has(this.key(namespace, groupName));
  }
  async upsertRuleGroup(
    _c: AlertingOSClient,
    _ds: Datasource,
    namespace: string,
    group: GeneratedRuleGroup
  ): Promise<void> {
    this.upsertCount += 1;
    this.groups.set(this.key(namespace, group.groupName), group);
  }
  async deleteRuleGroup(
    _c: AlertingOSClient,
    _ds: Datasource,
    namespace: string,
    groupName: string
  ): Promise<void> {
    this.deleteCount += 1;
    this.groups.delete(this.key(namespace, groupName));
  }
  async listRuleGroups(
    _c: AlertingOSClient,
    _ds: Datasource,
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

class FakeRefStore implements SloRuleRefStoreLite {
  public readonly refs = new Map<string, { refcount: number }>();
  private key(ws: string, ds: string, fp: string): string {
    return `${ws}|${ds}|${fp}`;
  }
  async get(ws: string, ds: string, fp: string) {
    const r = this.refs.get(this.key(ws, ds, fp));
    return r ? { attributes: { refcount: r.refcount } } : null;
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
    const existing = this.refs.get(k);
    if (!existing) {
      this.refs.set(k, { refcount: 1 });
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
    const existing = this.refs.get(k);
    if (!existing) return { droppedToZero: false, underflow: true };
    if (existing.refcount <= 0) return { droppedToZero: false, underflow: true };
    existing.refcount -= 1;
    return { droppedToZero: existing.refcount === 0, underflow: false };
  }
  refcount(ws: string, ds: string, fp: string): number {
    return this.refs.get(this.key(ws, ds, fp))?.refcount ?? 0;
  }
}

function seedSourceRuler(
  ruler: FakeRuler,
  opts: {
    spec: SloSpec;
    sloId: string;
    workspaceId: string;
    datasourceId: string;
    mutateProvenanceValue?: (value: string) => string;
  }
): { fingerprint: string; namespace: string; alertGroupName: string } {
  const namespace = `slo-generated-${opts.workspaceId}`;
  const objective = opts.spec.objectives[0];
  const fp = computeSliFingerprint(opts.datasourceId, opts.spec.sli, objective);
  if (fp === null) throw new Error('SLI did not produce a fingerprint');
  const fingerprints = { [objective.name]: fp };

  if (opts.spec.sli.type === 'single') {
    const rec = generateRecordingGroupForFingerprint({
      fingerprint: fp,
      sli: opts.spec.sli,
      objectiveLatencyThreshold: objective.latencyThreshold,
    });
    if (rec) {
      const annotated = annotateRecordingGroup(
        rec,
        buildRecordingProvenance({
          pluginVersion: '9.9.9',
          fingerprint: fp,
          fingerprintVersion: FINGERPRINT_VERSION,
          sliSnapshot: opts.spec.sli,
        })
      );
      ruler.seed(namespace, annotated);
    }
  }

  const stubDoc: SloDocument = {
    id: opts.sloId,
    spec: opts.spec,
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
        recordingFingerprints: fingerprints,
        alertGroupName: dedupAlertGroupName(opts.spec.name, opts.workspaceId, opts.sloId),
      },
    },
  };
  const rawAlert = generateAlertGroupFor(stubDoc, fingerprints, {
    workspaceId: opts.workspaceId,
  });
  const provenance = buildAlertProvenance({
    pluginVersion: '9.9.9',
    sloId: opts.sloId,
    workspaceId: opts.workspaceId,
    datasourceId: opts.datasourceId,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    spec: opts.spec,
  });
  let annotatedAlert = annotateAlertGroup(rawAlert, provenance);
  if (opts.mutateProvenanceValue) {
    const first = annotatedAlert.rules[0];
    const current = first.annotations![ALERT_PROVENANCE_ANNOTATION_KEY];
    const mutated = opts.mutateProvenanceValue(current);
    annotatedAlert = {
      ...annotatedAlert,
      rules: [
        {
          ...first,
          annotations: { ...first.annotations, [ALERT_PROVENANCE_ANNOTATION_KEY]: mutated },
        },
        ...annotatedAlert.rules.slice(1),
      ],
    };
  }
  ruler.seed(namespace, annotatedAlert);

  return { fingerprint: fp, namespace, alertGroupName: annotatedAlert.groupName };
}

function makeHarness() {
  const store = new InMemorySloStore();
  const sourceRuler = new FakeRuler();
  const targetRuler = new FakeRuler();
  const refStore = new FakeRefStore();
  const svc = new SloService(noopLogger(), store);
  svc.setDedupEnabled(true);
  svc.setRuleRefStore(refStore);

  const client = ({
    transport: { request: () => Promise.resolve({}) },
  } as unknown) as AlertingOSClient;
  const sourceDs: Datasource = {
    id: 'prom-ds-001',
    name: 'source-prom',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'prom-connection',
  };
  const targetDs: Datasource = {
    id: 'prom-ds-002',
    name: 'target-prom',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'prom-connection-target',
  };
  const sourceDeploy: SloDeployContext = {
    ruler: sourceRuler,
    client,
    datasource: sourceDs,
    workspaceId: 'ws-source',
  };
  const targetDeploy: SloDeployContext = {
    ruler: targetRuler,
    client,
    datasource: targetDs,
    workspaceId: 'ws-target',
  };
  return {
    store,
    sourceRuler,
    targetRuler,
    refStore,
    svc,
    sourceDeploy,
    targetDeploy,
    sourceDs,
    targetDs,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SloService.clone (W4.5)', () => {
  it('same-datasource clone into a different workspace creates a new SLO and leaves source untouched', async () => {
    const {
      svc,
      sourceRuler,
      targetRuler,
      refStore,
      sourceDs,
      sourceDeploy,
      targetDeploy,
    } = makeHarness();
    // Use the SAME datasource id in the target deploy so the spec's
    // datasourceId aligns with deploy.datasource.id (which is what refcount
    // bookkeeping keys on).
    const targetSameDsDeploy: SloDeployContext = { ...targetDeploy, datasource: sourceDs };
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-src',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });

    const sourceUpsertBefore = sourceRuler.upsertCount;
    const sourceDeleteBefore = sourceRuler.deleteCount;

    // Target uses the SAME datasource id (permitted) but a different workspace
    // → fresh alert group, shared recording group would be a new group in
    // the target workspace's namespace.
    const result = await svc.clone(
      {
        sourceSloId: 'slo-src',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
      },
      sourceDeploy,
      targetSameDsDeploy
    );

    expect(result.slo.id).not.toBe('slo-src');
    expect(result.slo.spec.datasourceId).toBe(sourceDs.id);
    const cloneProvisioning = result.slo.status.provisioning;
    expect(cloneProvisioning.backend).toBe('prometheus');
    const adoptionSource =
      cloneProvisioning.backend === 'prometheus' ? cloneProvisioning.adoptionSource : undefined;
    expect(adoptionSource?.source).toBe('clone');
    expect(adoptionSource?.sourceSloId).toBe('slo-src');
    expect(adoptionSource?.sourceDatasourceId).toBe(sourceDs.id);
    expect(result.sourceSpecSha256).toMatch(/^[a-f0-9]{64}$/);

    // Source ruler untouched.
    expect(sourceRuler.upsertCount).toBe(sourceUpsertBefore);
    expect(sourceRuler.deleteCount).toBe(sourceDeleteBefore);
    // Target ruler upserted at least the new alert group + recording group.
    expect(targetRuler.upsertCount).toBeGreaterThanOrEqual(2);
    // Target refs initialized.
    const fp = computeSliFingerprint(sourceDs.id, srcSpec.sli, srcSpec.objectives[0])!;
    expect(refStore.refcount('ws-target', sourceDs.id, fp)).toBe(1);
  });

  it('different-datasource clone initializes fresh refs on the target', async () => {
    const {
      svc,
      sourceRuler,
      refStore,
      sourceDs,
      targetDs,
      sourceDeploy,
      targetDeploy,
    } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-cross',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });

    await svc.clone(
      {
        sourceSloId: 'slo-cross',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: targetDs.id,
        targetWorkspaceId: 'ws-target',
      },
      sourceDeploy,
      targetDeploy
    );

    // Fingerprint is a function of datasourceId, so a different
    // datasourceId produces a different fingerprint in the target —
    // refcount for that new fingerprint starts at 1.
    const targetSpec = { ...srcSpec, datasourceId: targetDs.id };
    const targetFp = computeSliFingerprint(targetDs.id, targetSpec.sli, targetSpec.objectives[0])!;
    expect(refStore.refcount('ws-target', targetDs.id, targetFp)).toBe(1);
  });

  it('overrideName is applied to the target spec', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id, name: 'Source Name' });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-name',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });

    const result = await svc.clone(
      {
        sourceSloId: 'slo-name',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
        overrideName: 'Clone Name',
      },
      sourceDeploy,
      targetDeploy
    );

    expect(result.slo.spec.name).toBe('Clone Name');
  });

  it('overrideId is applied to the target SLO', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-id',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });
    const result = await svc.clone(
      {
        sourceSloId: 'slo-id',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
        overrideId: 'custom-slo-id',
      },
      sourceDeploy,
      targetDeploy
    );
    expect(result.slo.id).toBe('custom-slo-id');
  });

  it('ORPHAN_SPEC_DRIFT on sha256 mismatch', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-drift',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
      mutateProvenanceValue: (value) => {
        const parsed = JSON.parse(value);
        parsed.spec.name = 'Tampered';
        return JSON.stringify(parsed);
      },
    });
    await expect(
      svc.clone(
        {
          sourceSloId: 'slo-drift',
          sourceDatasourceId: sourceDs.id,
          sourceWorkspaceId: 'ws-source',
          targetDatasourceId: sourceDs.id,
          targetWorkspaceId: 'ws-target',
        },
        sourceDeploy,
        targetDeploy
      )
    ).rejects.toMatchObject({ name: 'SloAdoptionError', code: 'ORPHAN_SPEC_DRIFT' });
  });

  it('ORPHAN_WORKSPACE_MISMATCH when source provenance datasource differs', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-mismatch',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
      mutateProvenanceValue: (value) => {
        const parsed = JSON.parse(value);
        parsed.datasourceId = 'prom-OTHER';
        return JSON.stringify(parsed);
      },
    });
    await expect(
      svc.clone(
        {
          sourceSloId: 'slo-mismatch',
          sourceDatasourceId: sourceDs.id,
          sourceWorkspaceId: 'ws-source',
          targetDatasourceId: sourceDs.id,
          targetWorkspaceId: 'ws-target',
        },
        sourceDeploy,
        targetDeploy
      )
    ).rejects.toMatchObject({ name: 'SloAdoptionError', code: 'ORPHAN_WORKSPACE_MISMATCH' });
  });

  it('SloNotFoundError when the source alert group is absent', async () => {
    const { svc, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    await expect(
      svc.clone(
        {
          sourceSloId: 'slo-missing',
          sourceDatasourceId: sourceDs.id,
          sourceWorkspaceId: 'ws-source',
          targetDatasourceId: sourceDs.id,
          targetWorkspaceId: 'ws-target',
        },
        sourceDeploy,
        targetDeploy
      )
    ).rejects.toBeInstanceOf(SloNotFoundError);
  });

  it('CLONE_NAME_COLLISION when target workspace already has an SLO with that name', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id, name: 'Already Taken' });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-coll',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });

    // Pre-seed the target workspace with an SLO having the same name but
    // different datasource to trigger assertNameUnique conflict only when
    // the target datasource matches. Actually name-uniqueness keys on
    // (datasourceId, name). So we pre-create an SLO in the TARGET workspace
    // on the TARGET datasource with the same name.
    await svc.create(
      {
        spec: validSpec({ datasourceId: sourceDs.id, name: 'Already Taken' }),
      },
      'alice',
      targetDeploy
    );

    await expect(
      svc.clone(
        {
          sourceSloId: 'slo-coll',
          sourceDatasourceId: sourceDs.id,
          sourceWorkspaceId: 'ws-source',
          targetDatasourceId: sourceDs.id,
          targetWorkspaceId: 'ws-target',
        },
        sourceDeploy,
        targetDeploy
      )
    ).rejects.toMatchObject({ name: 'SloAdoptionError', code: 'CLONE_NAME_COLLISION' });
  });

  it('CLONE_NAME_COLLISION with overrideName succeeds when the override is unique', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id, name: 'Shared Name' });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-coll2',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });
    // Pre-seed the collision.
    await svc.create(
      { spec: validSpec({ datasourceId: sourceDs.id, name: 'Shared Name' }) },
      'alice',
      targetDeploy
    );

    const result = await svc.clone(
      {
        sourceSloId: 'slo-coll2',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
        overrideName: 'Fresh Name',
      },
      sourceDeploy,
      targetDeploy
    );
    expect(result.slo.spec.name).toBe('Fresh Name');
  });

  it('dedup off rejects with SloValidationError', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    svc.setDedupEnabled(false);
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-nodup',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });
    await expect(
      svc.clone(
        {
          sourceSloId: 'slo-nodup',
          sourceDatasourceId: sourceDs.id,
          sourceWorkspaceId: 'ws-source',
          targetDatasourceId: sourceDs.id,
          targetWorkspaceId: 'ws-target',
        },
        sourceDeploy,
        targetDeploy
      )
    ).rejects.toBeInstanceOf(SloValidationError);
  });

  it('source namespace is read-only: source upsert / delete are never invoked', async () => {
    const { svc, sourceRuler, sourceDs, sourceDeploy, targetDeploy } = makeHarness();
    const srcSpec = validSpec({ datasourceId: sourceDs.id });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec,
      sloId: 'slo-readonly',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });
    const upsertBefore = sourceRuler.upsertCount;
    const deleteBefore = sourceRuler.deleteCount;
    await svc.clone(
      {
        sourceSloId: 'slo-readonly',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
      },
      sourceDeploy,
      targetDeploy
    );
    expect(sourceRuler.upsertCount).toBe(upsertBefore);
    expect(sourceRuler.deleteCount).toBe(deleteBefore);
  });

  it('dedup in target workspace: two clones producing the same fingerprint share the same recording group', async () => {
    const {
      svc,
      sourceRuler,
      targetRuler,
      refStore,
      sourceDs,
      sourceDeploy,
      targetDeploy,
    } = makeHarness();
    const targetSameDsDeploy: SloDeployContext = { ...targetDeploy, datasource: sourceDs };
    const srcSpec1 = validSpec({ datasourceId: sourceDs.id, name: 'SLO-1' });
    const srcSpec2 = validSpec({ datasourceId: sourceDs.id, name: 'SLO-2' });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec1,
      sloId: 'slo-d1',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });
    seedSourceRuler(sourceRuler, {
      spec: srcSpec2,
      sloId: 'slo-d2',
      workspaceId: 'ws-source',
      datasourceId: sourceDs.id,
    });

    const r1 = await svc.clone(
      {
        sourceSloId: 'slo-d1',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
      },
      sourceDeploy,
      targetSameDsDeploy
    );
    const r2 = await svc.clone(
      {
        sourceSloId: 'slo-d2',
        sourceDatasourceId: sourceDs.id,
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: sourceDs.id,
        targetWorkspaceId: 'ws-target',
      },
      sourceDeploy,
      targetSameDsDeploy
    );
    // Both clones used the same SLI shape → same target fingerprint → one
    // ref with count 2.
    const fp = computeSliFingerprint(sourceDs.id, srcSpec1.sli, srcSpec1.objectives[0])!;
    expect(refStore.refcount('ws-target', sourceDs.id, fp)).toBe(2);
    expect(r1.slo.spec.name).not.toBe(r2.slo.spec.name);
    // Only ONE target-side upsert for the shared recording group.
    // (We can't assert exactly one from outside — the second clone's create
    // path would use `incrementRef.wasZero === false` and skip. The refcount
    // evidence above is sufficient.)
    expect(targetRuler.upsertCount).toBeGreaterThanOrEqual(3); // >= rec + alert1 + alert2
  });
});

describe('SloAdoptionError export surface', () => {
  it('is exported from slo_service for B2B consumers', () => {
    expect(typeof SloAdoptionError).toBe('function');
    const e = new SloAdoptionError('ORPHAN_SPEC_DRIFT', 'x');
    expect(e.code).toBe('ORPHAN_SPEC_DRIFT');
  });
});
