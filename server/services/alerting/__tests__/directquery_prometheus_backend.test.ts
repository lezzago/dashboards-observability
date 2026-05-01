/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { DirectQueryPrometheusBackend } from '../directquery_prometheus_backend';
import type { Datasource, Logger } from '../../../../common/types/alerting/types';

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

  // ---- queryInstant error surfacing ----
  // Probe-SLI relies on DirectQuery parse errors reaching the route as thrown
  // exceptions so it can populate `errors.{good,total}`. Previously every
  // error path returned `[]`, which made invalid PromQL indistinguishable
  // from "no samples".
  it('queryInstant surfaces Cortex parse errors from transport rejection', async () => {
    // Simulate an OSD transport rejection carrying the Cortex error body.
    const transportErr = Object.assign(new Error('Response Error'), {
      meta: {
        body: {
          status: 'error',
          errorType: 'bad_data',
          error: 'parse error at char 42: unclosed left parenthesis',
        },
      },
    });
    mockClient.transport.request.mockRejectedValueOnce(transportErr);
    await expect(backend.queryInstant(mockClient as never, ds, 'bad(')).rejects.toThrow(
      /parse error at char 42/
    );
  });

  it('queryInstant surfaces Cortex parse errors from successful response envelope', async () => {
    // Some envelopes come back as 200 OK with a Prometheus-style error body.
    mockClient.transport.request.mockResolvedValueOnce({
      body: { status: 'error', errorType: 'bad_data', error: 'invalid parameter "query"' },
    });
    await expect(backend.queryInstant(mockClient as never, ds, 'bad(')).rejects.toThrow(
      /invalid parameter/
    );
  });

  it('queryInstant rethrows non-Cortex transport errors verbatim', async () => {
    // Timeouts / connection refused / OSD 401 don't carry the Prom envelope.
    mockClient.transport.request.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(backend.queryInstant(mockClient as never, ds, 'up')).rejects.toThrow(
      /ECONNREFUSED/
    );
  });

  it('queryInstant throws on SQL-plugin silent-rejection shape (results wrapper with no resultType)', async () => {
    // The SQL plugin shipped in observability-stack swallows Cortex parse
    // errors and returns a 200 OK whose `results.{ds}` is an empty object.
    // That's indistinguishable from "no samples" unless we treat missing
    // resultType as a rejection.
    mockClient.transport.request.mockResolvedValueOnce({
      body: { results: { 'my-prom': {} }, queryId: 'x', sessionId: 'y' },
    });
    await expect(backend.queryInstant(mockClient as never, ds, 'bad(')).rejects.toThrow(
      /Invalid PromQL|unsupported query/
    );
  });

  it('queryInstant does NOT throw on a genuine empty-vector response', async () => {
    // Legitimate "no matching series" — Prometheus returns vector with empty
    // result array. Must NOT trip the rejection detector.
    mockClient.transport.request.mockResolvedValueOnce({
      body: { results: { 'my-prom': { resultType: 'vector', result: [] } } },
    });
    const points = await backend.queryInstant(mockClient as never, ds, 'up{nope="x"}');
    expect(points).toEqual([]);
  });
});
