/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import type { SloDocument, SloLiveStatus } from '../../../../../../common/slo/slo_types';
import { buildBudgetRemainingOption, SloBudgetRemainingChart } from '../slo_budget_remaining_chart';

// Keep the chart DOM inert so we can assert on the hook output without
// initialising ECharts (jsdom has no canvas and no ResizeObserver). The
// EchartsRender wrapper uses both; swap it for a sentinel div so the
// component tree still mounts cleanly.
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
    euiColorWarningText: '#8A5F00',
    euiColorLightShade: '#D3DAE6',
    euiColorDarkShade: '#69707D',
    euiColorLightestShade: '#F5F7FA',
  },
}));

function makeSlo(
  overrides: Partial<SloDocument['spec']> = {}
): SloDocument & {
  liveStatus: SloLiveStatus;
} {
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
      budgetWarningThresholds: [{ threshold: 0.5, severity: 'warning' }],
      window: { type: 'rolling', duration: '28d' },
      alerting: { strategy: 'mwmbr', burnRates: [] },
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
      ...overrides,
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
    liveStatus: {
      sloId: 'slo-1',
      objectives: [],
      state: 'ok',
      firingCount: 0,
      ruleCount: 0,
      computedAt: '2026-01-01T00:00:00Z',
    },
  };
}

const baseProps = {
  prometheusConnectionId: 'prom-1',
  timeRange: { from: 'now-28d', to: 'now' },
  refreshTrigger: 0,
};

describe('buildBudgetRemainingOption', () => {
  it('renders warning-threshold markLine with severity label', () => {
    const opt = buildBudgetRemainingOption({
      seriesName: 'obj-1',
      data: [
        [1, 1],
        [2, 0.6],
      ],
      warningThreshold: { threshold: 0.5, severity: 'warning' },
      atZero: false,
    });
    const series = (opt.series as Array<Record<string, unknown>>)[0];
    const markLine = series.markLine as { data: Array<Record<string, unknown>> };
    expect(markLine.data).toHaveLength(2);
    // The first entry is always the 0/exhausted line.
    expect(markLine.data[0].yAxis).toBe(0);
    // The second carries the warning threshold + severity label.
    expect(markLine.data[1].yAxis).toBe(0.5);
    const secondLabel = markLine.data[1].label as { formatter: string };
    expect(secondLabel.formatter).toContain('warning');
    expect(secondLabel.formatter).toContain('50.0%');
  });

  it('omits the warning-threshold line when the spec has no budget warnings', () => {
    const opt = buildBudgetRemainingOption({
      seriesName: 'obj-1',
      data: [[1, 0.9]],
      warningThreshold: undefined,
      atZero: false,
    });
    const series = (opt.series as Array<Record<string, unknown>>)[0];
    const markLine = series.markLine as { data: unknown[] };
    expect(markLine.data).toHaveLength(1);
  });

  it('switches fill color to the danger palette when budget is at zero', () => {
    const opt = buildBudgetRemainingOption({
      seriesName: 'obj-1',
      data: [[1, 0]],
      warningThreshold: undefined,
      atZero: true,
    });
    const series = (opt.series as Array<Record<string, unknown>>)[0];
    const lineStyle = series.lineStyle as { color: string };
    // Danger red from the mocked euiThemeVars table.
    expect(lineStyle.color).toBe('#BD271E');
    const area = series.areaStyle as { color: string };
    expect(area.color).toMatch(/189.*39.*30/);
  });

  it("pins yAxis to the [-0.1, 1] range so chartnegative values don't redraw the axis", () => {
    const opt = buildBudgetRemainingOption({
      seriesName: 'obj-1',
      data: [],
      atZero: false,
    });
    const yAxis = opt.yAxis as { min: number; max: number };
    expect(yAxis.min).toBeLessThan(0);
    expect(yAxis.max).toBe(1);
  });
});

describe('SloBudgetRemainingChart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the empty-state callout when the query returns no samples', () => {
    mockUsePromQLChartData.mockReturnValue({
      series: [],
      latestValue: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(
      <SloBudgetRemainingChart
        slo={makeSlo()}
        objective={makeSlo().spec.objectives[0]}
        {...baseProps}
      />
    );
    expect(screen.getByTestId('slos-budget-remaining-empty')).toBeInTheDocument();
  });

  it('renders the exhausted banner when the latest budget sample is <= 0', () => {
    mockUsePromQLChartData.mockReturnValue({
      series: [
        {
          name: 'obj-1',
          data: [
            { timestamp: 1, value: 0.5 },
            { timestamp: 2, value: 0 },
          ],
          color: '#000',
        },
      ],
      latestValue: 0,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(
      <SloBudgetRemainingChart
        slo={makeSlo()}
        objective={makeSlo().spec.objectives[0]}
        {...baseProps}
      />
    );
    expect(screen.getByTestId('slos-budget-remaining-exhausted')).toBeInTheDocument();
  });

  it('shows the unavailable callout when the SLI cannot produce a PromQL query', () => {
    mockUsePromQLChartData.mockReturnValue({
      series: [],
      latestValue: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const slo = makeSlo();
    // Strip the metric so `buildErrorRatioExprForWindow` returns null.
    if (slo.spec.sli.type === 'single' && slo.spec.sli.definition.backend === 'prometheus') {
      slo.spec.sli.definition = {
        ...slo.spec.sli.definition,
        metric: undefined,
        type: 'availability',
      };
    }
    render(<SloBudgetRemainingChart slo={slo} objective={slo.spec.objectives[0]} {...baseProps} />);
    expect(screen.getByText(/Budget chart unavailable/i)).toBeInTheDocument();
  });
});
