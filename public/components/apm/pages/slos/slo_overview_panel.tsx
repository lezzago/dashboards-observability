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
 * Layout:
 *   Row 1: six KPI tiles (Total / Breached / Warning / Healthy / Firing / No-data)
 *          — each tile (except Total) doubles as a quick filter when clicked.
 *   Row 2: health-by-tier stacked bars · error-budget leaderboard
 *   Row 3: SLI backend/type mix (compact chip row)
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
  EuiStat,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import type { SloHealthState, SloSummary } from '../../../../../common/slo/slo_types';

export interface SloOverviewPanelProps {
  items: SloSummary[];
  /** Current active state filter — null means "all". Used to highlight the active tile. */
  activeStateFilter?: SloHealthState | 'firing' | null;
  /** Callback when a KPI tile is clicked. Pass null to clear. */
  onStateFilterChange?: (filter: SloHealthState | 'firing' | null) => void;
}

const STATE_COLOR: Record<SloHealthState, string> = {
  breached: 'danger',
  warning: 'warning',
  ok: 'success',
  no_data: 'subdued',
  stale: 'subdued',
  disabled: 'default',
};

function segmentHex(state: SloHealthState): string {
  switch (state) {
    case 'breached':
      return euiThemeVars.euiColorDanger;
    case 'warning':
      return euiThemeVars.euiColorWarning;
    case 'ok':
      return euiThemeVars.euiColorSuccess;
    case 'disabled':
      return euiThemeVars.euiColorDarkShade;
    default:
      return euiThemeVars.euiColorLightShade;
  }
}

const STATE_ORDER: SloHealthState[] = ['breached', 'warning', 'ok', 'no_data', 'stale', 'disabled'];

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

/**
 * Compact budget bar used inside the leaderboard. Same visual language as the
 * detail-page `BudgetBar` but smaller and stateless.
 */
const MiniBudgetBar: React.FC<{ remaining: number }> = ({ remaining }) => {
  const consumed = Math.max(0, 1 - remaining);
  const consumedPct = Math.min(100, consumed * 100);
  const overBudget = remaining < 0;
  return (
    <div
      style={{
        position: 'relative',
        height: 6,
        background: euiThemeVars.euiColorLightestShade,
        borderRadius: 3,
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
 * Wraps an `EuiStat` so clicking it toggles the state filter. We render the
 * tile inside a button-styled EuiPanel (rather than an EuiStat inside a button)
 * because nesting a button inside EuiStat's title breaks its typography.
 */
const KpiTile: React.FC<{
  title: number | string;
  description: string;
  color?: 'danger' | 'accent' | 'success' | 'subdued' | 'default';
  tooltip?: string;
  onClick?: () => void;
  active?: boolean;
  dataTestSubj?: string;
}> = ({ title, description, color, tooltip, onClick, active, dataTestSubj }) => {
  const clickable = Boolean(onClick);
  const content = (
    <EuiPanel
      paddingSize="s"
      hasBorder
      hasShadow={false}
      onClick={onClick}
      data-test-subj={dataTestSubj}
      style={{
        cursor: clickable ? 'pointer' : 'default',
        borderColor: active ? euiThemeVars.euiColorPrimary : undefined,
        borderWidth: active ? 2 : undefined,
      }}
    >
      <EuiStat title={title} description={description} titleSize="m" titleColor={color} reverse />
    </EuiPanel>
  );
  return tooltip ? <EuiToolTip content={tooltip}>{content}</EuiToolTip> : content;
};

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
    }
    return { total: items.length, breached, warning, ok, noData, disabled, firing };
  }, [items]);

  const tierRows = useMemo(() => groupByTier(items), [items]);

  /**
   * Leaderboard — worst budget remaining first, cut off at 8. This is the most
   * actionable list on the page: these are the SLOs about to pop.
   */
  const leaderboard = useMemo(
    () =>
      [...items]
        .map((s) => ({ summary: s, remaining: worstBudgetRemaining(s) }))
        .filter(({ summary }) => summary.enabled)
        .sort((a, b) => a.remaining - b.remaining)
        .slice(0, 8),
    [items]
  );

  /** SLI backend/type mix — small chip row for the "what kind of SLOs do we have?" question. */
  const sliMix = useMemo(() => {
    const byLeaf = new Map<string, number>();
    const byBackend = new Map<string, number>();
    const byMode = new Map<string, number>();
    for (const s of items) {
      byMode.set(s.mode, (byMode.get(s.mode) ?? 0) + 1);
      if (s.sliNodeType === 'composite') {
        byLeaf.set('composite', (byLeaf.get('composite') ?? 0) + 1);
        continue;
      }
      if (s.sliBackend) byBackend.set(s.sliBackend, (byBackend.get(s.sliBackend) ?? 0) + 1);
      if (s.sliLeafType) byLeaf.set(s.sliLeafType, (byLeaf.get(s.sliLeafType) ?? 0) + 1);
    }
    return { byLeaf, byBackend, byMode };
  }, [items]);

  if (items.length === 0) return null;

  const toggle = (next: SloHealthState | 'firing' | null): (() => void) | undefined =>
    onStateFilterChange
      ? () => onStateFilterChange(activeStateFilter === next ? null : next)
      : undefined;

  return (
    <EuiPanel data-test-subj="slosOverviewPanel">
      <EuiFlexGroup alignItems="center">
        <EuiFlexItem>
          <EuiText size="m">
            <h4>SLO health overview</h4>
          </EuiText>
          <EuiText size="xs" color="subdued">
            Aggregate view across every SLO in this workspace. Click a tile to filter the catalog
            below.
          </EuiText>
        </EuiFlexItem>
        {activeStateFilter && onStateFilterChange && (
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              size="s"
              iconType="cross"
              onClick={() => onStateFilterChange(null)}
              data-test-subj="slosOverview-clearFilter"
            >
              Clear filter
            </EuiButtonEmpty>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>

      <EuiSpacer size="s" />

      {/* Row 1: KPI tiles — clickable filters */}
      <EuiFlexGroup gutterSize="s" responsive>
        <EuiFlexItem>
          <KpiTile
            title={stats.total}
            description="Total SLOs"
            tooltip="All SLOs in this workspace"
            dataTestSubj="slosOverview-total"
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <KpiTile
            title={stats.breached}
            description="Breached"
            color="danger"
            tooltip="SLOs where error ratio exceeded the budget"
            onClick={toggle('breached')}
            active={activeStateFilter === 'breached'}
            dataTestSubj="slosOverview-breached"
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <KpiTile
            title={stats.warning}
            description="Warning"
            color="accent"
            tooltip="SLOs where short-window burn has tripped a warning tier"
            onClick={toggle('warning')}
            active={activeStateFilter === 'warning'}
            dataTestSubj="slosOverview-warning"
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <KpiTile
            title={stats.ok}
            description="Healthy"
            color="success"
            tooltip="SLOs meeting their objective"
            onClick={toggle('ok')}
            active={activeStateFilter === 'ok'}
            dataTestSubj="slosOverview-ok"
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <KpiTile
            title={stats.firing}
            description="Firing alerts"
            color={stats.firing > 0 ? 'danger' : 'subdued'}
            tooltip="Total MWMBR burn-rate alerts currently firing"
            onClick={toggle('firing')}
            active={activeStateFilter === 'firing'}
            dataTestSubj="slosOverview-firing"
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <KpiTile
            title={stats.noData + stats.disabled}
            description="No data / disabled"
            color="subdued"
            tooltip="SLOs with no recent samples or explicitly disabled"
            onClick={toggle('no_data')}
            active={activeStateFilter === 'no_data'}
            dataTestSubj="slosOverview-noData"
          />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* Row 2: health-by-tier stacked bars + error-budget leaderboard */}
      <EuiFlexGroup gutterSize="m" responsive>
        <EuiFlexItem>
          <EuiPanel paddingSize="s" hasBorder hasShadow={false}>
            <EuiText size="s">
              <strong>Health by tier</strong>
            </EuiText>
            <EuiSpacer size="xs" />
            <EuiText size="xs" color="subdued">
              Stacked counts of SLOs in each state, grouped by tier.
            </EuiText>
            <EuiSpacer size="s" />
            {tierRows.map((row) => (
              <div key={row.tier} style={{ marginBottom: 10 }}>
                <EuiFlexGroup
                  gutterSize="s"
                  alignItems="center"
                  responsive={false}
                  justifyContent="spaceBetween"
                >
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs">
                      <strong>{row.tier}</strong>
                    </EuiText>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      {row.total}
                    </EuiText>
                  </EuiFlexItem>
                </EuiFlexGroup>
                <EuiSpacer size="xs" />
                <TierStackBar row={row} />
              </div>
            ))}
            <EuiSpacer size="xs" />
            <Legend />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel paddingSize="s" hasBorder hasShadow={false}>
            <EuiText size="s">
              <strong>Error-budget leaderboard</strong>
            </EuiText>
            <EuiSpacer size="xs" />
            <EuiText size="xs" color="subdued">
              Enabled SLOs ranked by the objective with the least budget remaining.
            </EuiText>
            <EuiSpacer size="s" />
            {leaderboard.length === 0 ? (
              <EuiText size="s" color="subdued">
                Nothing enabled yet.
              </EuiText>
            ) : (
              leaderboard.map(({ summary: s, remaining }) => (
                <div
                  key={s.id}
                  style={{
                    padding: '6px 0',
                    borderBottom: `1px solid ${euiThemeVars.euiColorLightestShade}`,
                  }}
                >
                  <EuiFlexGroup
                    gutterSize="s"
                    alignItems="center"
                    responsive={false}
                    justifyContent="spaceBetween"
                  >
                    <EuiFlexItem>
                      <EuiLink href={`#/slos/${encodeURIComponent(s.id)}`}>
                        <EuiText size="s">
                          <strong>{s.name}</strong>
                        </EuiText>
                      </EuiLink>
                      <EuiText size="xs" color="subdued">
                        {s.service}
                        {s.tier ? ` · ${s.tier}` : ''} · {s.owner.teams[0] ?? '—'}
                      </EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false} style={{ minWidth: 90, textAlign: 'right' }}>
                      <EuiText
                        size="s"
                        color={remaining <= 0 ? 'danger' : remaining < 0.25 ? 'accent' : 'success'}
                      >
                        <strong>
                          {remaining <= 0
                            ? 'over budget'
                            : `${Math.max(0, remaining * 100).toFixed(0)}%`}
                        </strong>
                      </EuiText>
                      <EuiText size="xs" color="subdued">
                        {s.status.firingCount > 0 ? (
                          <span style={{ color: euiThemeVars.euiColorDangerText }}>
                            <EuiIcon type="bell" size="s" /> {s.status.firingCount}
                          </span>
                        ) : (
                          <EuiHealth color={STATE_COLOR[s.status.state]}>
                            {s.status.state}
                          </EuiHealth>
                        )}
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="xs" />
                  <MiniBudgetBar remaining={remaining} />
                </div>
              ))
            )}
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* Row 3: SLI backend/type mix — chips on a single line */}
      <EuiPanel paddingSize="s" hasBorder hasShadow={false}>
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <strong>Mix</strong>
            </EuiText>
          </EuiFlexItem>
          {[...sliMix.byLeaf.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([key, count]) => (
              <EuiFlexItem key={`leaf-${key}`} grow={false}>
                <Chip icon="stats" label={`${key} · ${count}`} />
              </EuiFlexItem>
            ))}
          {[...sliMix.byBackend.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([key, count]) => (
              <EuiFlexItem key={`backend-${key}`} grow={false}>
                <Chip icon="database" label={`${key} · ${count}`} />
              </EuiFlexItem>
            ))}
          {[...sliMix.byMode.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([key, count]) => (
              <EuiFlexItem key={`mode-${key}`} grow={false}>
                <Chip
                  icon={key === 'shadow' ? 'eye' : 'play'}
                  label={`${key} · ${count}`}
                  color={key === 'shadow' ? 'subdued' : undefined}
                />
              </EuiFlexItem>
            ))}
        </EuiFlexGroup>
      </EuiPanel>
    </EuiPanel>
  );
};

/** Stacked proportional bar for one tier. */
const TierStackBar: React.FC<{ row: TierRow }> = ({ row }) => {
  const total = row.total;
  if (total === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: 10,
        borderRadius: 2,
        overflow: 'hidden',
        background: euiThemeVars.euiColorLightestShade,
      }}
    >
      {STATE_ORDER.map((state) => {
        const count = row.counts[state];
        if (count === 0) return null;
        const pct = (count / total) * 100;
        return (
          <EuiToolTip key={state} content={`${state}: ${count}`}>
            <div
              style={{
                width: `${pct}%`,
                background: segmentHex(state),
                height: '100%',
              }}
            />
          </EuiToolTip>
        );
      })}
    </div>
  );
};

const Legend: React.FC = () => {
  const items: Array<{ state: SloHealthState; label: string }> = [
    { state: 'breached', label: 'Breached' },
    { state: 'warning', label: 'Warning' },
    { state: 'ok', label: 'Healthy' },
    { state: 'no_data', label: 'No data' },
    { state: 'disabled', label: 'Disabled' },
  ];
  return (
    <EuiFlexGroup gutterSize="m" responsive={false} wrap>
      {items.map((i) => (
        <EuiFlexItem key={i.state} grow={false}>
          <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
            <EuiFlexItem grow={false}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: segmentHex(i.state),
                }}
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                {i.label}
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      ))}
    </EuiFlexGroup>
  );
};

/** Tiny pill used in the SLI mix row. */
const Chip: React.FC<{ icon: string; label: string; color?: 'subdued' }> = ({
  icon,
  label,
  color,
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 10,
      background: euiThemeVars.euiColorLightestShade,
      fontSize: 11,
      color: color === 'subdued' ? euiThemeVars.euiColorDarkShade : euiThemeVars.euiTextColor,
    }}
  >
    <EuiIcon type={icon} size="s" color={color === 'subdued' ? 'subdued' : undefined} />
    {label}
  </span>
);
