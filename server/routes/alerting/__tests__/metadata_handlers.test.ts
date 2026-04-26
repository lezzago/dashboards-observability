/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  handleGetMetricNames,
  handleGetLabelNames,
  handleGetLabelValues,
  handleGetMetricMetadata,
} from '../metadata_handlers';

const mockService = {
  getMetricNames: jest.fn(),
  getLabelNames: jest.fn(),
  getLabelValues: jest.fn(),
  getMetricMetadata: jest.fn(),
};

const mockClient = {};
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

describe('metadata_handlers', () => {
  // ---- handleGetMetricNames ----
  it('returns sorted, truncated metric names', async () => {
    mockService.getMetricNames.mockResolvedValueOnce(['z_metric', 'a_metric']);
    const result = await handleGetMetricNames(mockService as never, mockClient, 'ds-1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ metrics: ['a_metric', 'z_metric'], total: 2, truncated: false });
  });

  it('returns empty metrics on service error', async () => {
    mockService.getMetricNames.mockRejectedValueOnce(new Error('fail'));
    const result = await handleGetMetricNames(
      mockService as never,
      mockClient,
      'ds-1',
      undefined,
      mockLogger
    );
    expect(result.body).toEqual({ metrics: [], total: 0, truncated: false });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ---- handleGetLabelNames ----
  it('returns sorted label names', async () => {
    mockService.getLabelNames.mockResolvedValueOnce(['job', '__name__']);
    const result = await handleGetLabelNames(mockService as never, mockClient, 'ds-1');
    expect(result.body).toEqual({ labels: ['__name__', 'job'] });
  });

  it('returns empty labels on error', async () => {
    mockService.getLabelNames.mockRejectedValueOnce(new Error('fail'));
    const result = await handleGetLabelNames(
      mockService as never,
      mockClient,
      'ds-1',
      undefined,
      mockLogger
    );
    expect(result.body).toEqual({ labels: [] });
  });

  // ---- handleGetLabelValues ----
  it('returns sorted label values', async () => {
    mockService.getLabelValues.mockResolvedValueOnce(['b', 'a']);
    const result = await handleGetLabelValues(mockService as never, mockClient, 'ds-1', 'job');
    expect(result.body).toEqual({ values: ['a', 'b'], total: 2, truncated: false });
  });

  it('returns empty values on error', async () => {
    mockService.getLabelValues.mockRejectedValueOnce(new Error('fail'));
    const result = await handleGetLabelValues(
      mockService as never,
      mockClient,
      'ds-1',
      'job',
      undefined,
      mockLogger
    );
    expect(result.body).toEqual({ values: [], total: 0, truncated: false });
  });

  // ---- handleGetMetricNames: cap behaviour ----
  // Previous cap was 200, which silently dropped `http_*`, `rpc_*`, and other
  // high-letter metric families on realistic tenants. The cap is now high
  // enough that sensible universes pass through intact.
  it('does not truncate a 1000-metric universe that includes late-alphabet OTel families', async () => {
    const otelFamilies = [
      'http_server_request_duration_seconds_count',
      'http_server_request_duration_seconds_bucket',
      'rpc_server_duration_seconds_count',
      'rpc_server_duration_seconds_bucket',
      'messaging_process_duration_seconds_bucket',
    ];
    // 995 short "ax…"/"bx…" names to flood the early alphabet, plus the OTel
    // ones at the end — if the cap is too tight, OTel falls off first.
    const flood = Array.from({ length: 995 }, (_, i) => `a_metric_${String(i).padStart(4, '0')}`);
    mockService.getMetricNames.mockResolvedValueOnce([...flood, ...otelFamilies]);
    const result = await handleGetMetricNames(mockService as never, mockClient, 'ds-1');
    expect(result.body.truncated).toBe(false);
    expect(result.body.total).toBe(1000);
    // Every OTel family the Suggest page detects must survive the handler cap.
    for (const family of otelFamilies) {
      expect(result.body.metrics).toContain(family);
    }
  });

  // ---- handleGetMetricMetadata ----
  it('returns metadata from service', async () => {
    const meta = [{ metric: 'up', type: 'gauge', help: 'Up' }];
    mockService.getMetricMetadata.mockResolvedValueOnce(meta);
    const result = await handleGetMetricMetadata(mockService as never, mockClient, 'ds-1');
    expect(result).toEqual({ status: 200, body: { metadata: meta } });
  });

  it('returns empty metadata on error', async () => {
    mockService.getMetricMetadata.mockRejectedValueOnce(new Error('fail'));
    const result = await handleGetMetricMetadata(
      mockService as never,
      mockClient,
      'ds-1',
      mockLogger
    );
    expect(result.body).toEqual({ metadata: [] });
  });
});
