/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Burn-rate-per-tier chart (W4.1).
 *
 * Overlaid line chart showing `burnRate(t) = errorRatio(t, longWindow) / (1 - target)`
 * for each MWMBR tier the user configured. A horizontal markLine per tier shows
 * that tier's `burnRateMultiplier` threshold, annotated with the tier's
 * severity — Jay's chart-conventions review check.
 *
 * The alerting rule fires when burn > threshold AND sustained for `forDuration`;
 * this chart shows the "about to page me?" trajectory.
 *
 * Hook-count discipline: each tier renders its own child component (TierFetcher)
 * so the number of hooks per component stays fixed across renders. If the
 * user later edits the spec to add/remove tiers, the child list mounts/
 * unmounts cleanly instead of violating rules-of-hooks via in-map hooks.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { EuiCallOut, EuiPanel, EuiSpacer, EuiText } from '@elastic/eui';
import * as echarts from 'echarts';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { EchartsRender } from '../../../alerting/echarts_render';
import { usePromQLChartData } from '../../shared/hooks/use_promql_chart_data';
import { TimeRange } from '../../common/types/service_types';
import { CHART_COLORS } from '../../common/constants';
import type { BurnRateConfig, Objective, SloDocument } from '../../../../../common/slo/slo_types';
import { buildCoverageProbeQuery, buildErrorRatioExprForWindow } from './slo_query_builders';

export interface SloBurnRateChartProps {
  slo: SloDocument;
  objective: Objective;
  prometheusConnectionId: string;
  timeRange: TimeRange;
  refreshTrigger: number;
}

/** Friendly labels for the four default MWMBR tiers, in index order. */
const TIER_LABELS = ['Page · Quick', 'Page · Slow', 'Ticket · Quick', 'Ticket · Slow'] as const;

function formatMultiplier(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}x` : `${rounded.toFixed(1)}x`;
}

export interface BurnRateOptionInputs {
  tiers: Array<{
    label: string;
    severity: string;
    multiplier: number;
    color: string;
    data: Array<[number, number]>;
  }>;
}

/**
 * Exported separately so unit tests can assert on the ECharts spec shape
 * without rendering into jsdom. Keep in sync with the render below.
 */
export function buildBurnRateOption(inputs: BurnRateOptionInputs): echarts.EChartsOption {
  const { tiers } = inputs;

  // Upper bound of everything we need to fit — tier thresholds plus sampled
  // burn values. ECharts autoscales yAxis from series alone and would clip the
  // top threshold's markLine label (rendered at the line's y position) against
  // the grid's top edge. Compute the required height and pad ~15% for the label,
  // then round up to a clean integer so the rendered axis labels don't pick up
  // floating-point noise (e.g. `22.99999999…` rendering as "23x").
  const seriesMax = tiers.reduce((acc, t) => {
    for (const [, v] of t.data) {
      if (Number.isFinite(v) && v > acc) acc = v;
    }
    return acc;
  }, 0);
  const thresholdMax = tiers.reduce((acc, t) => (t.multiplier > acc ? t.multiplier : acc), 0);
  const yMaxCandidate = Math.max(seriesMax, thresholdMax);
  // Fall back to 1 so the axis doesn't collapse when there's no data yet.
  const yMax = yMaxCandidate > 0 ? Math.ceil(yMaxCandidate * 1.15) : 1;
  return {
    grid: { left: 50, right: 20, top: 30, bottom: 40, containLabel: true },
    legend: {
      show: true,
      bottom: 0,
      textStyle: {
        fontSize: 11,
        color: euiThemeVars.euiColorDarkShade,
      },
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 3,
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = params as Array<{
          axisValue: number;
          value: [number, number];
          seriesName: string;
          color: string;
        }>;
        if (!list || list.length === 0) return '';
        const ts = new Date(list[0].axisValue).toLocaleString();
        const rows = list
          .map((p) => {
            const v = Array.isArray(p.value) ? p.value[1] : (p.value as number);
            const swatch = `<span style="display:inline-block;width:10px;height:10px;background:${p.color};margin-right:6px;border-radius:2px;"></span>`;
            return `<div>${swatch}${p.seriesName}: <strong>${formatMultiplier(v)}</strong></div>`;
          })
          .join('');
        return `<div>${ts}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: euiThemeVars.euiColorLightShade } },
      axisLabel: { color: euiThemeVars.euiColorDarkShade, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: 'burn rate',
      nameGap: 25,
      nameTextStyle: { color: euiThemeVars.euiColorDarkShade, fontSize: 11 },
      // Burn rate is non-negative; pin the floor so recording-rule clock-skew
      // blips don't drag the axis below zero and waste vertical space.
      min: 0,
      max: yMax,
      axisLabel: {
        color: euiThemeVars.euiColorDarkShade,
        fontSize: 11,
        formatter: (v: number) => formatMultiplier(v),
      },
      splitLine: {
        lineStyle: { color: euiThemeVars.euiColorLightestShade, type: 'dashed' },
      },
    },
    series: tiers.map((t, idx) => ({
      name: t.label,
      type: 'line',
      data: t.data,
      smooth: false,
      symbol: 'none',
      lineStyle: { color: t.color, width: 2 },
      itemStyle: { color: t.color },
      // Each tier owns its own threshold markLine so the line + threshold
      // share a color — makes 4 overlaid tiers legible without a separate
      // legend entry per threshold.
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: t.color, type: 'dashed', width: 1 },
        label: {
          formatter: `${t.severity} @ ${formatMultiplier(t.multiplier)}`,
          position: idx % 2 === 0 ? 'insideStartTop' : 'insideEndTop',
          color: t.color,
          fontSize: 10,
        },
        data: [{ yAxis: t.multiplier }],
      },
    })),
  };
}

export interface TierSeriesData {
  data: Array<[number, number]>;
  isLoading: boolean;
  error: Error | null;
}

/**
 * One tier fetch. Mounts once per tier and calls its hooks exactly once
 * per render — the parent uses a `Map<index, TierSeriesData>` so adding
 * or removing tiers doesn't shuffle hooks between component instances.
 *
 * Reports data up via an `onChange` callback rather than lifting refs
 * so the parent stays a pure function of state.
 */
interface TierFetcherProps {
  index: number;
  tier: BurnRateConfig;
  slo: SloDocument;
  objective: Objective;
  prometheusConnectionId: string;
  timeRange: TimeRange;
  refreshTrigger: number;
  errorBudget: number;
  onChange: (index: number, result: TierSeriesData) => void;
}

const TierFetcher: React.FC<TierFetcherProps> = ({
  index,
  tier,
  slo,
  objective,
  prometheusConnectionId,
  timeRange,
  refreshTrigger,
  errorBudget,
  onChange,
}) => {
  const query = useMemo(() => buildErrorRatioExprForWindow(slo, objective, tier.longWindow), [
    slo,
    objective,
    tier.longWindow,
  ]);
  const { series, isLoading, error } = usePromQLChartData({
    promqlQuery: query ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(query),
  });

  const result: TierSeriesData = useMemo(() => {
    if (errorBudget <= 0) return { data: [], isLoading, error };
    const points = series[0]?.data ?? [];
    return {
      data: points.map((p) => [p.timestamp, p.value / errorBudget] as [number, number]),
      isLoading,
      error,
    };
  }, [series, errorBudget, isLoading, error]);

  React.useEffect(() => {
    onChange(index, result);
  }, [index, result, onChange]);

  return null;
};

export const SloBurnRateChart: React.FC<SloBurnRateChartProps> = ({
  slo,
  objective,
  prometheusConnectionId,
  timeRange,
  refreshTrigger,
}) => {
  const tiers = slo.spec.alerting.strategy === 'mwmbr' ? slo.spec.alerting.burnRates : [];
  const errorBudget = 1 - objective.target;

  // Cap at 4 tiers. W4.1 guidance: "if >3, stack or use the legend pattern" —
  // overlay-with-legend reads cleanly up to 4. Surface the overflow count
  // rather than silently dropping tiers.
  const visible = tiers.slice(0, 4);
  const overflow = tiers.length - visible.length;

  const [seriesByIndex, setSeriesByIndex] = useState<Record<number, TierSeriesData>>({});
  const onTierChange = useCallback((index: number, result: TierSeriesData) => {
    setSeriesByIndex((prev) => ({ ...prev, [index]: result }));
  }, []);

  const tierResults = visible.map((tier, idx) => {
    const entry = seriesByIndex[idx];
    return {
      tier,
      color: CHART_COLORS[idx % CHART_COLORS.length],
      data: entry?.data ?? [],
      isLoading: entry?.isLoading ?? false,
      error: entry?.error ?? null,
    };
  });

  const isLoading = tierResults.some((r) => r.isLoading);
  const hasData = tierResults.some((r) => r.data.length > 0);
  const firstError = tierResults.find((r) => r.error)?.error ?? null;

  // Coverage probe — one shared fetch per chart mount. See slo_budget_remaining_chart.tsx
  // for the rationale behind distinguishing "metric missing" vs "window empty".
  const probeQuery = useMemo(() => buildCoverageProbeQuery(slo, objective), [slo, objective]);
  const { series: probeSeries, isLoading: probeLoading } = usePromQLChartData({
    promqlQuery: probeQuery ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(probeQuery),
  });
  const metricExists = probeSeries.some((s) => s.data.length > 0);

  const spec = useMemo(
    () =>
      buildBurnRateOption({
        tiers: tierResults.map((r, idx) => ({
          label: TIER_LABELS[idx] ?? `Tier ${idx + 1}`,
          severity: r.tier.severity,
          multiplier: r.tier.burnRateMultiplier,
          color: r.color,
          data: r.data,
        })),
      }),
    [tierResults]
  );

  return (
    <EuiPanel data-test-subj="slosBurnRateChart">
      <EuiText size="m">
        <h4>Burn rate by tier</h4>
      </EuiText>
      <EuiText size="xs" color="subdued">
        Each tier&apos;s long-window burn rate plotted against its threshold. An alert fires when
        the line stays above the dashed threshold for the tier&apos;s <code>for</code> duration.
      </EuiText>
      <EuiSpacer size="s" />

      {visible.map((tier, idx) => (
        <TierFetcher
          key={`${tier.shortWindow}-${tier.longWindow}-${tier.severity}`}
          index={idx}
          tier={tier}
          slo={slo}
          objective={objective}
          prometheusConnectionId={prometheusConnectionId}
          timeRange={timeRange}
          refreshTrigger={refreshTrigger}
          errorBudget={errorBudget}
          onChange={onTierChange}
        />
      ))}

      {tiers.length === 0 && (
        <EuiCallOut
          size="s"
          color="warning"
          iconType="iInCircle"
          title="No burn-rate tiers configured"
          data-test-subj="slosBurnRateEmptyTiers"
        >
          <EuiText size="s">
            Configure MWMBR tiers in the Advanced section of the SLO wizard to populate this chart.
          </EuiText>
        </EuiCallOut>
      )}
      {tiers.length > 0 && firstError && (
        <EuiCallOut
          size="s"
          color="danger"
          iconType="alert"
          title="Failed to load burn-rate series"
          data-test-subj="slosBurnRateError"
        >
          <EuiText size="s">{firstError.message}</EuiText>
        </EuiCallOut>
      )}
      {tiers.length > 0 && !firstError && !isLoading && !hasData && !probeLoading && !metricExists && (
        <EuiCallOut
          size="s"
          color="warning"
          iconType="alert"
          title="SLI source metric not found in this datasource"
          data-test-subj="slosBurnRateMissingMetric"
        >
          <EuiText size="s">
            No samples exist for the metric this SLI queries on
            <strong> {prometheusConnectionId}</strong>. Burn rate is derived from the same error
            ratio as the budget chart — if that metric is absent, burn rate can&apos;t populate.
            Waiting won&apos;t help; re-check the SLI&apos;s metric / selectors.
          </EuiText>
        </EuiCallOut>
      )}
      {tiers.length > 0 && !firstError && !isLoading && !hasData && !probeLoading && metricExists && (
        <EuiCallOut
          size="s"
          color="primary"
          iconType="iInCircle"
          title="No samples in the selected time range"
          data-test-subj="slosBurnRateEmpty"
        >
          <EuiText size="s">
            The metric exists in this datasource but the current range returned no burn-rate
            samples. Widen the time range, or wait for the next Prometheus scrape + rule evaluation.
          </EuiText>
        </EuiCallOut>
      )}
      {tiers.length > 0 && hasData && <EchartsRender spec={spec} height={260} />}
      {overflow > 0 && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            {overflow} additional tier{overflow === 1 ? '' : 's'} hidden for legibility. See the
            burn-rate alerts panel below for the full matrix.
          </EuiText>
        </>
      )}
    </EuiPanel>
  );
};
