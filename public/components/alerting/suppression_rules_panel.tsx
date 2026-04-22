/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suppression Rules Panel — read-only view of silence-derived suppression rules
 * pulled from one or more Prometheus/Alertmanager datasources. Rules are
 * managed by creating silences directly in Alertmanager.
 *
 * Layout mirrors `AlertsDashboard`: a left filter rail inside an
 * `EuiResizableContainer` and a main region containing per-datasource fetch
 * warnings and the rules table / empty state.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  EuiBasicTable,
  EuiBadge,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiEmptyPrompt,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiResizableContainer,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import moment from 'moment';
import { AlarmsApiClient } from './services/alarms_client';
import { Datasource, DatasourceWarning } from '../../../server/services/alerting';
import type {
  SuppressionRuleConfig,
  SilenceState,
} from '../../../common/services/alerting/suppression';
import { FacetFilterGroup, useFacetCollapse } from './facet_filter_panel';
import { countBy, SILENCE_STATE_COLORS } from './shared_constants';
import { SuppressionRuleDetailFlyout } from './suppression_rule_detail_flyout';

export interface SuppressionRulesPanelProps {
  apiClient: AlarmsApiClient;
  /** All datasources known to the page; the panel filters to Prometheus. */
  datasources: Datasource[];
}

const ALL_STATES: SilenceState[] = ['active', 'pending', 'expired'];
const DEFAULT_STATES: SilenceState[] = ['active', 'pending'];

function matchersToString(matchers: Record<string, string>): string {
  return Object.entries(matchers || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function formatScheduleShort(rule: SuppressionRuleConfig): string {
  const fmt = (iso: string | undefined) => {
    if (!iso) return '?';
    const m = moment(iso);
    return m.isValid() ? m.format('MMM D, HH:mm') : iso;
  };
  return `${fmt(rule.startTime)} → ${fmt(rule.endTime)}`;
}

export const SuppressionRulesPanel: React.FC<SuppressionRulesPanelProps> = ({
  apiClient,
  datasources,
}) => {
  const prometheusDatasources = useMemo(
    () => datasources.filter((d) => d.type === 'prometheus' && d.enabled !== false),
    [datasources]
  );

  const [rules, setRules] = useState<SuppressionRuleConfig[]>([]);
  const [warnings, setWarnings] = useState<DatasourceWarning[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedDsIds, setSelectedDsIds] = useState<string[]>([]);
  const [dsInitialized, setDsInitialized] = useState(false);
  useEffect(() => {
    if (!dsInitialized && prometheusDatasources.length > 0) {
      setSelectedDsIds([prometheusDatasources[0].id]);
      setDsInitialized(true);
    } else if (dsInitialized) {
      const availableIds = new Set(prometheusDatasources.map((d) => d.id));
      setSelectedDsIds((prev) => {
        const filtered = prev.filter((id) => availableIds.has(id));
        return filtered.length === prev.length ? prev : filtered;
      });
    }
  }, [prometheusDatasources, dsInitialized]);

  const [selectedStates, setSelectedStates] = useState<SilenceState[]>(DEFAULT_STATES);
  const [matcherQuery, setMatcherQuery] = useState('');

  const { toggleFacetCollapse, isCollapsed: isFacetCollapsed } = useFacetCollapse();

  const [viewingRule, setViewingRule] = useState<SuppressionRuleConfig | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.listSuppressionRules(
        selectedDsIds.length > 0 ? { datasourceIds: selectedDsIds } : undefined
      );
      setRules(res?.rules ?? []);
      setWarnings(res?.warnings ?? []);
    } catch (_e) {
      setRules([]);
      setWarnings([]);
    }
    setLoading(false);
  }, [apiClient, selectedDsIds]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const filteredRules = useMemo(() => {
    const q = matcherQuery.trim().toLowerCase();
    return rules.filter((rule) => {
      if (selectedStates.length > 0 && !selectedStates.includes(rule.silenceState)) return false;
      if (q && !matchersToString(rule.matchers).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rules, selectedStates, matcherQuery]);

  const stateCounts = useMemo(() => countBy(rules, (r) => r.silenceState), [rules]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (prometheusDatasources.length > 0 && selectedDsIds.length !== prometheusDatasources.length) {
      n += 1;
    }
    const sameAsDefault =
      selectedStates.length === DEFAULT_STATES.length &&
      selectedStates.every((s) => DEFAULT_STATES.includes(s));
    if (!sameAsDefault) n += 1;
    if (matcherQuery.trim()) n += 1;
    return n;
  }, [prometheusDatasources.length, selectedDsIds.length, selectedStates, matcherQuery]);

  const clearAllFilters = () => {
    setSelectedDsIds(prometheusDatasources.length > 0 ? [prometheusDatasources[0].id] : []);
    setSelectedStates(DEFAULT_STATES);
    setMatcherQuery('');
  };

  const columns = [
    {
      field: 'name',
      name: 'Name',
      sortable: true,
      render: (name: string, rule: SuppressionRuleConfig) => (
        <EuiButtonEmpty
          size="xs"
          flush="left"
          onClick={() => setViewingRule(rule)}
          data-test-subj={`alertManager-suppression-view-${rule.id}`}
        >
          {name}
        </EuiButtonEmpty>
      ),
    },
    {
      name: 'State',
      width: '110px',
      render: (rule: SuppressionRuleConfig) => (
        <EuiBadge color={SILENCE_STATE_COLORS[rule.silenceState] || 'default'}>
          {rule.silenceState}
        </EuiBadge>
      ),
    },
    {
      field: 'datasourceName',
      name: 'Datasource',
      width: '160px',
      render: (name: string) => <EuiText size="xs">{name}</EuiText>,
    },
    {
      name: 'Schedule',
      render: (rule: SuppressionRuleConfig) => (
        <EuiText size="xs">{formatScheduleShort(rule)}</EuiText>
      ),
    },
    {
      field: 'matchers',
      name: 'Matchers',
      render: (m: Record<string, string>) => {
        const entries = Object.entries(m || {});
        return entries.length > 0 ? (
          entries.map(([k, v]) => (
            <EuiBadge key={k} color="hollow">
              {k}={v}
            </EuiBadge>
          ))
        ) : (
          <EuiBadge color="default">all</EuiBadge>
        );
      },
    },
    {
      name: 'Actions',
      width: '80px',
      render: (rule: SuppressionRuleConfig) => (
        <EuiToolTip content="View details">
          <EuiButtonIcon
            iconType="inspect"
            aria-label={`View details for ${rule.name}`}
            size="s"
            onClick={() => setViewingRule(rule)}
            data-test-subj={`alertManager-suppression-viewIcon-${rule.id}`}
          />
        </EuiToolTip>
      ),
    },
  ];

  const rowProps = (rule: SuppressionRuleConfig) => ({
    'data-test-subj': `alertManager-suppression-row-${rule.id}`,
  });

  const renderFacet = (
    id: string,
    label: string,
    options: string[],
    selected: string[],
    onChange: (v: string[]) => void,
    counts: Record<string, number>
  ) => (
    <FacetFilterGroup
      key={id}
      id={id}
      label={label}
      options={options}
      selected={selected}
      onChange={onChange}
      counts={counts}
      isCollapsed={isFacetCollapsed(id)}
      onToggleCollapse={toggleFacetCollapse}
    />
  );

  const tableOrEmpty =
    !loading && filteredRules.length === 0 ? (
      <EuiEmptyPrompt
        title={<h2>No Suppression Rules</h2>}
        body={
          <p>
            {rules.length === 0
              ? 'No active silences found. Create a silence in Alertmanager to suppress alerts during maintenance windows.'
              : 'No rules match the current filters. Adjust or clear filters to see more.'}
          </p>
        }
      />
    ) : (
      <EuiBasicTable
        items={filteredRules}
        columns={columns}
        loading={loading}
        rowProps={rowProps}
        data-test-subj="alertManager-suppression-table"
      />
    );

  return (
    <div>
      <EuiResizableContainer style={{ height: 'calc(100vh - 180px)' }}>
        {(EuiResizablePanel, EuiResizableButton) => (
          <>
            <EuiResizablePanel
              id="suppression-filters-panel"
              initialSize={15}
              minSize="200px"
              mode={['collapsible', { position: 'top' }]}
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
                        <EuiButtonEmpty
                          size="xs"
                          onClick={clearAllFilters}
                          flush="right"
                          data-test-subj="alertManager-suppression-clearFilters"
                        >
                          Clear ({activeFilterCount})
                        </EuiButtonEmpty>
                      </EuiFlexItem>
                    )}
                  </EuiFlexGroup>
                  <EuiSpacer size="s" />

                  {prometheusDatasources.length > 0 &&
                    renderFacet(
                      'datasource',
                      'Datasource',
                      prometheusDatasources.map((d) => d.name),
                      selectedDsIds
                        .map((id) => prometheusDatasources.find((d) => d.id === id)?.name || '')
                        .filter(Boolean),
                      (names) => {
                        const ids = names
                          .map((n) => prometheusDatasources.find((d) => d.name === n)?.id)
                          .filter(Boolean) as string[];
                        setSelectedDsIds(ids);
                      },
                      countBy(prometheusDatasources, (d) => d.name)
                    )}

                  {renderFacet(
                    'state',
                    'State',
                    ALL_STATES,
                    selectedStates,
                    (v) => setSelectedStates(v as SilenceState[]),
                    stateCounts
                  )}

                  <EuiSpacer size="s" />
                  <EuiText size="xs" color="subdued" style={{ marginBottom: 4 }}>
                    <strong>Matcher search</strong>
                  </EuiText>
                  <EuiFieldSearch
                    compressed
                    fullWidth
                    placeholder="e.g. env=prod"
                    value={matcherQuery}
                    onChange={(e) => setMatcherQuery(e.target.value)}
                    data-test-subj="alertManager-suppression-matcherSearch"
                  />
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
              <EuiCallOut title="Read-only view" color="primary" iconType="iInCircle" size="s">
                <p>
                  Suppression rules are derived from Alertmanager silences. Create or modify
                  silences directly in Alertmanager to manage suppression.
                </p>
              </EuiCallOut>
              <EuiSpacer size="s" />

              {warnings.length > 0 && (
                <>
                  <EuiCallOut
                    color="warning"
                    iconType="alert"
                    size="s"
                    title="Some datasources could not be reached"
                    data-test-subj="alertManager-suppression-warnings"
                  >
                    <EuiText size="xs">
                      Silences are unavailable for:{' '}
                      {warnings.map((w) => w.datasourceName).join(', ')}
                    </EuiText>
                  </EuiCallOut>
                  <EuiSpacer size="s" />
                </>
              )}

              <EuiTitle size="xs">
                <h3>Suppression Rules</h3>
              </EuiTitle>
              <EuiSpacer size="m" />

              {tableOrEmpty}
            </EuiResizablePanel>
          </>
        )}
      </EuiResizableContainer>

      {viewingRule && (
        <SuppressionRuleDetailFlyout rule={viewingRule} onClose={() => setViewingRule(null)} />
      )}
    </div>
  );
};
