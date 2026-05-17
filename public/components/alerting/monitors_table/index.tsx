/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Enhanced Monitors Table — search, filter, sort, column customization,
 * saved searches, bulk delete, and JSON export.
 *
 * This file is the top-level component and state owner. Sub-files in this
 * folder:
 *   - `monitors_table_columns.tsx`  — ColumnDef, BASE_COLUMNS, cell renderers
 *   - `monitors_table_filters.tsx`  — FilterState + search/filter/label helpers
 *   - `monitors_table_helpers.ts`   — constants + SavedSearch type
 *   - `resizable_columns.ts`        — DEFAULT_WIDTHS + `useResizableColumns`
 *   - `monitors_eui_table.tsx`      — memoized EuiInMemoryTable wrapper
 *   - `monitors_filters_panel.tsx`  — left-hand filters-panel render
 *   - `monitors_main_panel.tsx`     — right-hand table-panel render
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EuiResizableContainer } from '@elastic/eui';
import { Datasource, UnifiedRuleSummary } from '../../../../common/types/alerting';
import { serializeMonitors } from '../../../../common/services/alerting/serializer';
import type { RuleFacetCountsResponse } from '../query_services/alerting_opensearch_service';
import { useFacetCollapse } from '../facet_filter_panel';
import {
  BASE_COLUMNS,
  buildTableColumns,
  ColumnId,
  DEFAULT_VISIBLE,
} from './monitors_table_columns';
import {
  buildSuggestions,
  collectLabelKeys,
  collectUniqueValues,
  emptyFilters,
  FilterState,
  matchesSearch,
} from './monitors_table_filters';
import { SavedSearch } from './monitors_table_helpers';
import { DEFAULT_WIDTHS, useResizableColumns } from './resizable_columns';
import { MonitorsFiltersPanel } from './monitors_filters_panel';
import { MonitorsMainPanel } from './monitors_main_panel';

/**
 * Outgoing snapshot of the monitor table's filter state. Mirrors
 * `AlertsDashboardFilterSnapshot` — emitted to the parent so the parent
 * can pass the same filters into the server-side rules listing call.
 */
export interface MonitorsTableFilterSnapshot {
  status: string[];
  severity: string[];
  monitorType: string[];
  healthStatus: string[];
  createdBy: string[];
  destinations: string[];
  backend: string[];
  labels: Record<string, string[]>;
}

interface MonitorsTableProps {
  rules: UnifiedRuleSummary[];
  datasources: Datasource[];
  loading: boolean;
  onDelete: (ids: string[]) => void;
  onClone?: (monitor: UnifiedRuleSummary) => void;
  onImport?: (configs: Array<Record<string, unknown>>) => void;
  onCreateMonitor?: (type: 'logs' | 'prometheus' | 'metrics' | 'slo') => void;
  /** Currently selected datasource IDs */
  selectedDsIds: string[];
  /** Callback when datasource selection changes */
  onDatasourceChange: (ids: string[]) => void;
  /** Cap on concurrently selected datasources (from uiSettings). */
  maxDatasources: number;
  /** Callback fired when user tries to exceed `maxDatasources`. */
  onDatasourceCapReached: () => void;
  /**
   * Phase 4 — emit filter changes upward so the parent can drive the
   * server-side `listRules` call. When omitted the component still
   * renders client-side filtered results from `rules`.
   */
  onFilterChange?: (snapshot: MonitorsTableFilterSnapshot) => void;

  /** Phase 5 — server-side facet counts. Fallback to local memo while loading. */
  facetData?: RuleFacetCountsResponse | null;
  facetLoading?: boolean;

  /** Phase 5 — controlled pagination + sort. Page is 0-indexed. */
  page: number;
  pageSize: number;
  total: number;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSortChange: (field: string, direction: 'asc' | 'desc') => void;

  /** Phase 5 — search input lifted to the parent for debounced server calls. */
  searchInput: string;
  onSearchInputChange: (value: string) => void;
}

// ============================================================================
// Main Component
// ============================================================================

export const MonitorsTable: React.FC<MonitorsTableProps> = ({
  rules,
  datasources,
  loading,
  onDelete,
  onClone,
  onImport,
  onCreateMonitor,
  selectedDsIds,
  onDatasourceChange,
  maxDatasources,
  onDatasourceCapReached,
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
  // Phase 5: search lives on the parent for debouncing; expose a stable
  // local-shaped surface to the rest of this component.
  const searchQuery = searchInput;
  const setSearchQuery = onSearchInputChange;
  const [filters, setFilters] = useState<FilterState>(emptyFilters());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(new Set(DEFAULT_VISIBLE));
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_WIDTHS });
  const [selectedMonitor, setSelectedMonitor] = useState<UnifiedRuleSummary | null>(null);
  const [showCreatePopover, setShowCreatePopover] = useState(false);
  const [showSaveSearchInput, setShowSaveSearchInput] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState('');
  const searchRef = useRef<HTMLDivElement>(null);
  const tableWrapperRef = useRef<HTMLDivElement>(null);

  const rowProps = useCallback(
    (item: UnifiedRuleSummary) => ({
      style: selectedIds.has(item.id) ? { backgroundColor: '#F0F5FF' } : undefined,
    }),
    [selectedIds]
  );

  const dsNameMap = useMemo(() => new Map(datasources.map((d) => [d.id, d.name])), [datasources]);

  // Build selectable datasource entries for the filter facet — alpha by name
  const datasourceEntries = useMemo(
    () =>
      datasources
        .map((ds) => ({ id: ds.id, label: ds.name }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    [datasources]
  );

  const allSuggestions = useMemo(() => buildSuggestions(rules), [rules]);
  const labelKeys = useMemo(() => {
    if (facetData) return Object.keys(facetData.labels).sort();
    return collectLabelKeys(rules);
  }, [facetData, rules]);

  // Build available columns including dynamic label columns
  const allColumns = useMemo(() => {
    const cols = [...BASE_COLUMNS];
    for (const key of labelKeys) {
      cols.push({ id: `label:${key}`, label: `Label: ${key}`, isLabelColumn: true });
    }
    return cols;
  }, [labelKeys]);

  // Update suggestions as user types
  useEffect(() => {
    if (!searchQuery) {
      setSuggestions([]);
      return;
    }
    const q = searchQuery.toLowerCase();
    const matches = allSuggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 10);
    setSuggestions(matches);
  }, [searchQuery, allSuggestions]);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Phase 5 — `rules` is the server-paged + filtered set. The table
  // renders that page directly.
  const filtered = rules;

  // Mirror filter state to the parent so it can drive the server-side
  // listRules call. Stable JSON-projection key — same pattern as
  // AlertsDashboard so the effect only fires when the snapshot
  // actually changes.
  const filterSnapshotKey = useMemo(() => JSON.stringify(filters), [filters]);
  useEffect(() => {
    if (!onFilterChange) return;
    onFilterChange({
      status: filters.status,
      severity: filters.severity,
      monitorType: filters.monitorType,
      healthStatus: filters.healthStatus,
      createdBy: filters.createdBy,
      destinations: filters.destinations,
      backend: filters.backend,
      labels: filters.labels,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSnapshotKey, onFilterChange]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    count += filters.status.length;
    count += filters.severity.length;
    count += filters.monitorType.length;
    count += filters.healthStatus.length;
    count += filters.createdBy.length;
    count += filters.destinations.length;
    count += filters.backend.length;
    for (const vals of Object.values(filters.labels)) count += vals.length;
    return count;
  }, [filters]);

  // Selection
  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };
  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filtered.map((r) => r.id)));
  };

  // Saved searches
  const saveCurrentSearch = () => {
    setShowSaveSearchInput(true);
  };
  const loadSavedSearch = (ss: SavedSearch) => {
    setSearchQuery(ss.query);
    setFilters(ss.filters);
  };
  const deleteSavedSearch = (id: string) => {
    setSavedSearches((prev) => prev.filter((s) => s.id !== id));
  };

  // Export
  const exportJson = () => {
    const configs = serializeMonitors(filtered);
    const blob = new Blob([JSON.stringify(configs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'monitors-export.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import
  const handleImportFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e: Event) => {
      const file = (e.target as HTMLInputElement)?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          const configs = Array.isArray(data) ? data : data.monitors;
          if (onImport && Array.isArray(configs))
            onImport(configs as Array<Record<string, unknown>>);
        } catch (_err) {
          alert('Invalid JSON file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  // Bulk delete
  const handleBulkDelete = () => {
    onDelete(Array.from(selectedIds));
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  };

  // Build table columns from visible set
  const tableColumns = useMemo(() => {
    return buildTableColumns({
      visibleColumns,
      filtered,
      selectedIds,
      columnWidths,
      dsNameMap,
      toggleSelect,
      toggleSelectAll,
      setSelectedMonitor,
    });
    // `toggleSelect`/`toggleSelectAll` are recreated every render; adding them
    // would invalidate this memo every render. The closures only read from
    // `selectedIds`/`filtered` which are in the dep list, so staleness is
    // bounded to the same render cycle as the columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColumns, selectedIds, filtered, dsNameMap, columnWidths]);

  // Attach DOM-based resize handles to table header cells
  useResizableColumns(tableWrapperRef, columnWidths, setColumnWidths, visibleColumns);

  // Unique values for filter dropdowns. Phase 5: prefer server facet
  // keys (cover the full filtered set), fallback to page-local rules
  // while loading.
  const uniqueStatuses = useMemo(() => {
    if (facetData) return Object.keys(facetData.status).sort();
    return collectUniqueValues(rules, (r) => r.status);
  }, [facetData, rules]);
  const uniqueSeverities = useMemo(() => {
    if (facetData) return Object.keys(facetData.severity).sort();
    return collectUniqueValues(rules, (r) => r.severity);
  }, [facetData, rules]);
  const uniqueTypes = useMemo(() => {
    if (facetData) return Object.keys(facetData.monitorType).sort();
    return collectUniqueValues(rules, (r) => r.monitorType);
  }, [facetData, rules]);
  const uniqueHealth = useMemo(() => {
    if (facetData) return Object.keys(facetData.healthStatus).sort();
    return collectUniqueValues(rules, (r) => r.healthStatus);
  }, [facetData, rules]);
  const uniqueCreators = useMemo(() => {
    if (facetData) return Object.keys(facetData.createdBy).sort();
    return collectUniqueValues(rules, (r) => r.createdBy);
  }, [facetData, rules]);
  const uniqueBackends = useMemo(() => {
    if (facetData) return Object.keys(facetData.backend).sort();
    return collectUniqueValues(rules, (r) => r.datasourceType);
  }, [facetData, rules]);

  const updateFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const updateLabelFilter = (key: string, values: string[]) => {
    setFilters((prev) => ({
      ...prev,
      labels: { ...prev.labels, [key]: values },
    }));
  };

  const clearAllFilters = () => {
    setFilters(emptyFilters());
    setSearchQuery('');
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestion((prev) => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter' && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
      e.preventDefault();
      setSearchQuery(suggestions[activeSuggestion]);
      setShowSuggestions(false);
      setActiveSuggestion(-1);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  // Phase 5 — facet counts come from the server. Fallback to a client
  // memo over `rules` while the hook is still loading or has errored so
  // the panel never renders empty counts.
  const clientFallbackFacets = useMemo(() => {
    const searchMatched = rules.filter((r) => matchesSearch(r, searchQuery));
    const counts: Record<string, Record<string, number>> = {
      status: {},
      severity: {},
      monitorType: {},
      healthStatus: {},
      backend: {},
      createdBy: {},
    };
    for (const r of searchMatched) {
      counts.status[r.status] = (counts.status[r.status] || 0) + 1;
      counts.severity[r.severity] = (counts.severity[r.severity] || 0) + 1;
      counts.monitorType[r.monitorType] = (counts.monitorType[r.monitorType] || 0) + 1;
      counts.healthStatus[r.healthStatus] = (counts.healthStatus[r.healthStatus] || 0) + 1;
      counts.backend[r.datasourceType] = (counts.backend[r.datasourceType] || 0) + 1;
      counts.createdBy[r.createdBy] = (counts.createdBy[r.createdBy] || 0) + 1;
    }
    const labelCounts: Record<string, Record<string, number>> = {};
    for (const key of labelKeys) {
      labelCounts[key] = {};
      for (const r of searchMatched) {
        const v = r.labels[key];
        if (v) labelCounts[key][v] = (labelCounts[key][v] || 0) + 1;
      }
    }
    return { counts, labelCounts };
  }, [rules, searchQuery, labelKeys]);

  const facetCounts = useMemo(() => {
    if (facetData) {
      return {
        counts: {
          status: facetData.status,
          severity: facetData.severity,
          monitorType: facetData.monitorType,
          healthStatus: facetData.healthStatus,
          backend: facetData.backend,
          createdBy: facetData.createdBy,
        },
        labelCounts: facetData.labels,
      };
    }
    return clientFallbackFacets;
  }, [facetData, clientFallbackFacets]);

  // Collapsible facet sections state (shared hook)
  const { toggleFacetCollapse, isCollapsed: isFacetCollapsed } = useFacetCollapse();

  return (
    <EuiResizableContainer style={{ flex: 1, minHeight: 0 }}>
      {(EuiResizablePanel, EuiResizableButton) => {
        return (
          <>
            <EuiResizablePanel
              id="filters-panel"
              initialSize={20}
              minSize="200px"
              mode={['collapsible', { position: 'top' }]}
              onToggleCollapsed={() => {}}
              paddingSize="none"
              style={{ overflow: 'auto', paddingRight: '4px' }}
            >
              <MonitorsFiltersPanel
                rules={rules}
                datasources={datasources}
                selectedDsIds={selectedDsIds}
                onDatasourceChange={onDatasourceChange}
                maxDatasources={maxDatasources}
                onDatasourceCapReached={onDatasourceCapReached}
                filters={filters}
                activeFilterCount={activeFilterCount}
                clearAllFilters={clearAllFilters}
                updateFilter={updateFilter}
                updateLabelFilter={updateLabelFilter}
                labelKeys={labelKeys}
                datasourceEntries={datasourceEntries}
                uniqueStatuses={uniqueStatuses}
                uniqueSeverities={uniqueSeverities}
                uniqueTypes={uniqueTypes}
                uniqueHealth={uniqueHealth}
                uniqueBackends={uniqueBackends}
                uniqueCreators={uniqueCreators}
                facetCounts={facetCounts}
                isFacetCollapsed={isFacetCollapsed}
                toggleFacetCollapse={toggleFacetCollapse}
                savedSearches={savedSearches}
                setSavedSearches={setSavedSearches}
                loadSavedSearch={loadSavedSearch}
                deleteSavedSearch={deleteSavedSearch}
                showSaveSearchInput={showSaveSearchInput}
                setShowSaveSearchInput={setShowSaveSearchInput}
                saveSearchName={saveSearchName}
                setSaveSearchName={setSaveSearchName}
                saveCurrentSearch={saveCurrentSearch}
                searchQuery={searchQuery}
              />
            </EuiResizablePanel>

            <EuiResizableButton />

            <EuiResizablePanel
              initialSize={80}
              minSize="400px"
              mode="main"
              paddingSize="none"
              style={{ paddingLeft: '4px', overflow: 'auto' }}
            >
              <MonitorsMainPanel
                rules={rules}
                filtered={filtered}
                loading={loading}
                tableColumns={tableColumns}
                rowProps={rowProps}
                tableWrapperRef={tableWrapperRef}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSuggestions={showSuggestions}
                setShowSuggestions={setShowSuggestions}
                suggestions={suggestions}
                activeSuggestion={activeSuggestion}
                setActiveSuggestion={setActiveSuggestion}
                handleSearchKeyDown={handleSearchKeyDown}
                searchRef={searchRef}
                activeFilterCount={activeFilterCount}
                clearAllFilters={clearAllFilters}
                selectedIds={selectedIds}
                setSelectedIds={setSelectedIds}
                allColumns={allColumns}
                visibleColumns={visibleColumns}
                setVisibleColumns={setVisibleColumns}
                showColumnPicker={showColumnPicker}
                setShowColumnPicker={setShowColumnPicker}
                onCreateMonitor={onCreateMonitor}
                showCreatePopover={showCreatePopover}
                setShowCreatePopover={setShowCreatePopover}
                exportJson={exportJson}
                onImport={onImport}
                handleImportFile={handleImportFile}
                showDeleteConfirm={showDeleteConfirm}
                setShowDeleteConfirm={setShowDeleteConfirm}
                handleBulkDelete={handleBulkDelete}
                selectedMonitor={selectedMonitor}
                setSelectedMonitor={setSelectedMonitor}
                onDelete={onDelete}
                onClone={onClone}
                page={page}
                pageSize={pageSize}
                total={total}
                sortField={sortField}
                sortDirection={sortDirection}
                onPageChange={onPageChange}
                onPageSizeChange={onPageSizeChange}
                onSortChange={onSortChange}
              />
            </EuiResizablePanel>
          </>
        );
      }}
    </EuiResizableContainer>
  );
};
