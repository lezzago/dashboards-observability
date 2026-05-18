/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 3 / A3 test: getPromRuleDetail uses the lazy probe + post-filter.
 * Phase 3 / B3 test: getOSRuleDetail no longer fetches destinations.
 * Historical-Prom test: getAlertDetail walks `ALERTS{<labels>}` to emit
 * per-episode start/end times when labels + range are supplied.
 */
import {
  getPromRuleDetail,
  getOSRuleDetail,
  walkPromEpisodes,
  getAlertDetail,
} from '../alert_detail';
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

describe('walkPromEpisodes', () => {
  it('returns [] for an empty point list', () => {
    expect(walkPromEpisodes([], 60_000)).toEqual([]);
  });

  it('emits one episode for a single contiguous run', () => {
    // 5 samples 1 minute apart — 4 minute span, 5 samples.
    const points = [0, 60, 120, 180, 240].map((s) => ({
      timestamp: 1_700_000_000_000 + s * 1000,
      value: 1,
    }));
    const episodes = walkPromEpisodes(points, 60_000);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startMs).toBe(points[0].timestamp);
    expect(episodes[0].endMs).toBe(points[points.length - 1].timestamp);
    expect(episodes[0].sampleCount).toBe(5);
  });

  it('splits on gaps larger than 1.5 × step into separate episodes', () => {
    const stepMs = 60_000;
    const base = 1_700_000_000_000;
    // run A: 3 samples at t=0,60,120; gap of 5min; run B: 2 samples at t=420,480.
    const points = [0, 60, 120, 420, 480].map((s) => ({
      timestamp: base + s * 1000,
      value: 1,
    }));
    const episodes = walkPromEpisodes(points, stepMs);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].sampleCount).toBe(3);
    expect(episodes[1].sampleCount).toBe(2);
    expect(episodes[0].endMs).toBeLessThan(episodes[1].startMs);
  });
});

describe('getAlertDetail (Prom historical episodes)', () => {
  const datasourceService = {
    list: jest.fn(),
    get: jest.fn(async () => ds),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    testConnection: jest.fn(),
  };

  it('returns null when labels or range are missing (no episode walk possible)', async () => {
    const promBackend = {
      type: 'prometheus' as const,
      queryRangeMatrix: jest.fn(),
    };
    const result = await getAlertDetail(
      datasourceService as never,
      undefined,
      promBackend as never,
      {} as never,
      'ds-prom',
      'a-1'
    );
    expect(result).toBeNull();
    expect(promBackend.queryRangeMatrix).not.toHaveBeenCalled();
  });

  it('range-walks ALERTS{<labels>} and emits per-episode start/end times', async () => {
    const base = Date.parse('2026-05-01T00:00:00Z');
    // Use a 24h window so step ≈ 24h/200 ≈ 432s (within [15, 600]).
    // Samples 432s apart → fall under the 1.5×step gap threshold so they
    // collapse into a single episode.
    const startIso = '2026-05-01T00:00:00Z';
    const endIso = '2026-05-02T00:00:00Z';
    const points = [0, 432, 864].map((s) => ({ timestamp: base + s * 1000, value: 1 }));
    const queryRangeMatrix = jest.fn(async () => [{ metric: {}, values: points }]);
    const promBackend = {
      type: 'prometheus' as const,
      queryRangeMatrix,
    };

    const result = await getAlertDetail(
      datasourceService as never,
      undefined,
      promBackend as never,
      {} as never,
      'ds-prom',
      'a-1',
      undefined,
      { alertname: 'HighCPU', instance: 'host-1' },
      startIso,
      endIso
    );

    expect(result).not.toBeNull();
    expect(result!.isHistorical).toBe(true);
    expect(result!.name).toBe('HighCPU');
    const raw = (result!.raw as unknown) as { episodes: Array<{ startMs: number; endMs: number }> };
    expect(raw.episodes).toHaveLength(1);
    expect(raw.episodes[0].startMs).toBe(points[0].timestamp);
    expect(raw.episodes[0].endMs).toBe(points[points.length - 1].timestamp);
    // Query string must pin BOTH labels into the selector.
    const queryArg = queryRangeMatrix.mock.calls[0][2] as string;
    expect(queryArg).toContain('alertname="HighCPU"');
    expect(queryArg).toContain('instance="host-1"');
    // step bounded to [15, 600] seconds.
    const stepArg = queryRangeMatrix.mock.calls[0][5] as number;
    expect(stepArg).toBeGreaterThanOrEqual(15);
    expect(stepArg).toBeLessThanOrEqual(600);
  });

  it('returns episode list with empty episodes when upstream returned no series', async () => {
    const promBackend = {
      type: 'prometheus' as const,
      queryRangeMatrix: jest.fn(async () => []),
    };
    const result = await getAlertDetail(
      datasourceService as never,
      undefined,
      promBackend as never,
      {} as never,
      'ds-prom',
      'a-1',
      undefined,
      { alertname: 'X' },
      'now-1h',
      'now'
    );
    expect(result).not.toBeNull();
    const raw = (result!.raw as unknown) as { episodes: unknown[] };
    expect(raw.episodes).toEqual([]);
  });
});
