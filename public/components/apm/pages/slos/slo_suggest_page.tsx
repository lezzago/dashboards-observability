/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Preview page — discovers Prometheus services in the APM-configured
 * datasource, produces draft SLOs, lets the user review/edit, and creates
 * them in one batch.
 *
 * Nothing ships alerting rules until the user clicks "Create N selected";
 * every draft is a harmless client-side object until then.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCheckbox,
  EuiCode,
  EuiDescriptionList,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiPage,
  EuiPageBody,
  EuiPageContent,
  EuiPageContentBody,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { useHistory } from 'react-router-dom';
import { ChromeStart, HttpStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { useApmConfig } from '../../config/apm_config_context';
import type { SloApiClient } from './slo_api_client';
import { DiscoveryInput, Suggestion, generateSuggestions, metricsToProbe } from './suggest_engine';

export interface SloSuggestPageProps {
  apiClient: SloApiClient;
  http: HttpStart;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; suggestions: Suggestion[] }
  | { kind: 'error'; message: string };

// ============================================================================
// Main component
// ============================================================================

export const SloSuggestPage: React.FC<SloSuggestPageProps> = ({
  apiClient,
  http,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const history = useHistory();
  const { config: _config } = useApmConfig();
  // The alerting datasource service re-assigns numeric ids (ds-N) on every
  // OSD restart, so hardcoding an id is brittle. Default to blank and let the
  // effect below populate the picker with whatever is available.
  const [datasourceId, setDatasourceId] = useState<string>('');
  const [availableDatasources, setAvailableDatasources] = useState<
    Array<{ id: string; name: string; type: string }>
  >([]);
  const [state, setState] = useState<FetchState>({ kind: 'idle' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Per-suggestion overrides users type into the card. */
  const [overrides, setOverrides] = useState<
    Record<
      string,
      { ownerTeam?: string; tier?: string; target?: string; latencyThreshold?: string }
    >
  >({});
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    chrome.setBreadcrumbs([
      parentBreadcrumb,
      { text: 'SLO/SLI', href: '#/slos' },
      { text: 'Suggest' },
    ]);
  }, [chrome, parentBreadcrumb]);

  // Load the list of Prometheus datasources the alerting backend knows about.
  useEffect(() => {
    (async () => {
      try {
        const body = await http.get<{
          datasources: Array<{ id: string; name: string; type: string }>;
        }>('/api/alerting/datasources');
        const promDs = body.datasources.filter((d) => d.type === 'prometheus');
        setAvailableDatasources(promDs);
        // Auto-select the first Prometheus datasource so Discover is always armed.
        if (promDs.length > 0) {
          setDatasourceId((prev) => prev || promDs[0].id);
        }
      } catch {
        /* non-fatal — user can still type the datasource id */
      }
    })();
  }, [http]);

  const discover = useCallback(async () => {
    setState({ kind: 'loading' });
    setSelected(new Set());
    setOverrides({});
    try {
      // Step 1: metric names
      const metricsBody = await http.get<unknown>(
        `/api/alerting/prometheus/${encodeURIComponent(datasourceId)}/metadata/metrics`
      );
      const metricNames: string[] = Array.isArray(metricsBody)
        ? (metricsBody as string[])
        : (metricsBody as { metrics?: string[]; data?: string[] }).metrics ??
          (metricsBody as { metrics?: string[]; data?: string[] }).data ??
          [];

      // Step 2: label values per probe metric
      const probes = metricsToProbe(metricNames);
      const labelValuesByMetric: DiscoveryInput['labelValuesByMetric'] = {};
      for (const p of probes) {
        const entry: Record<string, string[]> = {};
        for (const label of p.labels) {
          const body = await http.get<unknown>(
            `/api/alerting/prometheus/${encodeURIComponent(
              datasourceId
            )}/metadata/label-values/${encodeURIComponent(label)}`,
            { query: { selector: p.metric } }
          );
          const cast = body as { values?: string[]; data?: string[] } | string[];
          entry[label] = Array.isArray(cast) ? cast : cast.values ?? cast.data ?? [];
        }
        labelValuesByMetric[p.metric] = entry as DiscoveryInput['labelValuesByMetric'][string];
      }

      const suggestions = generateSuggestions({
        datasourceId,
        metricNames,
        labelValuesByMetric,
      });
      setState({ kind: 'ready', suggestions });
      // Default every suggestion to "selected" — user can uncheck the ones
      // they don't want.
      setSelected(new Set(suggestions.map((s) => s.key)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message: msg });
    }
  }, [datasourceId, http]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setOverride = useCallback((key: string, patch: Partial<typeof overrides[string]>) => {
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

  const applyOverrides = useCallback(
    (s: Suggestion): Suggestion => {
      const o = overrides[s.key] ?? {};
      const spec = { ...s.input.spec };
      if (o.ownerTeam && o.ownerTeam.trim()) {
        spec.owner = { ...spec.owner, teams: [o.ownerTeam.trim()] };
      }
      if (o.tier && o.tier.trim()) {
        spec.tier = o.tier.trim();
      }
      if (o.target) {
        const t = Number(o.target);
        if (Number.isFinite(t) && t > 0.5 && t < 1) {
          spec.objectives = spec.objectives.map((obj, i) =>
            i === 0 ? { ...obj, target: t } : obj
          );
        }
      }
      if (o.latencyThreshold && spec.objectives[0]?.latencyThreshold !== undefined) {
        const lt = Number(o.latencyThreshold);
        if (Number.isFinite(lt) && lt > 0) {
          spec.objectives = spec.objectives.map((obj, i) =>
            i === 0 ? { ...obj, latencyThreshold: lt } : obj
          );
        }
      }
      return { ...s, input: { ...s.input, spec } };
    },
    [overrides]
  );

  const createSelected = useCallback(async () => {
    if (state.kind !== 'ready') return;
    setCreating(true);
    const picks = state.suggestions.filter((s) => selected.has(s.key)).map(applyOverrides);
    const results: Array<{ key: string; ok: boolean; message?: string }> = [];
    for (const s of picks) {
      try {
        await apiClient.create(s.input);
        results.push({ key: s.key, ok: true });
      } catch (e) {
        results.push({
          key: s.key,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    setCreating(false);
    const failures = results.filter((r) => !r.ok);
    if (failures.length === 0) {
      notifications.toasts.addSuccess({
        title: `Created ${results.length} SLO${results.length === 1 ? '' : 's'}`,
        text: 'Alerting rules are provisioned and will begin evaluating on the next ruler cycle.',
      });
      history.push('/slos');
    } else {
      notifications.toasts.addDanger({
        title: `${failures.length} of ${results.length} failed`,
        text: failures.map((f) => `• ${f.key}: ${f.message ?? 'unknown error'}`).join('\n'),
      });
    }
  }, [apiClient, applyOverrides, history, notifications, selected, state]);

  const suggestions = state.kind === 'ready' ? state.suggestions.map(applyOverrides) : [];

  const selectedCount = suggestions.filter((s) => selected.has(s.key)).length;
  const totalRules = suggestions
    .filter((s) => selected.has(s.key))
    .reduce((acc, s) => acc + s.estimatedRuleCount, 0);

  const headerActions = [
    <EuiButtonEmpty key="back" iconType="arrowLeft" href="#/slos" size="s">
      Back to SLOs
    </EuiButtonEmpty>,
    <EuiButton
      key="discover"
      size="s"
      iconType="refresh"
      onClick={discover}
      isLoading={state.kind === 'loading'}
      data-test-subj="slos-suggest-discover"
    >
      Discover
    </EuiButton>,
    <EuiButton
      key="create"
      size="s"
      fill
      iconType="plusInCircle"
      color="primary"
      onClick={createSelected}
      isLoading={creating}
      isDisabled={selectedCount === 0 || state.kind !== 'ready'}
      data-test-subj="slos-suggest-create"
    >
      Create {selectedCount} selected
    </EuiButton>,
  ];

  return (
    <EuiPage data-test-subj="sloSuggestPage">
      <EuiPageBody component="main">
        <HeaderControlledComponentsWrapper components={headerActions} />
        <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
          <EuiPageContentBody>
            {/* Intro + datasource picker */}
            <EuiPanel>
              <EuiText size="m">
                <h4>Suggest SLOs from Prometheus metrics</h4>
              </EuiText>
              <EuiSpacer size="s" />
              <EuiText size="s" color="subdued">
                Probes the Prometheus datasource for HTTP / gRPC / GenAI metrics and drafts SLOs you
                can preview below. Nothing is created — and no alerts will fire — until you click{' '}
                <strong>Create</strong>. Each draft shows the number of recording + MWMBR +
                budget-warning rules that will be provisioned.
              </EuiText>
              <EuiSpacer size="m" />
              <EuiFlexGroup gutterSize="s" alignItems="flexEnd">
                <EuiFlexItem grow={false} style={{ minWidth: 260 }}>
                  {availableDatasources.length > 0 ? (
                    <EuiSelect
                      compressed
                      options={availableDatasources.map((d) => ({
                        value: d.id,
                        text: `${d.name} (${d.id})`,
                      }))}
                      value={datasourceId}
                      onChange={(e) => setDatasourceId(e.target.value)}
                      aria-label="Prometheus datasource"
                      data-test-subj="slos-suggest-ds-select"
                    />
                  ) : (
                    <EuiFieldText
                      compressed
                      value={datasourceId}
                      onChange={(e) => setDatasourceId(e.target.value)}
                      placeholder="ds-2"
                      data-test-subj="slos-suggest-ds-input"
                    />
                  )}
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButtonEmpty size="s" onClick={discover} isLoading={state.kind === 'loading'}>
                    {state.kind === 'ready' ? 'Rediscover' : 'Discover'}
                  </EuiButtonEmpty>
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiPanel>

            <EuiSpacer size="m" />

            {state.kind === 'idle' && (
              <EuiPanel>
                <EuiText size="s" color="subdued">
                  Choose a Prometheus datasource and click <strong>Discover</strong> to generate
                  draft SLOs.
                </EuiText>
              </EuiPanel>
            )}

            {state.kind === 'loading' && (
              <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 200 }}>
                <EuiFlexItem grow={false}>
                  <EuiLoadingSpinner size="xl" />
                </EuiFlexItem>
              </EuiFlexGroup>
            )}

            {state.kind === 'error' && (
              <EuiCallOut color="danger" iconType="alert" title="Discovery failed" size="s">
                <EuiText size="s">{state.message}</EuiText>
              </EuiCallOut>
            )}

            {state.kind === 'ready' && (
              <>
                {state.suggestions.length === 0 ? (
                  <EuiCallOut
                    size="s"
                    iconType="iInCircle"
                    title="No suggestions for this datasource"
                  >
                    <EuiText size="s">
                      No HTTP, gRPC, or GenAI metrics were detected on this datasource. If you
                      believe these metrics exist, verify the datasource id and that the Prometheus
                      metadata API returns data.
                    </EuiText>
                  </EuiCallOut>
                ) : (
                  <>
                    <EuiPanel color="subdued">
                      <EuiFlexGroup alignItems="center" responsive={false} gutterSize="m">
                        <EuiFlexItem grow={true}>
                          <EuiText size="s">
                            <strong>{selectedCount}</strong> of {suggestions.length} draft SLOs
                            selected — clicking <strong>Create</strong> will provision{' '}
                            <strong>{totalRules}</strong> Prometheus rules in namespace{' '}
                            <EuiCode>slo-generated</EuiCode>.
                          </EuiText>
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiFlexGroup gutterSize="s" responsive={false}>
                            <EuiFlexItem grow={false}>
                              <EuiButtonEmpty
                                size="s"
                                onClick={() => setSelected(new Set(suggestions.map((s) => s.key)))}
                              >
                                Select all
                              </EuiButtonEmpty>
                            </EuiFlexItem>
                            <EuiFlexItem grow={false}>
                              <EuiButtonEmpty size="s" onClick={() => setSelected(new Set())}>
                                Clear
                              </EuiButtonEmpty>
                            </EuiFlexItem>
                          </EuiFlexGroup>
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    </EuiPanel>
                    <EuiSpacer size="m" />
                    <EuiFlexGroup wrap gutterSize="m">
                      {suggestions.map((s) => (
                        <EuiFlexItem
                          key={s.key}
                          grow={false}
                          style={{ minWidth: 360, maxWidth: 460 }}
                        >
                          <SuggestionCard
                            suggestion={s}
                            selected={selected.has(s.key)}
                            onToggle={() => toggle(s.key)}
                            overrides={overrides[s.key] ?? {}}
                            onOverrideChange={(patch) => setOverride(s.key, patch)}
                          />
                        </EuiFlexItem>
                      ))}
                    </EuiFlexGroup>
                  </>
                )}
              </>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};

// ============================================================================
// Card
// ============================================================================

const SuggestionCard: React.FC<{
  suggestion: Suggestion;
  selected: boolean;
  onToggle: () => void;
  overrides: { ownerTeam?: string; tier?: string; target?: string; latencyThreshold?: string };
  onOverrideChange: (
    patch: Partial<{
      ownerTeam: string;
      tier: string;
      target: string;
      latencyThreshold: string;
    }>
  ) => void;
}> = ({ suggestion, selected, onToggle, overrides, onOverrideChange }) => {
  const spec = suggestion.input.spec;
  const objective = spec.objectives[0];
  const isLatency = objective?.latencyThreshold !== undefined;
  const unit =
    spec.sli.type === 'single' &&
    spec.sli.definition.backend === 'prometheus' &&
    spec.sli.definition.type === 'latency_threshold'
      ? spec.sli.definition.latencyThresholdUnit ?? 'seconds'
      : 'seconds';

  return (
    <EuiPanel
      color={selected ? 'primary' : 'plain'}
      hasBorder
      style={{ height: '100%' }}
      data-test-subj={`slos-suggest-card-${suggestion.key}`}
    >
      <EuiFlexGroup gutterSize="s" alignItems="flexStart" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiCheckbox
            id={`slos-suggest-select-${suggestion.key}`}
            checked={selected}
            onChange={onToggle}
            data-test-subj={`slos-suggest-select-${suggestion.key}`}
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiText size="s">
            <strong>{spec.name}</strong>
          </EuiText>
          <EuiSpacer size="xs" />
          <EuiFlexGroup gutterSize="xs" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">{suggestion.kind}</EuiBadge>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">{suggestion.estimatedRuleCount} rules</EuiBadge>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="s" />
      <EuiText size="xs" color="subdued">
        {suggestion.reason}
      </EuiText>
      <EuiSpacer size="s" />
      <EuiDescriptionList
        compressed
        type="column"
        listItems={[
          { title: 'Metric', description: <EuiCode>{suggestion.sourceMetric}</EuiCode> },
          {
            title: 'Dimensions',
            description:
              Object.entries(suggestion.detected)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || '—',
          },
        ]}
      />

      <EuiSpacer size="s" />
      <EuiFlexGroup gutterSize="s">
        <EuiFlexItem>
          <EuiFieldText
            compressed
            prepend="Owner"
            value={overrides.ownerTeam ?? spec.owner.teams[0] ?? ''}
            onChange={(e) => onOverrideChange({ ownerTeam: e.target.value })}
            placeholder="team"
            aria-label="Owner team"
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiFieldText
            compressed
            prepend="Tier"
            value={overrides.tier ?? spec.tier ?? ''}
            onChange={(e) => onOverrideChange({ tier: e.target.value })}
            placeholder="tier-1"
            aria-label="Tier"
          />
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="xs" />
      <EuiFlexGroup gutterSize="s">
        <EuiFlexItem>
          <EuiFieldNumber
            compressed
            prepend="Target"
            append="%"
            value={
              overrides.target ??
              (objective ? (objective.target * 100).toFixed(2).replace(/\.?0+$/, '') : '99')
            }
            onChange={(e) => onOverrideChange({ target: String(Number(e.target.value) / 100) })}
            min={50}
            max={99.999}
            step={0.01}
            aria-label="Target percentage"
          />
        </EuiFlexItem>
        {isLatency && (
          <EuiFlexItem>
            <EuiFieldNumber
              compressed
              prepend="p95 ≤"
              append={unit === 'milliseconds' ? 'ms' : 's'}
              value={overrides.latencyThreshold ?? String(objective.latencyThreshold)}
              onChange={(e) => onOverrideChange({ latencyThreshold: e.target.value })}
              min={0}
              step={unit === 'milliseconds' ? 10 : 0.01}
              aria-label="Latency threshold"
            />
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
    </EuiPanel>
  );
};
