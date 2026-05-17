/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { computeAlertFacets, computeRuleFacets, MAX_LABEL_KEYS } from '../alert_facets';
import type {
  AlertingOSClient,
  Datasource,
  Logger,
  UnifiedAlertSummary,
  UnifiedFetchOptions,
  UnifiedRuleSummary,
} from '../../../../common/types/alerting';
import type { MultiBackendAlertService } from '../alert_service';

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
void mockLogger;

const osDs: Datasource = {
  id: 'ds-os',
  name: 'OS',
  type: 'opensearch',
  url: '',
  enabled: true,
};
const promDs: Datasource = {
  id: 'ds-prom',
  name: 'Prom',
  type: 'prometheus',
  url: '',
  enabled: true,
};

const mkAlert = (overrides: Partial<UnifiedAlertSummary>): UnifiedAlertSummary => ({
  id: 'a',
  datasourceId: 'ds-os',
  datasourceType: 'opensearch',
  name: 'n',
  state: 'active',
  severity: 'critical',
  startTime: '2026-01-01T00:00:00Z',
  lastUpdated: '2026-01-01T00:00:00Z',
  labels: {},
  annotations: {},
  ...overrides,
});

const mkRule = (overrides: Partial<UnifiedRuleSummary>): UnifiedRuleSummary => ({
  id: 'r',
  datasourceId: 'ds-os',
  datasourceType: 'opensearch',
  name: 'n',
  enabled: true,
  severity: 'critical',
  query: '',
  condition: '',
  labels: {},
  annotations: {},
  monitorType: 'metric',
  status: 'active',
  healthStatus: 'healthy',
  createdBy: 'admin',
  createdAt: '2026-01-01',
  lastModified: '2026-01-01',
  notificationDestinations: [],
  evaluationInterval: '1m',
  pendingPeriod: '5m',
  ...overrides,
});

interface FakeSvcConfig {
  alerts?: UnifiedAlertSummary[];
  rules?: UnifiedRuleSummary[];
  datasources?: Datasource[];
}

function makeFakeService(config: FakeSvcConfig): MultiBackendAlertService {
  const datasources = config.datasources ?? [osDs, promDs];
  return ({
    resolveDatasources: jest.fn(
      async (dsIds?: string[]): Promise<Datasource[]> => {
        if (!dsIds || dsIds.length === 0) return datasources;
        return datasources.filter((d) => dsIds.includes(d.id));
      }
    ),
    fetchAlertsRaw: jest.fn(async (_client: AlertingOSClient, ds: Datasource) => {
      const all = config.alerts ?? [];
      return { alerts: all.filter((a) => a.datasourceId === ds.id) };
    }),
    fetchRulesRaw: jest.fn(async (_client: AlertingOSClient, ds: Datasource) => {
      const all = config.rules ?? [];
      return all.filter((r) => r.datasourceId === ds.id);
    }),
  } as unknown) as MultiBackendAlertService;
}

const stubResolver = async (): Promise<AlertingOSClient> => ({} as AlertingOSClient);

describe('computeAlertFacets', () => {
  it('counts each dimension with its own filter excluded (OR-within, AND-across)', async () => {
    const alerts: UnifiedAlertSummary[] = [
      mkAlert({ id: 'a1', severity: 'critical', state: 'active' }),
      mkAlert({ id: 'a2', severity: 'critical', state: 'resolved' }),
      mkAlert({ id: 'a3', severity: 'high', state: 'active' }),
      mkAlert({
        id: 'a4',
        severity: 'high',
        state: 'active',
        datasourceId: 'ds-prom',
        datasourceType: 'prometheus',
      }),
    ];
    const svc = makeFakeService({ alerts });
    const options: UnifiedFetchOptions = {
      severity: ['critical'],
      state: ['active'],
    };
    const facets = await computeAlertFacets(svc, stubResolver, options);

    // severity: filter on `severity` is dropped → counts respect state=active
    // a1 (critical, active), a3 (high, active), a4 (high, active)
    expect(facets.severity).toEqual({ critical: 1, high: 2 });

    // state: filter on `state` is dropped → counts respect severity=critical
    // a1 (critical, active), a2 (critical, resolved)
    expect(facets.state).toEqual({ active: 1, resolved: 1 });

    // total: both filters applied — only a1
    expect(facets.total).toBe(1);
  });

  it('includes label facet keys/values, excluding internal keys', async () => {
    const alerts = [
      mkAlert({ id: 'a1', labels: { team: 'infra', monitor_id: 'X' } }),
      mkAlert({ id: 'a2', labels: { team: 'infra' } }),
      mkAlert({ id: 'a3', labels: { team: 'app', region: 'us-east-1' } }),
    ];
    const svc = makeFakeService({ alerts });
    const facets = await computeAlertFacets(svc, stubResolver, {});
    expect(facets.labels).toMatchObject({
      team: { infra: 2, app: 1 },
      region: { 'us-east-1': 1 },
    });
    expect(facets.labels.monitor_id).toBeUndefined();
  });

  it('caps label keys at MAX_LABEL_KEYS and surfaces truncated', async () => {
    const labels: Record<string, string> = {};
    for (let i = 0; i < MAX_LABEL_KEYS + 5; i++) labels[`k${i}`] = 'v';
    const alerts = [mkAlert({ id: 'a1', labels })];
    const svc = makeFakeService({ alerts });
    const facets = await computeAlertFacets(svc, stubResolver, {});
    expect(Object.keys(facets.labels).length).toBe(MAX_LABEL_KEYS);
    expect(facets.truncated).toBe(true);
  });

  it('honours dsIds + backend filters when narrowing facet set', async () => {
    const alerts = [
      mkAlert({ id: 'a1', datasourceId: 'ds-os' }),
      mkAlert({ id: 'a2', datasourceId: 'ds-prom', datasourceType: 'prometheus' }),
    ];
    const svc = makeFakeService({ alerts });
    const facets = await computeAlertFacets(svc, stubResolver, {
      backend: ['opensearch'],
    });
    expect(facets.total).toBe(1);
    expect(facets.backend).toEqual({ opensearch: 1 });
  });

  it('surfaces per-datasource warnings on partial failure', async () => {
    const svc = ({
      resolveDatasources: jest.fn(async () => [osDs, promDs]),
      fetchAlertsRaw: jest.fn(async (_c: AlertingOSClient, ds: Datasource) => {
        if (ds.id === 'ds-prom') throw new Error('boom');
        return { alerts: [mkAlert({ id: 'a1' })] };
      }),
    } as unknown) as MultiBackendAlertService;
    const facets = await computeAlertFacets(svc, stubResolver, {});
    expect(facets.total).toBe(1);
    expect(facets.warnings).toBeDefined();
    expect(facets.warnings?.[0].datasourceId).toBe('ds-prom');
  });
});

describe('computeRuleFacets', () => {
  it('mirrors alert facet semantics for status/severity/monitorType/healthStatus', async () => {
    const rules: UnifiedRuleSummary[] = [
      mkRule({ id: 'r1', status: 'active', severity: 'critical', monitorType: 'metric' }),
      mkRule({ id: 'r2', status: 'active', severity: 'high', monitorType: 'log' }),
      mkRule({ id: 'r3', status: 'disabled', severity: 'critical', monitorType: 'metric' }),
    ];
    const svc = makeFakeService({ rules });
    const facets = await computeRuleFacets(svc, stubResolver, {
      state: ['active'],
      severity: ['critical'],
    });

    // severity dimension excludes its own filter → respects status=active:
    // r1 (active, critical), r2 (active, high) → {critical:1, high:1}
    expect(facets.severity).toEqual({ critical: 1, high: 1 });

    // status dimension excludes its own filter → respects severity=critical:
    // r1 (active, critical), r3 (disabled, critical)
    expect(facets.status).toEqual({ active: 1, disabled: 1 });

    expect(facets.total).toBe(1);
  });

  it('caps createdBy entries and labels per the same MAX_VALUES_PER_KEY rule', async () => {
    const rules: UnifiedRuleSummary[] = [];
    for (let i = 0; i < 60; i++) {
      rules.push(mkRule({ id: `r${i}`, createdBy: `user${i}` }));
    }
    const svc = makeFakeService({ rules });
    const facets = await computeRuleFacets(svc, stubResolver, {});
    expect(Object.keys(facets.createdBy).length).toBeLessThanOrEqual(50);
    expect(facets.truncated).toBe(true);
  });
});
