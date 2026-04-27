/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error-budget-remaining chart (W4.1).
 *
 * Area chart of `errorBudgetRemaining(t) = 1 - errorRatio(t) / (1 - target)`
 * over the SLO's rolling window. When the chart line crosses below the first
 * budget-warning threshold an operator should treat this SLO as "at risk";
 * when it hits zero the SLO has exhausted its budget and the fill turns
 * danger-red — Jay's review check for "budget-at-zero must visually scream".
 *
 * Data comes from the same inline PromQL the burn-rate panel uses
 * (buildErrorRatioExprForWindow) so the chart lights up immediately even
 * before the recording rules have evaluated. Math is pushed into the PromQL
 * expression (subtract from 1, divide by errorBudget) rather than done in
 * JS — ECharts then sees a pre-shaped series without an extra transform step.
 */

import React, { useMemo } from 'react';
import { EuiCallOut, EuiIcon, EuiPanel, EuiSpacer, EuiText } from '@elastic/eui';
import * as echarts from 'echarts';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { EchartsRender } from '../../../alerting/echarts_render';
import { usePromQLChartData } from '../../shared/hooks/use_promql_chart_data';
import { TimeRange } from '../../common/types/service_types';
import type {
  BudgetWarningThreshold,
  Objective,
  SloDocument,
} from '../../../../../common/slo/slo_types';
import { buildErrorRatioExprForWindow } from './slo_query_builders';
import { formatPct } from '../../../../../common/slo/format';

export interface SloBudgetRemainingChartProps {
  slo: SloDocument;
  objective: Objective;
  prometheusConnectionId: string;
  timeRange: TimeRange;
  refreshTrigger: number;
}

/**
 * Construct a PromQL expression for `(target - errorRatio(t)) / (1 - target)`,
 * which maps [budget exhausted, full budget] to [0, 1]. When errorRatio > 1
 * (impossible in clean data but possible with clock skew on recording rules)
 * the value goes negative — the chart yAxis stays pinned so the negative
 * region shows as "off the floor" rather than redrawing the axis.
 */
function buildBudgetRemainingExpr(
  slo: SloDocument,
  objective: Objective,
  window: string
): string | null {
  const errorRatioExpr = buildErrorRatioExprForWindow(slo, objective, window);
  if (!errorRatioExpr) return null;
  const errorBudget = 1 - objective.target;
  if (errorBudget <= 0) return null;
  // Promql: ((1 - target) - errorRatio) / (1 - target)
  // = clamp_min(..., -0.5) keeps the chart readable if the rule briefly
  //   returns a value > 1 (histogram quirks, cold-start recording rule).
  return `clamp_min((${errorBudget} - (${errorRatioExpr})) / ${errorBudget}, -0.5)`;
}

export interface BudgetRemainingOptionInputs {
  seriesName: string;
  data: Array<[number, number]>;
  warningThreshold?: BudgetWarningThreshold;
  atZero: boolean;
}

/**
 * Exported separately so the unit test can assert on the ECharts spec shape
 * without rendering into jsdom. Keep in sync with the inline render below.
 */
export function buildBudgetRemainingOption(
  inputs: BudgetRemainingOptionInputs
): echarts.EChartsOption {
  const { seriesName, data, warningThreshold, atZero } = inputs;
  const fillColor = atZero ? euiThemeVars.euiColorDanger : euiThemeVars.euiColorSuccess;
  const fillRgba = atZero ? 'rgba(189, 39, 30, 0.35)' : 'rgba(84, 179, 153, 0.25)';

  const markLines: Array<Record<string, unknown>> = [
    {
      yAxis: 0,
      lineStyle: { color: euiThemeVars.euiColorDanger, type: 'solid', width: 1 },
      label: {
        formatter: 'exhausted',
        position: 'insideStartTop',
        color: euiThemeVars.euiColorDanger,
        fontSize: 10,
      },
    },
  ];
  if (warningThreshold) {
    markLines.push({
      yAxis: warningThreshold.threshold,
      lineStyle: {
        color: euiThemeVars.euiColorWarning,
        type: 'dashed',
        width: 1,
      },
      label: {
        formatter: `${warningThreshold.severity} @ ${formatPct(warningThreshold.threshold)}`,
        position: 'insideStartTop',
        color: euiThemeVars.euiColorWarningText,
        fontSize: 10,
      },
    });
  }

  return {
    grid: { left: 50, right: 20, top: 20, bottom: 30, containLabel: true },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = params as Array<{ axisValue: number; value: [number, number] }>;
        if (!list || list.length === 0) return '';
        const p = list[0];
        const ts = new Date(p.axisValue).toLocaleString();
        const v = Array.isArray(p.value) ? p.value[1] : (p.value as number);
        return `${ts}<br/><strong>${formatPct(v)}</strong> remaining`;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: euiThemeVars.euiColorLightShade } },
      axisLabel: { color: euiThemeVars.euiColorDarkShade, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      min: -0.1,
      max: 1,
      axisLabel: {
        color: euiThemeVars.euiColorDarkShade,
        fontSize: 11,
        formatter: (value: number) => formatPct(value),
      },
      splitLine: {
        lineStyle: { color: euiThemeVars.euiColorLightestShade, type: 'dashed' },
      },
    },
    series: [
      {
        name: seriesName,
        type: 'line',
        data,
        smooth: false,
        symbol: 'none',
        lineStyle: { color: fillColor, width: 2 },
        itemStyle: { color: fillColor },
        areaStyle: { color: fillRgba },
        markLine: {
          silent: true,
          symbol: 'none',
          data: markLines,
        },
      },
    ],
  };
}

export const SloBudgetRemainingChart: React.FC<SloBudgetRemainingChartProps> = ({
  slo,
  objective,
  prometheusConnectionId,
  timeRange,
  refreshTrigger,
}) => {
  const window = slo.spec.window.type === 'rolling' ? slo.spec.window.duration : '30d';
  const query = useMemo(() => buildBudgetRemainingExpr(slo, objective, window), [
    slo,
    objective,
    window,
  ]);

  // The first budget-warning threshold drives the "at risk" line. Sort
  // descending so a list like [0.25, 0.5, 0.1] still surfaces the most
  // generous guardrail first — users configure thresholds by risk, not order.
  const warningThreshold = useMemo(() => {
    const list = slo.spec.budgetWarningThresholds ?? [];
    if (list.length === 0) return undefined;
    return [...list].sort((a, b) => b.threshold - a.threshold)[0];
  }, [slo.spec.budgetWarningThresholds]);

  const { series, isLoading, error } = usePromQLChartData({
    promqlQuery: query ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(query),
  });

  // All hooks must be called before the early return — the spec is derived
  // from the fetched series so it's cheap when query is null (empty data).
  const data: Array<[number, number]> = (series[0]?.data ?? []).map((d) => [d.timestamp, d.value]);
  const latest = data.length > 0 ? data[data.length - 1][1] : null;
  const atZero = latest !== null && latest <= 0;
  const hasData = !isLoading && !error && data.length > 0;

  const spec = useMemo(
    () =>
      buildBudgetRemainingOption({
        seriesName: objective.displayName ?? objective.name,
        data,
        warningThreshold,
        atZero,
      }),
    [objective.displayName, objective.name, data, warningThreshold, atZero]
  );

  if (!query) {
    return (
      <EuiPanel data-test-subj="slosBudgetRemainingChart">
        <EuiText size="m">
          <h4>Error budget remaining</h4>
        </EuiText>
        <EuiSpacer size="s" />
        <EuiCallOut size="s" color="warning" iconType="iInCircle" title="Budget chart unavailable">
          <EuiText size="s">
            The SLI is missing the metric or custom expression required to compute the budget.
          </EuiText>
        </EuiCallOut>
      </EuiPanel>
    );
  }

  return (
    <EuiPanel data-test-subj="slosBudgetRemainingChart">
      <EuiText size="m">
        <h4>Error budget remaining</h4>
      </EuiText>
      <EuiText size="xs" color="subdued">
        Fraction of the {window} error budget still available. Starts at 100% and trends toward 0 as
        bad events accumulate. Crossing the warning threshold means an escalation is close.
      </EuiText>
      <EuiSpacer size="s" />
      {error && (
        <EuiCallOut
          size="s"
          color="danger"
          iconType="alert"
          title="Failed to load budget series"
          data-test-subj="slosBudgetRemainingError"
        >
          <EuiText size="s">{error.message}</EuiText>
        </EuiCallOut>
      )}
      {!error && !isLoading && !hasData && (
        <EuiCallOut
          size="s"
          color="primary"
          iconType="iInCircle"
          title="Waiting for data"
          data-test-subj="slosBudgetRemainingEmpty"
        >
          <EuiText size="s">
            The recording rules for this SLO have not evaluated yet. The chart will populate once
            Prometheus returns samples.
          </EuiText>
        </EuiCallOut>
      )}
      {hasData && <EchartsRender spec={spec} height={220} />}
      {hasData && atZero && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="danger" data-test-subj="slosBudgetRemainingExhausted">
            <EuiIcon type="alert" size="s" /> Budget exhausted — any further bad events push the SLO
            further into breach.
          </EuiText>
        </>
      )}
    </EuiPanel>
  );
};
