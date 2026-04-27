/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error-budget panel: the "am I safe?" summary for one SLO objective.
 *
 * Four tiles across the top:
 *   1. Attainment vs target — the headline SLI value over the SLO's own window
 *   2. Error budget remaining — how much of the allowed bad-event budget is left
 *   3. Time-to-exhaustion — linear forecast based on the current 1h burn rate
 *   4. Events (1h) — good/total counts + ratio, recent signal of SLI health
 *
 * Plus a budget bar showing consumed/remaining with a warning-threshold marker
 * and a thin 24h-consumption overlay so operators see "how fast am I burning
 * *right now*" against the overall window.
 *
 * Values come from the `SloLiveStatus` the server already computes plus a few
 * lightweight PromQL queries (1h burn ratio, 1h good/total counts, 24h error
 * ratio). Keeping the forecast tied to the 1h recorder means it reacts quickly
 * to incidents without being noisy on the 5m scale. "Rules provisioned" has
 * moved to the Advanced-details accordion since it's an implementation signal,
 * not an operator signal.
 */

import React, { useMemo } from 'react';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiStat,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { usePromQLChartData } from '../../shared/hooks/use_promql_chart_data';
import { TimeRange } from '../../common/types/service_types';
import type {
  BudgetWarningThreshold,
  Objective,
  SloDocument,
  SloLiveStatus,
} from '../../../../../common/slo/slo_types';
import {
  buildErrorRatioExprForWindow,
  buildGoodEventsCountQuery,
  buildTotalEventsCountQuery,
} from './slo_query_builders';
import { formatPct } from '../../../../../common/slo/format';

export interface SloBudgetPanelProps {
  slo: SloDocument;
  objective: Objective;
  liveStatus: SloLiveStatus;
  prometheusConnectionId: string;
  timeRange: TimeRange;
  refreshTrigger: number;
}

function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d|w)$/);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return val * 1_000;
    case 'm':
      return val * 60_000;
    case 'h':
      return val * 3_600_000;
    case 'd':
      return val * 86_400_000;
    case 'w':
      return val * 604_800_000;
    default:
      return 0;
  }
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Linear forecast: at the observed 1h burn rate, how long until the remaining
 * budget hits zero? Returns null when the burn rate is at or below the
 * sustainable rate (= error budget itself over the window).
 */
function estimateTimeToExhaustion(
  remaining: number,
  current1hErrorRatio: number | null,
  errorBudget: number,
  windowMs: number
): number | null {
  if (current1hErrorRatio === null || !Number.isFinite(current1hErrorRatio)) return null;
  if (remaining <= 0) return 0;
  if (errorBudget <= 0) return null;

  // The sustainable burn rate is "errorBudget per window" — anything at or
  // below that lasts forever in the linear model.
  const burnRate = current1hErrorRatio / errorBudget; // multiple of the sustainable rate
  if (burnRate <= 1) return null;

  // remaining (fraction of budget) * window / (burnRate - 1) — subtract 1 because
  // the window already "earns" budget at the sustainable rate.
  return (remaining * windowMs) / (burnRate - 1);
}

/**
 * Horizontal budget bar.
 *
 * Layout:
 *  - Main bar: left = consumed (red/warning), right = remaining (green).
 *    Scales so negative remaining renders as fully-red + overflow indicator.
 *  - Warning threshold: a dashed vertical line at the "consumed > warn"
 *    position (e.g. 50% of budget). Gives operators a visual anchor for
 *    "how close am I to paging on budget depletion?".
 *  - 24h overlay: a thin bar beneath the main bar showing the last 24h of
 *    budget consumption as a proportion of total budget — answers "am I
 *    burning faster than the window allows?". Omitted when 24h data is
 *    unavailable rather than rendering a placeholder.
 */
const BudgetBar: React.FC<{
  /** Fraction of budget remaining (0..1; can be negative). */
  remaining: number;
  /**
   * Warn-at-consumed fraction in [0, 1]. 0.5 = "warn once half the budget is
   * burned". If null, the threshold marker is omitted.
   */
  warnAtConsumed: number | null;
  /**
   * Fraction of budget consumed by the last 24h of burn, in [0, 1]. When null,
   * the 24h overlay is omitted.
   */
  last24hConsumed: number | null;
}> = ({ remaining, warnAtConsumed, last24hConsumed }) => {
  const consumed = Math.max(0, 1 - remaining);
  const consumedPct = Math.min(100, consumed * 100);
  const overBudget = remaining < 0;
  const warnPct =
    warnAtConsumed !== null && warnAtConsumed >= 0 && warnAtConsumed <= 1
      ? warnAtConsumed * 100
      : null;
  const show24h = last24hConsumed !== null && Number.isFinite(last24hConsumed);
  const last24hPct = show24h ? Math.min(100, Math.max(0, last24hConsumed as number) * 100) : 0;

  return (
    <>
      <div
        style={{
          position: 'relative',
          height: 14,
          background: euiThemeVars.euiColorLightestShade,
          borderRadius: 4,
          overflow: 'hidden',
        }}
        data-test-subj="slosBudgetBar"
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${consumedPct}%`,
            background: overBudget ? euiThemeVars.euiColorDanger : euiThemeVars.euiColorWarning,
            transition: 'width 200ms ease',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: `${consumedPct}%`,
            top: 0,
            bottom: 0,
            right: 0,
            background: euiThemeVars.euiColorSuccess,
            opacity: overBudget ? 0 : 0.35,
          }}
        />
        {warnPct !== null && (
          <div
            style={{
              position: 'absolute',
              left: `${warnPct}%`,
              top: -2,
              bottom: -2,
              width: 0,
              borderLeft: `1px dashed ${euiThemeVars.euiColorDangerText}`,
            }}
            data-test-subj="slosBudgetBarThreshold"
          />
        )}
      </div>
      {show24h && (
        <div
          style={{
            position: 'relative',
            height: 3,
            marginTop: 2,
            background: euiThemeVars.euiColorLightestShade,
            borderRadius: 2,
            overflow: 'hidden',
          }}
          data-test-subj="slosBudgetBar24h"
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${last24hPct}%`,
              background: euiThemeVars.euiColorVis5,
            }}
          />
        </div>
      )}
    </>
  );
};

/** Format an event count compactly (e.g. 12400 → "12.4k", 1_500_000 → "1.5M"). */
function formatCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs >= 10) return `${Math.round(n)}`;
  return n.toFixed(1);
}

/** Pick the tightest warning threshold the user configured (largest fraction
 *  remaining that triggers the warn band). Falls back to 50%-consumed when the
 *  SLO carries no budget-warning thresholds so the detail page still renders
 *  a meaningful marker — SloSpec carries budgetWarningThresholds as a list of
 *  "remaining" fractions, no dedicated "warn-at-consumed" field. */
function warnAtConsumedFromSpec(thresholds: BudgetWarningThreshold[] | undefined): number {
  if (!thresholds || thresholds.length === 0) return 0.5;
  const tightest = thresholds.reduce(
    (best, t) => (t.threshold > best ? t.threshold : best),
    -Infinity
  );
  if (!Number.isFinite(tightest)) return 0.5;
  return Math.min(1, Math.max(0, 1 - tightest));
}

export const SloBudgetPanel: React.FC<SloBudgetPanelProps> = ({
  slo,
  objective,
  liveStatus,
  prometheusConnectionId,
  timeRange,
  refreshTrigger,
}) => {
  const objectiveStatus =
    liveStatus.objectives.find((o) => o.objectiveName === objective.name) ??
    liveStatus.objectives[0];

  const target = objective.target;
  const errorBudget = 1 - target;
  const remaining = objectiveStatus?.errorBudgetRemaining ?? 1;
  const attainment = objectiveStatus?.attainment ?? target;

  // Drive the time-to-exhaustion off a 1h error ratio. We always query, but
  // the card renders "—" cleanly when no samples are returned.
  const burnRateQuery = useMemo(() => buildErrorRatioExprForWindow(slo, objective, '1h'), [
    slo,
    objective,
  ]);
  const { latestValue: oneHourErrorRatio } = usePromQLChartData({
    promqlQuery: burnRateQuery ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(burnRateQuery),
  });

  // Raw 1h good/total counts drive the Events stat. Custom SLIs return null
  // from the builders — the stat renders "—" / "waiting for samples".
  const goodEventsQuery = useMemo(() => buildGoodEventsCountQuery(slo, objective, '1h'), [
    slo,
    objective,
  ]);
  const totalEventsQuery = useMemo(() => buildTotalEventsCountQuery(slo, objective, '1h'), [
    slo,
    objective,
  ]);
  const { latestValue: goodEvents } = usePromQLChartData({
    promqlQuery: goodEventsQuery ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(goodEventsQuery),
  });
  const { latestValue: totalEvents } = usePromQLChartData({
    promqlQuery: totalEventsQuery ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(totalEventsQuery),
  });

  // 24h error ratio powers the thin secondary bar: "what fraction of the
  // total budget did the last 24h consume?". Sustains the "faster-than-
  // sustainable burn" visual cue without adding another scalar card.
  const twentyFourHourBurnQuery = useMemo(
    () => buildErrorRatioExprForWindow(slo, objective, '24h'),
    [slo, objective]
  );
  const { latestValue: twentyFourHourErrorRatio } = usePromQLChartData({
    promqlQuery: twentyFourHourBurnQuery ?? '',
    timeRange,
    prometheusConnectionId,
    refreshTrigger,
    enabled: Boolean(twentyFourHourBurnQuery),
  });

  const windowMs =
    slo.spec.window.type === 'rolling' ? parseDurationToMs(slo.spec.window.duration) : 0;
  const timeLeftMs = estimateTimeToExhaustion(remaining, oneHourErrorRatio, errorBudget, windowMs);

  const last24hConsumed =
    twentyFourHourErrorRatio !== null &&
    Number.isFinite(twentyFourHourErrorRatio) &&
    windowMs > 0 &&
    errorBudget > 0
      ? // Fraction of total budget consumed by 24h of this error rate.
        Math.max(0, (twentyFourHourErrorRatio * (24 * 3_600_000)) / (errorBudget * windowMs))
      : null;

  const warnAtConsumed = warnAtConsumedFromSpec(slo.spec.budgetWarningThresholds);

  const attainmentColor =
    attainment >= target
      ? euiThemeVars.euiColorSuccessText
      : attainment >= target - errorBudget * 0.5
      ? euiThemeVars.euiColorWarningText
      : euiThemeVars.euiColorDangerText;

  const remainingColor = remaining > 0.25 ? 'success' : remaining > 0 ? 'accent' : 'danger';

  // Events stat colour mirrors the attainment semantics: green when ratio is
  // at/above target, warning when below target but still above (target -
  // errorBudget), danger when below both.
  const eventsRatio =
    goodEvents !== null && totalEvents !== null && totalEvents > 0
      ? goodEvents / totalEvents
      : null;
  const eventsAvailable = eventsRatio !== null;
  const eventsColor =
    eventsRatio === null
      ? euiThemeVars.euiTextSubduedColor
      : eventsRatio >= target
      ? euiThemeVars.euiColorSuccessText
      : eventsRatio >= target - errorBudget
      ? euiThemeVars.euiColorWarningText
      : euiThemeVars.euiColorDangerText;

  return (
    <EuiPanel data-test-subj="slosBudgetPanel">
      <EuiFlexGroup alignItems="center">
        <EuiFlexItem>
          <EuiText size="m">
            <h4>Error budget</h4>
          </EuiText>
          <EuiText size="xs" color="subdued">
            {slo.spec.window.type === 'rolling'
              ? `Rolling ${slo.spec.window.duration} window — target ${formatPct(target, {
                  decimals: 3,
                }).replace(/\.?0+%$/, '%')}`
              : `Calendar ${slo.spec.window.period} window`}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="s" />

      <EuiFlexGroup gutterSize="m" responsive>
        <EuiFlexItem>
          <EuiStat
            titleSize="m"
            reverse
            description={
              <EuiToolTip content="Current SLI value over the SLO's window, compared to the target.">
                <span>Attainment</span>
              </EuiToolTip>
            }
            title={
              <span style={{ color: attainmentColor }}>
                {formatPct(attainment, { decimals: 3 }).replace(/\.?0+%$/, '%')}
              </span>
            }
            data-test-subj="slosBudgetAttainment"
          />
          <EuiText size="xs" color="subdued">
            target {formatPct(target, { decimals: 3 }).replace(/\.?0+%$/, '%')}
          </EuiText>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiStat
            titleSize="m"
            reverse
            titleColor={remainingColor as 'success' | 'accent' | 'danger'}
            description={
              <EuiToolTip content="Fraction of the error budget still available. Negative means the SLO has been exceeded.">
                <span>Budget remaining</span>
              </EuiToolTip>
            }
            title={formatPct(remaining, { decimals: 1 })}
            data-test-subj="slosBudgetRemaining"
          />
          <EuiText size="xs" color="subdued">
            budget {formatPct(errorBudget, { decimals: 3 }).replace(/\.?0+%$/, '%')} total
          </EuiText>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiStat
            titleSize="m"
            reverse
            description={
              <EuiToolTip content="Linear forecast at the current 1h burn rate. '—' means burn is at or below the sustainable rate.">
                <span>Time to exhaustion</span>
              </EuiToolTip>
            }
            title={
              timeLeftMs === null
                ? '—'
                : timeLeftMs === 0
                ? 'exhausted'
                : formatDurationMs(timeLeftMs)
            }
            titleColor={
              timeLeftMs !== null && timeLeftMs < 3_600_000
                ? 'danger'
                : timeLeftMs !== null && timeLeftMs < 24 * 3_600_000
                ? 'accent'
                : 'subdued'
            }
            data-test-subj="slosBudgetExhaustion"
          />
          <EuiText size="xs" color="subdued">
            based on 1h burn
          </EuiText>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiStat
            titleSize="m"
            reverse
            description={
              <EuiToolTip content="Good vs total events observed in the last hour. Colour tracks the attainment thresholds — green at/above target, warning below target but within the error budget, danger once below.">
                <span>Events (1h)</span>
              </EuiToolTip>
            }
            title={
              <span style={{ color: eventsColor }}>
                {eventsAvailable ? (
                  <>
                    {formatCount(goodEvents)} / {formatCount(totalEvents)}
                  </>
                ) : (
                  '—'
                )}
              </span>
            }
            data-test-subj="slosBudgetEvents"
          />
          <EuiText size="xs" color="subdued">
            {eventsAvailable
              ? `${formatPct(eventsRatio as number, { decimals: 2 })}`
              : 'waiting for samples'}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiText size="xs" color="subdued">
        <strong>Budget consumed</strong> — {formatPct(Math.max(0, 1 - remaining), { decimals: 1 })}{' '}
        of allowed
      </EuiText>
      <EuiSpacer size="xs" />
      <BudgetBar
        remaining={remaining}
        warnAtConsumed={warnAtConsumed}
        last24hConsumed={last24hConsumed}
      />
    </EuiPanel>
  );
};
