/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateSloSpec, validateSloId } from '../slo_validators';
import { DEFAULT_MWMBR_TIERS } from '../slo_promql_generator';
import type { SloSpec } from '../slo_types';

function minimalSpec(overrides: Partial<SloSpec> = {}): Partial<SloSpec> {
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

describe('validateSloSpec', () => {
  it('accepts a minimal valid spec', () => {
    const result = validateSloSpec(minimalSpec());
    expect(result.errors).toEqual({});
  });

  it('rejects missing name', () => {
    const result = validateSloSpec(minimalSpec({ name: '' }));
    expect(result.errors['spec.name']).toBeDefined();
  });

  it('rejects an objective target out of range', () => {
    const result = validateSloSpec(minimalSpec({ objectives: [{ name: 'x', target: 1.1 }] }));
    expect(result.errors['spec.objectives[0].target']).toBeDefined();
  });

  it('rejects rolling windows shorter than 1 day', () => {
    const result = validateSloSpec(minimalSpec({ window: { type: 'rolling', duration: '1h' } }));
    expect(result.errors['spec.window.duration']).toBeDefined();
  });

  it('warns when window > 3d (approximation)', () => {
    const result = validateSloSpec(minimalSpec());
    expect(result.warnings['spec.window.duration']).toContain('approximation');
  });

  it('rejects composite SLI (P2 deferral)', () => {
    const result = validateSloSpec(
      minimalSpec({
        sli: { type: 'composite', operator: 'all', members: [] },
      })
    );
    expect(result.errors['spec.sli.type']).toContain('P2');
  });

  it('rejects latency_threshold without latencyThreshold on each objective', () => {
    const result = validateSloSpec(
      minimalSpec({
        sli: {
          type: 'single',
          definition: {
            backend: 'prometheus',
            type: 'latency_threshold',
            calcMethod: 'events',
            metric: 'http_request_duration_seconds_bucket',
          },
          dimensions: [{ name: 'service', value: 'api' }],
        },
        objectives: [{ name: 'latency', target: 0.99 }],
      })
    );
    expect(result.errors['spec.objectives[0].latencyThreshold']).toBeDefined();
  });

  it('warns when latency threshold in seconds looks like milliseconds', () => {
    const result = validateSloSpec(
      minimalSpec({
        sli: {
          type: 'single',
          definition: {
            backend: 'prometheus',
            type: 'latency_threshold',
            calcMethod: 'events',
            metric: 'x_bucket',
            latencyThresholdUnit: 'seconds',
          },
          dimensions: [{ name: 'service', value: 'api' }],
        },
        objectives: [{ name: 'latency', target: 0.99, latencyThreshold: 500 }],
      })
    );
    expect(result.warnings['spec.objectives[0].latencyThreshold']).toContain('did you mean');
  });

  it('rejects reserved slo_* label keys', () => {
    const result = validateSloSpec(minimalSpec({ labels: { slo_id: 'hijacked' } }));
    expect(result.errors['spec.labels["slo_id"]']).toBeDefined();
  });

  it('rejects label values containing unsafe PromQL characters', () => {
    const result = validateSloSpec(minimalSpec({ labels: { foo: 'value"with"quotes' } }));
    expect(result.errors['spec.labels["foo"]']).toBeDefined();
  });
});

describe('validateSloId', () => {
  it('accepts a valid slug', () => {
    expect(validateSloId('my-api-availability')).toBeNull();
  });
  it('rejects uppercase or underscores', () => {
    expect(validateSloId('MY_SLO')).not.toBeNull();
  });
  it('rejects short slugs', () => {
    expect(validateSloId('ab')).not.toBeNull();
  });
});
