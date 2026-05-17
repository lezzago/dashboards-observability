/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { DirectQueryPrometheusBackend } from '../directquery_prometheus_backend';
import type { Datasource, Logger } from '../../../../common/types/alerting';

const mockLogger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const mockClient = {
  transport: { request: jest.fn() },
};

const ds: Datasource = {
  id: 'ds-1',
  name: 'my-prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'my-prom',
};

let backend: DirectQueryPrometheusBackend;

beforeEach(() => {
  backend = new DirectQueryPrometheusBackend(mockLogger);
});

describe('DirectQueryPrometheusBackend', () => {
  // ---- discoverDatasources ----
  it('discoverDatasources returns Prometheus entries from SQL plugin', async () => {
    mockClient.transport.request.mockResolvedValueOnce({
      body: [
        { name: 'prom1', connector: 'PROMETHEUS', status: 'ACTIVE' },
        { name: 'os1', connector: 'OPENSEARCH', status: 'ACTIVE' },
      ],
    });
    const result = await backend.discoverDatasources(mockClient as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'prom1',
      type: 'prometheus',
      directQueryName: 'prom1',
    });
  });

  it('discoverDatasources returns empty on error', async () => {
    mockClient.transport.request.mockRejectedValueOnce(new Error('fail'));
    const result = await backend.discoverDatasources(mockClient as never);
    expect(result).toEqual([]);
  });

  // ---- getRuleGroups ----
  it('getRuleGroups maps raw groups to typed PromRuleGroup[]', async () => {
    mockClient.transport.request.mockResolvedValueOnce({
      body: {
        data: {
          groups: [
            {
              name: 'g1',
              file: 'rules.yml',
              interval: '60s',
              rules: [
                { name: 'HighCPU', type: 'alerting', query: 'up==0', state: 'firing', alerts: [] },
              ],
            },
          ],
        },
      },
    });
    const groups = await backend.getRuleGroups(mockClient as never, ds);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('g1');
    expect(groups[0].rules[0].name).toBe('HighCPU');
  });

  // ---- getAlerts ----
  it('getAlerts returns alerts from /api/v1/alerts', async () => {
    mockClient.transport.request.mockResolvedValueOnce({
      body: {
        data: {
          alerts: [{ labels: { alertname: 'X' }, state: 'firing', annotations: {} }],
        },
      },
    });
    const alerts = await backend.getAlerts(mockClient as never, ds);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].state).toBe('firing');
  });

  // ---- getMetricNames ----
  it('getMetricNames returns array from label values endpoint', async () => {
    mockClient.transport.request.mockResolvedValueOnce({ body: { data: ['up', 'node_cpu'] } });
    const names = await backend.getMetricNames(mockClient as never, ds);
    expect(names).toEqual(['up', 'node_cpu']);
  });

  it('getMetricNames returns empty on error', async () => {
    mockClient.transport.request.mockRejectedValueOnce(new Error('fail'));
    const names = await backend.getMetricNames(mockClient as never, ds);
    expect(names).toEqual([]);
  });

  // ---- getLabelNames ----
  it('getLabelNames rejects invalid metric name', async () => {
    const names = await backend.getLabelNames(mockClient as never, ds, 'bad{metric}');
    expect(names).toEqual([]);
    expect(mockClient.transport.request).not.toHaveBeenCalled();
  });

  // ---- getMetricMetadata ----
  it('getMetricMetadata maps raw metadata to typed array', async () => {
    mockClient.transport.request.mockResolvedValueOnce({
      body: { data: { up: [{ type: 'gauge', help: 'Up metric' }] } },
    });
    const meta = await backend.getMetricMetadata(mockClient as never, ds);
    expect(meta).toEqual([{ metric: 'up', type: 'gauge', help: 'Up metric' }]);
  });

  // ---- queryRange ----
  it('queryRange posts to DirectQuery execution endpoint', async () => {
    mockClient.transport.request.mockResolvedValueOnce({
      body: {
        results: { 'my-prom': { resultType: 'matrix', result: [{ values: [[1000, '42']] }] } },
      },
    });
    const points = await backend.queryRange(mockClient as never, ds, 'up', 100, 200, 15);
    expect(mockClient.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/_plugins/_directquery/_query/my-prom',
      })
    );
    expect(points).toEqual([{ timestamp: 1000000, value: 42 }]);
  });

  // ---- resolveDqName guard ----
  it('throws when datasource has no directQueryName', async () => {
    const noDq = { ...ds, directQueryName: undefined };
    await expect(backend.getRuleGroups(mockClient as never, noDq as never)).rejects.toThrow(
      /directQueryName/
    );
  });

  // =========================================================================
  // queryRangeMatrix / queryTimelineSeverityBuckets
  // =========================================================================

  describe('queryRangeMatrix', () => {
    it('parses a fixture with multiple series correctly', async () => {
      mockClient.transport.request.mockResolvedValueOnce({
        body: {
          results: {
            'my-prom': {
              resultType: 'matrix',
              result: [
                {
                  metric: { alertname: 'HighCPU', instance: 'a' },
                  values: [
                    [100, '1'],
                    [200, '1'],
                  ],
                },
                {
                  metric: { alertname: 'HighCPU', instance: 'b' },
                  values: [
                    [100, '0'],
                    [200, '1'],
                  ],
                },
                {
                  metric: { alertname: 'LowDisk' },
                  values: [[200, '1']],
                },
              ],
            },
          },
        },
      });
      const series = await backend.queryRangeMatrix(
        mockClient as never,
        ds,
        'ALERTS',
        100,
        300,
        60
      );
      expect(series).toHaveLength(3);
      expect(series[0].metric).toEqual({ alertname: 'HighCPU', instance: 'a' });
      expect(series[0].values).toEqual([
        { timestamp: 100_000, value: 1 },
        { timestamp: 200_000, value: 1 },
      ]);
      // Second series — mixed 0 and 1 preserved
      expect(series[1].values.map((v) => v.value)).toEqual([0, 1]);
    });
  });

  describe('queryTimelineSeverityBuckets', () => {
    beforeEach(() => mockClient.transport.request.mockClear());

    const matrix = (
      series: Array<{ metric: Record<string, string>; points: Array<[number, string]> }>
    ) => ({
      body: {
        results: {
          'my-prom': {
            resultType: 'matrix',
            result: series.map((s) => ({ metric: s.metric, values: s.points })),
          },
        },
      },
    });

    it('emits sum by(severity) PromQL with the alertstate=firing matcher', async () => {
      mockClient.transport.request.mockResolvedValueOnce(matrix([]));
      await backend.queryTimelineSeverityBuckets(mockClient as never, ds, 100, 400, 60);
      const calls = mockClient.transport.request.mock.calls as Array<
        [{ body?: { query?: string }; path?: string }]
      >;
      expect(calls[0][0].path).toBe('/_plugins/_directquery/_query/my-prom');
      expect(calls[0][0].body?.query).toBe('sum by(severity) (ALERTS{alertstate="firing"})');
    });

    it('appends extra matchers (e.g. severity filter) inside the selector', async () => {
      mockClient.transport.request.mockResolvedValueOnce(matrix([]));
      await backend.queryTimelineSeverityBuckets(mockClient as never, ds, 100, 400, 60, [
        'severity=~"critical|high"',
      ]);
      const calls = mockClient.transport.request.mock.calls as Array<
        [{ body?: { query?: string } }]
      >;
      expect(calls[0][0].body?.query).toBe(
        'sum by(severity) (ALERTS{alertstate="firing", severity=~"critical|high"})'
      );
    });

    it('falls back to count(...) when no severity grouping is requested', async () => {
      mockClient.transport.request.mockResolvedValueOnce(matrix([]));
      await backend.queryTimelineSeverityBuckets(mockClient as never, ds, 100, 400, 60, [], null);
      const calls = mockClient.transport.request.mock.calls as Array<
        [{ body?: { query?: string } }]
      >;
      expect(calls[0][0].body?.query).toBe('count(ALERTS{alertstate="firing"})');
    });

    it('parses the multi-series response and preserves severity labels', async () => {
      mockClient.transport.request.mockResolvedValueOnce(
        matrix([
          {
            metric: { severity: 'critical' },
            points: [
              [100, '2'],
              [160, '1'],
            ],
          },
          {
            metric: { severity: 'high' },
            points: [[100, '1']],
          },
        ])
      );
      const series = await backend.queryTimelineSeverityBuckets(
        mockClient as never,
        ds,
        100,
        160,
        60
      );
      expect(series).toHaveLength(2);
      expect(series[0].metric).toEqual({ severity: 'critical' });
      expect(series[0].values).toEqual([
        { timestamp: 100_000, value: 2 },
        { timestamp: 160_000, value: 1 },
      ]);
    });
  });
});
