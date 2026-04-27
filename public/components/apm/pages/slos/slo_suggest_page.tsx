/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Suggest SLOs" page — enumerates the APM services the plugin already sees
 * (same PPL discovery path as Services Home: `useServices`), then drafts a
 * pair of SLOs per service (availability + latency on span-derived RED
 * metrics). The user reviews, tweaks, and creates in one batch.
 *
 * Nothing ships alerting rules until the user clicks "Create N selected";
 * every draft is a harmless client-side object until then.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiAccordion,
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonGroup,
  EuiCallOut,
  EuiCheckbox,
  EuiCode,
  EuiCodeBlock,
  EuiDescriptionList,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiIconTip,
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
import { useHistory } from 'react-router-dom';
import { ChromeStart, HttpStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { useApmConfig } from '../../config/apm_config_context';
import { useServices } from '../../shared/hooks/use_services';
import { parseTimeRange, getTimeInSeconds } from '../../shared/utils/time_utils';
import { PromQLSearchService } from '../../query_services/promql_search_service';
import type {
  GeneratedRuleGroup,
  SloCreateInput,
  SloSummary,
} from '../../../../../common/slo/slo_types';
import type { PromRuleGroup } from '../../../../../common/types/alerting/types';
import type { SloApiClient } from './slo_api_client';
import { templateIconFor } from './template_icons';
import {
  DiscoveredService,
  LabelValuesByMetric,
  MetricLabelValues,
  Suggestion,
  SuggestionKind,
  generateSuggestionsForServices,
} from './suggest_engine';

export interface SloSuggestPageProps {
  apiClient: SloApiClient;
  http: HttpStart;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

// ============================================================================
// Main component
// ============================================================================

export const SloSuggestPage: React.FC<SloSuggestPageProps> = ({
  apiClient,
  chrome,
  http,
  notifications,
  parentBreadcrumb,
}) => {
  const history = useHistory();
  const { config, loading: configLoading } = useApmConfig();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Per-suggestion overrides users type into the card. */
  const [overrides, setOverrides] = useState<
    Record<
      string,
      { ownerTeam?: string; tier?: string; target?: string; latencyThreshold?: string }
    >
  >({});
  const [creating, setCreating] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    chrome.setBreadcrumbs([
      parentBreadcrumb,
      { text: 'SLO/SLI', href: '#/slos' },
      { text: 'Suggest' },
    ]);
  }, [chrome, parentBreadcrumb]);

  // Use the Prometheus datasource the APM config points at — same one the SLO
  // wizard writes SLOs against. Users who want a different datasource edit the
  // APM config rather than picking here.
  const datasourceId = config?.prometheusDataSource?.name ?? '';

  // Same time range as Services Home's default (15m) — discovery is only about
  // "does this service emit traces right now?", not historical enumeration.
  const timeRange = useMemo(() => ({ from: 'now-15m', to: 'now' }), []);
  const parsedTimeRange = useMemo(() => parseTimeRange(timeRange), [timeRange]);

  const { data: services, isLoading: servicesLoading, error: servicesError, refetch } = useServices(
    {
      startTime: parsedTimeRange.startTime,
      endTime: parsedTimeRange.endTime,
    }
  );

  // Prometheus metric universe + label values. Used to decide which OTel
  // detectors fire and to scope each OTel draft to the right label selector.
  // Populated lazily after the APM service list lands.
  const [metricNames, setMetricNames] = useState<string[]>([]);
  const [labelValuesByMetric, setLabelValuesByMetric] = useState<LabelValuesByMetric>({});
  const [existingRuleGroups, setExistingRuleGroups] = useState<PromRuleGroup[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  /** Bumping this triggers the discovery effect; covers the "Rediscover" button. */
  const [discoveryEpoch, setDiscoveryEpoch] = useState(0);

  useEffect(() => {
    if (!datasourceId) {
      setMetricNames([]);
      setLabelValuesByMetric({});
      setExistingRuleGroups([]);
      return;
    }
    let cancelled = false;
    setDiscoveryLoading(true);
    (async () => {
      try {
        // Probe each OTel metric family directly via
        // `/metadata/label-values/<label>?selector={__name__="<metric>"}`.
        // We intentionally skip `/metadata/metrics` and the label/__name__
        // fallback: both are truncated server-side at 200 names (alphabetical),
        // which drops the `http_*`, `rpc_*`, etc. families we need. Probing
        // the bucket/count metric directly bounds the traffic at ~12 requests
        // regardless of TSDB size, and label-values is cached (90s TTL)
        // server-side so follow-up loads are cheap.
        //
        // A family "exists" iff *any* of its probes returns a non-empty label
        // set — that's what the detectors in suggest_engine.ts check too.
        const OTEL_PROBES: Array<{ metric: string; labels: string[] }> = [
          { metric: 'http_server_request_duration_seconds_count', labels: ['service_name', 'job'] },
          {
            metric: 'http_server_request_duration_seconds_bucket',
            labels: ['service_name', 'job'],
          },
          { metric: 'rpc_server_duration_seconds_count', labels: ['rpc_service'] },
          { metric: 'rpc_server_duration_seconds_bucket', labels: ['rpc_service'] },
          {
            metric: 'db_client_operation_duration_seconds_bucket',
            labels: ['service_name', 'job'],
          },
          {
            metric: 'messaging_process_duration_seconds_bucket',
            labels: ['service_name', 'job'],
          },
          {
            metric: 'gen_ai_client_operation_duration_seconds_count',
            labels: ['service_name', 'job'],
          },
        ];
        const labelPromises = OTEL_PROBES.flatMap((probe) =>
          probe.labels.map(async (label) => {
            // Pass `selector` through http.get's `query` option rather than
            // inline in the URL — OSD's http client URL-encodes every
            // reserved char in the path segment, including `?`, which would
            // swallow the selector into the final path component and make
            // the server return empty values.
            const url = `/api/alerting/prometheus/${encodeURIComponent(
              datasourceId
            )}/metadata/label-values/${encodeURIComponent(label)}`;
            try {
              const res = await http.get<{ values: string[] }>(url, {
                query: { selector: `{__name__="${probe.metric}"}` },
              });
              return { metric: probe.metric, label, values: res?.values ?? [] };
            } catch {
              return { metric: probe.metric, label, values: [] as string[] };
            }
          })
        );
        const rulerPromise = http
          .get<{ data?: { groups?: PromRuleGroup[] } }>(
            `/api/alerting/prometheus/${encodeURIComponent(datasourceId)}/rules`
          )
          .catch(() => ({ data: { groups: [] as PromRuleGroup[] } }));

        const [labelResults, rulerRes] = await Promise.all([
          Promise.all(labelPromises),
          rulerPromise,
        ]);
        if (cancelled) return;

        // Aggregate per-metric label values. A metric is considered "present"
        // iff any of its probes returned values — we synthesise the metric
        // name list from that signal so the detectors' `has(metricName)`
        // checks continue to work.
        const labelsByMetric: LabelValuesByMetric = {};
        const presentMetrics = new Set<string>();
        for (const { metric, label, values } of labelResults) {
          const existing: MetricLabelValues = labelsByMetric[metric] ?? {};
          (existing as Record<string, string[]>)[label] = values;
          labelsByMetric[metric] = existing;
          if (values.length > 0) presentMetrics.add(metric);
        }
        setMetricNames([...presentMetrics]);
        setLabelValuesByMetric(labelsByMetric);
        setExistingRuleGroups(rulerRes?.data?.groups ?? []);
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [datasourceId, http, discoveryEpoch]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!datasourceId || !services || services.length === 0) return [];
    const discovered: DiscoveredService[] = services.map((s) => ({
      serviceName: s.serviceName,
      environment: s.environment,
    }));
    return generateSuggestionsForServices({
      datasourceId,
      services: discovered,
      metricNames,
      labelValuesByMetric,
      existingRuleGroups,
    });
  }, [datasourceId, services, metricNames, labelValuesByMetric, existingRuleGroups]);

  // Default every suggestion to "selected" when the list changes — EXCEPT
  // those already covered by an existing Prometheus rule. Users can re-check
  // covered drafts explicitly if they want a duplicate, but the common case
  // is "leave them unchecked so we don't dual-write".
  useEffect(() => {
    setSelected(new Set(suggestions.filter((s) => !s.existingRuleMatch).map((s) => s.key)));
  }, [suggestions]);

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
    setCreating(true);
    const picks = suggestions.filter((s) => selected.has(s.key)).map(applyOverrides);
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
  }, [apiClient, applyOverrides, history, notifications, selected, suggestions]);

  const decoratedSuggestions = suggestions.map(applyOverrides);
  const selectedCount = decoratedSuggestions.filter((s) => selected.has(s.key)).length;
  const totalRules = decoratedSuggestions
    .filter((s) => selected.has(s.key))
    .reduce((acc, s) => acc + s.estimatedRuleCount, 0);
  const coveredCount = decoratedSuggestions.filter((s) => s.existingRuleMatch).length;
  // The service list comes from APM discovery but an OTel-only service (one
  // that emits direct metrics without span-derived RED) can still surface a
  // draft. Union both sources so those services render their own accordion.
  const serviceNameSet = new Set<string>();
  for (const s of services ?? []) {
    if (s.serviceName) serviceNameSet.add(s.serviceName);
  }
  for (const s of decoratedSuggestions) {
    if (s.input.spec.service) serviceNameSet.add(s.input.spec.service);
  }
  const uniqueServices = Array.from(serviceNameSet);

  const loading = configLoading || servicesLoading || discoveryLoading;

  const headerActions = [
    <EuiButtonEmpty key="back" iconType="arrowLeft" href="#/slos" size="s">
      Back to SLOs
    </EuiButtonEmpty>,
    <EuiButton
      key="discover"
      size="s"
      iconType="refresh"
      onClick={() => {
        refetch();
        setDiscoveryEpoch((n) => n + 1);
      }}
      isLoading={loading}
      data-test-subj="slosSuggestDiscover"
    >
      Rediscover
    </EuiButton>,
    <EuiButton
      key="create"
      size="s"
      fill
      iconType="plusInCircle"
      color="primary"
      onClick={createSelected}
      isLoading={creating}
      isDisabled={selectedCount === 0 || loading}
      data-test-subj="slosSuggestCreate"
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
            {/* Intro */}
            <EuiPanel>
              <EuiText size="m">
                <h4>Suggest SLOs from APM services</h4>
              </EuiText>
              <EuiSpacer size="s" />
              <EuiText size="s" color="subdued">
                Enumerates services emitting OTel traces through Data Prepper — the same list
                Services Home shows — and drafts an availability and latency SLO for each using
                span-derived RED metrics. When OTel direct-metric histograms (HTTP server, RPC, DB
                client, messaging, GenAI) are present, additional per-service drafts are produced
                alongside the APM pair. Drafts already covered by an existing Prometheus recording
                rule are flagged and left unchecked. Nothing is created (and no alerts will fire)
                until you click <strong>Create</strong>.
              </EuiText>
              {datasourceId && (
                <>
                  <EuiSpacer size="s" />
                  <EuiText size="xs" color="subdued">
                    SLOs will be written against Prometheus datasource{' '}
                    <EuiCode>{datasourceId}</EuiCode>.
                  </EuiText>
                </>
              )}
            </EuiPanel>

            <EuiSpacer size="m" />

            {servicesError && (
              <>
                <EuiCallOut
                  color="danger"
                  iconType="alert"
                  title="Failed to load services"
                  size="s"
                >
                  <EuiText size="s">{servicesError.message}</EuiText>
                </EuiCallOut>
                <EuiSpacer size="m" />
              </>
            )}

            {loading && (
              <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 200 }}>
                <EuiFlexItem grow={false}>
                  <EuiLoadingSpinner size="xl" />
                </EuiFlexItem>
              </EuiFlexGroup>
            )}

            {!loading && !datasourceId && (
              <EuiCallOut
                size="s"
                iconType="iInCircle"
                title="No Prometheus datasource configured"
                color="warning"
              >
                <EuiText size="s">
                  Configure a Prometheus datasource under APM configuration before suggesting SLOs.
                </EuiText>
              </EuiCallOut>
            )}

            {!loading && datasourceId && uniqueServices.length === 0 && !servicesError && (
              <EuiCallOut size="s" iconType="iInCircle" title="No APM services were discovered">
                <EuiText size="s">
                  No services appear to be sending OTel traces right now. If you expect services
                  here, verify the APM trace dataset and window duration under APM configuration.
                </EuiText>
              </EuiCallOut>
            )}

            {!loading && decoratedSuggestions.length > 0 && (
              <>
                <EuiPanel color="subdued">
                  <EuiFlexGroup alignItems="center" responsive={false} gutterSize="m">
                    <EuiFlexItem grow={true}>
                      <EuiText size="s">
                        <strong>{uniqueServices.length}</strong> service
                        {uniqueServices.length === 1 ? '' : 's'} discovered —{' '}
                        <strong>{selectedCount}</strong> of {decoratedSuggestions.length} draft SLOs
                        selected. Clicking <strong>Create</strong> will provision{' '}
                        <strong>{totalRules}</strong> Prometheus rules in namespace{' '}
                        <EuiCode>slo-generated</EuiCode>.
                        {coveredCount > 0 && (
                          <>
                            {' '}
                            <strong>{coveredCount}</strong> draft{coveredCount === 1 ? '' : 's'}{' '}
                            {coveredCount === 1 ? 'is' : 'are'} already covered by an existing
                            Prometheus rule and left unchecked by default.
                          </>
                        )}
                      </EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiFlexGroup gutterSize="s" responsive={false}>
                        <EuiFlexItem grow={false}>
                          <EuiButtonEmpty
                            size="s"
                            onClick={() =>
                              setSelected(new Set(decoratedSuggestions.map((s) => s.key)))
                            }
                          >
                            Select all
                          </EuiButtonEmpty>
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiButtonEmpty size="s" onClick={() => setSelected(new Set())}>
                            Clear
                          </EuiButtonEmpty>
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiButton
                            size="s"
                            iconType={showPreview ? 'eyeClosed' : 'eye'}
                            onClick={() => setShowPreview((v) => !v)}
                            isDisabled={selectedCount === 0}
                            data-test-subj="slosSuggestPreviewToggle"
                          >
                            {showPreview ? 'Hide preview' : `Preview ${selectedCount} selected`}
                          </EuiButton>
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                </EuiPanel>
                <EuiSpacer size="m" />

                {showPreview && selectedCount > 0 && (
                  <>
                    <BatchPreviewSection
                      apiClient={apiClient}
                      selectedSuggestions={decoratedSuggestions.filter((s) => selected.has(s.key))}
                      prometheusConnectionId={config?.prometheusDataSource?.name}
                      prometheusConnectionMeta={config?.prometheusDataSource?.meta}
                    />
                    <EuiSpacer size="m" />
                  </>
                )}
                {/* Group cards by service so availability + latency render together.
                    Each service collapses into an accordion — users expand only
                    the services they want to review in detail. */}
                {uniqueServices.map((serviceName) => {
                  const perService = decoratedSuggestions.filter(
                    (s) => s.input.spec.service === serviceName
                  );
                  if (perService.length === 0) return null;
                  const environment = perService[0].detected.environment;
                  const serviceSelected = perService.filter((s) => selected.has(s.key)).length;
                  const selectionColor =
                    serviceSelected === perService.length
                      ? 'primary'
                      : serviceSelected === 0
                      ? 'hollow'
                      : 'accent';
                  const accordionButton = (
                    <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false} wrap>
                      <EuiFlexItem grow={false}>
                        <EuiText size="s">
                          <strong>{serviceName}</strong>
                        </EuiText>
                      </EuiFlexItem>
                      {environment && (
                        <EuiFlexItem grow={false}>
                          <EuiBadge color="hollow">{environment}</EuiBadge>
                        </EuiFlexItem>
                      )}
                      <EuiFlexItem grow={false}>
                        <EuiBadge color={selectionColor}>
                          {serviceSelected} / {perService.length} selected
                        </EuiBadge>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                  );
                  return (
                    <EuiAccordion
                      key={serviceName}
                      id={`slosSuggestService-${serviceName}`}
                      buttonContent={accordionButton}
                      paddingSize="s"
                      initialIsOpen={false}
                      data-test-subj={`slosSuggestServiceAccordion-${serviceName}`}
                    >
                      <EuiFlexGroup wrap gutterSize="m">
                        {perService.map((s) => (
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
                      <EuiSpacer size="s" />
                    </EuiAccordion>
                  );
                })}
              </>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};

// ============================================================================
// Inline suggestion row — a compact, single-line-ish layout used inside the
// service tree table's expanded-row area. Replaces the wider `SuggestionCard`
// for that context: checkbox · name · kind · rules · covered badge · inline
// owner/tier/target/p95 override fields. The long `reason` blurb and
// rule-match details move into tooltips so the row stays compact on a 19-
// services × N-drafts page.
// ============================================================================

interface OverrideValues {
  ownerTeam?: string;
  tier?: string;
  target?: string;
  latencyThreshold?: string;
}

type OverridePatch = Partial<{
  ownerTeam: string;
  tier: string;
  target: string;
  latencyThreshold: string;
}>;

/** Derive a listing-shaped projection so we can reuse `templateIconFor`. */
function suggestionIconType(s: Suggestion): string {
  const sli = s.input.spec.sli;
  const sliBackend = sli.type === 'single' ? sli.definition.backend : undefined;
  const sliLeafType =
    sli.type === 'single' ? (sli.definition as { type?: string }).type ?? undefined : undefined;
  const projection = {
    sliNodeType: sli.type === 'single' ? 'single' : 'composite',
    sliBackend,
    sliLeafType,
  } as Partial<SloSummary>;
  return templateIconFor(projection as SloSummary);
}

interface SuggestionInlineRowProps {
  suggestion: Suggestion;
  selected: boolean;
  onToggle: () => void;
  overrides: OverrideValues;
  onOverrideChange: (patch: OverridePatch) => void;
  /** Render status — used by the batch-create progress strip. */
  rowStatus?: 'pending' | 'creating' | 'success' | 'error';
  rowStatusMessage?: string;
}

export const SuggestionInlineRow: React.FC<SuggestionInlineRowProps> = ({
  suggestion,
  selected,
  onToggle,
  overrides,
  onOverrideChange,
  rowStatus,
  rowStatusMessage,
}) => {
  const spec = suggestion.input.spec;
  const objective = spec.objectives[0];
  const isLatency = objective?.latencyThreshold !== undefined;
  const unit =
    spec.sli.type === 'single' &&
    spec.sli.definition.backend === 'prometheus' &&
    spec.sli.definition.type === 'latency_threshold'
      ? spec.sli.definition.latencyThresholdUnit ?? 'seconds'
      : 'seconds';
  const isCovered = Boolean(suggestion.existingRuleMatch);
  const fadedOut = isCovered && !selected;
  const disableCheckbox = rowStatus === 'creating' || rowStatus === 'success';

  const coveredTooltip = suggestion.existingRuleMatch
    ? `Matched: ${suggestion.existingRuleMatch.groupName} / ${
        suggestion.existingRuleMatch.ruleName
      }${
        suggestion.existingRuleMatch.sloId ? ` (SLO ${suggestion.existingRuleMatch.sloId})` : ''
      }. Unchecked to avoid dual-writing.`
    : '';

  return (
    <EuiPanel
      color={selected ? 'primary' : 'plain'}
      paddingSize="s"
      hasBorder
      style={{
        marginBottom: 8,
        opacity: fadedOut ? 0.75 : 1,
      }}
      data-test-subj={`slosSuggestInlineRow-${suggestion.key}`}
    >
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          {rowStatus === 'creating' ? (
            <EuiLoadingSpinner
              size="m"
              data-test-subj={`slosSuggestRowStatus-${suggestion.key}-creating`}
            />
          ) : rowStatus === 'success' ? (
            <EuiIcon
              type="check"
              color="success"
              data-test-subj={`slosSuggestRowStatus-${suggestion.key}-success`}
            />
          ) : rowStatus === 'error' ? (
            <EuiIconTip
              type="alert"
              color="danger"
              content={rowStatusMessage ?? 'Create failed.'}
              data-test-subj={`slosSuggestRowStatus-${suggestion.key}-error`}
            />
          ) : (
            <EuiCheckbox
              id={`slosSuggestSelect-${suggestion.key}`}
              checked={selected}
              onChange={onToggle}
              disabled={disableCheckbox}
              data-test-subj={`slosSuggestSelect-${suggestion.key}`}
            />
          )}
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiIcon type={suggestionIconType(suggestion)} color="subdued" />
        </EuiFlexItem>
        <EuiFlexItem grow={true}>
          <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiToolTip content={suggestion.reason} position="top">
                <EuiText size="s">
                  <strong>{spec.name}</strong>
                </EuiText>
              </EuiToolTip>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">{suggestion.kind}</EuiBadge>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">{suggestion.estimatedRuleCount} rules</EuiBadge>
            </EuiFlexItem>
            {isCovered && (
              <EuiFlexItem grow={false}>
                <EuiToolTip content={coveredTooltip} position="top">
                  <EuiBadge
                    color="warning"
                    iconType="check"
                    data-test-subj={`slosSuggestCovered-${suggestion.key}`}
                  >
                    covered by existing rule
                  </EuiBadge>
                </EuiToolTip>
              </EuiFlexItem>
            )}
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="xs" />
      {/* Inline override strip — same field shapes as the card, just laid out
          in a single row instead of two. */}
      <EuiFlexGroup gutterSize="s" responsive={false} wrap>
        <EuiFlexItem style={{ minWidth: 160 }}>
          <EuiFieldText
            compressed
            prepend="Owner"
            value={overrides.ownerTeam ?? spec.owner.teams[0] ?? ''}
            onChange={(e) => onOverrideChange({ ownerTeam: e.target.value })}
            placeholder="team"
            aria-label="Owner team"
          />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 120 }}>
          <EuiFieldText
            compressed
            prepend="Tier"
            value={overrides.tier ?? spec.tier ?? ''}
            onChange={(e) => onOverrideChange({ tier: e.target.value })}
            placeholder="tier-1"
            aria-label="Tier"
          />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 120 }}>
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
          <EuiFlexItem style={{ minWidth: 120 }}>
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
      data-test-subj={`slosSuggestCard-${suggestion.key}`}
    >
      <EuiFlexGroup gutterSize="s" alignItems="flexStart" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiCheckbox
            id={`slosSuggestSelect-${suggestion.key}`}
            checked={selected}
            onChange={onToggle}
            data-test-subj={`slosSuggestSelect-${suggestion.key}`}
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
            {suggestion.existingRuleMatch && (
              <EuiFlexItem grow={false}>
                <EuiBadge
                  color="warning"
                  iconType="check"
                  title={`Matching recording rule: ${suggestion.existingRuleMatch.groupName} / ${suggestion.existingRuleMatch.ruleName}`}
                  data-test-subj={`slosSuggestCovered-${suggestion.key}`}
                >
                  covered by existing rule
                </EuiBadge>
              </EuiFlexItem>
            )}
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="s" />
      <EuiText size="xs" color="subdued">
        {suggestion.reason}
        {suggestion.existingRuleMatch && (
          <>
            {' '}
            Already covered by <EuiCode>{suggestion.existingRuleMatch.ruleName}</EuiCode> in rule
            group <EuiCode>{suggestion.existingRuleMatch.groupName}</EuiCode>
            {suggestion.existingRuleMatch.sloId
              ? ` (SLO ${suggestion.existingRuleMatch.sloId})`
              : ''}
            . Leave unchecked to avoid dual-writing.
          </>
        )}
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

// ============================================================================
// Batch preview — renders the Prometheus rule group each selected draft would
// deploy. Calls `apiClient.preview` in parallel per draft so failures are
// per-SLO rather than aggregate. The server runs the same generator the
// Create path uses, so what appears here is exactly what will land in the
// ruler.
// ============================================================================

interface PerPreview {
  key: string;
  suggestion: Suggestion;
  status: 'loading' | 'success' | 'error';
  group?: GeneratedRuleGroup;
  error?: string;
}

/** Live SLI signal computed against the current Prometheus datasource. */
interface LiveSli {
  /** current SLI value in [0, 1] (availability fraction or fraction-under-threshold). */
  sliRatio?: number;
  /** total samples / requests observed in the window. */
  totalSamples?: number;
  /** observed p99 in milliseconds, only for latency_seconds_bucket-backed drafts. */
  p99Ms?: number;
  status: 'loading' | 'success' | 'error' | 'skipped';
  error?: string;
}

type WindowOption = '1h' | '24h' | '7d';

const WINDOW_OPTIONS = [
  { id: '1h', label: '1h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
] as const;

const BatchPreviewSection: React.FC<{
  apiClient: Pick<SloApiClient, 'preview'>;
  selectedSuggestions: Suggestion[];
  prometheusConnectionId?: string;
  prometheusConnectionMeta?: Record<string, unknown>;
}> = ({ apiClient, selectedSuggestions, prometheusConnectionId, prometheusConnectionMeta }) => {
  const [windowChoice, setWindowChoice] = useState<WindowOption>('24h');

  // Serialize the selected inputs so effect re-runs only when the *content*
  // changes (override typing → new JSON → refetch). Reference equality of
  // the array would refetch every render.
  const serializedInputs = useMemo(
    () =>
      selectedSuggestions.map((s) => ({
        key: s.key,
        suggestion: s,
        body: JSON.stringify(s.input),
      })),
    [selectedSuggestions]
  );
  const serializedKey = useMemo(
    () => serializedInputs.map((r) => `${r.key}::${r.body}`).join('||'),
    [serializedInputs]
  );

  const [previews, setPreviews] = useState<PerPreview[]>([]);
  const [liveByKey, setLiveByKey] = useState<Record<string, LiveSli>>({});

  // --- Rule-group preview (server-generated YAML) ---
  useEffect(() => {
    let cancelled = false;
    setPreviews(
      serializedInputs.map((r) => ({
        key: r.key,
        suggestion: r.suggestion,
        status: 'loading',
      }))
    );
    Promise.all(
      serializedInputs.map(async (r) => {
        try {
          const group = await apiClient.preview(JSON.parse(r.body) as SloCreateInput);
          return {
            key: r.key,
            suggestion: r.suggestion,
            status: 'success' as const,
            group,
          };
        } catch (e) {
          return {
            key: r.key,
            suggestion: r.suggestion,
            status: 'error' as const,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      })
    ).then((results) => {
      if (!cancelled) setPreviews(results);
    });
    return () => {
      cancelled = true;
    };
    // serializedKey gates re-fetch; serializedInputs is the payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, serializedKey]);

  // --- Live SLI signals ---
  const promqlService = useMemo(() => {
    if (!prometheusConnectionId) return null;
    return new PromQLSearchService(prometheusConnectionId, prometheusConnectionMeta);
  }, [prometheusConnectionId, prometheusConnectionMeta]);

  useEffect(() => {
    if (!promqlService) {
      // Mark every row as skipped so the UI shows "–" instead of a spinner.
      const skipped: Record<string, LiveSli> = {};
      for (const r of serializedInputs) skipped[r.key] = { status: 'skipped' };
      setLiveByKey(skipped);
      return;
    }
    let cancelled = false;
    // Seed loading state for every row.
    const loading: Record<string, LiveSli> = {};
    for (const r of serializedInputs) loading[r.key] = { status: 'loading' };
    setLiveByKey(loading);

    const evalTime = getTimeInSeconds(new Date());
    serializedInputs.forEach((r) => {
      const kind = liveKindFor(r.suggestion);
      if (!kind) {
        setLiveByKey((prev) => ({ ...prev, [r.key]: { status: 'skipped' } }));
        return;
      }
      const queries = buildLiveQueries(kind, r.suggestion, windowChoice);
      Promise.all(
        queries.map((q) =>
          promqlService
            .executeInstantQuery({ query: q, time: evalTime })
            .then((resp) => extractScalar(resp))
            .catch(() => undefined)
        )
      ).then((values) => {
        if (cancelled) return;
        const [ratio, samples, p99Ms] = values;
        setLiveByKey((prev) => ({
          ...prev,
          [r.key]: {
            status: 'success',
            sliRatio: Number.isFinite(ratio ?? NaN) ? (ratio as number) : undefined,
            totalSamples: Number.isFinite(samples ?? NaN) ? (samples as number) : undefined,
            p99Ms: Number.isFinite(p99Ms ?? NaN) ? (p99Ms as number) : undefined,
          },
        }));
      });
    });
    return () => {
      cancelled = true;
    };
    // serializedKey/windowChoice gate re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promqlService, serializedKey, windowChoice]);

  const totalRuleCount = previews
    .filter((p) => p.status === 'success')
    .reduce((acc, p) => acc + (p.group?.rules.length ?? 0), 0);
  const successCount = previews.filter((p) => p.status === 'success').length;
  const errorCount = previews.filter((p) => p.status === 'error').length;
  const loadingCount = previews.filter((p) => p.status === 'loading').length;
  const breachCount = previews.reduce((acc, p) => {
    const live = liveByKey[p.key];
    if (live?.status !== 'success') return acc;
    if (!(typeof live.totalSamples === 'number' && live.totalSamples > 0)) return acc;
    const obj = p.suggestion.input.spec.objectives[0];
    // Latency objectives: compare observed p99 to the bound.
    if (typeof obj?.latencyThreshold === 'number') {
      return typeof live.p99Ms === 'number' && live.p99Ms > obj.latencyThreshold * 1000
        ? acc + 1
        : acc;
    }
    // Availability objectives: compare SLI to target fraction.
    return typeof live.sliRatio === 'number' &&
      typeof obj?.target === 'number' &&
      live.sliRatio < obj.target
      ? acc + 1
      : acc;
  }, 0);

  return (
    <EuiPanel data-test-subj="slosSuggestPreview">
      <EuiFlexGroup alignItems="flexStart" responsive={false} gutterSize="s">
        <EuiFlexItem grow={true}>
          <EuiText size="m">
            <h4>Preview</h4>
          </EuiText>
          <EuiText size="s" color="subdued">
            Rule groups that will be deployed on Create — plus the current SLI evaluated against the
            APM Prometheus datasource. A red <strong>breaching</strong> badge means the draft would
            already be firing, making it a good candidate to create and investigate.
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                Evaluate over
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="SLI evaluation window"
                idSelected={windowChoice}
                onChange={(id) => setWindowChoice(id as WindowOption)}
                options={[...WINDOW_OPTIONS]}
                buttonSize="compressed"
                data-test-subj="slosSuggestPreviewWindow"
              />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="xs" />
          <EuiFlexGroup gutterSize="xs" responsive={false} wrap justifyContent="flexEnd">
            {loadingCount > 0 && (
              <EuiFlexItem grow={false}>
                <EuiBadge color="hollow">{loadingCount} loading</EuiBadge>
              </EuiFlexItem>
            )}
            <EuiFlexItem grow={false}>
              <EuiBadge color="primary">{successCount} previewed</EuiBadge>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiBadge color="primary">{totalRuleCount} rules total</EuiBadge>
            </EuiFlexItem>
            {breachCount > 0 && (
              <EuiFlexItem grow={false}>
                <EuiBadge color="danger">{breachCount} breaching</EuiBadge>
              </EuiFlexItem>
            )}
            {errorCount > 0 && (
              <EuiFlexItem grow={false}>
                <EuiBadge color="danger">{errorCount} failed</EuiBadge>
              </EuiFlexItem>
            )}
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {previews.length === 0 ? (
        <EuiText size="s" color="subdued">
          Select at least one draft to preview.
        </EuiText>
      ) : (
        previews.map((p) => (
          <PreviewRow
            key={p.key}
            preview={p}
            live={liveByKey[p.key] ?? { status: 'loading' }}
            windowChoice={windowChoice}
          />
        ))
      )}
    </EuiPanel>
  );
};

const PreviewRow: React.FC<{
  preview: PerPreview;
  live: LiveSli;
  windowChoice: WindowOption;
}> = ({ preview, live, windowChoice }) => {
  const { suggestion, status, group, error } = preview;
  const spec = suggestion.input.spec;
  const target = spec.objectives[0]?.target;
  const latencyBoundSec = spec.objectives[0]?.latencyThreshold;
  const isLatencyObjective = typeof latencyBoundSec === 'number';
  const hasSli = typeof live.sliRatio === 'number';
  // Only flag breaching when we actually observed traffic in the window;
  // zero samples means "no data yet", not "the SLO is firing".
  const hasTraffic = typeof live.totalSamples === 'number' && live.totalSamples > 0;
  // For latency objectives, span-derived histogram buckets aren't cumulative,
  // so the fraction-under-threshold SLI is unreliable. Flag breaching when the
  // observed p99 exceeds the template's latency bound instead.
  const breaching = isLatencyObjective
    ? live.status === 'success' &&
      hasTraffic &&
      typeof live.p99Ms === 'number' &&
      live.p99Ms > latencyBoundSec! * 1000
    : live.status === 'success' &&
      hasSli &&
      hasTraffic &&
      typeof target === 'number' &&
      live.sliRatio! < target;
  return (
    <EuiPanel
      color="subdued"
      paddingSize="s"
      hasBorder
      style={{ marginBottom: 8 }}
      data-test-subj={`slosSuggestPreviewRow-${suggestion.key}`}
    >
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
        <EuiFlexItem grow={true}>
          <EuiText size="s">
            <strong>{spec.name}</strong>
          </EuiText>
          <EuiFlexGroup gutterSize="xs" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">{suggestion.kind}</EuiBadge>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                {spec.objectives[0]?.name} · target{' '}
                {(spec.objectives[0]?.target * 100).toFixed(2).replace(/\.?0+$/, '')}%
                {spec.objectives[0]?.latencyThreshold !== undefined
                  ? ` · ≤ ${spec.objectives[0].latencyThreshold}s`
                  : ''}
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          {status === 'loading' && <EuiLoadingSpinner size="m" />}
          {status === 'success' && group && (
            <EuiBadge color="primary">
              {group.rules.length} {group.rules.length === 1 ? 'rule' : 'rules'}
            </EuiBadge>
          )}
          {status === 'error' && <EuiBadge color="danger">preview failed</EuiBadge>}
        </EuiFlexItem>
      </EuiFlexGroup>

      {/* Live signal row — always visible when we have (or are fetching) live data. */}
      {live.status !== 'skipped' && (
        <>
          <EuiSpacer size="xs" />
          <EuiFlexGroup
            gutterSize="xs"
            alignItems="center"
            responsive={false}
            wrap
            data-test-subj={`slosSuggestPreviewLive-${suggestion.key}`}
          >
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                Over last {windowChoice}:
              </EuiText>
            </EuiFlexItem>
            {live.status === 'loading' && (
              <EuiFlexItem grow={false}>
                <EuiLoadingSpinner size="s" />
              </EuiFlexItem>
            )}
            {live.status === 'success' && (
              <>
                {/* Availability templates: show the observed SLI fraction.
                    Latency templates skip this — Data Prepper span-derived
                    buckets aren't cumulative so the ratio isn't reliable. */}
                {!isLatencyObjective && hasSli && (
                  <EuiFlexItem grow={false}>
                    <EuiBadge color={breaching ? 'danger' : 'success'}>
                      SLI {(live.sliRatio! * 100).toFixed(2).replace(/\.?0+$/, '')}%
                    </EuiBadge>
                  </EuiFlexItem>
                )}
                {typeof live.p99Ms === 'number' && (
                  <EuiFlexItem grow={false}>
                    <EuiBadge
                      color={isLatencyObjective ? (breaching ? 'danger' : 'success') : 'hollow'}
                    >
                      p99 {live.p99Ms.toFixed(0)} ms
                      {isLatencyObjective
                        ? ` vs ${((latencyBoundSec as number) * 1000).toFixed(0)} ms`
                        : ''}
                    </EuiBadge>
                  </EuiFlexItem>
                )}
                {breaching && (
                  <EuiFlexItem grow={false}>
                    <EuiBadge color="danger" iconType="alert">
                      breaching
                    </EuiBadge>
                  </EuiFlexItem>
                )}
                {typeof live.totalSamples === 'number' && (
                  <EuiFlexItem grow={false}>
                    <EuiBadge color="hollow">{formatSamples(live.totalSamples)} samples</EuiBadge>
                  </EuiFlexItem>
                )}
                {!hasSli &&
                  typeof live.p99Ms !== 'number' &&
                  typeof live.totalSamples !== 'number' && (
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued">
                        no data in window
                      </EuiText>
                    </EuiFlexItem>
                  )}
              </>
            )}
            {live.status === 'error' && (
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  live metrics unavailable
                </EuiText>
              </EuiFlexItem>
            )}
          </EuiFlexGroup>
        </>
      )}

      {status === 'error' && (
        <>
          <EuiSpacer size="xs" />
          <EuiCallOut
            size="s"
            color="warning"
            iconType="alert"
            title="Preview unavailable"
            data-test-subj={`slosSuggestPreviewError-${suggestion.key}`}
          >
            <EuiText size="xs">{error ?? 'Unable to generate preview.'}</EuiText>
          </EuiCallOut>
        </>
      )}
      {status === 'success' && group && (
        <>
          <EuiSpacer size="xs" />
          <EuiAccordion
            id={`slosSuggestPreviewYaml-${suggestion.key}`}
            buttonContent={
              <EuiText size="xs">
                Show rule group <EuiCode>{group.groupName}</EuiCode> (eval interval {group.interval}
                s)
              </EuiText>
            }
            paddingSize="s"
            data-test-subj={`slosSuggestPreviewYamlToggle-${suggestion.key}`}
          >
            <EuiCodeBlock
              language="yaml"
              paddingSize="s"
              isCopyable
              overflowHeight={320}
              data-test-subj={`slosSuggestPreviewYaml-${suggestion.key}`}
            >
              {group.yaml}
            </EuiCodeBlock>
          </EuiAccordion>
        </>
      )}
    </EuiPanel>
  );
};

// ============================================================================
// Live-SLI query builders
//
// APM span-derived metrics are gauges, so we aggregate with sum_over_time over
// the selected window before taking the ratio (see use_services_red_metrics.ts
// for the same pattern). OTel direct-metric families are true counters /
// cumulative histograms, so those queries use rate() and histogram_quantile()
// directly — no sum_over_time wrap.
//
// Every builder returns [ratio, samples, p99Ms]:
//   - ratio   : SLI fraction in [0,1]; "vector(0) unless vector(1)" means
//               "emit nothing", and the UI renders only p99 + samples.
//   - samples : total observations in the window (used for "no data yet"
//               gating).
//   - p99Ms   : observed p99 in milliseconds when meaningful, else a
//               no-emit expression so the UI shows "—".
// ============================================================================

/**
 * A deliberately no-op query — Prometheus returns no samples, `extractScalar`
 * produces `undefined`, and the UI treats the slot as missing. Used when a
 * builder doesn't have a sensible ratio or p99 to report for the kind.
 */
const LIVE_NO_EMIT = 'vector(0) unless vector(1)';

function liveKindFor(s: Suggestion): SuggestionKind | null {
  return s.kindId;
}

function buildLiveQueries(
  kind: SuggestionKind,
  suggestion: Suggestion,
  win: WindowOption
): [string, string, string] {
  switch (kind) {
    case 'apm-availability':
      return buildApmAvailabilityQueries(suggestion.input.spec.service, win);
    case 'apm-latency':
      return buildApmLatencyQueries(suggestion.input.spec.service, win);
    case 'http-availability':
      return buildHttpAvailabilityQueries(suggestion, win);
    case 'http-latency':
      return buildHttpLatencyQueries(suggestion, win);
    case 'rpc-availability':
      return buildRpcAvailabilityQueries(suggestion.input.spec.service, win);
    case 'rpc-latency':
      return buildRpcLatencyQueries(suggestion.input.spec.service, win);
    case 'db-latency':
      return buildDbLatencyQueries(suggestion, win);
    case 'messaging-latency':
      return buildMessagingLatencyQueries(suggestion, win);
    case 'genai-availability':
      return buildGenAiAvailabilityQueries(suggestion, win);
  }
}

// --- APM span-derived (gauges) ---

function buildApmAvailabilityQueries(service: string, win: WindowOption): [string, string, string] {
  const selector = `service="${service}",remoteService="",namespace="span_derived"`;
  const ratio =
    `(sum(sum_over_time(request{${selector}}[${win}])) - sum(sum_over_time(fault{${selector}}[${win}]))) ` +
    `/ sum(sum_over_time(request{${selector}}[${win}]))`;
  const samples = `sum(sum_over_time(request{${selector}}[${win}]))`;
  const p99 = `histogram_quantile(0.99, sum by (le)(sum_over_time(latency_seconds_bucket{${selector}}[${win}]))) * 1000`;
  return [ratio, samples, p99];
}

function buildApmLatencyQueries(service: string, win: WindowOption): [string, string, string] {
  // Data Prepper's span-derived histogram buckets are NOT cumulative — each
  // `le` series reports observations in the bucket range, not "≤ le". The raw
  // bucket-based fraction-under-threshold SLI is unreliable here, so we only
  // emit observed p99; the UI compares it against the template's bound.
  const selector = `service="${service}",remoteService="",namespace="span_derived"`;
  const p99 = `histogram_quantile(0.99, sum by (le)(sum_over_time(latency_seconds_bucket{${selector}}[${win}]))) * 1000`;
  const samples = `sum(sum_over_time(latency_seconds_count{${selector}}[${win}]))`;
  return [LIVE_NO_EMIT, samples, p99];
}

// --- OTel HTTP server (true counters) ---

/**
 * Rebuild the OTel service selector from the dimension the engine stamped on
 * the draft. Returns the raw PromQL fragment, e.g. `service_name="checkout"`
 * or `job="opentelemetry-demo/checkout"`.
 */
function otelDimensionSelector(suggestion: Suggestion): string {
  const dims =
    suggestion.input.spec.sli.type === 'single' ? suggestion.input.spec.sli.dimensions : [];
  const parts = dims.filter((d) => d.value).map((d) => `${d.name}="${d.value}"`);
  // Fallback: scope to the spec's service field via `service_name`. Better to
  // over-match than to emit an unscoped aggregate.
  if (parts.length === 0 && suggestion.input.spec.service) {
    parts.push(`service_name="${suggestion.input.spec.service}"`);
  }
  return parts.join(',');
}

function buildHttpAvailabilityQueries(
  suggestion: Suggestion,
  win: WindowOption
): [string, string, string] {
  const metric = 'http_server_request_duration_seconds_count';
  const bucketMetric = 'http_server_request_duration_seconds_bucket';
  const selector = otelDimensionSelector(suggestion);
  const ratio =
    `sum(rate(${metric}{${selector},http_response_status_code!~"5.."}[${win}])) ` +
    `/ sum(rate(${metric}{${selector}}[${win}]))`;
  const samples = `sum(increase(${metric}{${selector}}[${win}]))`;
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${bucketMetric}{${selector}}[${win}]))) * 1000`;
  return [ratio, samples, p99];
}

function buildHttpLatencyQueries(
  suggestion: Suggestion,
  win: WindowOption
): [string, string, string] {
  const metric = 'http_server_request_duration_seconds_bucket';
  const countMetric = 'http_server_request_duration_seconds_count';
  const selector = otelDimensionSelector(suggestion);
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${metric}{${selector}}[${win}]))) * 1000`;
  const samples = `sum(increase(${countMetric}{${selector}}[${win}]))`;
  // OTel histograms ARE cumulative so a bucket-ratio is actually sound, but
  // the UI already handles latency via p99-vs-bound comparison. Keep ratio
  // no-emit for symmetry with APM latency.
  return [LIVE_NO_EMIT, samples, p99];
}

// --- OTel RPC (true counters) ---

function buildRpcAvailabilityQueries(
  rpcService: string,
  win: WindowOption
): [string, string, string] {
  const metric = 'rpc_server_duration_seconds_count';
  const bucketMetric = 'rpc_server_duration_seconds_bucket';
  const selector = `rpc_service="${rpcService}"`;
  const ratio =
    `sum(rate(${metric}{${selector},rpc_grpc_status_code="0"}[${win}])) ` +
    `/ sum(rate(${metric}{${selector}}[${win}]))`;
  const samples = `sum(increase(${metric}{${selector}}[${win}]))`;
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${bucketMetric}{${selector}}[${win}]))) * 1000`;
  return [ratio, samples, p99];
}

function buildRpcLatencyQueries(rpcService: string, win: WindowOption): [string, string, string] {
  const metric = 'rpc_server_duration_seconds_bucket';
  const countMetric = 'rpc_server_duration_seconds_count';
  const selector = `rpc_service="${rpcService}"`;
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${metric}{${selector}}[${win}]))) * 1000`;
  const samples = `sum(increase(${countMetric}{${selector}}[${win}]))`;
  return [LIVE_NO_EMIT, samples, p99];
}

// --- OTel DB / messaging / GenAI ---

function buildDbLatencyQueries(
  suggestion: Suggestion,
  win: WindowOption
): [string, string, string] {
  const metric = 'db_client_operation_duration_seconds_bucket';
  const countMetric = 'db_client_operation_duration_seconds_count';
  const selector = otelDimensionSelector(suggestion);
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${metric}{${selector}}[${win}]))) * 1000`;
  const samples = `sum(increase(${countMetric}{${selector}}[${win}]))`;
  return [LIVE_NO_EMIT, samples, p99];
}

function buildMessagingLatencyQueries(
  suggestion: Suggestion,
  win: WindowOption
): [string, string, string] {
  const metric = 'messaging_process_duration_seconds_bucket';
  const countMetric = 'messaging_process_duration_seconds_count';
  const selector = otelDimensionSelector(suggestion);
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${metric}{${selector}}[${win}]))) * 1000`;
  const samples = `sum(increase(${countMetric}{${selector}}[${win}]))`;
  return [LIVE_NO_EMIT, samples, p99];
}

function buildGenAiAvailabilityQueries(
  suggestion: Suggestion,
  win: WindowOption
): [string, string, string] {
  const metric = 'gen_ai_client_operation_duration_seconds_count';
  const bucketMetric = 'gen_ai_client_operation_duration_seconds_bucket';
  const selector = otelDimensionSelector(suggestion);
  const ratio =
    `sum(rate(${metric}{${selector},error_type=""}[${win}])) ` +
    `/ sum(rate(${metric}{${selector}}[${win}]))`;
  const samples = `sum(increase(${metric}{${selector}}[${win}]))`;
  // GenAI instrumentation often omits the bucket — emit the query anyway; if
  // the metric isn't present Cortex returns no samples and the UI shows "—".
  const p99 = `histogram_quantile(0.99, sum by (le)(rate(${bucketMetric}{${selector}}[${win}]))) * 1000`;
  return [ratio, samples, p99];
}

/**
 * PromQL instant query response unwrap. The query-enhancements response shape
 * is either a data-frame (`{ fields: [...] }`) or a Prometheus-native result
 * (`{ result: [{ value: [t, v] }] }`); both shapes surface scalar values.
 */
function extractScalar(resp: unknown): number | undefined {
  if (!resp || typeof resp !== 'object') return undefined;
  const r = resp as {
    fields?: Array<{ name: string; values: unknown[] }>;
    data?: { result?: Array<{ value?: [number, string] }> };
    result?: Array<{ value?: [number, string] }>;
    meta?: { instantData?: { rows?: Array<{ Value?: string | number }> } };
  };
  // Data-frame shape (query-enhancements default).
  const valueField = r.fields?.find((f) => f.name === 'Value');
  if (valueField && Array.isArray(valueField.values) && valueField.values.length > 0) {
    const raw = valueField.values[0];
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  // Prometheus-native instant query shape.
  const vec = r.data?.result ?? r.result;
  if (Array.isArray(vec) && vec.length > 0 && Array.isArray(vec[0].value)) {
    const n = Number(vec[0].value[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  // Query-enhancements instant-data fallback.
  const rows = r.meta?.instantData?.rows;
  if (Array.isArray(rows) && rows.length > 0) {
    const n = Number(rows[0].Value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function formatSamples(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return Math.round(n).toString();
}
