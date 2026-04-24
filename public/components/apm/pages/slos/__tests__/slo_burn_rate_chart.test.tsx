/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import type { SloDocument } from '../../../../../../common/slo/slo_types';
import { buildBurnRateOption, SloBurnRateChart } from '../slo_burn_rate_chart';

jest.mock('../../../../alerting/echarts_render', () => ({
  EchartsRender: () => null,
}));
jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: jest.fn(),
    dispose: jest.fn(),
    resize: jest.fn(),
  })),
  graphic: { LinearGradient: jest.fn() },
}));

const mockUsePromQLChartData = jest.fn();
jest.mock('../../../shared/hooks/use_promql_chart_data', () => ({
  usePromQLChartData: (p: unknown) => mockUsePromQLChartData(p),
}));

jest.mock('@osd/ui-shared-deps/theme', () => ({
  euiThemeVars: {
    euiColorSuccess: '#00BFB3',
    euiColorDanger: '#BD271E',
    euiColorWarning: '#F5A700',
    euiColorLightShade: '#D3DAE6',
    euiColorDarkShade: '#69707D',
    euiColorLightestShade: '#F5F7FA',
  },
}));

function baseSlo(): SloDocument {
  return {
    id: 'slo-1',
    spec: {
      datasourceId: 'ds-2',
      name: 'api-availability',
      enabled: true,
      mode: 'active',
      service: 'api',
      owner: { teams: ['sre'] },
      sli: {
        type: 'single',
        definition: {
          backend: 'prometheus',
          type: 'availability',
          calcMethod: 'events',
          metric: 'http_requests_total',
        },
        dimensions: [{ name: 'service', value: 'api' }],
      },
      objectives: [{ name: 'obj-1', target: 0.99 }],
      budgetWarningThresholds: [],
      window: { type: 'rolling', duration: '28d' },
      alerting: {
        strategy: 'mwmbr',
        burnRates: [
          {
            shortWindow: '5m',
            longWindow: '1h',
            burnRateMultiplier: 14,
            severity: 'page',
            createAlarm: true,
            forDuration: '2m',
          },
          {
            shortWindow: '30m',
            longWindow: '6h',
            burnRateMultiplier: 6,
            severity: 'ticket',
            createAlarm: true,
            forDuration: '15m',
          },
        ],
      },
      alarms: {
        sliHealth: { enabled: false },
        attainmentBreach: { enabled: false },
        budgetWarning: { enabled: true },
        noData: { enabled: false, forDuration: '15m' },
        resolved: { enabled: false },
      },
      exclusionWindows: [],
      labels: {},
      annotations: {},
    },
    status: {
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'me',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: 'me',
      provisioning: {
        backend: 'prometheus',
        ruleGroupName: 'rg',
        rulerNamespace: 'ns',
        generatedRuleNames: [],
      },
    },
  };
}

const baseProps = {
  prometheusConnectionId: 'prom-1',
  timeRange: { from: 'now-6h', to: 'now' },
  refreshTrigger: 0,
};

describe('buildBurnRateOption', () => {
  it('renders one series per tier with its threshold markLine labeled by severity', () => {
    const opt = buildBurnRateOption({
      tiers: [
        {
          label: 'Page · Quick',
          severity: 'page',
          multiplier: 14,
          color: '#A00',
          data: [[1, 5]],
        },
        {
          label: 'Ticket · Slow',
          severity: 'ticket',
          multiplier: 3,
          color: '#0A0',
          data: [[1, 2]],
        },
      ],
    });
    const seriesList = opt.series as Array<Record<string, unknown>>;
    expect(seriesList).toHaveLength(2);

    const firstMark = seriesList[0].markLine as {
      data: Array<{ yAxis: number }>;
      label: { formatter: string };
    };
    expect(firstMark.data[0].yAxis).toBe(14);
    expect(firstMark.label.formatter).toContain('page');
    expect(firstMark.label.formatter).toContain('14x');

    const secondMark = seriesList[1].markLine as {
      data: Array<{ yAxis: number }>;
      label: { formatter: string };
    };
    expect(secondMark.data[0].yAxis).toBe(3);
    expect(secondMark.label.formatter).toContain('ticket');
  });
});

describe('SloBurnRateChart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the empty-tiers callout when the SLO has no burn-rate config', () => {
    mockUsePromQLChartData.mockReturnValue({
      series: [],
      latestValue: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const slo = baseSlo();
    slo.spec.alerting.burnRates = [];
    render(<SloBurnRateChart slo={slo} objective={slo.spec.objectives[0]} {...baseProps} />);
    expect(screen.getByTestId('slos-burn-rate-empty-tiers')).toBeInTheDocument();
  });

  it('renders the waiting-for-data callout when every tier returns zero samples', () => {
    mockUsePromQLChartData.mockReturnValue({
      series: [],
      latestValue: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const slo = baseSlo();
    render(<SloBurnRateChart slo={slo} objective={slo.spec.objectives[0]} {...baseProps} />);
    expect(screen.getByTestId('slos-burn-rate-empty')).toBeInTheDocument();
  });
});
