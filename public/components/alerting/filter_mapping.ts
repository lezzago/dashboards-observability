/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for translating UI filter state into the server
 * filter parameters consumed by both:
 *   - the alerts/rules listing endpoints (`/api/alerting/unified/{alerts,rules}`)
 *   - the alerts timeline endpoint (`/api/alerting/unified/alerts/timeline`)
 *
 * Drift between the two is the most likely Phase 4 bug — chart-vs-table
 * divergence becomes user-visible (chart shows bars for filtered-out
 * alerts) when the timeline receives a different filter set than the
 * table.
 */
import type { AlertsDashboardFilterSnapshot } from './alerts_dashboard';
import type { FilterState as RulesFilterState } from './monitors_table/monitors_table_filters';

export interface AlertsFilterParams {
  severity?: string[];
  state?: string[];
  labels?: Record<string, string[]>;
}

export interface RulesFilterParams {
  status?: string[];
  severity?: string[];
  monitorType?: string[];
  healthStatus?: string[];
  createdBy?: string[];
  labels?: Record<string, string[]>;
}

/**
 * Map the alerts dashboard's filter state (panel filters + stat-card
 * single-selects) to a normalized `AlertsFilterParams` shape. Panel
 * filters (`filters.severity[]`) win over the stat-card single-select
 * (`severityFilter`) — same precedence the table renders today via
 * `filteredAlerts` in `alerts_dashboard.tsx`.
 *
 * Note: `backend[]` is NOT mapped here — it is resolved client-side by
 * intersecting with `dsIds` before issuing the listing/timeline calls.
 */
export function mapAlertFilters(snapshot: AlertsDashboardFilterSnapshot): AlertsFilterParams {
  const out: AlertsFilterParams = {};

  if (snapshot.severity.length > 0) {
    out.severity = snapshot.severity;
  } else if (snapshot.severityCard === 'medium') {
    out.severity = ['medium', 'low', 'info'];
  } else if (snapshot.severityCard !== 'all') {
    out.severity = [snapshot.severityCard];
  }

  if (snapshot.state.length > 0) {
    out.state = snapshot.state;
  } else if (snapshot.stateCard !== 'all') {
    out.state = [snapshot.stateCard];
  }

  const filteredLabels: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(snapshot.labels)) {
    if (vs.length > 0) filteredLabels[k] = vs;
  }
  if (Object.keys(filteredLabels).length > 0) out.labels = filteredLabels;

  return out;
}

/**
 * Map the rules table's filter state to a normalized
 * `RulesFilterParams` shape. `destinations[]` and the search query are
 * deliberately not pushed to the server — destinations require an O(N)
 * join the upstream can't express, and search push-down is deferred to
 * Phase 5. `backend[]` is resolved client-side as for alerts.
 */
export function mapRuleFilters(filters: RulesFilterState): RulesFilterParams {
  const out: RulesFilterParams = {};
  if (filters.status.length > 0) out.status = filters.status;
  if (filters.severity.length > 0) out.severity = filters.severity;
  if (filters.monitorType.length > 0) out.monitorType = filters.monitorType;
  if (filters.healthStatus.length > 0) out.healthStatus = filters.healthStatus;
  if (filters.createdBy.length > 0) out.createdBy = filters.createdBy;

  const filteredLabels: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(filters.labels)) {
    if (vs.length > 0) filteredLabels[k] = vs;
  }
  if (Object.keys(filteredLabels).length > 0) out.labels = filteredLabels;
  return out;
}

/**
 * Resolve a `backend[]` UI filter into a narrowed `dsIds` set by
 * intersecting with the currently-loaded datasource list. Caller-side
 * concern shared by the alerts table, rules table, and timeline hook.
 */
export function resolveBackendDsIds(
  selectedDsIds: string[],
  backendFilter: string[],
  datasources: Array<{ id: string; type: string }>
): string[] {
  if (backendFilter.length === 0) return selectedDsIds;
  const set = new Set(backendFilter);
  return selectedDsIds.filter((id) => {
    const ds = datasources.find((d) => d.id === id);
    return ds ? set.has(ds.type) : true;
  });
}
