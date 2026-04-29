/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 4 Batch 3 (W4.8 + W4.9) — SLO Adoption admin page.
 *
 * Shell that owns the feature-flag gate, breadcrumb wiring, and the
 * Recover/Clone tab switch. The two tabs live in sibling files; this module
 * only orchestrates them.
 *
 * Feature-flag gate strategy:
 *   - Fire `GET /_orphans` on mount.
 *   - 412 → render a simple "Orphan adoption disabled" notice with NO tabs.
 *   - 200 → seed the Recover tab's state with the already-fetched payload so
 *     we don't make an immediate second request.
 *   - Any other error → render a retry-capable error callout.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiEmptyPrompt,
  EuiLoadingSpinner,
  EuiPage,
  EuiPageBody,
  EuiPageContent,
  EuiPageContentBody,
  EuiPanel,
  EuiSpacer,
  EuiTabs,
  EuiTab,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { useHistory, useLocation } from 'react-router-dom';
import type {
  ChromeStart,
  HttpStart,
  NotificationsStart,
} from '../../../../../../../../src/core/public';
import type { OrphanListResponse, SloApiClient } from '../slo_api_client';
import { isPreconditionFailed } from '../slo_api_client';
import { RecoverTab } from './recover_tab';
import { CloneTab } from './clone_tab';

export interface SloAdoptionPageProps {
  apiClient: SloApiClient;
  http: HttpStart;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

type TabId = 'recover' | 'clone';
type FeatureState = 'loading' | 'enabled' | 'disabled' | 'error';

function readTabFromSearch(search: string): TabId {
  const params = new URLSearchParams(search);
  const raw = params.get('tab');
  return raw === 'clone' ? 'clone' : 'recover';
}

/** Unwrap an OSD http error envelope into a displayable string. */
function extractErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const body = (err as { body?: { message?: unknown } }).body;
    if (body && typeof body.message === 'string') return body.message;
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(err);
}

export const SloAdoptionPage: React.FC<SloAdoptionPageProps> = ({
  apiClient,
  http,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const history = useHistory();
  const location = useLocation();

  const [featureState, setFeatureState] = useState<FeatureState>('loading');
  const [initialData, setInitialData] = useState<OrphanListResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(readTabFromSearch(location.search));

  // Breadcrumb is mount-only to avoid re-firing on tab switches.
  useEffect(() => {
    chrome.setBreadcrumbs([parentBreadcrumb, { text: 'SLO/SLI' }, { text: 'Adoption' }]);
    // Intentionally empty deps — mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync active tab with URL so deep links (`?tab=clone`) work both on first
  // render and when the user clicks a tab.
  useEffect(() => {
    setActiveTab(readTabFromSearch(location.search));
  }, [location.search]);

  const load = useCallback(() => {
    let cancelled = false;
    setFeatureState('loading');
    setErrorMessage(null);
    apiClient
      .listOrphans()
      .then((data) => {
        if (cancelled) return;
        setInitialData(data);
        setFeatureState('enabled');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isPreconditionFailed(err)) {
          setFeatureState('disabled');
          return;
        }
        setErrorMessage(extractErrorMessage(err));
        setFeatureState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  useEffect(() => {
    const cancel = load();
    return cancel;
  }, [load]);

  const handleTabChange = useCallback(
    (tabId: TabId) => {
      setActiveTab(tabId);
      const params = new URLSearchParams(location.search);
      params.set('tab', tabId);
      history.replace({ pathname: location.pathname, search: `?${params.toString()}` });
    },
    [history, location.pathname, location.search]
  );

  const tabs = useMemo(
    () => [
      { id: 'recover' as const, name: 'Recover lost SLOs', testSubj: 'sloAdoption-tab-recover' },
      {
        id: 'clone' as const,
        name: 'Clone to another datasource',
        testSubj: 'sloAdoption-tab-clone',
      },
    ],
    []
  );

  return (
    <EuiPage data-test-subj="sloAdoption-page">
      <EuiPageBody component="main">
        <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
          <EuiPageContentBody>
            <EuiTitle size="l">
              <h1>SLO adoption</h1>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiText size="s" color="subdued">
              <p>
                Recover SLOs whose saved objects were deleted out-of-band, or clone rule groups into
                another datasource. Rules are only adopted after integrity verification.
              </p>
            </EuiText>
            <EuiSpacer size="m" />

            {featureState === 'loading' ? (
              <EuiPanel data-test-subj="sloAdoption-page-loading">
                <EuiEmptyPrompt
                  icon={<EuiLoadingSpinner size="xl" />}
                  title={<h3>Loading adoption data…</h3>}
                  body={<p>Checking feature flags and fetching orphan candidates.</p>}
                />
              </EuiPanel>
            ) : featureState === 'disabled' ? (
              <EuiPanel data-test-subj="sloAdoption-page-disabledPrompt">
                <EuiEmptyPrompt
                  iconType="lock"
                  title={<h3>Orphan adoption disabled</h3>}
                  body={
                    <p>
                      This feature requires <code>observability.slo.ruleDedup.enabled</code> and{' '}
                      <code>observability.slo.ruleAdoption.enabled</code>. Contact your
                      administrator.
                    </p>
                  }
                />
              </EuiPanel>
            ) : featureState === 'error' ? (
              <EuiPanel data-test-subj="sloAdoption-page-error">
                <EuiEmptyPrompt
                  iconType="alert"
                  color="danger"
                  title={<h3>Unable to load adoption data</h3>}
                  body={<p>{errorMessage ?? 'Unknown error'}</p>}
                  actions={
                    <EuiButton onClick={load} data-test-subj="sloAdoption-page-error-retry" fill>
                      Retry
                    </EuiButton>
                  }
                />
              </EuiPanel>
            ) : (
              <>
                <EuiTabs data-test-subj="sloAdoption-tabs">
                  {tabs.map((t) => (
                    <EuiTab
                      key={t.id}
                      isSelected={activeTab === t.id}
                      onClick={() => handleTabChange(t.id)}
                      data-test-subj={t.testSubj}
                    >
                      {t.name}
                    </EuiTab>
                  ))}
                </EuiTabs>
                <EuiSpacer size="m" />
                {activeTab === 'recover' ? (
                  <RecoverTab
                    apiClient={apiClient}
                    notifications={notifications}
                    initialData={initialData}
                  />
                ) : (
                  <CloneTab apiClient={apiClient} http={http} notifications={notifications} />
                )}
              </>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};
