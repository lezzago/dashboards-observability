/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  EuiAccordion,
  EuiBadge,
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiConfirmModal,
  EuiDescriptionList,
  EuiEmptyPrompt,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiLoadingSpinner,
  EuiPage,
  EuiPageBody,
  EuiPageContent,
  EuiPageContentBody,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { euiThemeVars } from '@osd/ui-shared-deps/theme';
import { useHistory, useParams } from 'react-router-dom';
import { ChromeStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { TimeRangePicker } from '../../shared/components/time_filter';
import { TimeRange } from '../../common/types/service_types';
import { SloVisualizations } from './slo_visualizations';
import { SloMetadataPanel } from './slo_metadata_panel';
import type { SloApiClient } from './slo_api_client';
import type {
  Objective,
  SloDocument,
  SloLiveStatus,
  SloSummary,
} from '../../../../../common/slo/slo_types';
import { getSloHealthColor } from '../../../../../common/slo/state';
import { formatPct } from '../../../../../common/slo/format';
import { templateIconFor } from './template_icons';

export interface SloDetailPageProps {
  apiClient: SloApiClient;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

type FullDoc = SloDocument & { liveStatus: SloLiveStatus };

/** Strip trailing zeros from a target/attainment percentage for compact rendering. */
function formatTightPct(value: number, decimals = 3): string {
  return formatPct(value, { decimals }).replace(/\.?0+%$/, '%');
}

function describeWindow(slo: SloDocument): string {
  return slo.spec.window.type === 'rolling'
    ? `rolling ${slo.spec.window.duration}`
    : `calendar (${slo.spec.window.period})`;
}

/** Build the listing's SloSummary shape just far enough to drive templateIconFor. */
function iconSummaryFromDoc(doc: SloDocument): SloSummary {
  const sli = doc.spec.sli.type === 'single' ? doc.spec.sli : null;
  return {
    id: doc.id,
    datasourceId: doc.spec.datasourceId,
    datasourceType: sli?.definition.backend ?? 'prometheus',
    name: doc.spec.name,
    enabled: doc.spec.enabled,
    mode: doc.spec.mode,
    service: doc.spec.service,
    owner: doc.spec.owner,
    sliNodeType: doc.spec.sli.type,
    sliBackend: sli?.definition.backend,
    sliLeafType: sli?.definition.type,
    dimensions: sli?.dimensions,
    objectiveCount: doc.spec.objectives.length,
    worstTarget: doc.spec.objectives[0]?.target ?? 0,
    window: doc.spec.window,
    labels: doc.spec.labels,
    status: {} as SloLiveStatus,
  };
}

interface DetailHeaderProps {
  doc: FullDoc;
  primaryObjective: Objective;
}

/**
 * Detail page header. Promotes health to the left edge as a coloured dot,
 * followed by name + a compact metadata strip (template icon · SLI leaf type ·
 * attainment/target · window). Badges (Enabled / mode) only render when the
 * SLO deviates from the majority defaults — matches the listing's majority-
 * value trait logic so operators aren't distracted by "Enabled" on every page.
 */
const DetailHeader: React.FC<DetailHeaderProps> = ({ doc, primaryObjective }) => {
  const sli = doc.spec.sli.type === 'single' ? doc.spec.sli : null;
  const sliLeafType =
    sli?.definition.backend === 'prometheus' || sli?.definition.backend === 'opensearch'
      ? sli.definition.type
      : doc.spec.sli.type;
  const attainment =
    doc.liveStatus.objectives.find((o) => o.objectiveName === primaryObjective.name)?.attainment ??
    doc.liveStatus.objectives[0]?.attainment ??
    null;
  const healthHex = (() => {
    switch (getSloHealthColor(doc.liveStatus.state)) {
      case 'danger':
        return euiThemeVars.euiColorDanger;
      case 'warning':
        return euiThemeVars.euiColorWarning;
      case 'success':
        return euiThemeVars.euiColorSuccess;
      case 'subdued':
        return euiThemeVars.euiColorMediumShade;
      default:
        return euiThemeVars.euiColorMediumShade;
    }
  })();

  return (
    <EuiPanel data-test-subj="slosDetailHeader">
      <EuiFlexGroup alignItems="flexStart" gutterSize="m" responsive={false}>
        <EuiFlexItem grow={false}>
          <span
            aria-label={`Health: ${doc.liveStatus.state}`}
            title={doc.liveStatus.state}
            data-test-subj="slosDetailHealthDot"
            style={{
              display: 'inline-block',
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: healthHex,
              marginTop: 4,
            }}
          />
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiText size="m">
            <h2 style={{ marginBottom: 4 }} data-test-subj="slosDetailTitle">
              {doc.spec.name}
            </h2>
          </EuiText>
          <EuiFlexGroup
            alignItems="center"
            gutterSize="s"
            responsive={false}
            wrap
            data-test-subj="slosDetailMetaStrip"
          >
            {sliLeafType && (
              <EuiFlexItem grow={false}>
                <EuiText size="s" color="subdued">
                  <EuiIcon type={templateIconFor(iconSummaryFromDoc(doc))} size="s" /> {sliLeafType}
                </EuiText>
              </EuiFlexItem>
            )}
            <EuiFlexItem grow={false}>
              <EuiText size="s" color="subdued">
                ·
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="s" color="subdued">
                attainment <strong>{attainment !== null ? formatTightPct(attainment) : '—'}</strong>{' '}
                / target <strong>{formatTightPct(primaryObjective.target)}</strong>
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="s" color="subdued">
                ·
              </EuiText>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="s" color="subdued">
                {describeWindow(doc)}
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
          {doc.spec.description && (
            <>
              <EuiSpacer size="xs" />
              <EuiText size="s" color="subdued">
                {doc.spec.description}
              </EuiText>
            </>
          )}
        </EuiFlexItem>
        {/* Only surface badges that deviate from the majority defaults (enabled
            + active). Mirrors the listing's majority-trait logic from d720b68a
            so operators aren't distracted by noise. */}
        {!doc.spec.enabled && (
          <EuiFlexItem grow={false}>
            <EuiBadge color="subdued" data-test-subj="slosDetailDisabledBadge">
              Disabled
            </EuiBadge>
          </EuiFlexItem>
        )}
        {doc.spec.mode === 'shadow' && (
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow" data-test-subj="slosDetailModeBadge">
              shadow
            </EuiBadge>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
    </EuiPanel>
  );
};

interface ObjectiveRow {
  name: string;
  displayName: string;
  target: number;
  threshold: string;
  alertsEnabled: string;
  rules: string;
}

const OBJECTIVE_COLUMNS: Array<EuiBasicTableColumn<ObjectiveRow>> = [
  { field: 'displayName', name: 'Name', width: '30%' },
  { field: 'target', name: 'Target', width: '15%', render: (t: number) => formatTightPct(t) },
  { field: 'threshold', name: 'Threshold', width: '20%' },
  { field: 'alertsEnabled', name: 'Alerts enabled', width: '20%' },
  { field: 'rules', name: 'Rules', width: '15%' },
];

function buildObjectiveRow(
  obj: Objective,
  doc: SloDocument,
  liveStatus: SloLiveStatus
): ObjectiveRow {
  const sli = doc.spec.sli.type === 'single' ? doc.spec.sli : null;
  const latencyUnit =
    sli?.definition.backend === 'prometheus' && sli.definition.type === 'latency_threshold'
      ? sli.definition.latencyThresholdUnit ?? 'seconds'
      : 'seconds';
  const threshold =
    obj.latencyThreshold !== undefined
      ? `≤ ${obj.latencyThreshold}${latencyUnit === 'milliseconds' ? 'ms' : 's'}`
      : obj.thresholdBound
      ? `${obj.thresholdBound.operator} ${obj.thresholdBound.value}`
      : '—';

  // SloAlarmConfig is SLO-wide, not per-objective — so every row shows the
  // same boolean. That's the closest signal we have in the persisted spec
  // today; per-objective alerting toggles aren't modelled yet.
  const burnRates = doc.spec.alerting.strategy === 'mwmbr' ? doc.spec.alerting.burnRates : [];
  const anyBurnRateAlarm = burnRates.some((b) => b.createAlarm);
  const alarms = doc.spec.alarms;
  const anySupplemental =
    alarms.sliHealth.enabled ||
    alarms.attainmentBreach.enabled ||
    alarms.budgetWarning.enabled ||
    alarms.noData.enabled;
  const alertsEnabled = doc.spec.enabled && (anyBurnRateAlarm || anySupplemental) ? 'Yes' : 'No';

  // Persisted rule names don't carry an objective tag we can filter on. Show
  // the live total only when there's a single objective (unambiguous); show
  // an em-dash otherwise so we don't misattribute counts.
  const rules = doc.spec.objectives.length === 1 ? String(liveStatus.ruleCount ?? 0) : '—';

  return {
    name: obj.name,
    displayName: obj.displayName ?? obj.name,
    target: obj.target,
    threshold,
    alertsEnabled,
    rules,
  };
}

export const SloDetailPage: React.FC<SloDetailPageProps> = ({
  apiClient,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const [doc, setDoc] = useState<FullDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>({ from: 'now-1h', to: 'now' });
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedRef = useRef<HTMLDivElement | null>(null);

  const onRefresh = useCallback(() => {
    setRefreshTrigger((v) => v + 1);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.get(id);
      setDoc(result);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [apiClient, id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    chrome.setBreadcrumbs([
      parentBreadcrumb,
      { text: 'SLO/SLI', href: '#/slos' },
      { text: doc?.spec.name ?? id },
    ]);
  }, [chrome, parentBreadcrumb, doc, id]);

  const onDelete = useCallback(async () => {
    setConfirmDelete(false);
    try {
      const result = await apiClient.delete(id);
      notifications.toasts.addSuccess({
        title: 'SLO deleted',
        text: `Removed ${result.generatedRuleNames.length} generated rules.`,
      });
      history.push('/slos');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      notifications.toasts.addDanger({ title: 'Delete failed', text: err.message });
    }
  }, [apiClient, history, id, notifications]);

  const onToggleEnabled = useCallback(async () => {
    if (!doc) return;
    try {
      const updated = doc.spec.enabled ? await apiClient.disable(id) : await apiClient.enable(id);
      notifications.toasts.addSuccess({
        title: updated.spec.enabled ? 'SLO enabled' : 'SLO disabled',
      });
      load();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      notifications.toasts.addDanger({ title: 'Toggle failed', text: err.message });
    }
  }, [apiClient, doc, id, load, notifications]);

  // Expand + scroll the Advanced-details accordion into view. Invoked from the
  // MWMBR tier cards when they surface the "view generated rules" affordance.
  const handleViewRulesRequest = useCallback(() => {
    setAdvancedOpen(true);
    // Wait one frame so the accordion has re-rendered expanded before scrolling.
    requestAnimationFrame(() => {
      advancedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  if (loading) {
    return (
      <EuiPage>
        <EuiPageBody>
          <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: '400px' }}>
            <EuiFlexItem grow={false}>
              <EuiLoadingSpinner size="xl" />
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiPageBody>
      </EuiPage>
    );
  }

  if (error) {
    return (
      <EuiPage>
        <EuiPageBody>
          <EuiPanel>
            <EuiEmptyPrompt
              iconType="alert"
              color="danger"
              title={<h2>Unable to load SLO</h2>}
              body={<p>{error.message}</p>}
              actions={<EuiButton onClick={load}>Retry</EuiButton>}
            />
          </EuiPanel>
        </EuiPageBody>
      </EuiPage>
    );
  }

  if (!doc) return null;

  const sli = doc.spec.sli.type === 'single' ? doc.spec.sli : null;
  const primaryObjective = doc.spec.objectives[0];
  const objectiveRows = doc.spec.objectives.map((o) => buildObjectiveRow(o, doc, doc.liveStatus));
  const prov = doc.status.provisioning.backend === 'prometheus' ? doc.status.provisioning : null;

  const summaryListItems: Array<{ title: React.ReactNode; description: React.ReactNode }> = [
    { title: 'ID', description: doc.id },
    { title: 'Datasource', description: doc.spec.datasourceId },
    { title: 'Service', description: doc.spec.service },
    { title: 'Owner team (primary)', description: doc.spec.owner.teams[0] ?? '—' },
    { title: 'Tier', description: doc.spec.tier ?? '—' },
    { title: 'Window', description: describeWindow(doc) },
  ];

  const sliListItems: Array<{ title: React.ReactNode; description: React.ReactNode }> =
    sli && sli.definition.backend === 'prometheus'
      ? [
          { title: 'Backend', description: sli.definition.backend },
          { title: 'Type', description: sli.definition.type },
          { title: 'Metric', description: sli.definition.metric ?? 'custom' },
          { title: 'Good events filter', description: sli.definition.goodEventsFilter ?? '—' },
          {
            title: 'Dimensions',
            description: sli.dimensions.map((d) => `${d.name}=${d.value}`).join(', ') || '—',
          },
        ]
      : [];

  const headerActions = [
    <EuiButtonEmpty
      key="back"
      iconType="arrowLeft"
      href="#/slos"
      size="s"
      data-test-subj="slosBack"
    >
      Back to SLOs
    </EuiButtonEmpty>,
    <TimeRangePicker
      key="time"
      timeRange={timeRange}
      onChange={setTimeRange}
      onRefresh={onRefresh}
      compressed
    />,
    <EuiButton key="toggle" size="s" onClick={onToggleEnabled} data-test-subj="slosDetailToggle">
      {doc.spec.enabled ? 'Disable' : 'Enable'}
    </EuiButton>,
    <EuiButton
      key="delete"
      size="s"
      color="danger"
      onClick={() => setConfirmDelete(true)}
      data-test-subj="slosDetailDelete"
    >
      Delete
    </EuiButton>,
  ];

  return (
    <EuiPage data-test-subj="sloDetailPage">
      <EuiPageBody component="main">
        <HeaderControlledComponentsWrapper components={headerActions} />
        <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
          <EuiPageContentBody>
            <DetailHeader doc={doc} primaryObjective={primaryObjective} />

            <EuiSpacer size="m" />

            {/* Two-column layout — left owns the quantitative signals (charts
                + objectives), right owns the descriptive config (Summary + SLI
                + Advanced details). Grow ratio 2:1 matches the service overview
                page so the SLOs and service pages feel consistent. */}
            <EuiFlexGroup gutterSize="m">
              <EuiFlexItem grow={2}>
                <SloVisualizations
                  slo={doc}
                  timeRange={timeRange}
                  refreshTrigger={refreshTrigger}
                  onViewRulesRequest={handleViewRulesRequest}
                />

                <EuiSpacer size="m" />

                <EuiPanel>
                  <EuiText size="m">
                    <h4>Objectives</h4>
                  </EuiText>
                  <EuiSpacer size="s" />
                  <EuiBasicTable<ObjectiveRow>
                    tableCaption="Objectives"
                    items={objectiveRows}
                    columns={OBJECTIVE_COLUMNS}
                    compressed
                    data-test-subj="slosDetailObjectivesTable"
                  />
                </EuiPanel>
              </EuiFlexItem>

              <EuiFlexItem grow={1}>
                <EuiPanel>
                  <EuiText size="s">
                    <h5>Summary</h5>
                  </EuiText>
                  <EuiSpacer size="xs" />
                  <EuiDescriptionList
                    compressed
                    type="column"
                    listItems={summaryListItems}
                    data-test-subj="slosDetailSummaryList"
                  />

                  {sliListItems.length > 0 && (
                    <>
                      <EuiSpacer size="m" />
                      <EuiText size="s">
                        <h5>SLI</h5>
                      </EuiText>
                      <EuiSpacer size="xs" />
                      <EuiDescriptionList
                        compressed
                        type="column"
                        listItems={sliListItems}
                        data-test-subj="slosDetailSliList"
                      />
                    </>
                  )}

                  <EuiSpacer size="m" />

                  <div ref={advancedRef}>
                    <EuiAccordion
                      id="slosDetailAdvanced"
                      buttonContent={
                        <EuiText size="s">
                          <strong>
                            <EuiIcon type="advancedSettingsApp" size="s" /> Advanced details
                          </strong>
                        </EuiText>
                      }
                      data-test-subj="slosDetailAdvancedAccordion"
                      forceState={advancedOpen ? 'open' : 'closed'}
                      onToggle={(open) => setAdvancedOpen(open)}
                    >
                      <EuiSpacer size="s" />
                      <EuiDescriptionList
                        compressed
                        type="column"
                        data-test-subj="slosDetailAdvancedOps"
                        listItems={[
                          {
                            title: 'Rules provisioned',
                            description: `${doc.liveStatus.ruleCount ?? 0}${
                              doc.liveStatus.firingCount > 0
                                ? ` · ${doc.liveStatus.firingCount} firing`
                                : ''
                            }`,
                          },
                          {
                            title: 'Last evaluated',
                            description: doc.liveStatus.lastEvaluatedAt ?? '—',
                          },
                          { title: 'Computed at', description: doc.liveStatus.computedAt },
                          { title: 'Version', description: String(doc.status.version) },
                          ...(prov
                            ? [
                                { title: 'Rule group', description: prov.ruleGroupName },
                                { title: 'Ruler namespace', description: prov.rulerNamespace },
                              ]
                            : []),
                        ]}
                      />

                      <EuiSpacer size="m" />

                      <SloMetadataPanel slo={doc} inline />
                    </EuiAccordion>
                  </div>
                </EuiPanel>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiPageContentBody>
        </EuiPageContent>

        {confirmDelete && (
          <EuiConfirmModal
            title={`Delete SLO "${doc.spec.name}"?`}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={onDelete}
            cancelButtonText="Cancel"
            confirmButtonText="Delete"
            buttonColor="danger"
          >
            <p>This tears down all generated Prometheus rules. The action cannot be undone.</p>
          </EuiConfirmModal>
        )}
      </EuiPageBody>
    </EuiPage>
  );
};
