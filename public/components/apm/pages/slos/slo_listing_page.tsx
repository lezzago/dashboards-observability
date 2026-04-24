/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiEmptyPrompt,
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
import { useHistory, useLocation } from 'react-router-dom';
import { ChromeStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { SloOverviewPanel } from './slo_overview_panel';
import { SloListFilterPanel } from './slo_list_filter_panel';
import { SloListFilterChips } from './slo_list_filter_chips';
import {
  deserializeFiltersFromSearch,
  filtersEqual,
  serializeFiltersToSearch,
} from './slo_list_filter_url';
import type { SloApiClient } from './slo_api_client';
import type {
  SloHealthState,
  SloListFilters,
  SloSummary,
} from '../../../../../common/slo/slo_types';

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

/**
 * Translate the overview panel's KPI-tile state into a listing filter delta.
 * The tile's "firing" pseudo-state stays client-side — we don't have a
 * server-side `firingCount > 0` filter, but we do have state=breached which
 * is the closest real facet, so a firing tile click maps to it.
 */
function stateTileToFilterState(
  tile: SloHealthState | 'firing' | null
): SloHealthState[] | undefined {
  if (tile === null) return undefined;
  if (tile === 'firing') return ['breached'];
  return [tile];
}

function filterStateToTile(state: SloHealthState[] | undefined): SloHealthState | 'firing' | null {
  if (!state || state.length !== 1) return null;
  return state[0];
}

export const SloListingPage: React.FC<SloListingPageProps> = ({
  apiClient,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const history = useHistory();
  const location = useLocation();

  // Hash-query round-trip: on mount and on hash changes, hydrate filters from
  // the URL so sharing a link preserves the view.
  const [filters, setFilters] = useState<SloListFilters>(() =>
    deserializeFiltersFromSearch(location.search)
  );
  const [items, setItems] = useState<SloSummary[]>([]);
  const [totalUnfiltered, setTotalUnfiltered] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    chrome.setBreadcrumbs([parentBreadcrumb, { text: 'SLO/SLI' }]);
  }, [chrome, parentBreadcrumb]);

  // Filter ↔ URL sync. Single effect, guarded by a ref that stores the last
  // serialized string we reconciled. Writing to URL via history.replace
  // intentionally does NOT re-trigger a setFilters, and an external URL
  // change (paste, back button) does NOT re-write the URL we just received.
  // Without this guard the two effects form a loop: write URL → read URL →
  // parse → setFilters(newObj) → compare → write URL → ...
  const lastSyncedSearch = useRef<string>(serializeFiltersToSearch(filters));
  useEffect(() => {
    const rawUrl = location.search.startsWith('?') ? location.search.slice(1) : location.search;
    const fromState = serializeFiltersToSearch(filters);

    if (fromState === rawUrl) {
      lastSyncedSearch.current = fromState;
      return;
    }

    if (rawUrl !== lastSyncedSearch.current) {
      // URL changed out from under us (paste / back button). Pull into state.
      const parsed = deserializeFiltersFromSearch(location.search);
      if (!filtersEqual(parsed, filters)) {
        lastSyncedSearch.current = rawUrl;
        setFilters(parsed);
      }
      return;
    }

    // State changed; push to URL.
    lastSyncedSearch.current = fromState;
    history.replace({
      pathname: location.pathname,
      search: fromState.length ? `?${fromState}` : '',
    });
  }, [filters, location.search, location.pathname, history]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Server-side filtering via the SloListFilters contract.
      const result = await apiClient.list({ ...filters, pageSize: 100 });
      setItems(result.results);
      // Track whether the workspace has any SLOs at all, so we can tell
      // "no SLOs exist" from "filters narrowed to zero". The total the server
      // returns is post-filter; if any filter is applied we can't tell from
      // this response alone, so only lock it on the unfiltered fetch.
      if (Object.keys(filters).length === 0) {
        setTotalUnfiltered(result.total);
      }
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
  }, [apiClient, filters, notifications]);

  useEffect(() => {
    load();
  }, [load]);

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

  const hasAnyFilter = useMemo(
    () =>
      Object.keys(filters).some((k) => {
        const v = (filters as Record<string, unknown>)[k];
        if (Array.isArray(v)) return v.length > 0;
        return v !== undefined && v !== '';
      }),
    [filters]
  );

  const clearAllFilters = useCallback(() => setFilters({}), []);

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

  // Overview panel tile-click: map the tile to a state filter slice so the
  // strip + chips stay in sync with the tile highlight.
  const overviewActive = filterStateToTile(filters.state);
  const setOverviewStateFilter = (tile: SloHealthState | 'firing' | null) => {
    setFilters((prev) => ({ ...prev, state: stateTileToFilterState(tile) }));
  };

  // --- Render states ---
  const isFirstLoad = loading && items.length === 0 && totalUnfiltered === null;
  const noSlosExist =
    !loading && !hasAnyFilter && items.length === 0 && (totalUnfiltered ?? 0) === 0;
  const filteredToZero = !loading && hasAnyFilter && items.length === 0;

  return (
    <EuiPage data-test-subj="slosPage">
      <EuiPageBody component="main">
        <HeaderControlledComponentsWrapper
          components={[refreshButton, suggestButton, createButton]}
        />
        <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
          <EuiPageContentBody>
            {isFirstLoad ? (
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
            ) : noSlosExist ? (
              <EuiPanel style={{ marginTop: '8px' }} data-test-subj="slos-empty-no-slos">
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
                {/* Aggregate health at a glance — server-side list provides the items. */}
                {items.length > 0 && (
                  <>
                    <SloOverviewPanel
                      items={items}
                      activeStateFilter={overviewActive}
                      onStateFilterChange={setOverviewStateFilter}
                    />
                    <EuiSpacer size="m" />
                  </>
                )}

                <SloListFilterPanel filters={filters} onChange={setFilters} items={items} />
                <EuiSpacer size="xs" />
                <SloListFilterChips
                  filters={filters}
                  onChange={setFilters}
                  onClearAll={clearAllFilters}
                />
                <EuiSpacer size="s" />

                {filteredToZero ? (
                  <EuiPanel data-test-subj="slos-empty-filtered-zero">
                    <EuiEmptyPrompt
                      iconType="search"
                      title={<h2>No SLOs match your filters</h2>}
                      body={
                        <p>
                          Try widening the filters, or clear them to see every SLO in this
                          workspace.
                        </p>
                      }
                      actions={
                        <EuiButton
                          onClick={clearAllFilters}
                          data-test-subj="slos-empty-filtered-clear"
                        >
                          Clear filters
                        </EuiButton>
                      }
                    />
                  </EuiPanel>
                ) : (
                  <EuiPanel>
                    <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
                      <EuiFlexItem grow={false}>
                        <EuiText size="m">
                          <h4>SLO catalog</h4>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText
                          size="s"
                          color="subdued"
                          data-test-subj="slos-listing-result-count"
                        >
                          {items.length} SLO{items.length === 1 ? '' : 's'}
                        </EuiText>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                    <EuiSpacer size="s" />
                    <EuiInMemoryTable<SloSummary>
                      items={items}
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
                )}
              </>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};
