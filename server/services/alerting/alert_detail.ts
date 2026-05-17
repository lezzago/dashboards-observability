/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alert detail resolvers — loaded on demand when the user opens a rule or
 * alert flyout. Split out from `alert_service.ts` as standalone functions
 * (no `this`) that take the backends + client + datasource service as
 * parameters.
 *
 * Contents:
 *   - `getRuleDetail` — dispatches to OS or Prom based on the datasource type
 *   - `getOSRuleDetail` — full OS monitor detail (history, routing, preview)
 *   - `getPromRuleDetail` — full Prometheus rule detail
 *   - `getAlertDetail` — full alert detail with raw backend data
 */
import {
  AlertHistoryEntry,
  AlertingOSClient,
  Datasource,
  DatasourceService,
  OpenSearchBackend,
  PromAlertingRule,
  PromRuleGroup,
  PrometheusBackend,
  UnifiedAlert,
  UnifiedRule,
} from '../../../common/types/alerting';
import type { PromFilterProbe } from './prom_filter_probe';
import {
  detectMonitorKind,
  osAlertToUnified,
  osMonitorToUnifiedRuleSummary,
  osStateToUnified,
  promRuleToUnified,
  promStateToUnified,
} from './alert_utils';
import { fetchOSPreviewTimeSeries, fetchPromPreviewData } from './alert_preview';

/**
 * Get full detail for a single rule/monitor. Fetches real metadata from
 * the backend (alert history, annotations). Fields that cannot be fetched
 * from the API are marked as mock placeholders. Notification routing is
 * lazily fetched by the flyout from `/routing`; this resolver no longer
 * builds it.
 */
export async function getRuleDetail(
  datasourceService: DatasourceService,
  osBackend: OpenSearchBackend | undefined,
  promBackend: PrometheusBackend | undefined,
  client: AlertingOSClient,
  dsId: string,
  ruleId: string,
  promFilterProbe?: PromFilterProbe
): Promise<UnifiedRule | null> {
  const ds = await datasourceService.get(dsId);
  if (!ds) return null;

  if (ds.type === 'opensearch' && osBackend) {
    return getOSRuleDetail(osBackend, client, ds, ruleId);
  } else if (ds.type === 'prometheus' && promBackend) {
    return getPromRuleDetail(promBackend, client, ds, ruleId, promFilterProbe);
  }
  return null;
}

export async function getOSRuleDetail(
  osBackend: OpenSearchBackend,
  client: AlertingOSClient,
  ds: Datasource,
  monitorId: string
): Promise<UnifiedRule | null> {
  const monitor = await osBackend.getMonitor(client, monitorId);
  if (!monitor) return null;

  const summary = osMonitorToUnifiedRuleSummary(monitor, ds.id);

  // Fetch real alert history for this monitor
  let alertHistory: AlertHistoryEntry[] = [];
  try {
    const { alerts } = await osBackend.getAlerts(client, { monitorId });
    alertHistory = alerts.slice(0, 20).map((a) => ({
      timestamp: new Date(a.start_time).toISOString(),
      state: osStateToUnified(a.state),
      value: a.severity,
      message: a.error_message || (a.state === 'ACTIVE' ? 'Threshold exceeded' : 'Resolved'),
    }));
  } catch {
    // Alert history fetch is best-effort
  }

  // Build description from trigger message template or input type
  const trigger = monitor.triggers[0];
  const kind = detectMonitorKind(monitor);
  const input = monitor.inputs[0];
  let descriptionFallback: string;
  if (kind === 'cluster_metrics' && input && 'uri' in input) {
    descriptionFallback = `Cluster metrics monitor: ${input.uri.api_type} (${input.uri.path})`;
  } else if (kind === 'doc' && input && 'doc_level_input' in input) {
    const docIndices = input.doc_level_input.indices?.join(', ') || 'unknown indices';
    const queryCount = input.doc_level_input.queries?.length ?? 0;
    descriptionFallback = `Document-level monitor targeting ${docIndices} with ${queryCount} queries`;
  } else if (kind === 'bucket' && input && 'search' in input) {
    const bucketIndices = input.search.indices?.join(', ') || 'unknown indices';
    descriptionFallback = `Bucket aggregation monitor targeting ${bucketIndices}`;
  } else {
    const queryIndices = input && 'search' in input ? input.search.indices?.join(', ') : null;
    descriptionFallback = `${summary.monitorType} monitor targeting ${
      queryIndices || 'unknown indices'
    }`;
  }
  const description = trigger?.actions?.[0]?.message_template?.source || descriptionFallback;

  // Fetch condition preview: run the monitor's query as a date_histogram to build a time-series
  let conditionPreviewData: Array<{ timestamp: number; value: number }> = [];
  try {
    conditionPreviewData = await fetchOSPreviewTimeSeries(osBackend, client, ds, monitor);
  } catch {
    // Preview data fetch is best-effort
  }

  return {
    ...summary,
    description,
    // AI summary not available from OS alerting API — empty triggers flyout fallback
    aiSummary: '',
    firingPeriod: undefined,
    lookbackPeriod: undefined,
    alertHistory,
    conditionPreviewData,
    // Notification routing is fetched lazily by the flyout when the user
    // expands the accordion. The dedicated /routing endpoint owns the
    // destinations lookup so the detail path stays cheap.
    notificationRouting: [],
    // Suppression rules from the in-memory service (not from OS API)
    suppressionRules: [],
    raw: monitor,
  };
}

/**
 * Parse the unified ruleId `{dsId}-{groupName}-{ruleName}` into its parts.
 * `dsId` may itself contain `-`, but the convention used by `promRuleToUnified`
 * always concatenates exactly three components in this order. We split from
 * the left taking the first two `-` boundaries and treat everything between
 * the last two as `groupName`, the suffix after the trailing `-{ruleName}`.
 *
 * Returns `undefined` when the id can't be parsed — caller falls back to a
 * full scan, which preserves correctness against unexpected id shapes.
 */
function parsePromRuleId(
  ruleId: string,
  dsId: string
): { groupName: string; ruleName: string } | undefined {
  if (!ruleId.startsWith(`${dsId}-`)) return undefined;
  const tail = ruleId.slice(dsId.length + 1);
  const idx = tail.indexOf('-');
  if (idx <= 0 || idx === tail.length - 1) return undefined;
  return { groupName: tail.slice(0, idx), ruleName: tail.slice(idx + 1) };
}

export async function getPromRuleDetail(
  promBackend: PrometheusBackend,
  client: AlertingOSClient,
  ds: Datasource,
  ruleId: string,
  promFilterProbe?: PromFilterProbe
): Promise<UnifiedRule | null> {
  const parsed = parsePromRuleId(ruleId, ds.id);

  let groups: PromRuleGroup[];
  if (parsed && promFilterProbe) {
    const probeResult = await promFilterProbe.probe(client, ds);
    if (probeResult.status === 'pushdown-works') {
      groups = await promBackend.getRuleGroups(
        client,
        ds,
        { ruleGroup: parsed.groupName, ruleName: parsed.ruleName, type: 'alert' },
        { includeAlerts: true }
      );
    } else {
      groups = await promBackend.getRuleGroups(client, ds, undefined, { includeAlerts: true });
    }
  } else {
    groups = await promBackend.getRuleGroups(client, ds, undefined, { includeAlerts: true });
  }

  // Post-filter for correctness — a Cortex upstream that only partially
  // honors `rule_group` / `rule_name` would otherwise sneak the wrong rule
  // through. Cost is O(returned rules), which is 1 in the happy path and
  // ≤ N (full listing) in fallback.
  for (const group of groups) {
    for (const rule of group.rules) {
      if (rule.type !== 'alerting') continue;
      const alertingRule = rule as PromAlertingRule;
      const id = `${ds.id}-${group.name}-${alertingRule.name}`;
      if (id !== ruleId) continue;

      const summary = promRuleToUnified(alertingRule, group.name, ds.id);

      // Real alert history from the rule's embedded alerts
      const alertHistory: AlertHistoryEntry[] = (alertingRule.alerts || []).map((a) => ({
        timestamp: a.activeAt,
        state: promStateToUnified(a.state),
        value: a.value,
        message: a.annotations.summary || a.annotations.description || a.state,
      }));

      // Description from annotations
      const description =
        alertingRule.annotations.description ||
        alertingRule.annotations.summary ||
        `PromQL rule: ${alertingRule.query}`;

      return {
        ...summary,
        description,
        // AI summary not available from Prometheus API — empty triggers flyout fallback
        aiSummary: '',
        firingPeriod: undefined,
        lookbackPeriod: undefined,
        alertHistory,
        conditionPreviewData: await fetchPromPreviewData(
          promBackend,
          client,
          ds,
          alertingRule.query,
          alertingRule
        ),
        notificationRouting: [],
        suppressionRules: [],
        raw: alertingRule,
      };
    }
  }
  return null;
}

/**
 * Get full detail for a single alert including raw backend data.
 *
 * `monitorId` (optional) scopes the OS lookup to one monitor's alerts via
 * the `monitorId` query param on `_plugins/_alerting/monitors/alerts`. The
 * unified flyout already has it on the summary; passing it avoids the
 * full-cluster scan that this function used to do. Without it, the
 * legacy unscoped path is preserved for any direct-API consumer.
 *
 * For Prometheus we no longer scan every firing alert to find one — the
 * matrix is unbounded by alert cardinality and the flyout already has the
 * labels/annotations it needs. Returns `null` so the client renders the
 * Raw Alert Data accordion from the summary's labels/annotations.
 */
export async function getAlertDetail(
  datasourceService: DatasourceService,
  osBackend: OpenSearchBackend | undefined,
  promBackend: PrometheusBackend | undefined,
  client: AlertingOSClient,
  dsId: string,
  alertId: string,
  monitorId?: string
): Promise<UnifiedAlert | null> {
  const ds = await datasourceService.get(dsId);
  if (!ds) return null;

  if (ds.type === 'opensearch' && osBackend) {
    const { alerts } = await osBackend.getAlerts(client, monitorId ? { monitorId } : undefined);
    const alert = alerts.find((a) => a.id === alertId);
    if (!alert) return null;
    const summary = osAlertToUnified(alert, ds!.id);
    return { ...summary, raw: alert };
  } else if (ds.type === 'prometheus' && promBackend) {
    return null;
  }
  return null;
}
