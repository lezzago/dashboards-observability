/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Top-strip filter panel for the SLO listing.
 *
 * Layout decision (Chen + Maya): chose a horizontal `EuiFilterGroup` over a
 * sidebar so the catalog table keeps the full listing width. The overview
 * panel above already provides the KPI-tile drilldown; this strip is a fast
 * modifier, not a primary surface. Each facet is a popover-backed
 * `EuiFilterButton` that opens an `EuiSelectable` — the OUI-native way to
 * present multi-select checkboxes without building a custom dropdown.
 */

import React, { useMemo, useState } from 'react';
import {
  EuiFieldSearch,
  EuiFilterButton,
  EuiFilterGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiPopover,
  EuiPopoverTitle,
  EuiSelectable,
  EuiSelectableOption,
} from '@elastic/eui';
import type {
  SloHealthState,
  SloListFilters,
  SloSummary,
} from '../../../../../common/slo/slo_types';

type SliBackend = 'prometheus' | 'opensearch';
type SloMode = 'active' | 'shadow';

const STATE_ORDER: SloHealthState[] = ['breached', 'warning', 'ok', 'no_data', 'stale', 'disabled'];
const STATE_LABEL: Record<SloHealthState, string> = {
  breached: 'Breached',
  warning: 'Warning',
  ok: 'Healthy',
  no_data: 'No data',
  stale: 'Stale',
  disabled: 'Disabled',
};
const STATE_COLOR: Record<SloHealthState, string> = {
  breached: 'danger',
  warning: 'warning',
  ok: 'success',
  no_data: 'subdued',
  stale: 'subdued',
  disabled: 'default',
};

const SLI_BACKEND_LABEL: Record<SliBackend, string> = {
  prometheus: 'Prometheus',
  opensearch: 'OpenSearch',
};

const MODE_LABEL: Record<SloMode, string> = {
  active: 'Active',
  shadow: 'Shadow',
};

export interface SloListFilterPanelProps {
  /** Current filter state (server-applied on listing fetches). */
  filters: SloListFilters;
  /** Called with the full next filter state — parent handles URL sync. */
  onChange: (next: SloListFilters) => void;
  /**
   * Result set used to derive distinct values for service/team/tier/sliLeafType.
   * Deliberately the *filtered* set (what's on screen right now) — we
   * intentionally don't fire a separate unfiltered fetch per the design brief.
   */
  items: SloSummary[];
}

/** Count of applied facets, for the "Clear (N)" affordance. */
function countAppliedFilters(f: SloListFilters): number {
  let n = 0;
  if (f.state?.length) n++;
  if (f.sliBackend?.length) n++;
  if (f.sliLeafType?.length) n++;
  if (f.service?.length) n++;
  if (f.team?.length) n++;
  if (f.tier?.length) n++;
  if (f.mode?.length) n++;
  if (f.enabled !== undefined) n++;
  if (f.search && f.search.trim().length > 0) n++;
  return n;
}

/** Stable distinct-and-sorted values for a summary-derived facet. */
function distinctValues<T>(items: T[], pick: (t: T) => string | string[] | undefined): string[] {
  const set = new Set<string>();
  for (const it of items) {
    const v = pick(it);
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((s) => set.add(s));
    else if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Build EuiSelectable options from a flat string[] + current selection. */
function toSelectOptions(
  all: string[],
  selected: string[],
  displayMap?: Record<string, string>
): EuiSelectableOption[] {
  return all.map((value) => ({
    label: displayMap?.[value] ?? value,
    key: value,
    checked: selected.includes(value) ? ('on' as const) : undefined,
  }));
}

/**
 * Generic popover-backed multi-select facet. Keeps the open/close state local
 * so we don't proliferate props on the parent.
 */
const FacetPopover: React.FC<{
  label: string;
  dataTestSubj: string;
  options: EuiSelectableOption[];
  onChange: (selectedKeys: string[]) => void;
  searchable?: boolean;
  /** Render each row with a coloured health dot. */
  healthColor?: Record<string, string>;
}> = ({ label, dataTestSubj, options, onChange, searchable, healthColor }) => {
  const [open, setOpen] = useState(false);
  const activeCount = options.filter((o) => o.checked === 'on').length;

  const button = (
    <EuiFilterButton
      iconType="arrowDown"
      onClick={() => setOpen((v) => !v)}
      isSelected={open}
      hasActiveFilters={activeCount > 0}
      numActiveFilters={activeCount > 0 ? activeCount : undefined}
      data-test-subj={`slos-listing-filter-${dataTestSubj}-button`}
    >
      {label}
    </EuiFilterButton>
  );

  return (
    <EuiPopover
      button={button}
      isOpen={open}
      closePopover={() => setOpen(false)}
      panelPaddingSize="none"
      anchorPosition="downCenter"
    >
      <EuiSelectable
        aria-label={`Filter by ${label}`}
        searchable={searchable}
        searchProps={
          searchable
            ? { placeholder: `Search ${label.toLowerCase()}`, compressed: true }
            : undefined
        }
        options={options}
        onChange={(next) =>
          onChange(
            next
              .filter((o) => o.checked === 'on')
              .map((o) => (typeof o.key === 'string' ? o.key : String(o.label)))
          )
        }
        listProps={{ bordered: false, showIcons: false }}
        renderOption={
          healthColor
            ? (opt) => (
                <EuiHealth color={healthColor[String(opt.key ?? opt.label)] ?? 'subdued'}>
                  {opt.label}
                </EuiHealth>
              )
            : undefined
        }
        data-test-subj={`slos-listing-filter-${dataTestSubj}-selectable`}
      >
        {(list, search) => (
          <div style={{ width: 260 }}>
            {searchable ? <EuiPopoverTitle paddingSize="s">{search}</EuiPopoverTitle> : null}
            {list}
          </div>
        )}
      </EuiSelectable>
    </EuiPopover>
  );
};

/** Tri-state Enabled button — cycles: any → enabled → disabled → any. */
const EnabledTriStateButton: React.FC<{
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
}> = ({ value, onChange }) => {
  const label = value === undefined ? 'Enabled: Any' : value ? 'Enabled: Yes' : 'Enabled: No';
  const cycle = () => {
    if (value === undefined) onChange(true);
    else if (value === true) onChange(false);
    else onChange(undefined);
  };
  return (
    <EuiFilterButton
      onClick={cycle}
      hasActiveFilters={value !== undefined}
      data-test-subj="slos-listing-filter-enabled-button"
    >
      {label}
    </EuiFilterButton>
  );
};

export const SloListFilterPanel: React.FC<SloListFilterPanelProps> = ({
  filters,
  onChange,
  items,
}) => {
  const allServices = useMemo(() => distinctValues(items, (s) => s.service), [items]);
  const allTeams = useMemo(() => distinctValues(items, (s) => s.owner.teams), [items]);
  const allTiers = useMemo(() => distinctValues(items, (s) => s.tier), [items]);
  const allLeafTypes = useMemo(() => distinctValues(items, (s) => s.sliLeafType), [items]);

  const patch = (delta: Partial<SloListFilters>) => onChange({ ...filters, ...delta });

  const activeCount = countAppliedFilters(filters);

  return (
    <EuiFlexGroup
      gutterSize="s"
      alignItems="center"
      responsive={false}
      wrap
      data-test-subj="slos-listing-filter-panel"
    >
      <EuiFlexItem grow={false} style={{ minWidth: 280, flexGrow: 1 }}>
        <EuiFieldSearch
          placeholder="Filter by name, service, or description"
          value={filters.search ?? ''}
          onChange={(e) => patch({ search: e.target.value })}
          isClearable
          compressed
          fullWidth
          data-test-subj="slos-listing-filter-search"
        />
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <EuiFilterGroup compressed>
          <FacetPopover
            label="State"
            dataTestSubj="state"
            options={toSelectOptions(STATE_ORDER, filters.state ?? [], STATE_LABEL)}
            onChange={(keys) =>
              patch({ state: keys.length ? (keys as SloHealthState[]) : undefined })
            }
            healthColor={STATE_COLOR}
          />
          <FacetPopover
            label="SLI backend"
            dataTestSubj="sliBackend"
            options={toSelectOptions(
              ['prometheus', 'opensearch'],
              filters.sliBackend ?? [],
              SLI_BACKEND_LABEL as Record<string, string>
            )}
            onChange={(keys) =>
              patch({ sliBackend: keys.length ? (keys as SliBackend[]) : undefined })
            }
          />
          <FacetPopover
            label="SLI type"
            dataTestSubj="sliLeafType"
            options={toSelectOptions(allLeafTypes, filters.sliLeafType ?? [])}
            onChange={(keys) => patch({ sliLeafType: keys.length ? keys : undefined })}
          />
          <FacetPopover
            label="Service"
            dataTestSubj="service"
            options={toSelectOptions(allServices, filters.service ?? [])}
            onChange={(keys) => patch({ service: keys.length ? keys : undefined })}
            searchable
          />
          <FacetPopover
            label="Team"
            dataTestSubj="team"
            options={toSelectOptions(allTeams, filters.team ?? [])}
            onChange={(keys) => patch({ team: keys.length ? keys : undefined })}
            searchable
          />
          <FacetPopover
            label="Tier"
            dataTestSubj="tier"
            options={toSelectOptions(allTiers, filters.tier ?? [])}
            onChange={(keys) => patch({ tier: keys.length ? keys : undefined })}
          />
          <FacetPopover
            label="Mode"
            dataTestSubj="mode"
            options={toSelectOptions(
              ['active', 'shadow'],
              filters.mode ?? [],
              MODE_LABEL as Record<string, string>
            )}
            onChange={(keys) => patch({ mode: keys.length ? (keys as SloMode[]) : undefined })}
          />
          <EnabledTriStateButton
            value={filters.enabled}
            onChange={(next) => patch({ enabled: next })}
          />
        </EuiFilterGroup>
      </EuiFlexItem>
      {activeCount > 0 ? (
        <EuiFlexItem grow={false}>
          <span
            data-test-subj="slos-listing-filter-active-count"
            style={{ fontSize: 12, color: '#69707D' }}
          >
            {activeCount} active
          </span>
        </EuiFlexItem>
      ) : null}
    </EuiFlexGroup>
  );
};
