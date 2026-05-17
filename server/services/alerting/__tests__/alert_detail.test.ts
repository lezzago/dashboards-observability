/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 3 / A3 test: getPromRuleDetail uses the lazy probe + post-filter.
 * Phase 3 / B3 test: getOSRuleDetail no longer fetches destinations.
 */
import { getPromRuleDetail, getOSRuleDetail } from '../alert_detail';
import type { Datasource, PromAlertingRule } from '../../../../common/types/alerting';
import type { ProbeResult, PromFilterProbe } from '../prom_filter_probe';
import { sampleOSMonitor } from '../../../../common/services/alerting/__tests__/fixtures';

const ds: Datasource = {
  id: 'ds-prom',
  name: 'prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prom',
};

const osDs: Datasource = {
  id: 'ds-os',
  name: 'os',
  type: 'opensearch',
  url: '',
  enabled: true,
};

const buildAlertingRule = (name: string): PromAlertingRule => ({
  type: 'alerting',
  name,
  query: 'up == 0',
  duration: 0,
  labels: {},
  annotations: {},
  alerts: [],
  health: 'ok',
  state: 'inactive',
});

describe('getPromRuleDetail (Phase 3 / A3)', () => {
  it('issues a scoped /rules call with rule_group + rule_name when probe says pushdown-works', async () => {
    const rule = buildAlertingRule('HighCPU');
    const getRuleGroups = jest.fn(async () => [
      { name: 'g1', file: '', interval: 60, rules: [rule] },
    ]);
    const probe: PromFilterProbe = {
      probe: jest.fn(async (): Promise<ProbeResult> => ({ status: 'pushdown-works' })),
      reset: jest.fn(),
    };
    const promBackend = { getRuleGroups } as never;

    const detail = await getPromRuleDetail(
      promBackend,
      {} as never,
      ds,
      'ds-prom-g1-HighCPU',
      probe
    );
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('HighCPU');
    expect(getRuleGroups).toHaveBeenCalledWith(
      expect.anything(),
      ds,
      { ruleGroup: 'g1', ruleName: 'HighCPU', type: 'alert' },
      { includeAlerts: true }
    );
  });

  it('falls back to a full listing when probe says pushdown-ignored', async () => {
    const rule = buildAlertingRule('HighCPU');
    const getRuleGroups = jest.fn(async () => [
      { name: 'g1', file: '', interval: 60, rules: [rule] },
    ]);
    const probe: PromFilterProbe = {
      probe: jest.fn(async (): Promise<ProbeResult> => ({ status: 'pushdown-ignored' })),
      reset: jest.fn(),
    };
    const promBackend = { getRuleGroups } as never;

    const detail = await getPromRuleDetail(
      promBackend,
      {} as never,
      ds,
      'ds-prom-g1-HighCPU',
      probe
    );
    expect(detail).not.toBeNull();
    expect(getRuleGroups).toHaveBeenCalledWith(expect.anything(), ds, undefined, {
      includeAlerts: true,
    });
  });

  it('post-filters the response so the wrong rule never sneaks past pushdown-works', async () => {
    // Simulates a Cortex bug: probe said pushdown works, but on this scoped
    // request the upstream returned a *different* rule. JS post-filter must
    // catch it and return null rather than the wrong one.
    const wrongRule = buildAlertingRule('LowDisk');
    const getRuleGroups = jest.fn(async () => [
      { name: 'g1', file: '', interval: 60, rules: [wrongRule] },
    ]);
    const probe: PromFilterProbe = {
      probe: jest.fn(async (): Promise<ProbeResult> => ({ status: 'pushdown-works' })),
      reset: jest.fn(),
    };
    const promBackend = { getRuleGroups } as never;

    const detail = await getPromRuleDetail(
      promBackend,
      {} as never,
      ds,
      'ds-prom-g1-HighCPU',
      probe
    );
    expect(detail).toBeNull();
  });

  it('works without a probe (legacy callers fall through to the unfiltered path)', async () => {
    const rule = buildAlertingRule('HighCPU');
    const getRuleGroups = jest.fn(async () => [
      { name: 'g1', file: '', interval: 60, rules: [rule] },
    ]);
    const promBackend = { getRuleGroups } as never;

    const detail = await getPromRuleDetail(promBackend, {} as never, ds, 'ds-prom-g1-HighCPU');
    expect(detail).not.toBeNull();
    expect(getRuleGroups).toHaveBeenCalledWith(expect.anything(), ds, undefined, {
      includeAlerts: true,
    });
  });
});

describe('getOSRuleDetail (Phase 3 / B3)', () => {
  const osBackend = {
    getMonitor: jest.fn(),
    getAlerts: jest.fn(),
    getDestinations: jest.fn(),
    searchQuery: jest.fn(async () => ({
      aggregations: { time_buckets: { buckets: [] } },
    })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not call getDestinations and returns notificationRouting: []', async () => {
    osBackend.getMonitor.mockResolvedValueOnce(sampleOSMonitor);
    osBackend.getAlerts.mockResolvedValueOnce({ alerts: [], totalAlerts: 0, truncated: false });
    const result = await getOSRuleDetail(osBackend as never, {} as never, osDs, 'mon-1');
    expect(result).not.toBeNull();
    expect(result!.notificationRouting).toEqual([]);
    expect(osBackend.getDestinations).not.toHaveBeenCalled();
  });
});
