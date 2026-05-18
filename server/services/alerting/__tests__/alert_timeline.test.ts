/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getUnifiedTimeline } from '../alert_timeline';
import type {
  AlertingOSClient,
  Datasource,
  Logger,
  OpenSearchBackend,
  PrometheusBackend,
  DatasourceService,
} from '../../../../common/types/alerting';

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const promDatasource: Datasource = {
  id: 'ds-prom',
  name: 'prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prom',
};

const osDatasource: Datasource = {
  id: 'ds-os',
  name: 'os',
  type: 'opensearch',
  url: '',
  enabled: true,
};

const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;
const START_MS = FIXED_NOW - HOUR_MS;

const stubClient = ({} as unknown) as AlertingOSClient;
const clientResolver = async () => stubClient;

function makeDatasourceService(list: Datasource[]): DatasourceService {
  return ({
    list: jest.fn(async () => list),
    get: jest.fn(async (id: string) => list.find((d) => d.id === id) ?? null),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    testConnection: jest.fn(),
    listWorkspaces: jest.fn(),
  } as unknown) as DatasourceService;
}

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(FIXED_NOW));
});
afterAll(() => jest.useRealTimers());

describe('getUnifiedTimeline', () => {
  it('clamps bucket count below the [12, 48] floor', async () => {
    const datasourceService = makeDatasourceService([]);
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: undefined,
        promBackend: undefined,
        clientResolver,
        logger: mockLogger,
      },
      {
        startTime: 'now-1h',
        endTime: 'now',
        buckets: 5,
      }
    );
    expect(result.bucketCount).toBe(12);
    expect(result.buckets).toHaveLength(12);
  });

  it('clamps bucket count above the [12, 48] ceiling', async () => {
    const datasourceService = makeDatasourceService([]);
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: undefined,
        promBackend: undefined,
        clientResolver,
        logger: mockLogger,
      },
      { startTime: 'now-7d', endTime: 'now', buckets: 200 }
    );
    expect(result.bucketCount).toBe(48);
  });

  it('isolates per-datasource errors and still returns 200', async () => {
    const datasourceService = makeDatasourceService([osDatasource, promDatasource]);
    const failingProm = ({
      type: 'prometheus' as const,
      getRuleGroups: jest.fn(),
      getAlerts: jest.fn(),
      listWorkspaces: jest.fn(),
      queryRangeMatrix: jest.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown) as PrometheusBackend;
    const okOs = ({
      type: 'opensearch' as const,
      getMonitors: jest.fn(),
      getMonitor: jest.fn(),
      runMonitor: jest.fn(),
      searchQuery: jest.fn(),
      createMonitor: jest.fn(),
      updateMonitor: jest.fn(),
      deleteMonitor: jest.fn(),
      getAlerts: jest.fn(async () => ({ alerts: [], totalAlerts: 0, truncated: false })),
      acknowledgeAlerts: jest.fn(),
      getDestinations: jest.fn(),
      createDestination: jest.fn(),
      deleteDestination: jest.fn(),
    } as unknown) as OpenSearchBackend;
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: okOs,
        promBackend: failingProm,
        clientResolver,
        logger: mockLogger,
      },
      { startTime: 'now-1h', endTime: 'now' }
    );
    const promStatus = result.datasourceStatus.find((s) => s.datasourceId === 'ds-prom');
    const osStatus = result.datasourceStatus.find((s) => s.datasourceId === 'ds-os');
    expect(promStatus?.status).toBe('error');
    expect(osStatus?.status).toBe('success');
  });

  it('Prometheus path bucket-fills sum-by(severity) results into the right severity', async () => {
    const datasourceService = makeDatasourceService([promDatasource]);
    const promBackend = ({
      type: 'prometheus' as const,
      getRuleGroups: jest.fn(),
      getAlerts: jest.fn(),
      listWorkspaces: jest.fn(),
      queryRangeMatrix: jest.fn(async () => [
        {
          metric: { severity: 'critical' },
          values: [
            { timestamp: START_MS + 60_000, value: 3 },
            { timestamp: START_MS + 120_000, value: 1 },
          ],
        },
        {
          metric: { severity: 'high' },
          values: [{ timestamp: START_MS + 60_000, value: 2 }],
        },
      ]),
    } as unknown) as PrometheusBackend;
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: undefined,
        promBackend,
        clientResolver,
        logger: mockLogger,
      },
      { startTime: 'now-1h', endTime: 'now', buckets: 12 }
    );
    expect(result.bucketCount).toBe(12);
    const totalCritical = result.buckets.reduce((s, b) => s + b.severity.critical, 0);
    const totalHigh = result.buckets.reduce((s, b) => s + b.severity.high, 0);
    expect(totalCritical).toBe(4);
    expect(totalHigh).toBe(2);
  });

  it('Prometheus path emits prometheus-no-severity-labels fallback when group has no severity label', async () => {
    const datasourceService = makeDatasourceService([promDatasource]);
    const calls: string[] = [];
    const promBackend = ({
      type: 'prometheus' as const,
      getRuleGroups: jest.fn(),
      getAlerts: jest.fn(),
      listWorkspaces: jest.fn(),
      queryRangeMatrix: jest.fn(
        async (_client: AlertingOSClient, _ds: Datasource, query: string) => {
          calls.push(query);
          if (query.startsWith('sum by(severity)')) {
            // Returned a series, but it has no severity label.
            return [
              {
                metric: { instance: 'i-1' },
                values: [{ timestamp: START_MS + 60_000, value: 4 }],
              },
            ];
          }
          // count(...) fallback.
          return [
            {
              metric: {},
              values: [{ timestamp: START_MS + 60_000, value: 4 }],
            },
          ];
        }
      ),
    } as unknown) as PrometheusBackend;
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: undefined,
        promBackend,
        clientResolver,
        logger: mockLogger,
      },
      { startTime: 'now-1h', endTime: 'now' }
    );
    const status = result.datasourceStatus.find((s) => s.datasourceId === 'ds-prom');
    expect(status?.fallback).toBe('prometheus-no-severity-labels');
    expect(calls.some((c) => c.startsWith('count('))).toBe(true);
    const totalMedium = result.buckets.reduce((s, b) => s + b.severity.medium, 0);
    expect(totalMedium).toBe(4);
  });

  it('Prometheus path narrows the selector when severity[] is supplied', async () => {
    const datasourceService = makeDatasourceService([promDatasource]);
    const queryRangeMatrix = jest.fn(
      async (...args: unknown[]): Promise<unknown[]> => {
        void args;
        return [];
      }
    );
    const promBackend = ({
      type: 'prometheus' as const,
      getRuleGroups: jest.fn(),
      getAlerts: jest.fn(),
      listWorkspaces: jest.fn(),
      queryRangeMatrix,
    } as unknown) as PrometheusBackend;
    await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: undefined,
        promBackend,
        clientResolver,
        logger: mockLogger,
      },
      {
        startTime: 'now-1h',
        endTime: 'now',
        severity: ['critical', 'high'],
      }
    );
    const queryArg = queryRangeMatrix.mock.calls[0][2];
    expect(queryArg).toMatch(
      /sum by\(severity\) \(ALERTS\{alertstate="firing", severity=~"critical\|high"\}\)/
    );
  });

  it('Prometheus path wraps the selector in topk(200, ...) when search is supplied (Phase 5)', async () => {
    const datasourceService = makeDatasourceService([promDatasource]);
    const queryRangeMatrix = jest.fn(
      async (...args: unknown[]): Promise<unknown[]> => {
        void args;
        return [
          {
            metric: { severity: 'critical' },
            values: [{ timestamp: START_MS + 60_000, value: 1 }],
          },
        ];
      }
    );
    const promBackend = ({
      type: 'prometheus' as const,
      getRuleGroups: jest.fn(),
      getAlerts: jest.fn(),
      listWorkspaces: jest.fn(),
      queryRangeMatrix,
    } as unknown) as PrometheusBackend;
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend: undefined,
        promBackend,
        clientResolver,
        logger: mockLogger,
      },
      {
        startTime: 'now-1h',
        endTime: 'now',
        search: 'cpu',
      }
    );
    const queryArg = queryRangeMatrix.mock.calls[0][2];
    expect(queryArg).toMatch(/topk\(200, ALERTS\{[^)]*alertname=~"\.\*cpu\.\*"\}\)/);
    const status = result.datasourceStatus.find((s) => s.datasourceId === 'ds-prom');
    expect(status?.fallback).toBe('prometheus-search-truncated');
  });

  it('OpenSearch path buckets alerts from getAlerts and applies severity post-filter', async () => {
    const datasourceService = makeDatasourceService([osDatasource]);
    // Mix of severities; severity:['critical'] filter should drop the medium one.
    const getAlerts = jest.fn(async () => ({
      alerts: [
        {
          id: 'a-crit-1',
          version: 1,
          monitor_id: 'm',
          monitor_name: 'm',
          monitor_version: 1,
          trigger_id: 't',
          trigger_name: 't',
          state: 'ACTIVE' as const,
          severity: '1' as const,
          error_message: null,
          start_time: START_MS + 60_000,
          last_notification_time: START_MS + 60_000,
          end_time: null,
          acknowledged_time: null,
          action_execution_results: [],
        },
        {
          id: 'a-crit-2',
          version: 1,
          monitor_id: 'm',
          monitor_name: 'm',
          monitor_version: 1,
          trigger_id: 't',
          trigger_name: 't',
          state: 'COMPLETED' as const,
          severity: '1' as const,
          error_message: null,
          start_time: START_MS + 120_000,
          last_notification_time: START_MS + 120_000,
          end_time: START_MS + 180_000,
          acknowledged_time: null,
          action_execution_results: [],
        },
        {
          id: 'a-medium',
          version: 1,
          monitor_id: 'm',
          monitor_name: 'm',
          monitor_version: 1,
          trigger_id: 't',
          trigger_name: 't',
          state: 'ACTIVE' as const,
          severity: '3' as const,
          error_message: null,
          start_time: START_MS + 180_000,
          last_notification_time: START_MS + 180_000,
          end_time: null,
          acknowledged_time: null,
          action_execution_results: [],
        },
      ],
      totalAlerts: 3,
      truncated: false,
    }));
    const osBackend = ({
      type: 'opensearch' as const,
      getMonitors: jest.fn(),
      getMonitor: jest.fn(),
      runMonitor: jest.fn(),
      searchQuery: jest.fn(),
      createMonitor: jest.fn(),
      updateMonitor: jest.fn(),
      deleteMonitor: jest.fn(),
      getAlerts,
      acknowledgeAlerts: jest.fn(),
      getDestinations: jest.fn(),
      createDestination: jest.fn(),
      deleteDestination: jest.fn(),
    } as unknown) as OpenSearchBackend;
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend,
        promBackend: undefined,
        clientResolver,
        logger: mockLogger,
      },
      { startTime: 'now-1h', endTime: 'now', severity: ['critical'] }
    );
    expect(getAlerts).toHaveBeenCalledTimes(1);
    // The OS timeline path goes through the alerting REST API
    // (`/_plugins/_alerting/monitors/alerts`); it must NEVER read
    // `.opendistro-alerting-alert-history-*` directly because the
    // security plugin silently masks system indices to 0 hits.
    const callArgs = getAlerts.mock.calls[0];
    expect(callArgs[1]).toEqual(expect.objectContaining({ startMs: expect.any(Number) }));
    const totalCritical = result.buckets.reduce((s, b) => s + b.severity.critical, 0);
    const totalMedium = result.buckets.reduce((s, b) => s + b.severity.medium, 0);
    expect(totalCritical).toBe(2);
    expect(totalMedium).toBe(0);
  });

  it('multi-datasource merge: sums per-bucket severity across both datasources', async () => {
    const datasourceService = makeDatasourceService([osDatasource, promDatasource]);
    const osBackend = ({
      type: 'opensearch' as const,
      getMonitors: jest.fn(),
      getMonitor: jest.fn(),
      runMonitor: jest.fn(),
      searchQuery: jest.fn(),
      createMonitor: jest.fn(),
      updateMonitor: jest.fn(),
      deleteMonitor: jest.fn(),
      getAlerts: jest.fn(async () => ({
        alerts: [
          {
            id: 'a-os',
            version: 1,
            monitor_id: 'm',
            monitor_name: 'm',
            monitor_version: 1,
            trigger_id: 't',
            trigger_name: 't',
            state: 'ACTIVE' as const,
            severity: '1' as const,
            error_message: null,
            start_time: START_MS + 60_000,
            last_notification_time: START_MS + 60_000,
            end_time: null,
            acknowledged_time: null,
            action_execution_results: [],
          },
        ],
        totalAlerts: 1,
        truncated: false,
      })),
      acknowledgeAlerts: jest.fn(),
      getDestinations: jest.fn(),
      createDestination: jest.fn(),
      deleteDestination: jest.fn(),
    } as unknown) as OpenSearchBackend;
    const promBackend = ({
      type: 'prometheus' as const,
      getRuleGroups: jest.fn(),
      getAlerts: jest.fn(),
      listWorkspaces: jest.fn(),
      queryRangeMatrix: jest.fn(async () => [
        {
          metric: { severity: 'critical' },
          values: [{ timestamp: START_MS + 60_000, value: 2 }],
        },
      ]),
    } as unknown) as PrometheusBackend;
    const result = await getUnifiedTimeline(
      {
        datasourceService,
        osBackend,
        promBackend,
        clientResolver,
        logger: mockLogger,
      },
      { startTime: 'now-1h', endTime: 'now' }
    );
    const totalCritical = result.buckets.reduce((s, b) => s + b.severity.critical, 0);
    expect(totalCritical).toBe(3);
  });
});
