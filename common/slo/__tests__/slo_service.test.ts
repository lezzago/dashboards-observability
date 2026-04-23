/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SloService tests — pins regression surfaces for:
 *   - W1.2 removal of the `_demoState` annotation back-door. Anyone who can
 *     set an SLO annotation must NOT be able to override the computed health
 *     state. The stub returns 'disabled' when `spec.enabled === false` and
 *     'no_data' otherwise, full stop.
 *   - W1.3(c) 6-significant-figure target clamp in `normalizeSpec` (happens
 *     in the service layer, not the validator — validators stay pure).
 */

import { SloService, SloValidationError } from '../slo_service';
import { DEFAULT_MWMBR_TIERS } from '../slo_promql_generator';
import type { Logger } from '../../types/alerting/types';
import type { SloSpec } from '../slo_types';

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

// ============================================================================
// W1.2 — computeStatus / getStatus contract + no `_demoState` back-door
// ============================================================================

describe('SloService.getStatus — stub contract (W1.2)', () => {
  it('returns state=disabled when spec.enabled is false', async () => {
    const svc = new SloService(noopLogger());
    const doc = await svc.create({ spec: validSpec({ enabled: false }) });
    const status = await svc.getStatus(doc.id);
    expect(status.state).toBe('disabled');
    expect(status.objectives.every((o) => o.state === 'disabled')).toBe(true);
  });

  it('returns state=no_data when spec.enabled is true (live aggregator deferred)', async () => {
    const svc = new SloService(noopLogger());
    const doc = await svc.create({ spec: validSpec({ enabled: true }) });
    const status = await svc.getStatus(doc.id);
    expect(status.state).toBe('no_data');
    expect(status.objectives.every((o) => o.state === 'no_data')).toBe(true);
  });

  // Regression: before W1.2 landed, `spec.annotations._demoState` could flip
  // reported state to 'ok' / 'breached' / anything the attacker chose. The
  // demo hook is gone. Annotations are metadata and MUST NOT leak into status.
  it('ignores the removed _demoState annotation back-door (annotations do not affect status)', async () => {
    const svc = new SloService(noopLogger());
    const doc = await svc.create({
      spec: validSpec({ enabled: true, annotations: { _demoState: 'ok' } }),
    });
    const status = await svc.getStatus(doc.id);
    // enabled=true → no_data. If the back-door were back, this would be 'ok'.
    expect(status.state).toBe('no_data');
  });

  it('ignores _demoState even on a disabled SLO', async () => {
    const svc = new SloService(noopLogger());
    const doc = await svc.create({
      spec: validSpec({ enabled: false, annotations: { _demoState: 'breached' } }),
    });
    const status = await svc.getStatus(doc.id);
    expect(status.state).toBe('disabled');
  });

  it('errorBudgetRemaining is 1 in the no_data state (full budget, stub contract)', async () => {
    const svc = new SloService(noopLogger());
    const doc = await svc.create({ spec: validSpec({ enabled: true }) });
    const status = await svc.getStatus(doc.id);
    expect(status.objectives).toHaveLength(1);
    expect(status.objectives[0].errorBudgetRemaining).toBe(1);
  });
});

// ============================================================================
// W1.3(c) — 6-sig-fig target clamp in normalizeSpec
// ============================================================================

describe('SloService.create — target precision clamp (W1.3c)', () => {
  it('clamps a 7th-digit target down to 6 significant figures', async () => {
    const svc = new SloService(noopLogger());
    // 0.9876543 * 1e6 = 987654.3 → Math.round → 987654 → 0.987654
    const doc = await svc.create({
      spec: validSpec({ objectives: [{ name: 'obj-a', target: 0.9876543 }] }),
    });
    expect(doc.spec.objectives[0].target).toBe(0.987654);
  });

  it('leaves a 6-sig-fig target unchanged', async () => {
    const svc = new SloService(noopLogger());
    const doc = await svc.create({
      spec: validSpec({ objectives: [{ name: 'obj-a', target: 0.987654 }] }),
    });
    expect(doc.spec.objectives[0].target).toBe(0.987654);
  });

  it('clamp runs before range validation — clamped value outside [0.5, 0.99999] still rejects', async () => {
    const svc = new SloService(noopLogger());
    // 0.9999995 * 1e6 = 999999.5 → round → 1000000 → 1.0 → rejected by range check.
    await expect(
      svc.create({ spec: validSpec({ objectives: [{ name: 'obj-a', target: 0.9999995 }] }) })
    ).rejects.toBeInstanceOf(SloValidationError);
  });
});
