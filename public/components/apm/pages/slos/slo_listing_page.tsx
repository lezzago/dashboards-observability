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
  EuiResizableContainer,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { useHistory, useLocation } from 'react-router-dom';
import { ChromeStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { ActiveFilterBadges, FilterBadge } from '../../shared/components/active_filter_badges';
import { SloOverviewPanel } from './slo_overview_panel';
import { SloListFilterPanel } from './slo_list_filter_panel';
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
import { SLO_HEALTH_COLOR } from '../../../../../common/slo/state';

export interface SloListingPageProps {
  apiClient: SloApiClient;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

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

const STATE_LABEL: Record<SloHealthState, string> = {
  breached: 'Breached',
  warning: 'Warning',
  ok: 'Healthy',
  no_data: 'No data',
  stale: 'Stale',
  disabled: 'Disabled',
};

const SLI_BACKEND_LABEL: Record<'prometheus' | 'opensearch', string> = {
  prometheus: 'Prometheus',
  opensearch: 'OpenSearch',
};

const MODE_LABEL: Record<'active' | 'shadow', string> = {
  active: 'Active',
  shadow: 'Shadow',
};

// Module-level memoized table panel. EuiResizableContainer re-runs its render
// prop on every mousemove; memoizing keeps pagination and sort stable. Project
// memory references the same pattern from services_home.tsx.
interface SlosTablePanelProps {
  items: SloSummary[];
  columns: Array<EuiBasicTableColumn<SloSummary>>;
  loading: boolean;
  resultCount: number;
  filteredToZero: boolean;
  onClearAllFilters: () => void;
}

const SlosTablePanelUI: React.FC<SlosTablePanelProps> = ({
  items,
  columns,
  loading,
  resultCount,
  filteredToZero,
  onClearAllFilters,
}) => {
  if (filteredToZero) {
    return (
      <EuiPanel data-test-subj="slosEmptyFilteredZero">
        <EuiEmptyPrompt
          iconType="search"
          title={<h2>No SLOs match your filters</h2>}
          body={<p>Try widening the filters, or clear them to see every SLO in this workspace.</p>}
          actions={
            <EuiButton onClick={onClearAllFilters} data-test-subj="slosEmptyFilteredClear">
              Clear filters
            </EuiButton>
          }
        />
      </EuiPanel>
    );
  }
  return (
    <EuiPanel>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiText size="m">
            <h4>SLO catalog</h4>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="s" color="subdued" data-test-subj="slosListingResultCount">
            {resultCount} SLO{resultCount === 1 ? '' : 's'}
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
        data-test-subj="slosTable"
      />
    </EuiPanel>
  );
};

const SlosTablePanel = React.memo(SlosTablePanelUI);

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
      const parsed = deserializeFiltersFromSearch(location.search);
      if (!filtersEqual(parsed, filters)) {
        lastSyncedSearch.current = rawUrl;
        setFilters(parsed);
      }
      return;
    }

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
      const result = await apiClient.list({ ...filters, pageSize: 100 });
      setItems(result.results);
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
            data-test-subj={`slosLink-${row.id}`}
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
          <EuiHealth color={SLO_HEALTH_COLOR[row.status.state]}>{row.status.state}</EuiHealth>
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

  // Build the shared ActiveFilterBadges rows. Each badge clears all values for
  // its category at once — mirrors services_home.
  const activeFilters: FilterBadge[] = useMemo(() => {
    const badges: FilterBadge[] = [];
    const clearKey = (key: keyof SloListFilters) =>
      setFilters((f) => {
        const next = { ...f };
        delete next[key];
        return next;
      });
    if (filters.state?.length) {
      badges.push({
        key: 'state',
        category: 'State',
        values: filters.state.map((v) => STATE_LABEL[v] ?? v),
        onRemove: () => clearKey('state'),
      });
    }
    if (filters.sliBackend?.length) {
      badges.push({
        key: 'sliBackend',
        category: 'Backend',
        values: filters.sliBackend.map((v) => SLI_BACKEND_LABEL[v] ?? v),
        onRemove: () => clearKey('sliBackend'),
      });
    }
    if (filters.sliLeafType?.length) {
      badges.push({
        key: 'sliLeafType',
        category: 'SLI type',
        values: filters.sliLeafType,
        onRemove: () => clearKey('sliLeafType'),
      });
    }
    if (filters.service?.length) {
      badges.push({
        key: 'service',
        category: 'Service',
        values: filters.service,
        onRemove: () => clearKey('service'),
      });
    }
    if (filters.team?.length) {
      badges.push({
        key: 'team',
        category: 'Team',
        values: filters.team,
        onRemove: () => clearKey('team'),
      });
    }
    if (filters.tier?.length) {
      badges.push({
        key: 'tier',
        category: 'Tier',
        values: filters.tier,
        onRemove: () => clearKey('tier'),
      });
    }
    if (filters.mode?.length) {
      badges.push({
        key: 'mode',
        category: 'Mode',
        values: filters.mode.map((v) => MODE_LABEL[v] ?? v),
        onRemove: () => clearKey('mode'),
      });
    }
    if (filters.enabled !== undefined) {
      badges.push({
        key: 'enabled',
        category: 'Enabled',
        values: [filters.enabled ? 'Yes' : 'No'],
        onRemove: () => clearKey('enabled'),
      });
    }
    if (filters.search && filters.search.trim().length > 0) {
      badges.push({
        key: 'search',
        category: 'Search',
        values: [`"${filters.search}"`],
        onRemove: () => clearKey('search'),
      });
    }
    return badges;
  }, [filters]);

  const createButton = (
    <EuiButton
      fill
      href="#/slos/create"
      data-test-subj="slosCreate"
      size="s"
      iconType="plusInCircle"
    >
      Create SLO
    </EuiButton>
  );

  const suggestButton = (
    <EuiButton href="#/slos/suggest" data-test-subj="slosSuggest" size="s" iconType="wand">
      Suggest SLOs
    </EuiButton>
  );

  const refreshButton = (
    <EuiButtonEmpty
      onClick={load}
      data-test-subj="slosRefresh"
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
  const setOverviewStateFilter = useCallback((tile: SloHealthState | 'firing' | null) => {
    setFilters((prev) => ({ ...prev, state: stateTileToFilterState(tile) }));
  }, []);

  const onSearchChange = useCallback((next: string) => {
    setFilters((f) => ({ ...f, search: next || undefined }));
  }, []);

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
              <EuiPanel style={{ marginTop: '8px' }} data-test-subj="slosEmptyNoSlos">
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
                      data-test-subj="slosSuggestEmpty"
                    >
                      Suggest SLOs
                    </EuiButton>,
                    <EuiButtonEmpty
                      key="create"
                      href="#/slos/create"
                      data-test-subj="slosCreateEmpty"
                    >
                      Start from a template
                    </EuiButtonEmpty>,
                  ]}
                />
              </EuiPanel>
            ) : (
              <EuiResizableContainer style={{ marginTop: '8px' }}>
                {(EuiResizablePanel, EuiResizableButton) => (
                  <>
                    <EuiResizablePanel
                      id="slosFilterSidebar"
                      initialSize={18}
                      minSize="12%"
                      paddingSize="none"
                      style={{ paddingTop: '8px', paddingRight: '8px' }}
                    >
                      <EuiPanel style={{ height: '100%', overflowY: 'auto' }} paddingSize="s">
                        <EuiText size="xs">
                          <strong>Filters</strong>
                        </EuiText>
                        <EuiSpacer size="xs" />
                        <SloListFilterPanel filters={filters} onChange={setFilters} items={items} />
                      </EuiPanel>
                    </EuiResizablePanel>

                    <EuiResizableButton />

                    <EuiResizablePanel
                      initialSize={82}
                      minSize="50%"
                      paddingSize="none"
                      scrollable={false}
                      style={{ padding: '8px 0 0 8px' }}
                    >
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

                      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                        <EuiFlexItem>
                          <EuiFieldSearch
                            placeholder="Filter by name, service, or description"
                            value={filters.search ?? ''}
                            onChange={(e) => onSearchChange(e.target.value)}
                            isClearable
                            compressed
                            fullWidth
                            data-test-subj="slosListingFilterSearch"
                          />
                        </EuiFlexItem>
                      </EuiFlexGroup>
                      {activeFilters.length > 0 && (
                        <>
                          <EuiSpacer size="xs" />
                          <ActiveFilterBadges
                            filters={activeFilters}
                            onClearAll={clearAllFilters}
                          />
                        </>
                      )}
                      <EuiSpacer size="s" />

                      <SlosTablePanel
                        items={items}
                        columns={columns}
                        loading={loading}
                        resultCount={items.length}
                        filteredToZero={filteredToZero}
                        onClearAllFilters={clearAllFilters}
                      />
                    </EuiResizablePanel>
                  </>
                )}
              </EuiResizableContainer>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};
