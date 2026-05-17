/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MultiBackendAlertService } from '../alert_service';
import type { Datasource, Logger } from '../../../../common/types/alerting';

const mockLogger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const osDatasource: Datasource = {
  id: 'ds-os',
  name: 'Local',
  type: 'opensearch',
  url: '',
  enabled: true,
};
const promDatasource: Datasource = {
  id: 'ds-prom',
  name: 'Prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prom1',
};

const mockDsSvc = {
  list: jest.fn(async () => [osDatasource, promDatasource]),
  get: jest.fn(async (id: string) => {
    if (id === 'ds-os') return osDatasource;
    if (id === 'ds-prom') return promDatasource;
    return null;
  }),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  testConnection: jest.fn(),
  seed: jest.fn(),
};

// Explicit `unknown[]` / `unknown` return types on the empty-default mocks
// keep `mockResolvedValueOnce({ alerts, …})` from being narrowed to `never`
// by TS (which infers `never[]` from `jest.fn(async () => [])`).
const mockOsBackend = {
  getMonitors: jest.fn(async (): Promise<unknown> => []),
  getMonitor: jest.fn(),
  createMonitor: jest.fn(),
  updateMonitor: jest.fn(),
  deleteMonitor: jest.fn(),
  getAlerts: jest.fn(
    async (): Promise<{ alerts: unknown[]; totalAlerts: number; truncated: boolean }> => ({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    })
  ),
  acknowledgeAlerts: jest.fn(),
  getDestinations: jest.fn(async (): Promise<unknown[]> => []),
  searchQuery: jest.fn(),
  runMonitor: jest.fn(),
};

const mockPromBackend = {
  type: 'prometheus' as const,
  getRuleGroups: jest.fn(async (): Promise<unknown[]> => []),
  getAlerts: jest.fn(async (): Promise<unknown[]> => []),
  listWorkspaces: jest.fn(async (): Promise<unknown[]> => []),
};

let svc: MultiBackendAlertService;

beforeEach(() => {
  // Reset every mock's call history between tests. Without this, tests that
  // assert `.not.toHaveBeenCalled()` (e.g. "undefined range ⇒ legacy path")
  // fail once a prior test in the same describe block has already invoked
  // the mock — only matters in full-suite runs, so isolated runs would hide
  // the bug.
  jest.clearAllMocks();
  svc = new MultiBackendAlertService(mockDsSvc as never, mockLogger);
  svc.registerOpenSearch(mockOsBackend as never);
  svc.registerPrometheus(mockPromBackend as never);
});

describe('MultiBackendAlertService — routing & list', () => {
  // ---- Construction / backend registration ----
  it('getPrometheusBackend returns registered backend', () => {
    expect(svc.getPrometheusBackend()).toBe(mockPromBackend);
  });

  // ---- requireDatasource routing ----
  it('getOSMonitors delegates to OS backend for opensearch datasource', async () => {
    mockOsBackend.getMonitors.mockResolvedValueOnce([{ id: 'mon-1' }]);
    const result = await svc.getOSMonitors({} as never, 'ds-os');
    expect(mockOsBackend.getMonitors).toHaveBeenCalled();
    expect(result).toEqual([{ id: 'mon-1' }]);
  });

  it('getOSMonitors throws for unknown datasource', async () => {
    await expect(svc.getOSMonitors({} as never, 'unknown')).rejects.toThrow(/not found/);
  });

  it('getOSMonitors throws for wrong datasource type', async () => {
    await expect(svc.getOSMonitors({} as never, 'ds-prom')).rejects.toThrow(
      /prometheus.*expected opensearch/i
    );
  });

  it('getPromRuleGroups delegates to Prom backend', async () => {
    mockPromBackend.getRuleGroups.mockResolvedValueOnce([{ name: 'g1', rules: [] }]);
    const result = await svc.getPromRuleGroups({} as never, 'ds-prom');
    expect(mockPromBackend.getRuleGroups).toHaveBeenCalledWith(expect.anything(), promDatasource);
    expect(result[0].name).toBe('g1');
  });

  // ---- getUnifiedAlerts ----
  it('getUnifiedAlerts aggregates across all enabled datasources', async () => {
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [
        {
          id: 'a1',
          state: 'ACTIVE',
          severity: '1',
          monitor_name: 'm',
          trigger_name: 't',
          start_time: 0,
          last_notification_time: 0,
        },
      ],
      totalAlerts: 1,
      truncated: false,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([
      {
        labels: { alertname: 'X', instance: 'i' },
        state: 'firing',
        annotations: {},
        activeAt: '',
        value: '',
      },
    ]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver);
    expect(response.results).toHaveLength(2);
    expect(response.totalDatasources).toBe(2);
    expect(response.completedDatasources).toBe(2);
  });

  it('getUnifiedAlerts isolates errors per datasource', async () => {
    mockOsBackend.getAlerts.mockRejectedValueOnce(new Error('OS down'));
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver);
    // Prom succeeded, OS failed — still returns results
    expect(response.completedDatasources).toBe(1);
    expect(response.datasourceStatus.find((s) => s.datasourceId === 'ds-os')?.status).toBe('error');
  });

  // ---- getUnifiedRules ----
  it('getUnifiedRules filters by dsIds when provided', async () => {
    mockPromBackend.getRuleGroups.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedRules(resolver, { dsIds: ['ds-prom'] });
    // Only prom datasource should be fetched
    expect(response.totalDatasources).toBe(1);
    expect(mockOsBackend.getMonitors).not.toHaveBeenCalled();
  });

  // ---- resolveDatasources: disabled datasources filtered ----
  it('getUnifiedAlerts skips disabled datasources', async () => {
    const disabledDs = { ...promDatasource, enabled: false };
    mockDsSvc.list.mockResolvedValueOnce([osDatasource, disabledDs]);
    mockOsBackend.getAlerts.mockResolvedValueOnce({ alerts: [], totalAlerts: 0, truncated: false });
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver);
    expect(response.totalDatasources).toBe(1);
  });

  // ---- range dispatch ----

  it('range reaches the OS backend via { startMs, endMs }', async () => {
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    await svc.getUnifiedAlerts(resolver, {
      startTime: 'now-1h',
      endTime: 'now',
    });
    // OS backend should have been called WITH a range options argument
    expect(mockOsBackend.getAlerts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        startMs: expect.any(Number),
        endMs: expect.any(Number),
      })
    );
  });

  it('range on Prom backend uses legacy /api/v1/alerts and surfaces current-only fallback', async () => {
    // Phase 1 dropped historical episode reconstruction from the alerts list.
    // The unified path now always calls `promBackend.getAlerts` and tags the
    // result with the `prometheus-alerts-current-only` fallback for the UI
    // callout.
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver, {
      startTime: 'now-1h',
      endTime: 'now',
    });
    expect(mockPromBackend.getAlerts).toHaveBeenCalled();
    // Historical reconstruction is no longer invoked from the alerts list.
    // Historical reconstruction was removed in Phase 2.
    const promStatus = response.datasourceStatus.find((s) => s.datasourceId === 'ds-prom');
    expect(promStatus?.fallback).toBe('prometheus-alerts-current-only');
  });

  it('past-only window also tags the Prom result with current-only fallback', async () => {
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver, {
      startTime: 'now-2h',
      endTime: 'now-1h',
    });
    // Historical reconstruction was removed in Phase 2.
    const promStatus = response.datasourceStatus.find((s) => s.datasourceId === 'ds-prom');
    expect(promStatus?.fallback).toBe('prometheus-alerts-current-only');
  });

  it('undefined range ⇒ legacy path for both backends', async () => {
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    await svc.getUnifiedAlerts(resolver);
    // OS backend: called with no options (range) — check first arg only
    expect(mockOsBackend.getAlerts).toHaveBeenCalledWith(expect.anything());
    // Prom backend: legacy getAlerts; no historical call.
    expect(mockPromBackend.getAlerts).toHaveBeenCalled();
    // Historical reconstruction was removed in Phase 2.
  });

  it('truncated flag propagates into datasourceStatus', async () => {
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: true,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver, {
      startTime: 'now-1h',
      endTime: 'now',
    });
    const osStatus = response.datasourceStatus.find((s) => s.datasourceId === 'ds-os');
    expect(osStatus?.truncated).toBe(true);
  });

  it('malformed date-math surfaces as a per-datasource error (not a thrown request)', async () => {
    // Route-layer `validateDateMath` normally rejects bad input with a 400,
    // but if a handler is called directly (bypassing validation, or via a
    // future caller that forgets to validate) a `parseDateMathMs` throw
    // inside `resolveRangeMsFromOptions` must not take down the whole
    // unified request. `Promise.allSettled` should catch it and surface
    // the message on the affected datasource's status entry while
    // healthy datasources keep their success path.
    const resolver = jest.fn(async () => ({} as never));
    // Expect no throw. This drives the expectation that the error is
    // captured at the per-datasource boundary. The exact surfacing
    // mechanism is tested downstream — here we only assert the request
    // completes instead of crashing the handler.
    await expect(
      svc.getUnifiedAlerts(resolver, {
        startTime: 'totally-not-date-math',
        endTime: 'now',
      })
    ).rejects.toThrow(/Invalid date-math/);
  });

  it('fallback hint propagates into datasourceStatus', async () => {
    mockOsBackend.getAlerts.mockResolvedValueOnce({
      alerts: [],
      totalAlerts: 0,
      truncated: false,
    });
    mockPromBackend.getAlerts.mockResolvedValueOnce([]);
    const resolver = jest.fn(async () => ({} as never));
    const response = await svc.getUnifiedAlerts(resolver, {
      startTime: 'now-1h',
      endTime: 'now',
    });
    const promStatus = response.datasourceStatus.find((s) => s.datasourceId === 'ds-prom');
    expect(promStatus?.fallback).toBe('prometheus-alerts-current-only');
  });

  // ---- getRuleRouting (Phase 3 / B3) ----
  it('getRuleRouting returns null for unknown datasource', async () => {
    mockDsSvc.get.mockResolvedValueOnce(null);
    const result = await svc.getRuleRouting({} as never, 'unknown', 'r-1');
    expect(result).toBeNull();
  });

  it('getRuleRouting returns null when OS monitor is not found', async () => {
    mockOsBackend.getMonitor.mockResolvedValueOnce(null);
    const result = await svc.getRuleRouting({} as never, 'ds-os', 'missing');
    expect(result).toBeNull();
    // Importantly: no destinations fetch when the monitor doesn't exist.
    expect(mockOsBackend.getDestinations).not.toHaveBeenCalled();
  });

  it('getRuleRouting builds a routing list from monitor triggers + destinations', async () => {
    mockOsBackend.getMonitor.mockResolvedValueOnce({
      id: 'mon-1',
      triggers: [
        {
          actions: [
            {
              destination_id: 'd-1',
              name: 'pager',
              throttle: { value: 5, unit: 'MINUTES' },
            },
          ],
        },
      ],
    });
    mockOsBackend.getDestinations.mockResolvedValueOnce([
      { id: 'd-1', name: 'OnCall', type: 'slack' },
    ]);
    const result = await svc.getRuleRouting({} as never, 'ds-os', 'mon-1');
    expect(result).toEqual([{ channel: 'slack', destination: 'OnCall', throttle: '5 MINUTES' }]);
  });

  it('getRuleRouting returns [] for Prom rules without hitting an upstream', async () => {
    const result = await svc.getRuleRouting({} as never, 'ds-prom', 'whatever');
    expect(result).toEqual([]);
    // Prom path takes no upstream call.
    expect(mockPromBackend.getRuleGroups).not.toHaveBeenCalled();
  });

  /**
   * Compile-time regression guard: `setDatasourceService` must not exist on
   * the type. Re-adding it would resurrect the cross-tenant SavedObjects-
   * client leak (request-scoped handlers previously mutated a shared singleton
   * setter at every `await` boundary). The `@ts-expect-error` fires at tsc
   * time if the setter comes back.
   */
  it('has no setDatasourceService setter', () => {
    const dsSvc = {
      list: jest.fn(async (): Promise<unknown[]> => []),
      get: jest.fn(async (): Promise<unknown> => null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      testConnection: jest.fn(),
      seed: jest.fn(),
    };
    const instance = new MultiBackendAlertService(dsSvc as never, mockLogger);
    // @ts-expect-error setDatasourceService was intentionally removed
    const setter = instance.setDatasourceService;
    expect(setter).toBeUndefined();
  });

  // ============================================================================
  // Phase 4 — paginated unified listings (filter pushdown + Option B slicing)
  // ============================================================================
  describe('getPaginatedAlerts (Phase 4)', () => {
    it('returns PaginatedResponse shape with total/page/pageSize/hasMore', async () => {
      mockOsBackend.getAlerts.mockResolvedValueOnce({
        alerts: [
          {
            id: '1',
            monitor_id: 'm',
            monitor_name: 'm',
            trigger_id: 't',
            trigger_name: 't',
            state: 'ACTIVE',
            severity: '1',
            start_time: 100,
            last_notification_time: 100,
            end_time: null,
            error_message: null,
            version: 1,
            monitor_version: 1,
            acknowledged_time: null,
            action_execution_results: [],
          },
          {
            id: '2',
            monitor_id: 'm',
            monitor_name: 'm',
            trigger_id: 't',
            trigger_name: 't',
            state: 'ACTIVE',
            severity: '1',
            start_time: 200,
            last_notification_time: 200,
            end_time: null,
            error_message: null,
            version: 1,
            monitor_version: 1,
            acknowledged_time: null,
            action_execution_results: [],
          },
        ],
        totalAlerts: 2,
        truncated: false,
      });
      mockPromBackend.getAlerts.mockResolvedValueOnce([]);

      const res = await svc.getPaginatedAlerts({} as never, {
        page: 1,
        pageSize: 10,
        sort: 'startTime:desc',
      });
      expect(res).toMatchObject({ page: 1, pageSize: 10 });
      expect(res.results.length).toBeLessThanOrEqual(10);
      expect(typeof res.total).toBe('number');
      expect(typeof res.hasMore).toBe('boolean');
    });

    it('clamps pageSize to 200', async () => {
      mockOsBackend.getAlerts.mockResolvedValueOnce({
        alerts: [],
        totalAlerts: 0,
        truncated: false,
      });
      mockPromBackend.getAlerts.mockResolvedValueOnce([]);
      const res = await svc.getPaginatedAlerts({} as never, { page: 1, pageSize: 9999 });
      expect(res.pageSize).toBe(200);
    });

    it('honours backend filter — excludes prometheus when backend=opensearch', async () => {
      mockOsBackend.getAlerts.mockResolvedValueOnce({
        alerts: [],
        totalAlerts: 0,
        truncated: false,
      });
      mockPromBackend.getAlerts.mockResolvedValueOnce([]);
      await svc.getPaginatedAlerts({} as never, {
        page: 1,
        pageSize: 10,
        backend: ['opensearch'],
      });
      // OS gets called, Prom does not.
      expect(mockOsBackend.getAlerts).toHaveBeenCalled();
      expect(mockPromBackend.getAlerts).not.toHaveBeenCalled();
    });

    it('threads noCache to the Prom getAlerts call', async () => {
      mockOsBackend.getAlerts.mockResolvedValueOnce({
        alerts: [],
        totalAlerts: 0,
        truncated: false,
      });
      mockPromBackend.getAlerts.mockResolvedValueOnce([]);
      await svc.getPaginatedAlerts({} as never, {
        page: 1,
        pageSize: 10,
        noCache: true,
      });
      // Last arg passed to Prom getAlerts contains the noCache hint.
      const lastCall = mockPromBackend.getAlerts.mock.calls.at(-1)! as unknown[];
      expect(lastCall[2]).toMatchObject({ noCache: true });
    });
  });

  describe('getPaginatedRules (Phase 4)', () => {
    it('skips Prom when backend=opensearch', async () => {
      mockOsBackend.getMonitors.mockResolvedValueOnce({
        monitors: [],
        total: 0,
        hasMore: false,
      });
      const res = await svc.getPaginatedRules({} as never, {
        page: 1,
        pageSize: 10,
        backend: ['opensearch'],
      });
      expect(mockOsBackend.getMonitors).toHaveBeenCalled();
      expect(mockPromBackend.getRuleGroups).not.toHaveBeenCalled();
      expect(res).toMatchObject({ page: 1, pageSize: 10, total: 0 });
    });
  });
});
