/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Post-Phase-3/5 handler tests. The 6 datasource-CRUD handlers
 * (`handleListDatasources`, `handleGet/Create/Update/Delete/TestDatasource`)
 * are no longer exercised — datasource discovery moved to the client via
 * `useDatasources` and direct saved-object queries. The handlers may still
 * be present as dead exports in `handlers.ts`; they are no longer wired by
 * `registerAlertingRoutes` and no longer have test coverage here.
 *
 * Surviving handlers: monitor CRUD, alerts, unified views, and detail
 * views. Those are what this file covers.
 */

import {
  handleGetOSMonitors,
  handleCreateOSMonitor,
  handleDeleteOSMonitor,
  handleGetUnifiedAlerts,
  handleGetUnifiedTimeline,
  handleGetOSAlerts,
  handleGetPromAlerts,
  handleGetAlertDetail,
  handleGetRuleDetail,
  handleGetRuleRouting,
} from '../handlers';

const mockAlertSvc = {
  getOSMonitors: jest.fn(),
  getOSMonitor: jest.fn(),
  createOSMonitor: jest.fn(),
  updateOSMonitor: jest.fn(),
  deleteOSMonitor: jest.fn(),
  getOSAlerts: jest.fn(),
  acknowledgeOSAlerts: jest.fn(),
  getPromRuleGroups: jest.fn(),
  getPromAlerts: jest.fn(),
  getUnifiedAlerts: jest.fn(),
  getUnifiedRules: jest.fn(),
  getRuleDetail: jest.fn(),
  getRuleRouting: jest.fn(),
  getAlertDetail: jest.fn(),
  getUnifiedTimeline: jest.fn(),
};

const mockClient = {} as never;

describe('handlers', () => {
  // ---- Monitor handlers ----
  it('handleGetOSMonitors returns monitors', async () => {
    mockAlertSvc.getOSMonitors.mockResolvedValueOnce([{ id: 'mon-1' }]);
    const result = await handleGetOSMonitors(mockAlertSvc as never, mockClient, 'ds-1');
    expect(result).toEqual({ status: 200, body: { monitors: [{ id: 'mon-1' }] } });
  });

  it('handleCreateOSMonitor returns 201', async () => {
    mockAlertSvc.createOSMonitor.mockResolvedValueOnce({ id: 'mon-1' });
    const result = await handleCreateOSMonitor(mockAlertSvc as never, mockClient, 'ds-1', {
      name: 'test',
    } as never);
    expect(result.status).toBe(201);
  });

  it('handleDeleteOSMonitor returns 404 when not found', async () => {
    mockAlertSvc.deleteOSMonitor.mockResolvedValueOnce(false);
    const result = await handleDeleteOSMonitor(mockAlertSvc as never, mockClient, 'ds-1', 'nope');
    expect(result.status).toBe(404);
  });

  // ---- Unified + Detail ----
  it('handleGetUnifiedAlerts parses query and delegates', async () => {
    mockAlertSvc.getUnifiedAlerts.mockResolvedValueOnce({ results: [] });
    const resolver = jest.fn();
    const result = await handleGetUnifiedAlerts(mockAlertSvc as never, resolver, {
      dsIds: 'a,b',
      maxResults: '10',
    });
    expect(result.status).toBe(200);
    // Use `objectContaining` because the handler always forwards the new
    // `startTime`/`endTime` keys (as `undefined` when absent). An exact
    // deep-equal would pass today by Jest's loose-undefined semantics but
    // becomes misleading if that behavior changes.
    expect(mockAlertSvc.getUnifiedAlerts).toHaveBeenCalledWith(
      resolver,
      expect.objectContaining({
        dsIds: ['a', 'b'],
        timeoutMs: undefined,
        maxResults: 10,
      })
    );
  });

  it('handleGetAlertDetail returns 404 when not found', async () => {
    mockAlertSvc.getAlertDetail.mockResolvedValueOnce(null);
    const result = await handleGetAlertDetail(mockAlertSvc as never, mockClient, 'ds-1', 'nope');
    expect(result.status).toBe(404);
  });

  it('handleGetAlertDetail forwards monitorId to the service', async () => {
    mockAlertSvc.getAlertDetail.mockResolvedValueOnce({ id: 'a-1' });
    await handleGetAlertDetail(mockAlertSvc as never, mockClient, 'ds-1', 'a-1', 'mon-42');
    expect(mockAlertSvc.getAlertDetail).toHaveBeenCalledWith(mockClient, 'ds-1', 'a-1', 'mon-42');
  });

  it('handleGetRuleDetail returns 404 when not found', async () => {
    mockAlertSvc.getRuleDetail.mockResolvedValueOnce(null);
    const result = await handleGetRuleDetail(mockAlertSvc as never, mockClient, 'ds-1', 'nope');
    expect(result.status).toBe(404);
  });

  // ---- handleGetRuleRouting (Phase 3 / B3) ----
  it('handleGetRuleRouting returns 404 when the rule is missing', async () => {
    mockAlertSvc.getRuleRouting.mockResolvedValueOnce(null);
    const result = await handleGetRuleRouting(mockAlertSvc as never, mockClient, 'ds-1', 'nope');
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'Rule not found' });
  });

  it('handleGetRuleRouting wraps the array in { routing }', async () => {
    mockAlertSvc.getRuleRouting.mockResolvedValueOnce([
      { channel: 'slack', destination: '#oncall' },
    ]);
    const result = await handleGetRuleRouting(mockAlertSvc as never, mockClient, 'ds-1', 'mon-1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      routing: [{ channel: 'slack', destination: '#oncall' }],
    });
  });

  it('handleGetRuleRouting returns 200 with empty array for Prom rules', async () => {
    mockAlertSvc.getRuleRouting.mockResolvedValueOnce([]);
    const result = await handleGetRuleRouting(mockAlertSvc as never, mockClient, 'ds-prom', 'r-1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ routing: [] });
  });

  // =========================================================================
  // Range threading
  // =========================================================================

  it('handleGetUnifiedAlerts forwards startTime/endTime to the service', async () => {
    mockAlertSvc.getUnifiedAlerts.mockResolvedValueOnce({ results: [] });
    const resolver = jest.fn();
    await handleGetUnifiedAlerts(mockAlertSvc as never, resolver, {
      dsIds: 'a',
      startTime: 'now-1h',
      endTime: 'now',
    });
    expect(mockAlertSvc.getUnifiedAlerts).toHaveBeenCalledWith(
      resolver,
      expect.objectContaining({
        startTime: 'now-1h',
        endTime: 'now',
      })
    );
  });

  it('handleGetOSAlerts forwards range to getOSAlerts', async () => {
    mockAlertSvc.getOSAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    await handleGetOSAlerts(mockAlertSvc as never, mockClient, 'ds-1', {
      startTime: 'now-2h',
      endTime: 'now',
    });
    expect(mockAlertSvc.getOSAlerts).toHaveBeenCalledWith(mockClient, 'ds-1', {
      startTime: 'now-2h',
      endTime: 'now',
    });
  });

  it('handleGetPromAlerts forwards range to getPromAlerts', async () => {
    mockAlertSvc.getPromAlerts.mockResolvedValueOnce([]);
    await handleGetPromAlerts(mockAlertSvc as never, mockClient, 'ds-1', {
      startTime: 'now-30m',
      endTime: 'now',
    });
    expect(mockAlertSvc.getPromAlerts).toHaveBeenCalledWith(mockClient, 'ds-1', {
      startTime: 'now-30m',
      endTime: 'now',
    });
  });

  // ---- handleGetUnifiedTimeline ----
  it('handleGetUnifiedTimeline parses csv dsIds, severity, state, and JSON labels', async () => {
    mockAlertSvc.getUnifiedTimeline.mockResolvedValueOnce({
      buckets: [],
      bucketCount: 12,
      bucketDurationMs: 5 * 60 * 1000,
      datasourceStatus: [],
      fetchedAt: '2026-01-01T00:00:00Z',
    });
    const resolver = jest.fn(async () => ({} as never));
    await handleGetUnifiedTimeline(mockAlertSvc as never, resolver, {
      dsIds: 'ds-1,ds-2',
      startTime: 'now-1h',
      endTime: 'now',
      buckets: '24',
      severity: 'critical,high,bogus',
      state: 'active',
      labels: JSON.stringify({ service: ['cart'] }),
      timeout: '5000',
    });
    expect(mockAlertSvc.getUnifiedTimeline).toHaveBeenCalledWith(
      resolver,
      expect.objectContaining({
        dsIds: ['ds-1', 'ds-2'],
        startTime: 'now-1h',
        endTime: 'now',
        buckets: 24,
        severity: ['critical', 'high'],
        state: ['active'],
        labels: { service: ['cart'] },
        timeoutMs: 5000,
      })
    );
  });

  it('handleGetUnifiedTimeline drops invalid severity / state values silently', async () => {
    mockAlertSvc.getUnifiedTimeline.mockResolvedValueOnce({
      buckets: [],
      bucketCount: 12,
      bucketDurationMs: 5 * 60 * 1000,
      datasourceStatus: [],
      fetchedAt: '2026-01-01T00:00:00Z',
    });
    const resolver = jest.fn(async () => ({} as never));
    await handleGetUnifiedTimeline(mockAlertSvc as never, resolver, {
      startTime: 'now-1h',
      endTime: 'now',
      severity: 'bogus,nope',
      state: 'wat',
    });
    const opts = mockAlertSvc.getUnifiedTimeline.mock.calls[0][1];
    expect(opts.severity).toBeUndefined();
    expect(opts.state).toBeUndefined();
  });

  it('handleGetUnifiedTimeline ignores malformed JSON labels', async () => {
    mockAlertSvc.getUnifiedTimeline.mockResolvedValueOnce({
      buckets: [],
      bucketCount: 12,
      bucketDurationMs: 5 * 60 * 1000,
      datasourceStatus: [],
      fetchedAt: '2026-01-01T00:00:00Z',
    });
    const resolver = jest.fn(async () => ({} as never));
    await handleGetUnifiedTimeline(mockAlertSvc as never, resolver, {
      startTime: 'now-1h',
      endTime: 'now',
      labels: '{not valid json',
    });
    const opts = mockAlertSvc.getUnifiedTimeline.mock.calls[0][1];
    expect(opts.labels).toBeUndefined();
  });

  it('handleGetOSAlerts accepts absent range (undefined options)', async () => {
    mockAlertSvc.getOSAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    await handleGetOSAlerts(mockAlertSvc as never, mockClient, 'ds-1');
    expect(mockAlertSvc.getOSAlerts).toHaveBeenCalledWith(mockClient, 'ds-1', {
      startTime: undefined,
      endTime: undefined,
    });
  });
});
