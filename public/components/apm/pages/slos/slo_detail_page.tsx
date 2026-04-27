/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiConfirmModal,
  EuiDescriptionList,
  EuiEmptyPrompt,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiLoadingSpinner,
  EuiPage,
  EuiPageBody,
  EuiPageContent,
  EuiPageContentBody,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { useHistory, useParams } from 'react-router-dom';
import { ChromeStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import { TimeRangePicker } from '../../shared/components/time_filter';
import { TimeRange } from '../../common/types/service_types';
import { SloVisualizations } from './slo_visualizations';
import { SloMetadataPanel } from './slo_metadata_panel';
import type { SloApiClient } from './slo_api_client';
import type { SloDocument, SloLiveStatus } from '../../../../../common/slo/slo_types';
import { SLO_HEALTH_COLOR } from '../../../../../common/slo/state';

export interface SloDetailPageProps {
  apiClient: SloApiClient;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

type FullDoc = SloDocument & { liveStatus: SloLiveStatus };

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

  const headerActions = [
    <EuiButtonEmpty
      key="back"
      iconType="arrowLeft"
      href="#/slos"
      size="s"
      data-test-subj="slos-back"
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
    <EuiButton key="toggle" size="s" onClick={onToggleEnabled} data-test-subj="slos-detail-toggle">
      {doc.spec.enabled ? 'Disable' : 'Enable'}
    </EuiButton>,
    <EuiButton
      key="delete"
      size="s"
      color="danger"
      onClick={() => setConfirmDelete(true)}
      data-test-subj="slos-detail-delete"
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
            {/* Name + state pill row */}
            <EuiPanel>
              <EuiFlexGroup alignItems="center" gutterSize="m" wrap responsive={false}>
                <EuiFlexItem grow={true}>
                  <EuiText size="m">
                    <h2 style={{ marginBottom: 0 }}>{doc.spec.name}</h2>
                  </EuiText>
                  {doc.spec.description && (
                    <EuiText size="s" color="subdued">
                      {doc.spec.description}
                    </EuiText>
                  )}
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiHealth color={SLO_HEALTH_COLOR[doc.liveStatus.state]}>
                    {doc.liveStatus.state}
                  </EuiHealth>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiBadge color={doc.spec.enabled ? 'success' : 'subdued'}>
                    {doc.spec.enabled ? 'Enabled' : 'Disabled'}
                  </EuiBadge>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiBadge>{doc.spec.mode}</EuiBadge>
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiPanel>

            <EuiSpacer size="m" />

            {/* Pre-canned visualizations — driven by the primary objective's
                PromQL. Uses the APM-configured Prometheus datasource so the
                charts light up on services that have rules provisioned AND
                on services whose raw metrics are already being scraped. */}
            <SloVisualizations slo={doc} timeRange={timeRange} refreshTrigger={refreshTrigger} />

            <EuiSpacer size="m" />

            <EuiFlexGroup>
              <EuiFlexItem>
                <EuiPanel>
                  <EuiText size="m">
                    <h4>Summary</h4>
                  </EuiText>
                  <EuiSpacer size="s" />
                  <EuiDescriptionList
                    compressed
                    type="column"
                    listItems={[
                      { title: 'ID', description: doc.id },
                      { title: 'Datasource', description: doc.spec.datasourceId },
                      { title: 'Service', description: doc.spec.service },
                      {
                        title: 'Owner team (primary)',
                        description: doc.spec.owner.teams[0] ?? '—',
                      },
                      { title: 'Tier', description: doc.spec.tier ?? '—' },
                      {
                        title: 'Window',
                        description:
                          doc.spec.window.type === 'rolling'
                            ? `rolling ${doc.spec.window.duration}`
                            : `calendar (${doc.spec.window.period})`,
                      },
                    ]}
                  />
                </EuiPanel>
              </EuiFlexItem>

              {sli && sli.definition.backend === 'prometheus' && (
                <EuiFlexItem>
                  <EuiPanel>
                    <EuiText size="m">
                      <h4>SLI</h4>
                    </EuiText>
                    <EuiSpacer size="s" />
                    <EuiDescriptionList
                      compressed
                      type="column"
                      listItems={[
                        { title: 'Backend', description: sli.definition.backend },
                        { title: 'Type', description: sli.definition.type },
                        {
                          title: 'Metric',
                          description: sli.definition.metric ?? 'custom',
                        },
                        {
                          title: 'Good events filter',
                          description: sli.definition.goodEventsFilter ?? '—',
                        },
                        {
                          title: 'Dimensions',
                          description:
                            sli.dimensions.map((d) => `${d.name}=${d.value}`).join(', ') || '—',
                        },
                      ]}
                    />
                  </EuiPanel>
                </EuiFlexItem>
              )}
            </EuiFlexGroup>

            <EuiSpacer size="m" />

            <EuiPanel>
              <EuiText size="m">
                <h4>Objectives</h4>
              </EuiText>
              <EuiSpacer size="s" />
              <EuiText size="s">
                {doc.spec.objectives.map((obj) => (
                  <p key={obj.name} style={{ marginBottom: 4 }}>
                    <strong>{obj.displayName ?? obj.name}</strong>
                    <span> — target {(obj.target * 100).toFixed(3).replace(/\.?0+$/, '')}%</span>
                    {obj.latencyThreshold !== undefined && <span> ≤ {obj.latencyThreshold}s</span>}
                  </p>
                ))}
              </EuiText>
            </EuiPanel>

            <EuiSpacer size="m" />

            <SloMetadataPanel slo={doc} />
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
