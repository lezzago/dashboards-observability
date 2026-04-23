/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiEmptyPrompt,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiInMemoryTable,
  EuiLink,
  EuiLoadingSpinner,
  EuiPage,
  EuiPageBody,
  EuiPageContent,
  EuiPageContentBody,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { ChromeStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { SloOverviewPanel } from './slo_overview_panel';
import type { SloApiClient } from './slo_api_client';
import type { SloHealthState, SloSummary } from '../../../../../common/slo/slo_types';

export interface SloListingPageProps {
  apiClient: SloApiClient;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

/** Health-state colour mapping for the status column. */
const STATE_COLOR: Record<SloHealthState, string> = {
  breached: 'danger',
  warning: 'warning',
  ok: 'success',
  no_data: 'subdued',
  stale: 'subdued',
  disabled: 'default',
};

function formatTargetPct(target: number): string {
  return `${(target * 100).toFixed(target >= 0.999 ? 2 : 1)}%`;
}

/**
 * Pick the worst objective's remaining budget for the SLO summary — lines up
 * with the overview panel's leaderboard ranking so the column values match.
 */
function worstBudgetRemaining(summary: SloSummary): number {
  const objectives = summary.status.objectives;
  if (!objectives || objectives.length === 0) return 1;
  return objectives.reduce((acc, o) => Math.min(acc, o.errorBudgetRemaining), 1);
}

/** Compact budget bar for the table column. Identical visual language to the overview leaderboard. */
const BudgetColumnBar: React.FC<{ remaining: number }> = ({ remaining }) => {
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
        width: 80,
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

export const SloListingPage: React.FC<SloListingPageProps> = ({
  apiClient,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const [items, setItems] = useState<SloSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // State filter driven by the overview KPI tiles. "firing" is a pseudo-state
  // meaning "any SLO with firingCount > 0" — convenient for the "jump to
  // what's on fire" workflow even though it doesn't map to a single state.
  const [stateFilter, setStateFilter] = useState<SloHealthState | 'firing' | null>(null);

  useEffect(() => {
    chrome.setBreadcrumbs([parentBreadcrumb, { text: 'SLO/SLI' }]);
  }, [chrome, parentBreadcrumb]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.list({ pageSize: 100 });
      setItems(result.results);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      notifications.toasts.addDanger({
        title: 'Failed to load SLOs',
        text: err.message,
      });
    } finally {
      setLoading(false);
    }
  }, [apiClient, notifications]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let out = items;
    if (stateFilter === 'firing') {
      out = out.filter((i) => i.status.firingCount > 0);
    } else if (stateFilter) {
      out = out.filter((i) => i.status.state === stateFilter);
    }
    if (q) {
      out = out.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.service.toLowerCase().includes(q) ||
          (i.description?.toLowerCase().includes(q) ?? false)
      );
    }
    return out;
  }, [items, searchQuery, stateFilter]);

  // EuiBasicTable render signature:
  //   - with `field`:    render(value, row)
  //   - without `field`: render(row)
  // Every column below omits `field` and takes `row` as the only argument.
  const columns = useMemo<Array<EuiBasicTableColumn<SloSummary>>>(
    () => [
      {
        name: 'Name',
        render: (row: SloSummary) => (
          <EuiLink
            href={`#/slos/${encodeURIComponent(row.id)}`}
            data-test-subj={`slos-link-${row.id}`}
          >
            <EuiText size="s">
              <strong>{row.name}</strong>
            </EuiText>
          </EuiLink>
        ),
      },
      {
        name: 'Service',
        render: (row: SloSummary) => <EuiText size="s">{row.service}</EuiText>,
      },
      {
        name: 'Owner',
        render: (row: SloSummary) => (
          <EuiText size="s">{row.owner.teams.join(', ') || '—'}</EuiText>
        ),
      },
      {
        name: 'Tier',
        align: 'center',
        width: '8%',
        render: (row: SloSummary) => <EuiText size="s">{row.tier ?? '—'}</EuiText>,
      },
      {
        name: 'Objectives',
        render: (row: SloSummary) => (
          <EuiText size="s">
            {row.objectiveCount} • {formatTargetPct(row.worstTarget)}
          </EuiText>
        ),
      },
      {
        name: 'Mode',
        align: 'center',
        width: '8%',
        render: (row: SloSummary) => <EuiText size="s">{row.mode}</EuiText>,
      },
      {
        name: 'Enabled',
        align: 'center',
        width: '8%',
        render: (row: SloSummary) => <EuiText size="s">{row.enabled ? 'Yes' : 'No'}</EuiText>,
      },
      {
        name: 'Status',
        align: 'center',
        render: (row: SloSummary) => (
          <EuiHealth color={STATE_COLOR[row.status.state]}>{row.status.state}</EuiHealth>
        ),
      },
      {
        name: 'Budget left',
        align: 'left',
        width: '130px',
        render: (row: SloSummary) => {
          const remaining = worstBudgetRemaining(row);
          const label =
            remaining <= 0 ? 'over budget' : `${Math.max(0, remaining * 100).toFixed(0)}%`;
          const color = remaining <= 0 ? 'danger' : remaining < 0.25 ? 'warning' : 'subdued';
          return (
            <EuiToolTip content="Remaining error budget (worst objective).">
              <div>
                <EuiText size="xs" color={color}>
                  {label}
                </EuiText>
                <BudgetColumnBar remaining={remaining} />
              </div>
            </EuiToolTip>
          );
        },
      },
      {
        name: 'Firing',
        align: 'center',
        width: '6%',
        render: (row: SloSummary) => <EuiText size="s">{row.status.firingCount}</EuiText>,
      },
    ],
    []
  );

  const createButton = (
    <EuiButton
      fill
      href="#/slos/create"
      data-test-subj="slos-create"
      size="s"
      iconType="plusInCircle"
    >
      Create SLO
    </EuiButton>
  );

  const suggestButton = (
    <EuiButton href="#/slos/suggest" data-test-subj="slos-suggest" size="s" iconType="wand">
      Suggest SLOs
    </EuiButton>
  );

  const refreshButton = (
    <EuiButtonEmpty
      onClick={load}
      data-test-subj="slos-refresh"
      size="s"
      iconType="refresh"
      isLoading={loading}
    >
      Refresh
    </EuiButtonEmpty>
  );

  return (
    <EuiPage data-test-subj="slosPage">
      <EuiPageBody component="main">
        <HeaderControlledComponentsWrapper
          components={[refreshButton, suggestButton, createButton]}
        />
        <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
          <EuiPageContentBody>
            {loading && items.length === 0 ? (
              <EuiFlexGroup alignItems="center" justifyContent="center" style={{ minHeight: 200 }}>
                <EuiFlexItem grow={false}>
                  <EuiLoadingSpinner size="xl" />
                </EuiFlexItem>
              </EuiFlexGroup>
            ) : error ? (
              <EuiPanel>
                <EuiEmptyPrompt
                  iconType="alert"
                  color="danger"
                  title={<h2>Unable to load SLOs</h2>}
                  body={<p>{error.message}</p>}
                  actions={<EuiButton onClick={load}>Retry</EuiButton>}
                />
              </EuiPanel>
            ) : items.length === 0 ? (
              <EuiPanel style={{ marginTop: '8px' }}>
                <EuiEmptyPrompt
                  iconType="visualizeApp"
                  title={<h2>No SLOs yet</h2>}
                  body={
                    <p>
                      Track service level objectives for your Prometheus-backed services. Let us
                      auto-suggest SLOs from the metrics you&apos;re already scraping, or start from
                      a template.
                    </p>
                  }
                  actions={[
                    <EuiButton
                      key="suggest"
                      fill
                      href="#/slos/suggest"
                      data-test-subj="slos-suggest-empty"
                    >
                      Suggest SLOs
                    </EuiButton>,
                    <EuiButtonEmpty
                      key="create"
                      href="#/slos/create"
                      data-test-subj="slos-create-empty"
                    >
                      Start from a template
                    </EuiButtonEmpty>,
                  ]}
                />
              </EuiPanel>
            ) : (
              <>
                {/* Aggregate health at a glance — client-side derived from the listing. */}
                <SloOverviewPanel
                  items={items}
                  activeStateFilter={stateFilter}
                  onStateFilterChange={setStateFilter}
                />
                <EuiSpacer size="m" />

                <EuiFieldSearch
                  placeholder="Filter by name, service, or description"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  isClearable
                  fullWidth
                  compressed
                  data-test-subj="slosSearchBar"
                />
                <EuiSpacer size="s" />
                <EuiPanel>
                  <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
                    <EuiFlexItem grow={false}>
                      <EuiText size="m">
                        <h4>SLO catalog</h4>
                      </EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="s" color="subdued">
                        {filteredItems.length} of {items.length}
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="s" />
                  <EuiInMemoryTable<SloSummary>
                    items={filteredItems}
                    columns={columns}
                    pagination={{
                      initialPageSize: 20,
                      pageSizeOptions: [10, 20, 50, 100],
                    }}
                    sorting={{ sort: { field: 'name', direction: 'asc' } }}
                    loading={loading}
                    data-test-subj="slos-table"
                  />
                </EuiPanel>
              </>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};
