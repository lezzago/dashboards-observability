/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Aggregate health panel shown above the SLO catalog listing.
 *
 * Derives everything from the SloSummary[] the listing already fetches — no
 * extra network calls.
 *
 * Layout (dense, one EuiPanel, no nested panels padding each section):
 *   Row 1: KPI strip — six stats on one line, active tile highlighted.
 *   Row 2: donut (health distribution) · tier stacked bars · leaderboard.
 */

import React, { useMemo } from 'react';
import {
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiIcon,
  EuiLink,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import type { EChartsOption } from 'echarts';
import { EchartsRender } from '../../../alerting/echarts_render';
import type { SloHealthState, SloSummary } from '../../../../../common/slo/slo_types';
import { SLO_HEALTH_COLOR, SLO_HEALTH_ORDER } from '../../../../../common/slo/state';
import { formatPct } from '../../../../../common/slo/format';

export interface SloOverviewPanelProps {
  items: SloSummary[];
  /** Current active state filter — null means "all". Used to highlight the active tile. */
  activeStateFilter?: SloHealthState | 'firing' | null;
  /** Callback when a KPI tile is clicked. Pass null to clear. */
  onStateFilterChange?: (filter: SloHealthState | 'firing' | null) => void;
}

const STATE_DISPLAY: Record<SloHealthState, { label: string; color: string }> = {
  breached: { label: 'Breached', color: euiThemeVars.euiColorDanger },
  warning: { label: 'Warning', color: euiThemeVars.euiColorWarning },
  ok: { label: 'Healthy', color: euiThemeVars.euiColorSuccess },
  no_data: { label: 'No data', color: euiThemeVars.euiColorMediumShade },
  stale: { label: 'Stale', color: euiThemeVars.euiColorLightShade },
  disabled: { label: 'Disabled', color: euiThemeVars.euiColorDarkShade },
};

interface TierRow {
  tier: string;
  total: number;
  counts: Record<SloHealthState, number>;
}

function groupByTier(items: SloSummary[]): TierRow[] {
  const byTier = new Map<string, TierRow>();
  for (const s of items) {
    const key = s.tier ?? 'untiered';
    let row = byTier.get(key);
    if (!row) {
      row = {
        tier: key,
        total: 0,
        counts: {
          breached: 0,
          warning: 0,
          ok: 0,
          no_data: 0,
          stale: 0,
          disabled: 0,
        },
      };
      byTier.set(key, row);
    }
    row.total++;
    row.counts[s.status.state]++;
  }
  const weight = (t: string) => {
    const m = /^tier-(\d+)$/.exec(t);
    if (m) return Number(m[1]);
    if (t === 'untiered') return 999;
    return 100;
  };
  return [...byTier.values()].sort(
    (a, b) => weight(a.tier) - weight(b.tier) || a.tier.localeCompare(b.tier)
  );
}

/** Pick the worst objective's error-budget remaining for leaderboard ranking. */
function worstBudgetRemaining(summary: SloSummary): number {
  const objectives = summary.status.objectives;
  if (!objectives || objectives.length === 0) return 1;
  return objectives.reduce((acc, o) => Math.min(acc, o.errorBudgetRemaining), 1);
}

/** True iff this SLO is actually producing samples — not no-data and not disabled. */
function isReporting(summary: SloSummary): boolean {
  const state = summary.status.state;
  return state !== 'no_data' && state !== 'stale' && state !== 'disabled';
}

/**
 * Color the aggregate-budget tile by how much headroom is left — this is the
 * first thing an operator sees on the page, so the gradient has to match the
 * same success/warning/danger thresholds used on the listing's budget column.
 */
function aggregateBudgetAccent(avgRemaining: number): string {
  if (avgRemaining >= 0.8) return euiThemeVars.euiColorSuccess;
  if (avgRemaining >= 0.4) return euiThemeVars.euiColorWarning;
  return euiThemeVars.euiColorDanger;
}

/** Compact budget bar used inside the leaderboard. */
const MiniBudgetBar: React.FC<{ remaining: number }> = ({ remaining }) => {
  const consumed = Math.max(0, 1 - remaining);
  const consumedPct = Math.min(100, consumed * 100);
  const overBudget = remaining < 0;
  return (
    <div
      style={{
        position: 'relative',
        height: 4,
        background: euiThemeVars.euiColorLightestShade,
        borderRadius: 2,
        overflow: 'hidden',
        width: '100%',
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
        }}
      />
    </div>
  );
};

/**
 * Compact KPI cell. Renders as a single line: big number + label, with a
 * narrow colored rail on the left to signal severity. Clicking toggles a
 * state filter; the active tile gets a tinted background.
 */
const KpiCell: React.FC<{
  value: number | string;
  label: string;
  accent: string;
  tooltip?: string;
  onClick?: () => void;
  active?: boolean;
  dataTestSubj?: string;
}> = ({ value, label, accent, tooltip, onClick, active, dataTestSubj }) => {
  const clickable = Boolean(onClick);
  const content = (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === 'Enter' || e.key === ' ') onClick?.();
      }}
      data-test-subj={dataTestSubj}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 4,
        cursor: clickable ? 'pointer' : 'default',
        background: active ? euiThemeVars.euiColorLightestShade : 'transparent',
        outline: active ? `1px solid ${euiThemeVars.euiColorPrimary}` : 'none',
        minWidth: 96,
      }}
    >
      <span
        style={{
          width: 3,
          borderRadius: 2,
          background: accent,
          flexShrink: 0,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span
          style={{
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1.1,
            color: accent,
          }}
        >
          {value}
        </span>
        <span
          style={{
            fontSize: 11,
            color: euiThemeVars.euiColorDarkShade,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
  return tooltip ? <EuiToolTip content={tooltip}>{content}</EuiToolTip> : content;
};

function buildHealthDonutOption(counts: {
  breached: number;
  warning: number;
  ok: number;
  noData: number;
  disabled: number;
}): EChartsOption {
  const total = counts.breached + counts.warning + counts.ok + counts.noData + counts.disabled;
  const slices = [
    { name: 'Breached', value: counts.breached, color: STATE_DISPLAY.breached.color },
    { name: 'Warning', value: counts.warning, color: STATE_DISPLAY.warning.color },
    { name: 'Healthy', value: counts.ok, color: STATE_DISPLAY.ok.color },
    { name: 'No data', value: counts.noData, color: STATE_DISPLAY.no_data.color },
    { name: 'Disabled', value: counts.disabled, color: STATE_DISPLAY.disabled.color },
  ].filter((s) => s.value > 0);

  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: {
      show: false,
    },
    series: [
      {
        type: 'pie',
        radius: ['58%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: slices.map((s) => ({
          value: s.value,
          name: s.name,
          itemStyle: { color: s.color, borderWidth: 2, borderColor: '#fff' },
        })),
      },
    ],
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '42%',
        style: {
          text: total.toString(),
          fontSize: 22,
          fontWeight: 700,
          fill: euiThemeVars.euiTextColor,
          textAlign: 'center',
        },
      },
      {
        type: 'text',
        left: 'center',
        top: '58%',
        style: {
          text: total === 1 ? 'SLO' : 'SLOs',
          fontSize: 11,
          fill: euiThemeVars.euiColorDarkShade,
          textAlign: 'center',
        },
      },
    ],
  };
}

function buildTierBarOption(rows: TierRow[]): EChartsOption {
  const categories = rows.map((r) => r.tier);
  const series = SLO_HEALTH_ORDER.filter((s) => s !== 'stale').map((state) => ({
    name: STATE_DISPLAY[state].label,
    type: 'bar' as const,
    stack: 'tier',
    barMaxWidth: 18,
    itemStyle: { color: STATE_DISPLAY[state].color },
    emphasis: { focus: 'series' as const },
    data: rows.map((r) => r.counts[state] + (state === 'no_data' ? r.counts.stale : 0)),
  }));

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    legend: { show: false },
    grid: { left: 8, right: 8, top: 6, bottom: 18, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: euiThemeVars.euiColorDarkShade, fontSize: 10 },
      splitLine: { lineStyle: { color: euiThemeVars.euiColorLightestShade } },
    },
    yAxis: {
      type: 'category',
      data: categories,
      inverse: true,
      axisLabel: { color: euiThemeVars.euiColorDarkShade, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series,
  };
}

export const SloOverviewPanel: React.FC<SloOverviewPanelProps> = ({
  items,
  activeStateFilter,
  onStateFilterChange,
}) => {
  const stats = useMemo(() => {
    let breached = 0;
    let warning = 0;
    let ok = 0;
    let noData = 0;
    let disabled = 0;
    let firing = 0;
    let reportingCount = 0;
    let budgetSum = 0;
    for (const s of items) {
      firing += s.status.firingCount;
      switch (s.status.state) {
        case 'breached':
          breached++;
          break;
        case 'warning':
          warning++;
          break;
        case 'ok':
          ok++;
          break;
        case 'disabled':
          disabled++;
          break;
        case 'no_data':
        case 'stale':
          noData++;
          break;
      }
      if (isReporting(s)) {
        // Weight each SLO equally; the worst-objective budget is the one
        // users already see in the listing, so reuse it as the contribution.
        reportingCount++;
        budgetSum += worstBudgetRemaining(s);
      }
    }
    const avgBudgetRemaining = reportingCount > 0 ? budgetSum / reportingCount : NaN;
    return {
      total: items.length,
      breached,
      warning,
      ok,
      noData,
      disabled,
      firing,
      reportingCount,
      avgBudgetRemaining,
    };
  }, [items]);

  const tierRows = useMemo(() => groupByTier(items), [items]);

  /**
   * Leaderboard — worst budget remaining first, cut off at 6. These are the
   * SLOs about to pop: the most actionable list on the page.
   */
  const leaderboard = useMemo(
    () =>
      [...items]
        .map((s) => ({ summary: s, remaining: worstBudgetRemaining(s) }))
        .filter(({ summary }) => summary.enabled)
        .sort((a, b) => a.remaining - b.remaining)
        .slice(0, 6),
    [items]
  );

  const donutSpec = useMemo(() => buildHealthDonutOption(stats), [stats]);
  const tierSpec = useMemo(() => buildTierBarOption(tierRows), [tierRows]);

  if (items.length === 0) return null;

  const toggle = (next: SloHealthState | 'firing' | null): (() => void) | undefined =>
    onStateFilterChange
      ? () => onStateFilterChange(activeStateFilter === next ? null : next)
      : undefined;

  return (
    <EuiPanel paddingSize="s" data-test-subj="slosOverviewPanel">
      {/* Header: title on the left, clear-filter on the right */}
      <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
        <EuiFlexItem>
          <EuiFlexGroup alignItems="baseline" gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiText size="s">
                <h4 style={{ margin: 0 }}>SLO health overview</h4>
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                Click a tile to filter the catalog below.
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
        {activeStateFilter && onStateFilterChange && (
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              size="xs"
              iconType="cross"
              onClick={() => onStateFilterChange(null)}
              data-test-subj="slosOverview-clearFilter"
            >
              Clear filter
            </EuiButtonEmpty>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>

      <EuiSpacer size="xs" />

      {/* Row 1: KPI strip — budget leads, no-data demoted to the right end. */}
      <EuiFlexGroup
        gutterSize="none"
        responsive={false}
        wrap
        alignItems="stretch"
        style={{
          border: `1px solid ${euiThemeVars.euiColorLightShade}`,
          borderRadius: 4,
          padding: 2,
          background: euiThemeVars.euiColorEmptyShade,
        }}
      >
        <EuiFlexItem grow={false}>
          <KpiCell
            value={
              stats.reportingCount > 0 ? formatPct(stats.avgBudgetRemaining, { decimals: 1 }) : '—'
            }
            label={stats.reportingCount > 0 ? 'Aggregate budget' : 'No reporting SLOs'}
            accent={
              stats.reportingCount > 0
                ? aggregateBudgetAccent(stats.avgBudgetRemaining)
                : euiThemeVars.euiColorMediumShade
            }
            tooltip={`Weighted-average error budget remaining across SLOs that are reporting samples (${stats.reportingCount} of ${stats.total}).`}
            dataTestSubj="slosOverviewBudget"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <KpiCell
            value={stats.breached}
            label="Breached"
            accent={STATE_DISPLAY.breached.color}
            tooltip="SLOs where error ratio exceeded the budget"
            onClick={toggle('breached')}
            active={activeStateFilter === 'breached'}
            dataTestSubj="slosOverview-breached"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <KpiCell
            value={stats.warning}
            label="Warning"
            accent={STATE_DISPLAY.warning.color}
            tooltip="SLOs where short-window burn has tripped a warning tier"
            onClick={toggle('warning')}
            active={activeStateFilter === 'warning'}
            dataTestSubj="slosOverview-warning"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <KpiCell
            value={stats.ok}
            label="Healthy"
            accent={STATE_DISPLAY.ok.color}
            tooltip="SLOs meeting their objective"
            onClick={toggle('ok')}
            active={activeStateFilter === 'ok'}
            dataTestSubj="slosOverview-ok"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <KpiCell
            value={stats.firing}
            label="Firing"
            accent={
              stats.firing > 0 ? euiThemeVars.euiColorDanger : euiThemeVars.euiColorMediumShade
            }
            tooltip="Total MWMBR burn-rate alerts currently firing"
            onClick={toggle('firing')}
            active={activeStateFilter === 'firing'}
            dataTestSubj="slosOverview-firing"
          />
        </EuiFlexItem>
        {/* Spacer pushes no-data/disabled to the right end — it's background
            state (most dev clusters are mostly no_data), not a leading signal. */}
        <EuiFlexItem />
        <EuiFlexItem grow={false}>
          <KpiCell
            value={stats.noData + stats.disabled}
            label="No data / disabled"
            accent={euiThemeVars.euiColorMediumShade}
            tooltip="SLOs with no recent samples or explicitly disabled"
            onClick={toggle('no_data')}
            active={activeStateFilter === 'no_data'}
            dataTestSubj="slosOverview-noData"
          />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="s" />

      {/* Row 2: donut + tier bars + leaderboard */}
      <EuiFlexGroup gutterSize="s" responsive alignItems="stretch">
        <EuiFlexItem grow={2} style={{ minWidth: 200 }}>
          <div
            style={{
              border: `1px solid ${euiThemeVars.euiColorLightShade}`,
              borderRadius: 4,
              padding: 8,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
            data-test-subj="slosOverview-donut"
          >
            <EuiText size="xs">
              <strong>Health mix</strong>
            </EuiText>
            <div style={{ flex: 1, minHeight: 140 }}>
              <EchartsRender spec={donutSpec} height={140} />
            </div>
            <EuiFlexGroup gutterSize="xs" responsive={false} wrap>
              {(['breached', 'warning', 'ok', 'no_data', 'disabled'] as const).map((s) => (
                <EuiFlexItem key={s} grow={false}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10,
                      color: euiThemeVars.euiColorDarkShade,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: STATE_DISPLAY[s].color,
                        display: 'inline-block',
                      }}
                    />
                    {STATE_DISPLAY[s].label}
                  </span>
                </EuiFlexItem>
              ))}
            </EuiFlexGroup>
          </div>
        </EuiFlexItem>

        <EuiFlexItem grow={3} style={{ minWidth: 260 }}>
          <div
            style={{
              border: `1px solid ${euiThemeVars.euiColorLightShade}`,
              borderRadius: 4,
              padding: 8,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
            data-test-subj="slosOverview-tierBars"
          >
            <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiText size="xs">
                  <strong>Health by tier</strong>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  counts per state
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
            <div style={{ flex: 1, minHeight: 160 }}>
              <EchartsRender spec={tierSpec} height={Math.max(130, tierRows.length * 28 + 30)} />
            </div>
          </div>
        </EuiFlexItem>

        <EuiFlexItem grow={3} style={{ minWidth: 280 }}>
          <div
            style={{
              border: `1px solid ${euiThemeVars.euiColorLightShade}`,
              borderRadius: 4,
              padding: 8,
              height: '100%',
            }}
            data-test-subj="slosOverview-leaderboard"
          >
            <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiText size="xs">
                  <strong>Error-budget leaderboard</strong>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  worst remaining budget first
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="xs" />
            {leaderboard.length === 0 ? (
              <EuiText size="s" color="subdued">
                Nothing enabled yet.
              </EuiText>
            ) : (
              leaderboard.map(({ summary: s, remaining }) => (
                <div
                  key={s.id}
                  style={{
                    padding: '4px 0',
                    borderBottom: `1px solid ${euiThemeVars.euiColorLightestShade}`,
                  }}
                >
                  <EuiFlexGroup
                    gutterSize="s"
                    alignItems="center"
                    responsive={false}
                    justifyContent="spaceBetween"
                  >
                    <EuiFlexItem style={{ minWidth: 0 }}>
                      <EuiLink href={`#/slos/${encodeURIComponent(s.id)}`}>
                        <EuiText size="xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <strong>{s.name}</strong>
                        </EuiText>
                      </EuiLink>
                      <EuiText size="xs" color="subdued">
                        {s.service}
                        {s.tier ? ` · ${s.tier}` : ''} · {s.owner.teams[0] ?? '—'}
                      </EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false} style={{ minWidth: 72, textAlign: 'right' }}>
                      <EuiText
                        size="xs"
                        color={remaining <= 0 ? 'danger' : remaining < 0.25 ? 'accent' : 'success'}
                      >
                        <strong>
                          {remaining <= 0 ? 'over' : `${Math.max(0, remaining * 100).toFixed(0)}%`}
                        </strong>
                      </EuiText>
                      <EuiText size="xs" color="subdued">
                        {s.status.firingCount > 0 ? (
                          <span style={{ color: euiThemeVars.euiColorDangerText }}>
                            <EuiIcon type="bell" size="s" /> {s.status.firingCount}
                          </span>
                        ) : (
                          <EuiHealth color={SLO_HEALTH_COLOR[s.status.state]}>
                            <span style={{ fontSize: 10 }}>{s.status.state}</span>
                          </EuiHealth>
                        )}
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <div style={{ marginTop: 3 }}>
                    <MiniBudgetBar remaining={remaining} />
                  </div>
                </div>
              ))
            )}
          </div>
        </EuiFlexItem>
      </EuiFlexGroup>
    </EuiPanel>
  );
};
