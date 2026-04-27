/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error-budget panel: the "am I safe?" summary for one SLO objective.
 *
 * Three tiles across the top:
 *   1. Attainment vs target — the headline SLI value over the SLO's own window
 *   2. Error budget remaining — how much of the allowed bad-event budget is left
 *   3. Time-to-exhaustion — linear forecast based on the current 1h burn rate
 *
 * Plus a big horizontal budget bar showing consumed/remaining.
 *
 * Values come from the `SloLiveStatus` the server already computes plus a
 * live 1h error-ratio query for the forecast. Keeping the forecast tied to the
 * 1h recorder means it reacts quickly to incidents without being noisy on the
 * 5m scale.
 */

import React, { useMemo } from 'react';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiStat,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { usePromQLChartData } from '../../shared/hooks/use_promql_chart_data';
import { TimeRange } from '../../common/types/service_types';
import type { Objective, SloDocument, SloLiveStatus } from '../../../../../common/slo/slo_types';
import { buildErrorRatioExprForWindow } from './slo_query_builders';
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
 * Horizontal bar: left = consumed (red), right = remaining (green). Scales so
 * negative remaining renders as fully-red plus an overflow indicator.
 */
const BudgetBar: React.FC<{ remaining: number }> = ({ remaining }) => {
  const consumed = Math.max(0, 1 - remaining);
  const consumedPct = Math.min(100, consumed * 100);
  const overBudget = remaining < 0;

  return (
    <div
      style={{
        position: 'relative',
        height: 14,
        background: euiThemeVars.euiColorLightestShade,
        borderRadius: 4,
        overflow: 'hidden',
      }}
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
    </div>
  );
};

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

  const windowMs =
    slo.spec.window.type === 'rolling' ? parseDurationToMs(slo.spec.window.duration) : 0;
  const timeLeftMs = estimateTimeToExhaustion(remaining, oneHourErrorRatio, errorBudget, windowMs);

  const attainmentColor =
    attainment >= target
      ? euiThemeVars.euiColorSuccessText
      : attainment >= target - errorBudget * 0.5
      ? euiThemeVars.euiColorWarningText
      : euiThemeVars.euiColorDangerText;

  const remainingColor = remaining > 0.25 ? 'success' : remaining > 0 ? 'accent' : 'danger';

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
              <EuiToolTip content="Number of alert rules generated for this SLO.">
                <span>Rules provisioned</span>
              </EuiToolTip>
            }
            title={liveStatus.ruleCount ?? 0}
            titleColor="subdued"
            data-test-subj="slosBudgetRules"
          />
          <EuiText size="xs" color="subdued">
            {liveStatus.firingCount > 0 ? (
              <span style={{ color: euiThemeVars.euiColorDangerText }}>
                <EuiIcon type="bell" size="s" /> {liveStatus.firingCount} firing
              </span>
            ) : (
              'no alerts firing'
            )}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiText size="xs" color="subdued">
        <strong>Budget consumed</strong> — {formatPct(Math.max(0, 1 - remaining), { decimals: 1 })}{' '}
        of allowed
      </EuiText>
      <EuiSpacer size="xs" />
      <BudgetBar remaining={remaining} />
    </EuiPanel>
  );
};
