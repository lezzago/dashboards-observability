/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 4 (W4.8) — SLO Adoption admin page.
 *
 * Shell that owns the feature-flag gate, breadcrumb wiring, and the
 * Recover + Legacy-orphans surfaces.
 *
 * Feature-flag gate strategy:
 *   - Fire `GET /_orphans` on mount.
 *   - 412 → render a simple "Orphan adoption disabled" notice with no table.
 *   - 200 → seed the Recover table state with the already-fetched payload so
 *     we don't make an immediate second request.
 *   - Any other error → render a retry-capable error callout.
 *
 * Session C introduced a "Legacy orphans" tab gated on
 * `observability.slo.legacyOrphanPurge.enabled`. Session D (F1) exposed that
 * flag to the browser via `exposeToBrowser`, so the page now reads it
 * synchronously from `coreRefs.legacyOrphanPurgeEnabled` instead of probing
 * `_purge_legacy` with an empty body.
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
import type {
  ChromeStart,
  HttpStart,
  NotificationsStart,
} from '../../../../../../../../src/core/public';
import { coreRefs } from '../../../../../framework/core_refs';
import type { OrphanListResponse, OrphanUnknown, SloApiClient } from '../slo_api_client';
import { isPreconditionFailed } from '../slo_api_client';
import { RecoverTab } from './recover_tab';
import { LegacyTab } from './legacy_tab';

export interface SloAdoptionPageProps {
  apiClient: SloApiClient;
  http: HttpStart;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

/**
 * Predicate matching the reconciler's diagnostic for pre-Phase-3 legacy
 * rule groups. Kept as a string-compare rather than a named enum because
 * the reconciler produces it verbatim and the UI should not have to import
 * server-side constants.
 */
const LEGACY_DIAGNOSTIC = 'pre-Phase-3 rule layout; not eligible for adoption';

function isLegacyOrphan(o: OrphanUnknown): boolean {
  return o.diagnostic === LEGACY_DIAGNOSTIC;
}

type FeatureState = 'loading' | 'enabled' | 'disabled' | 'error';

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

/** Tab ids rendered on the adoption page. */
type AdoptionTabId = 'recover' | 'legacy';

export const SloAdoptionPage: React.FC<SloAdoptionPageProps> = ({
  apiClient,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const [featureState, setFeatureState] = useState<FeatureState>('loading');
  const [initialData, setInitialData] = useState<OrphanListResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Session D (F1) — legacy-purge flag is now browser-exposed via
  // `exposeToBrowser` in `server/index.ts`, so tab visibility resolves
  // synchronously at mount. The exposed config is read once at plugin
  // start; a server-side flag flip requires a page reload to take effect.
  const legacyPurgeEnabled = coreRefs.legacyOrphanPurgeEnabled ?? false;
  const [activeTab, setActiveTab] = useState<AdoptionTabId>('recover');

  // Breadcrumb is mount-only.
  useEffect(() => {
    chrome.setBreadcrumbs([parentBreadcrumb, { text: 'SLO/SLI' }, { text: 'Adoption' }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const cancelList = load();
    return () => {
      cancelList?.();
    };
  }, [load]);

  const legacyOrphans = useMemo(() => {
    if (!initialData) return [] as OrphanUnknown[];
    return initialData.unknowns.filter(isLegacyOrphan);
  }, [initialData]);

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
                Recover SLOs whose saved objects were deleted out-of-band while their rule groups
                still live on the ruler. Rules are only adopted after integrity verification.
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
                {legacyPurgeEnabled ? (
                  <>
                    <EuiTabs data-test-subj="sloAdoption-page-tabs">
                      <EuiTab
                        isSelected={activeTab === 'recover'}
                        onClick={() => setActiveTab('recover')}
                        data-test-subj="sloAdoption-page-tab-recover"
                      >
                        Recover
                      </EuiTab>
                      <EuiTab
                        isSelected={activeTab === 'legacy'}
                        onClick={() => setActiveTab('legacy')}
                        data-test-subj="sloAdoption-page-tab-legacy"
                      >
                        Legacy orphans ({legacyOrphans.length})
                      </EuiTab>
                    </EuiTabs>
                    <EuiSpacer size="m" />
                  </>
                ) : null}
                {activeTab === 'recover' || !legacyPurgeEnabled ? (
                  <RecoverTab
                    apiClient={apiClient}
                    notifications={notifications}
                    initialData={initialData}
                  />
                ) : (
                  <LegacyTab
                    apiClient={apiClient}
                    notifications={notifications}
                    legacyOrphans={legacyOrphans}
                    onPurgeComplete={load}
                  />
                )}
              </>
            )}
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};
