/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * W4.9 — Clone tab.
 *
 * Lets the operator copy provenance-stamped groups from a source datasource
 * into a different target datasource. Integrity guards mirror the Recover
 * tab — non-`ok` rows are blocked from cloning.
 *
 * Flow:
 *   1. Pick a source datasource (Prometheus connections only).
 *   2. Table renders candidates scoped to that datasource; each row exposes
 *      a checkbox + an integrity badge + a read-only spec preview.
 *   3. With ≥1 row selected, the clone form appears below. Single-row mode
 *      exposes overrideName / overrideId; bulk mode (>1 row) uses the
 *      source spec name/id.
 *   4. Submit fires `apiClient.cloneSlo` once per selected row via
 *      `Promise.allSettled`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiAccordion,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCheckbox,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiInMemoryTable,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import type { HttpStart, NotificationsStart } from '../../../../../../../../src/core/public';
import type { OrphanCandidate, OrphanListResponse, SloApiClient } from '../slo_api_client';
import { usePrometheusDatasources } from '../use_prometheus_datasources';
import { OrphanIntegrityBadge } from './orphan_integrity_badge';
import { ReadOnlySpecPreview } from './read_only_spec_preview';

export interface CloneTabProps {
  apiClient: SloApiClient;
  http: HttpStart;
  notifications: NotificationsStart;
}

interface CloneRowError {
  key: string;
  name: string;
  message: string;
}

function rowKey(c: OrphanCandidate): string {
  return `${c.datasourceId}:${c.namespace}:${c.groupName}:${c.sloId}`;
}

function errorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const body = (err as { body?: { message?: unknown; attributes?: { message?: unknown } } }).body;
  if (body) {
    if (typeof body.message === 'string') return body.message;
    if (body.attributes && typeof body.attributes.message === 'string') {
      return body.attributes.message;
    }
  }
  if ((err as Error).message) return (err as Error).message;
  return 'Request failed';
}

export const CloneTab: React.FC<CloneTabProps> = ({ apiClient, http, notifications }) => {
  const {
    datasources: promDatasources,
    loading: dsLoading,
    error: dsError,
  } = usePrometheusDatasources(http);

  const [sourceId, setSourceId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [candidates, setCandidates] = useState<OrphanCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [overrideName, setOverrideName] = useState('');
  const [overrideId, setOverrideId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rowErrors, setRowErrors] = useState<CloneRowError[]>([]);
  const [itemIdToExpandedRowMap, setItemIdToExpandedRowMap] = useState<
    Record<string, React.ReactNode>
  >({});

  // Reset candidate list when source changes.
  useEffect(() => {
    setCandidates([]);
    setSelected(new Set());
    setRowErrors([]);
    setItemIdToExpandedRowMap({});
    if (!sourceId) return;
    let cancelled = false;
    setLoadingCandidates(true);
    setCandidateError(null);
    apiClient
      .listOrphans(sourceId)
      .then((data: OrphanListResponse) => {
        if (cancelled) return;
        setCandidates(data.candidates);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCandidateError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, sourceId]);

  const sourceOptions = useMemo(
    () => [
      { value: '', text: 'Select a source datasource…' },
      ...promDatasources.map((d) => ({ value: d.id, text: d.name })),
    ],
    [promDatasources]
  );

  // Exclude the source so operators can't clone a row onto itself.
  const targetOptions = useMemo(
    () => [
      { value: '', text: 'Select a target datasource…' },
      ...promDatasources
        .filter((d) => d.id !== sourceId)
        .map((d) => ({ value: d.id, text: d.name })),
    ],
    [promDatasources, sourceId]
  );

  const toggleSelect = useCallback((c: OrphanCandidate, checked: boolean) => {
    const key = rowKey(c);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((c: OrphanCandidate) => {
    const key = rowKey(c);
    setItemIdToExpandedRowMap((prev) => {
      const next = { ...prev };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = (
          <div data-test-subj={`sloAdoption-cloneTab-expanded-${c.sloId}`}>
            <ReadOnlySpecPreview spec={c.spec} fingerprints={c.fingerprints} />
          </div>
        );
      }
      return next;
    });
  }, []);

  const selectedCandidates = useMemo(() => candidates.filter((c) => selected.has(rowKey(c))), [
    candidates,
    selected,
  ]);

  const hasBlockedSelection = selectedCandidates.some((c) => c.specIntegrity !== 'ok');
  const isBulk = selectedCandidates.length > 1;

  const submit = useCallback(async () => {
    if (!targetId) {
      notifications.toasts.addWarning({
        title: 'Select a target datasource',
        text: 'Pick where you want the cloned SLOs to land.',
      });
      return;
    }
    if (selectedCandidates.length === 0) return;

    setSubmitting(true);
    setRowErrors([]);
    try {
      const calls = selectedCandidates.map((c) =>
        apiClient
          .cloneSlo({
            sourceSloId: c.sloId,
            sourceDatasourceId: c.datasourceId,
            sourceWorkspaceId: c.workspaceId,
            targetDatasourceId: targetId,
            // Name/id overrides only apply to single-row clone; bulk keeps
            // source identifiers so the operator doesn't accidentally collide
            // multiple clones on one name.
            overrideName: !isBulk && overrideName.trim() ? overrideName.trim() : undefined,
            overrideId: !isBulk && overrideId.trim() ? overrideId.trim() : undefined,
          })
          .then(() => ({
            key: rowKey(c),
            status: 'success' as const,
            name: c.spec?.name ?? c.sloId,
          }))
          .catch((err: unknown) => ({
            key: rowKey(c),
            status: 'failed' as const,
            name: c.spec?.name ?? c.sloId,
            message: errorMessage(err),
          }))
      );
      const results = await Promise.allSettled(calls);
      const failed: CloneRowError[] = [];
      let successCount = 0;
      results.forEach((r) => {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v.status === 'success') successCount += 1;
          else failed.push({ key: v.key, name: v.name, message: v.message });
        } else {
          failed.push({ key: 'unknown', name: '(unknown row)', message: String(r.reason) });
        }
      });
      setRowErrors(failed);
      if (failed.length === 0) {
        notifications.toasts.addSuccess({
          title: 'Clone complete',
          text: `${successCount} SLO${
            successCount === 1 ? '' : 's'
          } cloned to the target datasource.`,
        });
        // Clear selection so the operator can stack another batch.
        setSelected(new Set());
      } else if (successCount > 0) {
        notifications.toasts.addWarning({
          title: 'Clone partial',
          text: `Cloned ${successCount}, failed ${failed.length}. See per-row errors below.`,
        });
      } else {
        notifications.toasts.addDanger({
          title: 'Clone failed',
          text: `All ${failed.length} clone requests failed. See per-row errors below.`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    apiClient,
    isBulk,
    notifications.toasts,
    overrideId,
    overrideName,
    selectedCandidates,
    targetId,
  ]);

  const columns = useMemo<Array<EuiBasicTableColumn<OrphanCandidate>>>(
    () => [
      {
        width: '40px',
        name: '',
        render: (c: OrphanCandidate) => {
          const key = rowKey(c);
          const blocked = c.specIntegrity !== 'ok';
          const checkbox = (
            <EuiCheckbox
              id={`sloAdoption-cloneTab-select-${c.sloId}`}
              data-test-subj={`sloAdoption-cloneTab-select-${c.sloId}`}
              checked={selected.has(key)}
              disabled={blocked}
              onChange={(e) => toggleSelect(c, e.target.checked)}
            />
          );
          return blocked ? (
            <EuiToolTip content="Only 'ok' integrity rows can be cloned.">{checkbox}</EuiToolTip>
          ) : (
            checkbox
          );
        },
      },
      {
        name: 'SLO name',
        render: (c: OrphanCandidate) => (
          <EuiText size="s">
            <strong>{c.spec?.name ?? c.sloId}</strong>
          </EuiText>
        ),
      },
      {
        name: 'Status',
        render: (c: OrphanCandidate) => (
          <OrphanIntegrityBadge integrity={c.specIntegrity} testSubjSuffix={c.sloId} />
        ),
      },
      {
        name: 'Fingerprints',
        render: (c: OrphanCandidate) => (
          <EuiText size="s">{c.fingerprints.length} recording groups</EuiText>
        ),
      },
      {
        align: 'right',
        width: '40px',
        isExpander: true,
        render: (c: OrphanCandidate) => {
          const key = rowKey(c);
          const expanded = Boolean(itemIdToExpandedRowMap[key]);
          return (
            <EuiButtonEmpty
              size="s"
              iconType={expanded ? 'arrowUp' : 'arrowDown'}
              data-test-subj={`sloAdoption-cloneTab-expandButton-${c.sloId}`}
              onClick={() => toggleExpand(c)}
            >
              {expanded ? 'Hide' : 'Preview'}
            </EuiButtonEmpty>
          );
        },
      },
    ],
    [itemIdToExpandedRowMap, selected, toggleExpand, toggleSelect]
  );

  const itemId = useCallback((c: OrphanCandidate) => rowKey(c), []);

  return (
    <div data-test-subj="sloAdoption-cloneTab">
      <EuiPanel paddingSize="m">
        <EuiTitle size="xs">
          <h3>Source datasource</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiFormRow
          label="Pick a source datasource"
          helpText={dsError ? `Datasource fetch failed: ${dsError.message}` : undefined}
        >
          <EuiSelect
            data-test-subj="sloAdoption-cloneTab-sourceSelect"
            options={sourceOptions}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            isLoading={dsLoading}
          />
        </EuiFormRow>
      </EuiPanel>

      <EuiSpacer size="m" />

      {!sourceId ? (
        <EuiPanel paddingSize="m" data-test-subj="sloAdoption-cloneTab-sourcePlaceholder">
          <EuiText size="s" color="subdued">
            Pick a source datasource above to list its adoptable rule groups.
          </EuiText>
        </EuiPanel>
      ) : loadingCandidates ? (
        <EuiPanel paddingSize="m">
          <EuiFlexGroup justifyContent="center" alignItems="center">
            <EuiFlexItem grow={false}>
              <EuiLoadingSpinner size="m" />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="s">Loading candidates…</EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiPanel>
      ) : candidateError ? (
        <EuiCallOut
          color="danger"
          iconType="alert"
          title="Failed to load candidates"
          data-test-subj="sloAdoption-cloneTab-candidateError"
        >
          {candidateError}
        </EuiCallOut>
      ) : (
        <EuiPanel paddingSize="s">
          <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiText size="s" color="subdued">
                {candidates.length} candidate{candidates.length === 1 ? '' : 's'} · {selected.size}{' '}
                selected
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="xs" />
          <EuiInMemoryTable<OrphanCandidate>
            items={candidates}
            columns={columns}
            itemId={itemId}
            itemIdToExpandedRowMap={itemIdToExpandedRowMap}
            isExpandable
            data-test-subj="sloAdoption-cloneTab-table"
          />
        </EuiPanel>
      )}

      {selectedCandidates.length > 0 ? (
        <>
          <EuiSpacer size="m" />
          <EuiPanel paddingSize="m" data-test-subj="sloAdoption-cloneTab-form">
            <EuiTitle size="xs">
              <h3>
                {isBulk ? `Clone ${selectedCandidates.length} selected SLOs` : 'Clone selected SLO'}
              </h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiFormRow label="Target datasource">
              <EuiSelect
                data-test-subj="sloAdoption-cloneTab-targetSelect"
                options={targetOptions}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              />
            </EuiFormRow>
            {!isBulk ? (
              <>
                <EuiFormRow
                  label="Override name (optional)"
                  helpText="Leave blank to reuse the source SLO's name."
                >
                  <EuiFieldText
                    data-test-subj="sloAdoption-cloneTab-overrideName"
                    value={overrideName}
                    onChange={(e) => setOverrideName(e.target.value)}
                  />
                </EuiFormRow>
                <EuiAccordion
                  id="sloAdoption-cloneTab-overrideIdAccordion"
                  buttonContent="Advanced: override SLO id"
                  data-test-subj="sloAdoption-cloneTab-overrideIdAccordion"
                  paddingSize="s"
                >
                  <EuiFormRow
                    label="Override id (optional)"
                    helpText="Must match /^[a-z][a-z0-9-]{2,62}$/."
                  >
                    <EuiFieldText
                      data-test-subj="sloAdoption-cloneTab-overrideId"
                      value={overrideId}
                      onChange={(e) => setOverrideId(e.target.value)}
                    />
                  </EuiFormRow>
                </EuiAccordion>
              </>
            ) : (
              <EuiText size="s" color="subdued">
                Bulk clone keeps source names — rename each clone separately from the detail page if
                needed.
              </EuiText>
            )}
            <EuiSpacer size="s" />
            {hasBlockedSelection ? (
              <>
                <EuiCallOut color="warning" size="s" title="Some selected rows are blocked" />
                <EuiSpacer size="s" />
              </>
            ) : null}
            <EuiFlexGroup gutterSize="s" alignItems="center">
              <EuiFlexItem grow={false}>
                <EuiButton
                  fill
                  data-test-subj="sloAdoption-cloneTab-submit"
                  isLoading={submitting}
                  isDisabled={!targetId || hasBlockedSelection || selectedCandidates.length === 0}
                  onClick={submit}
                >
                  {isBulk ? `Clone ${selectedCandidates.length} selected` : 'Clone'}
                </EuiButton>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  data-test-subj="sloAdoption-cloneTab-clearSelection"
                  onClick={() => setSelected(new Set())}
                >
                  Clear selection
                </EuiButtonEmpty>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiPanel>
        </>
      ) : null}

      {rowErrors.length > 0 ? (
        <>
          <EuiSpacer size="s" />
          {rowErrors.map((r) => (
            <EuiCallOut
              key={r.key}
              color="danger"
              iconType="alert"
              size="s"
              title={`Clone failed: ${r.name}`}
              data-test-subj={`sloAdoption-cloneTab-rowError-${r.key}`}
            >
              {r.message}
            </EuiCallOut>
          ))}
        </>
      ) : null}
    </div>
  );
};
