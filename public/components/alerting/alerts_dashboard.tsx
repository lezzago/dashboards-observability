/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alerts Dashboard — visualization-first view of alert history
 * with summary stats, charts, and drill-down table.
 */
import React, { useState, useMemo, useEffect } from 'react';
import {
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiHealth,
  EuiText,
  EuiTitle,
  EuiButtonIcon,
  EuiToolTip,
  EuiFieldSearch,
  EuiEmptyPrompt,
  EuiButtonEmpty,
  EuiResizableContainer,
  EuiCallOut,
} from '@elastic/eui';
import { i18n } from '@osd/i18n';
import { FormattedMessage } from '@osd/i18n/react';
import {
  AlertsTimelineResponse,
  DatasourceFetchFallback,
  UnifiedAlertSummary,
  Datasource,
} from '../../../common/types/alerting';
import type { AlertFacetCountsResponse } from './query_services/alerting_opensearch_service';
import { AlertTimeline } from './alerts_charts';
import { AlertsSummaryCards } from './alerts_summary_cards';
import { FacetFilterGroup, useFacetCollapse } from './facet_filter_panel';
import { countBy } from './shared_constants';

// ============================================================================
// Color maps (used by table columns and filter panel)
// ============================================================================

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#BD271E',
  high: '#F5A700',
  medium: '#006BB4',
  low: '#98A2B3',
  info: '#D3DAE6',
};
const STATE_COLORS: Record<string, string> = {
  active: '#BD271E',
  pending: '#F5A700',
  acknowledged: '#006BB4',
  resolved: '#017D73',
  error: '#BD271E',
  silenced: '#98A2B3',
};
const STATE_HEALTH: Record<string, string> = {
  active: 'danger',
  pending: 'warning',
  acknowledged: 'primary',
  resolved: 'success',
  error: 'danger',
  silenced: 'default',
};

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(startTime: string | number): string {
  const start = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
  const ms = Date.now() - start;
  if (ms < 60000) return '<1m';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ' + (Math.floor(ms / 60000) % 60) + 'm';
  return Math.floor(ms / 86400000) + 'd ' + (Math.floor(ms / 3600000) % 24) + 'h';
}

const SEVERITY_SORT_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Internal label keys to hide from the filter panel */
const INTERNAL_LABEL_KEYS = new Set([
  'monitor_id',
  'datasource_id',
  '_workspace',
  'monitor_type',
  'monitor_kind',
  'trigger_id',
  'trigger_name',
]);

// ============================================================================
// Alert Filter State
// ============================================================================

interface AlertFilterState {
  severity: string[];
  state: string[];
  backend: string[];
  labels: Record<string, string[]>;
}

/**
 * Outgoing filter snapshot exposed to the parent so it can drive the
 * timeline chart's separate hook with the same severity / state / labels
 * the table is rendering. `searchQuery` is intentionally excluded —
 * Phase 2 keeps the chart unfiltered by free-text search.
 */
export interface AlertsDashboardFilterSnapshot {
  severity: string[];
  state: string[];
  backend: string[];
  labels: Record<string, string[]>;
  /** 'all' | 'critical' | 'high' | 'medium' — the stat-card single-select. */
  severityCard: string;
  /** 'all' | 'active' — the stat-card single-select. */
  stateCard: string;
}

const emptyAlertFilters = (): AlertFilterState => ({
  severity: [],
  state: [],
  backend: [],
  labels: {},
});

function collectAlertUniqueValues(
  alerts: UnifiedAlertSummary[],
  field: (a: UnifiedAlertSummary) => string
): string[] {
  const set = new Set<string>();
  for (const a of alerts) {
    const val = field(a);
    if (val) set.add(val);
  }
  return Array.from(set).sort();
}

function collectAlertLabelKeys(alerts: UnifiedAlertSummary[]): string[] {
  const keys = new Set<string>();
  for (const a of alerts) {
    for (const k of Object.keys(a.labels)) keys.add(k);
  }
  return Array.from(keys).sort();
}

function collectAlertLabelValues(alerts: UnifiedAlertSummary[], key: string): string[] {
  const set = new Set<string>();
  for (const a of alerts) {
    const v = a.labels[key];
    if (v) set.add(v);
  }
  return Array.from(set).sort();
}

// ============================================================================
// Memoized Table — controlled `EuiBasicTable`. Page nav, sort, and page-size
// changes flow upward via `onTableChange` so the parent's hook can fire a
// new server request for the page. Memoization keeps the table stable under
// the ancestor `EuiResizableContainer`'s mousemove re-render cascade
// (mirrors `services_home.tsx`).
// ============================================================================

interface AlertsTableProps {
  items: UnifiedAlertSummary[];
  columns: Array<EuiBasicTableColumn<UnifiedAlertSummary>>;
  loading: boolean;
  message: React.ReactNode;
  page: number;
  pageSize: number;
  total: number;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onChange: (e: {
    page?: { index: number; size: number };
    sort?: { field: keyof UnifiedAlertSummary | string; direction: 'asc' | 'desc' };
  }) => void;
}

const AlertsTable = React.memo(
  ({
    items,
    columns,
    loading,
    message,
    page,
    pageSize,
    total,
    sortField,
    sortDirection,
    onChange,
  }: AlertsTableProps) => (
    <EuiBasicTable
      items={items}
      columns={columns}
      loading={loading}
      pagination={{
        pageIndex: page,
        pageSize,
        totalItemCount: total,
        pageSizeOptions: [10, 20, 50, 100],
      }}
      sorting={{
        sort: { field: sortField as keyof UnifiedAlertSummary, direction: sortDirection },
      }}
      onChange={onChange}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- React duplicate-types collision with @elastic/eui
      noItemsMessage={message as any}
    />
  )
);

// ============================================================================
// Main Dashboard Component
// ============================================================================

export interface AlertsDashboardProps {
  alerts: UnifiedAlertSummary[];
  datasources: Datasource[];
  loading: boolean;
  onViewDetail: (alert: UnifiedAlertSummary) => void;
  onAcknowledge: (alertId: string) => void;
  /** Currently selected datasource IDs */
  selectedDsIds: string[];
  /** Callback when datasource selection changes */
  onDatasourceChange: (ids: string[]) => void;
  /** Cap on concurrently selected datasources (from uiSettings). */
  maxDatasources: number;
  /** Callback fired when user tries to exceed `maxDatasources`. */
  onDatasourceCapReached: () => void;
  /**
   * Set by the parent when any backend reported a hard cap on returned
   * alerts (e.g. the OpenSearch 1000-alert post-filter cap). Drives a
   * warning callout near the timeline telling the user to narrow the
   * range.
   */
  truncated?: boolean;
  /**
   * Per-datasource hints from the unified fetch, used to surface backend
   * fallbacks (e.g. Prometheus empty-matrix → legacy /alerts active-only).
   * Rendered as a callout above the timeline.
   */
  fallbackHints?: Array<{ datasourceName: string; fallback: DatasourceFetchFallback }>;
  /**
   * Pre-bucketed timeline payload from `useAlertsTimeline`. The chart
   * renders directly from this — it does not iterate `alerts` to build
   * histograms.
   */
  timelineData: AlertsTimelineResponse | null;
  /** True while the timeline hook is in flight. */
  timelineLoading?: boolean;
  /**
   * Called whenever the dashboard's filter state changes so the parent
   * can mirror it into the `useAlertsTimeline` deps. Search query is
   * intentionally excluded — see Phase 2 plan.
   */
  onFilterChange?: (filters: AlertsDashboardFilterSnapshot) => void;
  /**
   * Phase 5 — server-side facet response. Drives the panel counts. While
   * the hook is loading or errored, the dashboard falls back to the
   * client-side memo so users never see flash-of-empty counts.
   */
  facetData?: AlertFacetCountsResponse | null;
  facetLoading?: boolean;
  /**
   * Phase 5 — controlled pagination + sort state. Page is 0-indexed (Eui
   * convention). Filter / datasource changes reset page to 0 in the
   * parent.
   */
  page: number;
  pageSize: number;
  total: number;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSortChange: (field: string, direction: 'asc' | 'desc') => void;
  /**
   * Phase 5 — search input state lives in the parent so the listing /
   * facet / timeline hooks can debounce against the same underlying
   * value. The dashboard renders the input but emits keystrokes
   * upward.
   */
  searchInput: string;
  onSearchInputChange: (value: string) => void;
}

export const AlertsDashboard: React.FC<AlertsDashboardProps> = ({
  alerts,
  datasources,
  loading,
  onViewDetail,
  onAcknowledge,
  selectedDsIds,
  onDatasourceChange,
  maxDatasources,
  onDatasourceCapReached,
  truncated,
  fallbackHints,
  timelineData,
  timelineLoading,
  onFilterChange,
  facetData,
  page,
  pageSize,
  total,
  sortField,
  sortDirection,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  searchInput,
  onSearchInputChange,
}) => {
  // searchInput is controlled by the parent (so hooks debounce against the
  // same underlying value); local string mirrors it for in-component reads.
  const searchQuery = searchInput;
  const [severityFilter, setSeverityFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [filters, setFilters] = useState<AlertFilterState>(emptyAlertFilters());
  const { toggleFacetCollapse, isCollapsed: isFacetCollapsed } = useFacetCollapse();

  // Mirror filter state to the parent so it can drive the timeline hook.
  // We use a stable JSON projection so the effect only fires when the
  // serialized snapshot actually changes (otherwise every render would
  // ping the parent because `filters.labels` is a fresh object).
  const filterSnapshotKey = useMemo(
    () =>
      JSON.stringify({
        s: filters.severity,
        st: filters.state,
        b: filters.backend,
        l: filters.labels,
        sc: severityFilter,
        sx: stateFilter,
      }),
    [filters, severityFilter, stateFilter]
  );
  useEffect(() => {
    if (!onFilterChange) return;
    onFilterChange({
      severity: filters.severity,
      state: filters.state,
      backend: filters.backend,
      labels: filters.labels,
      severityCard: severityFilter,
      stateCard: stateFilter,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSnapshotKey, onFilterChange]);

  // Build selectable datasource entries for the filter facet — alpha by name
  const datasourceEntries = useMemo(
    () =>
      datasources
        .map((ds) => ({ id: ds.id, label: ds.name }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    [datasources]
  );

  // Unique values for facets. Phase 5: prefer the server's facet response
  // (covers the full filtered set), fall back to the page-local `alerts`
  // when the hook is still loading.
  const uniqueSeverities = useMemo(() => {
    if (facetData) return Object.keys(facetData.severity).sort();
    return collectAlertUniqueValues(alerts, (a) => a.severity);
  }, [facetData, alerts]);
  const uniqueStates = useMemo(() => {
    if (facetData) return Object.keys(facetData.state).sort();
    return collectAlertUniqueValues(alerts, (a) => a.state);
  }, [facetData, alerts]);
  const uniqueBackends = useMemo(() => {
    if (facetData) return Object.keys(facetData.backend).sort();
    return collectAlertUniqueValues(alerts, (a) => a.datasourceType);
  }, [facetData, alerts]);
  const labelKeys = useMemo(() => {
    if (facetData) return Object.keys(facetData.labels).sort();
    return collectAlertLabelKeys(alerts);
  }, [facetData, alerts]);

  // Phase 5 — facet counts come from the server (`useAlertsFacets`),
  // computed over the full filtered set rather than the page-local
  // `alerts` array. While the hook is loading or has errored we fall
  // back to a client-side memo over the page-local set so the panel
  // never flashes empty.
  const clientFallbackFacets = useMemo(() => {
    const searchMatched = alerts.filter((a) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        a.name.toLowerCase().includes(q) ||
        (a.message || '').toLowerCase().includes(q) ||
        Object.values(a.labels).some((v) => v.toLowerCase().includes(q))
      );
    });
    const counts: Record<string, Record<string, number>> = {
      severity: {},
      state: {},
      backend: {},
    };
    for (const a of searchMatched) {
      counts.severity[a.severity] = (counts.severity[a.severity] || 0) + 1;
      counts.state[a.state] = (counts.state[a.state] || 0) + 1;
      counts.backend[a.datasourceType] = (counts.backend[a.datasourceType] || 0) + 1;
    }
    const labelCounts: Record<string, Record<string, number>> = {};
    for (const key of labelKeys) {
      labelCounts[key] = {};
      for (const a of searchMatched) {
        const v = a.labels[key];
        if (v) labelCounts[key][v] = (labelCounts[key][v] || 0) + 1;
      }
    }
    return { counts, labelCounts };
  }, [alerts, searchQuery, labelKeys]);

  const facetCounts = useMemo(() => {
    if (facetData) {
      return {
        counts: {
          severity: facetData.severity,
          state: facetData.state,
          backend: facetData.backend,
        },
        labelCounts: facetData.labels,
      };
    }
    return clientFallbackFacets;
  }, [facetData, clientFallbackFacets]);

  const activeFilterCount = useMemo(() => {
    let count = filters.severity.length + filters.state.length + filters.backend.length;
    for (const vals of Object.values(filters.labels)) count += vals.length;
    return count;
  }, [filters]);

  // Phase 5 — `alerts` is the server-paged + filtered set. The dashboard
  // renders that page directly; no client-side re-filter, no client-side
  // search-narrow. Stat cards / counts come from the server facet
  // response (full filtered set).
  const filteredAlerts = alerts;

  // Severity counts for stat cards — derived from the server facet
  // response (full filtered set), falling back to the page-local set
  // before the hook resolves.
  const severityCounts = useMemo(() => {
    if (facetData) return facetData.severity;
    return countBy(alerts, (a) => a.severity);
  }, [facetData, alerts]);
  const activeCount = useMemo(() => {
    if (facetData) return facetData.state.active ?? 0;
    return alerts.filter((a) => a.state === 'active').length;
  }, [facetData, alerts]);
  const isFiltered =
    activeFilterCount > 0 ||
    searchQuery !== '' ||
    severityFilter !== 'all' ||
    stateFilter !== 'all';

  const clearAllFilters = () => {
    setFilters(emptyAlertFilters());
    setSeverityFilter('all');
    setStateFilter('all');
    onSearchInputChange('');
  };

  const updateFilter = <K extends keyof AlertFilterState>(key: K, value: AlertFilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    if (key === 'severity') setSeverityFilter('all');
    if (key === 'state') setStateFilter('all');
  };

  const updateLabelFilter = (key: string, values: string[]) => {
    setFilters((prev) => ({ ...prev, labels: { ...prev.labels, [key]: values } }));
  };

  const renderFacetGroup = (
    id: string,
    label: string,
    options: string[],
    selected: string[],
    onChange: (v: string[]) => void,
    counts: Record<string, number>,
    colorMap?: Record<string, string>
  ) => (
    <FacetFilterGroup
      key={id}
      id={id}
      label={label}
      options={options}
      selected={selected}
      onChange={onChange}
      counts={counts}
      colorMap={colorMap}
      isCollapsed={isFacetCollapsed(id)}
      onToggleCollapse={toggleFacetCollapse}
    />
  );

  // Table columns — memoized so `AlertsTable`'s React.memo shallow-compare
  // doesn't invalidate on every parent re-render.
  const columns = useMemo<Array<EuiBasicTableColumn<UnifiedAlertSummary>>>(
    () => [
      {
        field: 'severity',
        name: 'Sev',
        width: '60px',
        sortable: (a: UnifiedAlertSummary) => SEVERITY_SORT_ORDER[a.severity] ?? 5,
        render: (s: string) => (
          <EuiToolTip content={s}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: SEVERITY_COLORS[s],
                display: 'inline-block',
              }}
            />
          </EuiToolTip>
        ),
      },
      {
        field: 'name',
        name: 'Alert',
        sortable: true,
        truncateText: true,
        render: (name: string, alert: UnifiedAlertSummary) => (
          <EuiButtonEmpty
            size="xs"
            flush="left"
            onClick={() => onViewDetail(alert)}
            style={{ fontWeight: 500 }}
          >
            {name}
          </EuiButtonEmpty>
        ),
      },
      {
        field: 'state',
        name: 'State',
        width: '140px',
        sortable: true,
        render: (state: string) => (
          <EuiHealth color={STATE_HEALTH[state] || 'subdued'}>{state}</EuiHealth>
        ),
      },
      {
        field: 'datasourceType',
        name: 'Source',
        width: '130px',
        render: (t: string) => {
          const displayName =
            t === 'opensearch' ? 'OpenSearch' : t === 'prometheus' ? 'Prometheus' : t;
          return <EuiText size="xs">{displayName}</EuiText>;
        },
      },
      {
        field: 'message',
        name: 'Message',
        truncateText: true,
        render: (msg: string) => (
          <EuiText size="xs" color="subdued">
            {msg || '—'}
          </EuiText>
        ),
      },
      {
        field: 'startTime',
        name: 'Started',
        width: '120px',
        sortable: true,
        render: (ts: string) => {
          if (!ts) return <EuiText size="xs">---</EuiText>;
          const abs = new Date(ts).toLocaleString();
          return (
            <EuiToolTip content={abs}>
              <span style={{ fontSize: 12 }}>{formatDuration(ts)} ago</span>
            </EuiToolTip>
          );
        },
      },
      {
        field: 'startTime',
        name: 'Duration',
        width: '90px',
        render: (ts: string) => <EuiText size="xs">{ts ? formatDuration(ts) : '—'}</EuiText>,
      },
      {
        name: 'Actions',
        width: '150px',
        render: (alert: UnifiedAlertSummary) => (
          <EuiFlexGroup gutterSize="xs" responsive={false} wrap={false} alignItems="center">
            <EuiFlexItem grow={false}>
              <EuiToolTip content="View details">
                <EuiButtonIcon
                  iconType="inspect"
                  aria-label="View"
                  size="s"
                  onClick={() => onViewDetail(alert)}
                />
              </EuiToolTip>
            </EuiFlexItem>
            {alert.state === 'active' && alert.datasourceType !== 'prometheus' && (
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  iconType="check"
                  size="xs"
                  color="primary"
                  onClick={() => onAcknowledge(alert.id)}
                >
                  Ack
                </EuiButtonEmpty>
              </EuiFlexItem>
            )}
          </EuiFlexGroup>
        ),
      },
    ],
    [onAcknowledge, onViewDetail]
  );

  // Two-axis empty derivation. We want the page-wide "No Active Alerts"
  // prompt only when both data sources are empty AND the user hasn't
  // applied a filter. If the chart has data but the table doesn't (e.g. a
  // filter is narrowing the table), we keep the chart visible and let the
  // table render its filter-aware empty message.
  const tableEmpty = !loading && total === 0;
  const timelineHasData = useMemo(() => {
    if (!timelineData || !timelineData.buckets) return false;
    for (const b of timelineData.buckets) {
      const bucketTotal =
        b.severity.critical +
        b.severity.high +
        b.severity.medium +
        b.severity.low +
        b.severity.info;
      if (bucketTotal > 0) return true;
    }
    return false;
  }, [timelineData]);
  // Show the page-wide empty prompt only when nothing is filtered AND both
  // signals report empty (or the timeline endpoint hasn't returned anything
  // yet — null timelineData with an empty alerts list still warrants the
  // prompt rather than rendering an empty chart frame).
  const showEmptyPrompt = tableEmpty && !isFiltered && !timelineHasData && !timelineLoading;

  return (
    <EuiResizableContainer style={{ flex: 1, minHeight: 0 }}>
      {(EuiResizablePanel, EuiResizableButton) => (
        <>
          <EuiResizablePanel
            id="alerts-filters-panel"
            initialSize={15}
            minSize="180px"
            mode={['collapsible', { position: 'top' }]}
            onToggleCollapsed={() => {}}
            paddingSize="none"
            style={{ overflow: 'auto', paddingRight: '4px' }}
          >
            <EuiPanel
              paddingSize="s"
              hasBorder
              style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            >
              <div style={{ flex: 1, overflow: 'auto' }}>
                <EuiFlexGroup
                  gutterSize="xs"
                  alignItems="center"
                  responsive={false}
                  justifyContent="spaceBetween"
                >
                  <EuiFlexItem>
                    <EuiText size="xs">
                      <strong>Filters</strong>
                    </EuiText>
                  </EuiFlexItem>
                  {activeFilterCount > 0 && (
                    <EuiFlexItem grow={false}>
                      <EuiButtonEmpty size="xs" onClick={clearAllFilters} flush="right">
                        Clear ({activeFilterCount})
                      </EuiButtonEmpty>
                    </EuiFlexItem>
                  )}
                </EuiFlexGroup>
                <EuiSpacer size="s" />

                {/* Datasource filter — searchable, max 10 visible, max 5 selected */}
                <FacetFilterGroup
                  id="datasource"
                  label="Datasource"
                  options={datasourceEntries.map((e) => e.label)}
                  selected={selectedDsIds
                    .map((id) => datasourceEntries.find((e) => e.id === id)?.label || '')
                    .filter(Boolean)}
                  onChange={(labels) => {
                    const ids = labels
                      .map((l) => datasourceEntries.find((e) => e.label === l)?.id)
                      .filter(Boolean) as string[];
                    onDatasourceChange(ids);
                  }}
                  counts={countBy(
                    datasourceEntries.filter(
                      (e) => selectedDsIds.includes(e.id) || selectedDsIds.length === 0
                    ),
                    (e) => e.label
                  )}
                  searchable
                  maxVisible={10}
                  maxSelected={maxDatasources}
                  onCapReached={onDatasourceCapReached}
                  searchAriaLabel="Search datasources"
                  checkedFirst
                  isCollapsed={isFacetCollapsed('datasource')}
                  onToggleCollapse={toggleFacetCollapse}
                />

                {renderFacetGroup(
                  'severity',
                  'Severity',
                  uniqueSeverities,
                  filters.severity,
                  (v) => updateFilter('severity', v),
                  facetCounts.counts.severity,
                  SEVERITY_COLORS
                )}
                {renderFacetGroup(
                  'state',
                  'State',
                  uniqueStates,
                  filters.state,
                  (v) => updateFilter('state', v),
                  facetCounts.counts.state,
                  STATE_COLORS
                )}
                {renderFacetGroup(
                  'backend',
                  'Backend',
                  uniqueBackends,
                  filters.backend,
                  (v) => updateFilter('backend', v),
                  facetCounts.counts.backend
                )}

                {labelKeys.length > 0 && (
                  <>
                    <EuiSpacer size="xs" />
                    <EuiText size="xs" color="subdued" style={{ marginBottom: 6 }}>
                      <strong>Labels</strong>
                    </EuiText>
                    {labelKeys
                      .filter((key) => !INTERNAL_LABEL_KEYS.has(key))
                      .map((key) => {
                        // Phase 5: prefer the server's per-key value list
                        // when available; fall back to the page-local set.
                        const values = facetData?.labels[key]
                          ? Object.keys(facetData.labels[key]).sort()
                          : collectAlertLabelValues(alerts, key);
                        return renderFacetGroup(
                          `label:${key}`,
                          key,
                          values,
                          filters.labels[key] || [],
                          (v) => updateLabelFilter(key, v),
                          facetCounts.labelCounts[key] || {}
                        );
                      })}
                  </>
                )}
              </div>
            </EuiPanel>
          </EuiResizablePanel>

          <EuiResizableButton />

          <EuiResizablePanel
            initialSize={85}
            minSize="400px"
            mode="main"
            paddingSize="none"
            style={{ paddingLeft: '4px', overflow: 'auto' }}
          >
            {showEmptyPrompt ? (
              <EuiEmptyPrompt
                title={<h2>No Active Alerts</h2>}
                body={<p>All systems operating normally.</p>}
                iconType="checkInCircleFilled"
                iconColor="success"
              />
            ) : (
              <>
                {/* ---- Summary Stat Cards (extracted component) ---- */}
                <AlertsSummaryCards
                  filteredCount={total}
                  totalCount={total}
                  activeCount={activeCount}
                  severityCounts={severityCounts}
                  severityFilter={severityFilter}
                  stateFilter={stateFilter}
                  filtersSeverityLength={filters.severity.length}
                  filtersStateLength={filters.state.length}
                  isFiltered={isFiltered}
                  onShowAll={() => {
                    setSeverityFilter('all');
                    setStateFilter('all');
                    setFilters((prev) => ({ ...prev, severity: [], state: [] }));
                  }}
                  onToggleActive={() => {
                    setSeverityFilter('all');
                    setStateFilter(stateFilter === 'active' ? 'all' : 'active');
                    setFilters((prev) => ({ ...prev, severity: [], state: [] }));
                  }}
                  onToggleCritical={() => {
                    setStateFilter('all');
                    setSeverityFilter(severityFilter === 'critical' ? 'all' : 'critical');
                    setFilters((prev) => ({ ...prev, severity: [], state: [] }));
                  }}
                  onToggleHigh={() => {
                    setStateFilter('all');
                    setSeverityFilter(severityFilter === 'high' ? 'all' : 'high');
                    setFilters((prev) => ({ ...prev, severity: [], state: [] }));
                  }}
                  onToggleMedium={() => {
                    setStateFilter('all');
                    setSeverityFilter(severityFilter === 'medium' ? 'all' : 'medium');
                    setFilters((prev) => ({ ...prev, severity: [], state: [] }));
                  }}
                />

                <EuiSpacer size="m" />

                {/* ---- Backend hints / fallbacks ---- */}
                {/* Surfaced here (above the timeline) because both hints      */}
                {/* directly explain what the chart and table are showing:     */}
                {/*   - `truncated` → the backend capped results (OS 1000      */}
                {/*     post-filter cap) so the chart is missing bars and the  */}
                {/*     table row count is lower than reality.                 */}
                {/*   - `fallbackHints` → a Prometheus datasource returned no  */}
                {/*     historical matrix and fell back to the legacy         */}
                {/*     `/api/v1/alerts` endpoint, which is active-only and   */}
                {/*     does not reflect the selected time range.             */}
                {truncated && (
                  <>
                    <EuiCallOut
                      title={i18n.translate(
                        'observability.alerting.dashboard.truncatedCallout.title',
                        {
                          defaultMessage: 'Search incomplete — too many alerts to scan',
                        }
                      )}
                      color="warning"
                      iconType="alert"
                      size="s"
                      data-test-subj="alerts-truncated-callout"
                    >
                      <p>
                        <FormattedMessage
                          id="observability.alerting.dashboard.truncatedCallout.body"
                          defaultMessage="Narrow the time range or refine your filters and try again."
                        />
                      </p>
                    </EuiCallOut>
                    <EuiSpacer size="s" />
                  </>
                )}
                {fallbackHints && fallbackHints.length > 0 && (
                  <>
                    <EuiCallOut
                      title={i18n.translate(
                        'observability.alerting.dashboard.fallbackCallout.title',
                        {
                          defaultMessage: 'Showing current alerts only',
                        }
                      )}
                      color="warning"
                      iconType="alert"
                      size="s"
                      data-test-subj="alerts-fallback-callout"
                    >
                      {fallbackHints.map((h, i) => (
                        <p key={i}>
                          <FormattedMessage
                            id="observability.alerting.dashboard.fallbackCallout.entry"
                            defaultMessage="{datasourceName}: historical alert data unavailable; showing currently active alerts instead ({fallback})."
                            values={{
                              datasourceName: <strong>{h.datasourceName}</strong>,
                              fallback: h.fallback,
                            }}
                          />
                        </p>
                      ))}
                    </EuiCallOut>
                    <EuiSpacer size="s" />
                  </>
                )}

                {/* ---- Visualization Row ---- */}
                <EuiFlexGroup gutterSize="m" responsive={true}>
                  <EuiFlexItem grow={3}>
                    <EuiPanel paddingSize="m" hasBorder>
                      <EuiTitle size="xxs">
                        <h4>Alert Timeline</h4>
                      </EuiTitle>
                      <EuiSpacer size="s" />
                      <AlertTimeline
                        buckets={timelineData?.buckets ?? []}
                        bucketCount={timelineData?.bucketCount ?? 0}
                        bucketDurationMs={timelineData?.bucketDurationMs ?? 0}
                        loading={timelineLoading}
                      />
                    </EuiPanel>
                  </EuiFlexItem>
                </EuiFlexGroup>

                <EuiSpacer size="l" />

                {/* ---- Search + Table ---- */}
                <EuiPanel paddingSize="m" hasBorder>
                  <EuiTitle size="xs">
                    <h2>All Alerts</h2>
                  </EuiTitle>
                  <EuiSpacer size="s" />
                  <EuiFieldSearch
                    placeholder="Search alerts by name, message, or label..."
                    value={searchQuery}
                    onChange={(e) => onSearchInputChange(e.target.value)}
                    isClearable
                    fullWidth
                    aria-label="Search alerts"
                  />
                  <EuiSpacer size="s" />
                  <EuiText size="s">
                    <strong>{total}</strong> alerts
                    {activeFilterCount > 0 && (
                      <span>
                        {' '}
                        · {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
                      </span>
                    )}
                  </EuiText>
                  <EuiSpacer size="s" />
                  <AlertsTable
                    items={filteredAlerts}
                    columns={columns}
                    loading={loading}
                    page={page}
                    pageSize={pageSize}
                    total={total}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onChange={(e) => {
                      if (e.page) {
                        if (e.page.size !== pageSize) {
                          onPageSizeChange(e.page.size);
                        } else {
                          onPageChange(e.page.index);
                        }
                      }
                      if (e.sort) {
                        onSortChange(String(e.sort.field), e.sort.direction);
                      }
                    }}
                    message={
                      searchQuery ||
                      activeFilterCount > 0 ||
                      severityFilter !== 'all' ||
                      stateFilter !== 'all'
                        ? 'No alerts match your filters'
                        : 'No alerts'
                    }
                  />
                </EuiPanel>
              </>
            )}
          </EuiResizablePanel>
        </>
      )}
    </EuiResizableContainer>
  );
};
