/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session C — Legacy-orphans tab.
 *
 * Sibling of the Recover tab. Reads the same `_orphans` payload but filters
 * to rows the reconciler tagged `"pre-Phase-3 rule layout; not eligible for
 * adoption"` and exposes a bulk-purge action for each one. The purge
 * endpoint is admin-gated server-side — the tab is only mounted when the
 * feature flag `observability.slo.legacyOrphanPurge.enabled` is on.
 *
 * Notes:
 *   - The UI is NOT trusted for deletion. The server re-validates the name
 *     pattern, namespace, no-owning-SO, and ruler presence; the tab's
 *     "select all" just nominates candidates the server may still refuse.
 *     Post-purge toast always reports both the purged count AND any
 *     skipped / failed counts so operators see the drift.
 *   - Reuses the memoized-table-inside-EuiResizableContainer pattern from
 *     `SlosTablePanel` (`slo_listing_page.tsx:372-442`). Not wrapped in a
 *     resizable container in this component, but the project's convention
 *     for any table inside the admin tabs is to memoize anyway — mousemove
 *     inside the adjoining panels triggers re-renders on the parent and
 *     Chrome drops pagination clicks when the table re-renders mid-click.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonIcon,
  EuiCallOut,
  EuiConfirmModal,
  EuiEmptyPrompt,
  EuiFlexGroup,
  EuiFlexItem,
  EuiInMemoryTable,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { NotificationsStart } from '../../../../../../../../src/core/public';
import type {
  LegacyPurgeAuditRecord,
  LegacyPurgeResponse,
  OrphanUnknown,
  SloApiClient,
} from '../slo_api_client';

export interface LegacyTabProps {
  apiClient: SloApiClient;
  notifications: NotificationsStart;
  /** Entries filtered by the page to ones tagged as legacy. */
  legacyOrphans: OrphanUnknown[];
  /** Called after a purge so the parent can re-fetch and update its own state. */
  onPurgeComplete?: () => void;
}

/** Stable per-row identity. */
function rowKey(o: OrphanUnknown): string {
  return `${o.datasourceId}::${o.namespace}::${o.groupName}`;
}

/**
 * Best-effort parse of the originating SLO name slug from a legacy group
 * name of shape `slo:<slug>_<8-hex>`. Returns the raw slug as fallback so
 * the column never shows empty.
 */
function parseOriginatingSloSlug(groupName: string): string {
  const stripped = groupName.startsWith('slo:') ? groupName.slice(4) : groupName;
  const underscoreIdx = stripped.lastIndexOf('_');
  if (underscoreIdx <= 0) return stripped;
  return stripped.slice(0, underscoreIdx);
}

/**
 * Session E (F3) — format `firstSeenAt` as a relative-time string. Matches
 * the thresholds called out in the plan: "Just now" under a minute,
 * "N minutes ago" under an hour, "N hours ago" under a day, "N days ago"
 * from there. Fallback "Unknown" when the observation hook hasn't run yet
 * (e.g. pre-F3 deployment or first sweep still pending).
 *
 * Not using `EuiRelativeTime` / `moment.fromNow` here — both pull in i18n
 * context we don't wire in this tab, and the granularity we need is
 * coarser than their defaults. A small pure function keeps the column
 * cheap to render while a table is being mousemove-re-rendered inside an
 * EuiResizableContainer (see CLAUDE.md).
 */
export function formatRelativeAge(firstSeenAt: string | undefined, now: Date = new Date()): string {
  if (!firstSeenAt) return 'Unknown';
  const firstMs = Date.parse(firstSeenAt);
  if (!Number.isFinite(firstMs)) return 'Unknown';
  const deltaMs = now.getTime() - firstMs;
  if (deltaMs < 60_000) return 'Just now';
  if (deltaMs < 60 * 60_000) {
    const n = Math.floor(deltaMs / 60_000);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (deltaMs < 24 * 60 * 60_000) {
    const n = Math.floor(deltaMs / (60 * 60_000));
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const n = Math.floor(deltaMs / (24 * 60 * 60_000));
  return `${n} day${n === 1 ? '' : 's'} ago`;
}

function errorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const body = (err as { body?: { message?: unknown; attributes?: { message?: unknown } } }).body;
  if (body) {
    if (typeof body.message === 'string') return body.message;
    if (body.attributes && typeof body.attributes.message === 'string') {
      return body.attributes.message as string;
    }
  }
  if ((err as Error).message) return (err as Error).message;
  return 'Request failed';
}

interface LegacyTableProps {
  items: OrphanUnknown[];
  columns: Array<EuiBasicTableColumn<OrphanUnknown>>;
  selection: {
    selectable: () => boolean;
    onSelectionChange: (items: OrphanUnknown[]) => void;
  };
  itemId: (o: OrphanUnknown) => string;
  loading: boolean;
  /**
   * Session E (F4) — per-row audit history accordion. Passed from the
   * parent so the expansion state lives in one place; the parent owns
   * the audit fetch because the map is keyed on row identity and the
   * table re-renders on every mousemove inside an EuiResizableContainer
   * (see CLAUDE.md). Keys are `rowKey(orphan)`.
   */
  itemIdToExpandedRowMap: Record<string, React.ReactNode>;
}

const LegacyTableUI: React.FC<LegacyTableProps> = ({
  items,
  columns,
  selection,
  itemId,
  loading,
  itemIdToExpandedRowMap,
}) => (
  <EuiInMemoryTable<OrphanUnknown>
    items={items}
    columns={columns}
    itemId={itemId}
    isSelectable
    selection={selection}
    isExpandable
    itemIdToExpandedRowMap={itemIdToExpandedRowMap}
    pagination={{ initialPageSize: 20, pageSizeOptions: [10, 20, 50, 100] }}
    loading={loading}
    data-test-subj="sloAdoption-legacyTab-table"
  />
);

const LegacyTable = React.memo(LegacyTableUI);

/**
 * Session E (F4) — renders the audit timeline for a single legacy orphan
 * group. Called only when the row is expanded.
 *
 * Three states:
 *   - `loading` — fetch in flight, render a spinner.
 *   - `error`   — fetch failed, render the message.
 *   - otherwise — render the audit records in descending `requestedAt`
 *     order, or the empty-state "No purge history for this group."
 */
interface AuditTimelineProps {
  state: AuditFetchState;
}

function outcomeBadgeColor(o: LegacyPurgeAuditRecord['outcome']): string {
  switch (o) {
    case 'purged':
      return 'success';
    case 'skipped_validation':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'default';
  }
}

const AuditTimeline: React.FC<AuditTimelineProps> = ({ state }) => {
  if (state.status === 'loading') {
    return (
      <EuiPanel
        paddingSize="s"
        color="subdued"
        data-test-subj="sloAdoption-legacyTab-auditTimeline-loading"
      >
        <EuiFlexGroup alignItems="center" gutterSize="s">
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="s" />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiText size="s">Loading purge history…</EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    );
  }
  if (state.status === 'error') {
    return (
      <EuiCallOut
        color="warning"
        size="s"
        iconType="alert"
        title="Could not load purge history"
        data-test-subj="sloAdoption-legacyTab-auditTimeline-error"
      >
        <EuiText size="s">{state.message}</EuiText>
      </EuiCallOut>
    );
  }
  if (state.records.length === 0) {
    return (
      <EuiText size="s" color="subdued" data-test-subj="sloAdoption-legacyTab-auditTimeline-empty">
        No purge history for this group.
      </EuiText>
    );
  }
  return (
    <EuiPanel paddingSize="s" color="subdued" data-test-subj="sloAdoption-legacyTab-auditTimeline">
      <EuiText size="xs" color="subdued">
        <strong>Purge history</strong>
      </EuiText>
      <EuiSpacer size="xs" />
      <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
        {state.records.map((r) => (
          <li
            key={`${r.requestedAt}::${r.outcome}`}
            data-test-subj={`sloAdoption-legacyTab-auditRecord-${r.outcome}`}
            style={{ marginBottom: 4 }}
          >
            <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiBadge color={outcomeBadgeColor(r.outcome)}>{r.outcome}</EuiBadge>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="xs">{r.requestedAt}</EuiText>
              </EuiFlexItem>
              {r.requestedBy ? (
                <EuiFlexItem grow={false}>
                  <EuiText size="xs" color="subdued">
                    by {r.requestedBy}
                  </EuiText>
                </EuiFlexItem>
              ) : null}
              {r.reason ? (
                <EuiFlexItem>
                  <EuiText size="xs" color="subdued">
                    {r.reason}
                    {r.claimantSloId ? ` (claimed by ${r.claimantSloId})` : ''}
                  </EuiText>
                </EuiFlexItem>
              ) : null}
              {r.errorCode ? (
                <EuiFlexItem>
                  <EuiText size="xs" color="subdued">
                    {r.errorCode}
                    {r.errorHttpStatus ? ` (HTTP ${r.errorHttpStatus})` : ''}
                  </EuiText>
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
          </li>
        ))}
      </ul>
    </EuiPanel>
  );
};

/**
 * Session E (F4) — parent-managed per-row audit fetch state. Keyed on
 * rowKey so the parent can keep the state out of the memoized table's
 * render path.
 */
type AuditFetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; records: LegacyPurgeAuditRecord[] };

export const LegacyTab: React.FC<LegacyTabProps> = ({
  apiClient,
  notifications,
  legacyOrphans,
  onPurgeComplete,
}) => {
  const [selected, setSelected] = useState<OrphanUnknown[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<LegacyPurgeResponse | null>(null);
  // Session E (F4) — per-row audit fetch state keyed by rowKey. When a row
  // collapses, we drop its entry so the next expand triggers a fresh fetch
  // (audit records may have accrued since).
  const [auditByKey, setAuditByKey] = useState<Record<string, AuditFetchState>>({});

  const datasourceIdsInSelection = useMemo(
    () => Array.from(new Set(selected.map((o) => o.datasourceId))),
    [selected]
  );

  const multiDatasourceSelection = datasourceIdsInSelection.length > 1;

  const handleSelectionChange = useCallback((items: OrphanUnknown[]) => {
    setSelected(items);
  }, []);

  const selectionConfig = useMemo(
    () => ({
      selectable: () => true,
      onSelectionChange: handleSelectionChange,
    }),
    [handleSelectionChange]
  );

  const itemId = useCallback((o: OrphanUnknown) => rowKey(o), []);

  // Session E (F4) — row-expand handler. Toggles the audit timeline for a
  // given orphan. First expansion fires off an audit-list fetch scoped to
  // (datasourceId, groupName); failures render inline, success replaces
  // the loading state with the records. Collapses drop the entry so a
  // re-expansion picks up any new audit records.
  const toggleExpand = useCallback(
    async (o: OrphanUnknown) => {
      const key = rowKey(o);
      setAuditByKey((prev) => {
        if (prev[key]) {
          const { [key]: _drop, ...rest } = prev;
          return rest;
        }
        return { ...prev, [key]: { status: 'loading' } as AuditFetchState };
      });
      // Avoid a stale closure by checking the open-or-closed state we just
      // scheduled: if we just collapsed, skip the fetch.
      const willCollapse = auditByKey[key] !== undefined;
      if (willCollapse) return;
      try {
        const result = await apiClient.listLegacyPurgeAudit({
          datasourceId: o.datasourceId,
          groupName: o.groupName,
        });
        setAuditByKey((prev) => ({
          ...prev,
          [key]: { status: 'ready', records: result.records },
        }));
      } catch (err) {
        setAuditByKey((prev) => ({
          ...prev,
          [key]: { status: 'error', message: errorMessage(err) },
        }));
      }
    },
    [apiClient, auditByKey]
  );

  const itemIdToExpandedRowMap = useMemo(() => {
    const map: Record<string, React.ReactNode> = {};
    for (const o of legacyOrphans) {
      const key = rowKey(o);
      const state = auditByKey[key];
      if (state) map[key] = <AuditTimeline state={state} />;
    }
    return map;
  }, [legacyOrphans, auditByKey]);

  const columns = useMemo<Array<EuiBasicTableColumn<OrphanUnknown>>>(
    () => [
      {
        name: 'Group name',
        render: (o: OrphanUnknown) => (
          <EuiText size="s" data-test-subj={`sloAdoption-legacyTab-groupName-${o.groupName}`}>
            <code>{o.groupName}</code>
          </EuiText>
        ),
      },
      {
        name: 'Originating SLO',
        render: (o: OrphanUnknown) => (
          <EuiText size="s" color="subdued">
            {parseOriginatingSloSlug(o.groupName)}
          </EuiText>
        ),
      },
      {
        name: 'Namespace',
        render: (o: OrphanUnknown) => (
          <EuiText size="s" color="subdued">
            {o.namespace}
          </EuiText>
        ),
      },
      {
        name: 'Datasource',
        render: (o: OrphanUnknown) => <EuiText size="s">{o.datasourceId}</EuiText>,
      },
      {
        // Session E (F4) — row-expand column. Toggles an inline audit
        // history timeline. The arrow orientation reflects the expansion
        // state so admins can see at a glance which rows they've opened.
        align: 'right',
        width: '40px',
        name: '',
        render: (o: OrphanUnknown) => {
          const isOpen = Boolean(auditByKey[rowKey(o)]);
          return (
            <EuiButtonIcon
              onClick={() => toggleExpand(o)}
              aria-label={isOpen ? 'Collapse purge history' : 'Expand purge history'}
              iconType={isOpen ? 'arrowDown' : 'arrowRight'}
              data-test-subj={`sloAdoption-legacyTab-expand-${o.groupName}`}
            />
          );
        },
      },
      {
        // Session E (F3) — Age column reads the reconciler-persisted
        // firstSeenAt. Fallback "Unknown" when the sweep hasn't written an
        // observation yet (either pre-F3 deployment or fresh install
        // before the first sweep interval). Hover tooltip surfaces the
        // absolute ISO timestamp for operator diagnostics.
        name: 'Age',
        render: (o: OrphanUnknown) => {
          const label = formatRelativeAge(o.firstSeenAt);
          if (!o.firstSeenAt) {
            return (
              <EuiText
                size="s"
                color="subdued"
                data-test-subj={`sloAdoption-legacyTab-age-${o.groupName}`}
              >
                {label}
              </EuiText>
            );
          }
          return (
            <EuiToolTip position="top" content={o.firstSeenAt}>
              <EuiText size="s" data-test-subj={`sloAdoption-legacyTab-age-${o.groupName}`}>
                {label}
              </EuiText>
            </EuiToolTip>
          );
        },
      },
    ],
    [auditByKey, toggleExpand]
  );

  const performPurge = useCallback(async () => {
    if (selected.length === 0) return;
    if (multiDatasourceSelection) {
      setPurgeError(
        'Purges run per datasource. Narrow the selection to one datasource and try again.'
      );
      setConfirmOpen(false);
      return;
    }
    setInFlight(true);
    setPurgeError(null);
    try {
      const datasourceId = datasourceIdsInSelection[0];
      const result = await apiClient.purgeLegacyOrphans({
        datasourceId,
        groups: selected.map((o) => ({ groupName: o.groupName, namespace: o.namespace })),
      });
      setLastResult(result);
      const skipped = result.skipped_validation.length;
      const failed = result.failed.length;
      if (failed > 0 || skipped > 0) {
        notifications.toasts.addWarning({
          title: `Purged ${result.purged} of ${result.requested} legacy groups`,
          text: `${skipped} skipped by validation · ${failed} failed to delete. See details below.`,
        });
      } else {
        notifications.toasts.addSuccess({
          title: `Purged ${result.purged} legacy rule group${result.purged === 1 ? '' : 's'}`,
          text: `Removed from ${datasourceId}. External dashboards bound to these rule names will stop receiving data.`,
        });
      }
      setSelected([]);
      if (onPurgeComplete) onPurgeComplete();
    } catch (err) {
      setPurgeError(errorMessage(err));
    } finally {
      setInFlight(false);
      setConfirmOpen(false);
    }
  }, [
    selected,
    multiDatasourceSelection,
    datasourceIdsInSelection,
    apiClient,
    notifications.toasts,
    onPurgeComplete,
  ]);

  const singleDatasourceId = datasourceIdsInSelection[0];

  return (
    <div data-test-subj="sloAdoption-legacyTab">
      <EuiCallOut
        size="s"
        iconType="iInCircle"
        title="Legacy pre-dedup rule groups"
        data-test-subj="sloAdoption-legacyTab-callout"
      >
        <p>
          These rule groups were created before the dedup migration (schema v3) and have no owning
          SLO. They cannot be adopted and will not evaluate. Purging removes them from the
          Prometheus-compatible ruler.
        </p>
      </EuiCallOut>
      <EuiSpacer size="s" />

      <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" responsive={false}>
        <EuiFlexItem>
          <EuiText size="s" color="subdued">
            {legacyOrphans.length} legacy rule group{legacyOrphans.length === 1 ? '' : 's'} ·{' '}
            {selected.length} selected
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton
            color="danger"
            iconType="trash"
            size="s"
            isDisabled={selected.length === 0 || inFlight}
            isLoading={inFlight}
            onClick={() => setConfirmOpen(true)}
            data-test-subj="sloAdoption-legacyTab-purgeSelected"
          >
            Purge {selected.length} selected
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />

      {multiDatasourceSelection ? (
        <>
          <EuiCallOut
            color="warning"
            size="s"
            iconType="alert"
            title="Selection spans multiple datasources"
            data-test-subj="sloAdoption-legacyTab-multiDsWarning"
          >
            <p>
              Purges are scoped to a single datasource per request. Narrow your selection to rows
              from one datasource before purging.
            </p>
          </EuiCallOut>
          <EuiSpacer size="s" />
        </>
      ) : null}

      {purgeError ? (
        <>
          <EuiCallOut
            color="danger"
            iconType="alert"
            size="s"
            title="Purge failed"
            data-test-subj="sloAdoption-legacyTab-purgeError"
          >
            {purgeError}
          </EuiCallOut>
          <EuiSpacer size="s" />
        </>
      ) : null}

      <EuiPanel paddingSize="s">
        {legacyOrphans.length === 0 ? (
          <EuiEmptyPrompt
            iconType="check"
            title={<h3>No legacy rule groups</h3>}
            body={
              <p>
                The reconciler did not report any pre-dedup rule groups. If you just purged them,
                refresh the Recover tab to confirm the reconciler picked up the change.
              </p>
            }
            data-test-subj="sloAdoption-legacyTab-emptyPrompt"
          />
        ) : (
          <LegacyTable
            items={legacyOrphans}
            columns={columns}
            selection={selectionConfig}
            itemId={itemId}
            loading={inFlight}
            itemIdToExpandedRowMap={itemIdToExpandedRowMap}
          />
        )}
      </EuiPanel>

      {lastResult && (lastResult.skipped_validation.length > 0 || lastResult.failed.length > 0) ? (
        <>
          <EuiSpacer size="m" />
          <EuiPanel paddingSize="s" data-test-subj="sloAdoption-legacyTab-lastResultPanel">
            <EuiText size="s">
              <h4>Last purge outcome</h4>
              <p>
                Requested {lastResult.requested} · Purged {lastResult.purged} · Skipped{' '}
                {lastResult.skipped_validation.length} · Failed {lastResult.failed.length}
              </p>
            </EuiText>
            {lastResult.skipped_validation.length > 0 ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <strong>Skipped:</strong>
                </EuiText>
                <ul data-test-subj="sloAdoption-legacyTab-skippedList">
                  {lastResult.skipped_validation.map((s) => (
                    <li key={`${s.namespace}::${s.groupName}`}>
                      <code>{s.groupName}</code> — {s.reason}
                      {s.claimantSloId ? ` (claimed by ${s.claimantSloId})` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {lastResult.failed.length > 0 ? (
              <>
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <strong>Failed:</strong>
                </EuiText>
                <ul data-test-subj="sloAdoption-legacyTab-failedList">
                  {lastResult.failed.map((f) => (
                    <li key={`${f.namespace}::${f.groupName}`}>
                      <code>{f.groupName}</code> — {f.error.code} (HTTP {f.error.httpStatus}):{' '}
                      {f.error.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </EuiPanel>
        </>
      ) : null}

      {confirmOpen ? (
        <EuiConfirmModal
          data-test-subj="sloAdoption-legacyTab-confirmModal"
          title={`Purge ${selected.length} legacy rule group${
            selected.length === 1 ? '' : 's'
          } from ${singleDatasourceId ?? '<datasource>'}?`}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={performPurge}
          cancelButtonText="Cancel"
          confirmButtonText="Purge groups"
          buttonColor="danger"
          defaultFocusedButton="cancel"
          isLoading={inFlight}
        >
          <p>
            These groups were created by this plugin before the dedup migration (schema v3) and have
            no owning SLO. They cannot be adopted and will not evaluate. Purging removes them from
            Prometheus.
          </p>
          <p>
            <strong>This cannot be undone.</strong> Visualizations bound to the old rule names will
            stop receiving data.
          </p>
        </EuiConfirmModal>
      ) : null}
    </div>
  );
};
