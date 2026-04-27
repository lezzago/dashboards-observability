/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Left-sidebar filter shell for the SLO listing.
 *
 * Each facet is an EuiAccordion wrapping a compressed EuiCheckboxGroup. High-
 * cardinality facets (Service, Team) get an EuiFieldSearch above the checkbox
 * list; the others are plain groups. The panel emits the full next filter
 * state on every change — URL sync stays in the parent.
 */

import React, { useMemo, useState } from 'react';
import {
  EuiAccordion,
  EuiButtonGroup,
  EuiCheckboxGroup,
  EuiFieldSearch,
  EuiHealth,
  EuiHorizontalRule,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type {
  SloHealthState,
  SloListFilters,
  SloSummary,
} from '../../../../../common/slo/slo_types';
import { SLO_HEALTH_COLOR, SLO_HEALTH_ORDER } from '../../../../../common/slo/state';

type SliBackend = 'prometheus' | 'opensearch';
type SloMode = 'active' | 'shadow';

const STATE_LABEL: Record<SloHealthState, string> = {
  breached: 'Breached',
  warning: 'Warning',
  ok: 'Healthy',
  no_data: 'No data',
  stale: 'Stale',
  disabled: 'Disabled',
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
  filters: SloListFilters;
  onChange: (next: SloListFilters) => void;
  /**
   * Result set used to derive distinct service/team/tier/sliLeafType values.
   * Deliberately the *filtered* set — we don't fire a second unfiltered fetch.
   */
  items: SloSummary[];
}

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

function toggleInArray<T>(arr: T[] | undefined, value: T): T[] | undefined {
  const set = new Set(arr ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  const next = Array.from(set);
  return next.length === 0 ? undefined : next;
}

function arrToIdMap(values: string[] | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  (values ?? []).forEach((v) => (out[v] = true));
  return out;
}

interface FacetAccordionProps {
  id: string;
  label: string;
  options: Array<{ id: string; label: React.ReactNode }>;
  selected: string[] | undefined;
  onToggle: (id: string) => void;
  initialIsOpen?: boolean;
  searchable?: boolean;
  dataTestSubj: string;
}

const FacetAccordion: React.FC<FacetAccordionProps> = ({
  id,
  label,
  options,
  selected,
  onToggle,
  initialIsOpen = true,
  searchable = false,
  dataTestSubj,
}) => {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.id.toLowerCase().includes(q));
  }, [options, query, searchable]);
  const selectedCount = (selected ?? []).length;
  const buttonContent = (
    <EuiText size="xs">
      <strong>{label}</strong>
      {selectedCount > 0 ? (
        <span style={{ fontWeight: 400, marginLeft: 4 }}>({selectedCount})</span>
      ) : null}
    </EuiText>
  );

  return (
    <EuiAccordion
      id={id}
      buttonContent={buttonContent}
      initialIsOpen={initialIsOpen}
      data-test-subj={dataTestSubj}
    >
      <EuiSpacer size="xs" />
      {searchable ? (
        <>
          <EuiFieldSearch
            placeholder={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            isClearable
            compressed
            fullWidth
            data-test-subj={`${dataTestSubj}-search`}
          />
          <EuiSpacer size="xs" />
        </>
      ) : null}
      {filtered.length === 0 ? (
        <EuiText size="xs" color="subdued">
          No values
        </EuiText>
      ) : (
        <EuiCheckboxGroup
          options={filtered}
          idToSelectedMap={arrToIdMap(selected)}
          onChange={onToggle}
          compressed
          data-test-subj={`${dataTestSubj}-checkboxGroup`}
        />
      )}
    </EuiAccordion>
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

  return (
    <div data-test-subj="slosListingFilterPanel">
      <FacetAccordion
        id="slosFilterAccordion-state"
        label="State"
        dataTestSubj="slosFilterAccordion-state"
        options={SLO_HEALTH_ORDER.map((s) => ({
          id: s,
          label: (
            <EuiHealth color={SLO_HEALTH_COLOR[s]}>
              <span style={{ fontSize: 12 }}>{STATE_LABEL[s]}</span>
            </EuiHealth>
          ),
        }))}
        selected={filters.state}
        onToggle={(id) => patch({ state: toggleInArray(filters.state, id as SloHealthState) })}
      />
      <EuiHorizontalRule margin="xs" />

      <FacetAccordion
        id="slosFilterAccordion-sliType"
        label="SLI type"
        dataTestSubj="slosFilterAccordion-sliType"
        options={allLeafTypes.map((v) => ({ id: v, label: v }))}
        selected={filters.sliLeafType}
        onToggle={(id) => patch({ sliLeafType: toggleInArray(filters.sliLeafType, id) })}
      />
      <EuiHorizontalRule margin="xs" />

      <FacetAccordion
        id="slosFilterAccordion-sliBackend"
        label="SLI backend"
        dataTestSubj="slosFilterAccordion-sliBackend"
        options={(['prometheus', 'opensearch'] as const).map((v) => ({
          id: v,
          label: SLI_BACKEND_LABEL[v],
        }))}
        selected={filters.sliBackend}
        onToggle={(id) =>
          patch({ sliBackend: toggleInArray(filters.sliBackend, id as SliBackend) })
        }
      />
      <EuiHorizontalRule margin="xs" />

      <FacetAccordion
        id="slosFilterAccordion-service"
        label="Service"
        dataTestSubj="slosFilterAccordion-service"
        options={allServices.map((v) => ({ id: v, label: v }))}
        selected={filters.service}
        onToggle={(id) => patch({ service: toggleInArray(filters.service, id) })}
        searchable
      />
      <EuiHorizontalRule margin="xs" />

      <FacetAccordion
        id="slosFilterAccordion-team"
        label="Team"
        dataTestSubj="slosFilterAccordion-team"
        options={allTeams.map((v) => ({ id: v, label: v }))}
        selected={filters.team}
        onToggle={(id) => patch({ team: toggleInArray(filters.team, id) })}
        searchable
      />
      <EuiHorizontalRule margin="xs" />

      <FacetAccordion
        id="slosFilterAccordion-tier"
        label="Tier"
        dataTestSubj="slosFilterAccordion-tier"
        options={allTiers.map((v) => ({ id: v, label: v }))}
        selected={filters.tier}
        onToggle={(id) => patch({ tier: toggleInArray(filters.tier, id) })}
      />
      <EuiHorizontalRule margin="xs" />

      <FacetAccordion
        id="slosFilterAccordion-mode"
        label="Mode"
        dataTestSubj="slosFilterAccordion-mode"
        options={(['active', 'shadow'] as const).map((v) => ({ id: v, label: MODE_LABEL[v] }))}
        selected={filters.mode}
        onToggle={(id) => patch({ mode: toggleInArray(filters.mode, id as SloMode) })}
      />
      <EuiHorizontalRule margin="xs" />

      <EuiAccordion
        id="slosFilterAccordion-enabled"
        buttonContent={
          <EuiText size="xs">
            <strong>Enabled</strong>
            {filters.enabled !== undefined ? (
              <span style={{ fontWeight: 400, marginLeft: 4 }}>
                ({filters.enabled ? 'yes' : 'no'})
              </span>
            ) : null}
          </EuiText>
        }
        initialIsOpen
        data-test-subj="slosFilterAccordion-enabled"
      >
        <EuiSpacer size="xs" />
        <EuiButtonGroup
          legend="Filter by enabled"
          buttonSize="compressed"
          options={[
            { id: 'any', label: 'Any' },
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ]}
          idSelected={filters.enabled === undefined ? 'any' : filters.enabled ? 'yes' : 'no'}
          onChange={(id) => patch({ enabled: id === 'any' ? undefined : id === 'yes' })}
          data-test-subj="slosFilterEnabledGroup"
        />
      </EuiAccordion>
    </div>
  );
};
