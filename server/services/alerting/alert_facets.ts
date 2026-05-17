/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-side facet computation for alerts and rules (Phase 5 / C2).
 *
 * Standard "OR-within-dimension, AND-across-dimensions" facet semantics —
 * each top-level dimension's count is computed with that dimension's own
 * filter EXCLUDED so the count is "what would I see if I added this
 * filter," matching the existing client-side memo's behavior.
 *
 * Cache reuse: hits the same `fetchAlertsRaw` / `fetchRulesRaw` paths used
 * by the listing endpoints — so a facet call within 30s of a listing call
 * (or vice versa) reuses Phase 4's `alertsCache` / `ruleGroupsCache`.
 *
 * Caps:
 *   - `MAX_FACET_SCAN`         — total alerts/rules considered. When the
 *     filter-narrowed set exceeds this we surface `truncated: true` and
 *     compute facets over the truncated slice.
 *   - `MAX_LABEL_KEYS`         — distinct label keys returned in the
 *     `labels` map. Caller can refine filters; UI shows the same
 *     truncated callout as listing.
 *   - `MAX_VALUES_PER_KEY`     — distinct values per label key.
 */
import type {
  AlertingOSClient,
  Datasource,
  DatasourceWarning,
  UnifiedAlertSummary,
  UnifiedFetchOptions,
  UnifiedRuleSummary,
} from '../../../common/types/alerting';
import type { MultiBackendAlertService } from './alert_service';
import {
  applyAlertFilters,
  applyRuleFilters,
  filterDatasourcesByBackend,
  resolveRangeMsFromOptions,
} from './alert_service';

export const MAX_FACET_SCAN = 10_000;
export const MAX_LABEL_KEYS = 20;
export const MAX_VALUES_PER_KEY = 50;

/** Internal label keys hidden from the UI. Mirrors `INTERNAL_LABEL_KEYS`
 *  in `alerts_dashboard.tsx`. */
const INTERNAL_LABEL_KEYS = new Set([
  'monitor_id',
  'datasource_id',
  '_workspace',
  'monitor_type',
  'monitor_kind',
  'trigger_id',
  'trigger_name',
]);

export interface AlertFacetCounts {
  severity: Record<string, number>;
  state: Record<string, number>;
  backend: Record<string, number>;
  labels: Record<string, Record<string, number>>;
  total: number;
  truncated?: boolean;
  warnings?: DatasourceWarning[];
  fetchedAt: string;
}

export interface RuleFacetCounts {
  status: Record<string, number>;
  severity: Record<string, number>;
  monitorType: Record<string, number>;
  healthStatus: Record<string, number>;
  backend: Record<string, number>;
  createdBy: Record<string, number>;
  labels: Record<string, Record<string, number>>;
  total: number;
  truncated?: boolean;
  warnings?: DatasourceWarning[];
  fetchedAt: string;
}

function countBy<T>(items: T[], pick: (item: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const v = pick(item);
    if (v === undefined || v === '') continue;
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

/**
 * Build the `labels` facet map. Each key's value count is computed over
 * the items in which the key appears at all. Internal keys are filtered;
 * keys are sorted alphabetically and capped at `MAX_LABEL_KEYS`. Each
 * key's value map is capped at `MAX_VALUES_PER_KEY`.
 *
 * Returns `[map, truncated]` so the caller can union the truncation flag
 * with the scan-cap signal.
 */
function buildLabelFacets(
  items: Array<{ labels: Record<string, string> }>
): [Record<string, Record<string, number>>, boolean] {
  const allKeys = new Set<string>();
  for (const item of items) {
    for (const k of Object.keys(item.labels)) {
      if (INTERNAL_LABEL_KEYS.has(k)) continue;
      allKeys.add(k);
    }
  }
  const sortedKeys = Array.from(allKeys).sort();
  const keys = sortedKeys.slice(0, MAX_LABEL_KEYS);
  const truncatedKeys = sortedKeys.length > MAX_LABEL_KEYS;

  const out: Record<string, Record<string, number>> = {};
  let truncatedValues = false;
  for (const k of keys) {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const v = item.labels[k];
      if (v === undefined || v === '') continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    const sortedEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sortedEntries.length > MAX_VALUES_PER_KEY) truncatedValues = true;
    const capped = sortedEntries.slice(0, MAX_VALUES_PER_KEY);
    out[k] = Object.fromEntries(capped);
  }
  return [out, truncatedKeys || truncatedValues];
}

/**
 * Strip dimensional filters from `options` so facets compute over the
 * dimensional superset. Keeps `dsIds`, `startTime`/`endTime`,
 * `backend` (resolved into `dsIds` upstream so it's a no-op here but kept
 * for safety), `search`, and `noCache`. `severity`/`state`/`labels`/
 * `monitorType`/`healthStatus`/`createdBy` are dropped.
 */
function stripDimensionalFilters(options: UnifiedFetchOptions): UnifiedFetchOptions {
  return {
    dsIds: options.dsIds,
    backend: options.backend,
    startTime: options.startTime,
    endTime: options.endTime,
    timeoutMs: options.timeoutMs,
    search: options.search,
    noCache: options.noCache,
  };
}

/**
 * Per-datasource alerts fetch — applies range and pushdown but skips
 * dimensional filters so the facet path can recount each dimension. The
 * results are pushed through `applyAlertFilters` with `search` only
 * (search is treated like a search-narrowed superset).
 */
async function fetchFilteredAlerts(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  options: UnifiedFetchOptions
): Promise<{
  alerts: UnifiedAlertSummary[];
  warnings: DatasourceWarning[];
  truncated: boolean;
}> {
  const datasources = filterDatasourcesByBackend(
    await alertSvc.resolveDatasources(options.dsIds),
    options.backend
  );
  const range = resolveRangeMsFromOptions(options);
  const baseOptions = stripDimensionalFilters(options);

  const settled = await Promise.allSettled(
    datasources.map(async (ds: Datasource) => {
      const client = await clientResolver(ds.id);
      return alertSvc.fetchAlertsRaw(client, ds, range, baseOptions);
    })
  );

  const all: UnifiedAlertSummary[] = [];
  const warnings: DatasourceWarning[] = [];
  for (let i = 0; i < datasources.length; i++) {
    const settledI = settled[i];
    if (settledI.status === 'fulfilled') {
      all.push(...settledI.value.alerts);
    } else {
      warnings.push({
        datasourceId: datasources[i].id,
        datasourceName: datasources[i].name,
        datasourceType: datasources[i].type,
        error: String(settledI.reason),
      });
    }
  }

  // Apply `search` post-filter (label / state / severity stripped above).
  // `applyAlertFilters` is the same helper the listing path runs.
  const searchOnly: UnifiedFetchOptions = options.search ? { search: options.search } : {};
  const searched = applyAlertFilters(all, searchOnly);

  let truncated = false;
  let bounded = searched;
  if (searched.length > MAX_FACET_SCAN) {
    truncated = true;
    bounded = searched.slice(0, MAX_FACET_SCAN);
  }
  return { alerts: bounded, warnings, truncated };
}

async function fetchFilteredRules(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  options: UnifiedFetchOptions
): Promise<{
  rules: UnifiedRuleSummary[];
  warnings: DatasourceWarning[];
  truncated: boolean;
}> {
  const datasources = filterDatasourcesByBackend(
    await alertSvc.resolveDatasources(options.dsIds),
    options.backend
  );
  const baseOptions = stripDimensionalFilters(options);

  const settled = await Promise.allSettled(
    datasources.map(async (ds: Datasource) => {
      const client = await clientResolver(ds.id);
      return alertSvc.fetchRulesRaw(client, ds, baseOptions);
    })
  );

  const all: UnifiedRuleSummary[] = [];
  const warnings: DatasourceWarning[] = [];
  for (let i = 0; i < datasources.length; i++) {
    const settledI = settled[i];
    if (settledI.status === 'fulfilled') {
      all.push(...settledI.value);
    } else {
      warnings.push({
        datasourceId: datasources[i].id,
        datasourceName: datasources[i].name,
        datasourceType: datasources[i].type,
        error: String(settledI.reason),
      });
    }
  }

  const searchOnly: UnifiedFetchOptions = options.search ? { search: options.search } : {};
  const searched = applyRuleFilters(all, searchOnly);

  let truncated = false;
  let bounded = searched;
  if (searched.length > MAX_FACET_SCAN) {
    truncated = true;
    bounded = searched.slice(0, MAX_FACET_SCAN);
  }
  return { rules: bounded, warnings, truncated };
}

export async function computeAlertFacets(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  options: UnifiedFetchOptions
): Promise<AlertFacetCounts> {
  const { alerts, warnings, truncated: scanTruncated } = await fetchFilteredAlerts(
    alertSvc,
    clientResolver,
    options
  );

  // For each dimension, recount with that dimension's filter EXCLUDED.
  // The listing path applies `severity`/`state`/`labels` post-filter
  // (Phase 4); facets do the same with one dimension at a time relaxed.
  const severitySet = applyAlertFilters(alerts, {
    ...options,
    severity: undefined,
  });
  const stateSet = applyAlertFilters(alerts, {
    ...options,
    state: undefined,
  });
  // backend is a `dsIds` intersect at fetch time, but the unfiltered
  // fetch already covers the dimensional superset for it; the filter
  // doesn't apply to the post-filter pass, so backend counts equal
  // counts over the full filtered set with all other filters applied.
  const backendSet = applyAlertFilters(alerts, options);
  const labelsSet = applyAlertFilters(alerts, {
    ...options,
    labels: undefined,
  });
  const totalSet = applyAlertFilters(alerts, options);

  const [labels, labelsTruncated] = buildLabelFacets(labelsSet);

  return {
    severity: countBy(severitySet, (a) => a.severity),
    state: countBy(stateSet, (a) => a.state),
    backend: countBy(backendSet, (a) => a.datasourceType),
    labels,
    total: totalSet.length,
    ...(scanTruncated || labelsTruncated ? { truncated: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export async function computeRuleFacets(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  options: UnifiedFetchOptions
): Promise<RuleFacetCounts> {
  const { rules, warnings, truncated: scanTruncated } = await fetchFilteredRules(
    alertSvc,
    clientResolver,
    options
  );

  // Per-dimension recounts with each dimension's filter excluded. The
  // wire field is `state` (mapped to monitor `status` in the rule
  // listing path), so `state` here drives the `status` facet.
  const statusSet = applyRuleFilters(rules, { ...options, state: undefined });
  const severitySet = applyRuleFilters(rules, { ...options, severity: undefined });
  const monitorTypeSet = applyRuleFilters(rules, { ...options, monitorType: undefined });
  const healthStatusSet = applyRuleFilters(rules, { ...options, healthStatus: undefined });
  const createdBySet = applyRuleFilters(rules, { ...options, createdBy: undefined });
  const backendSet = applyRuleFilters(rules, options);
  const labelsSet = applyRuleFilters(rules, { ...options, labels: undefined });
  const totalSet = applyRuleFilters(rules, options);

  const [labels, labelsTruncated] = buildLabelFacets(labelsSet);
  const createdByMap = countBy(createdBySet, (r) => r.createdBy);
  const sortedCreators = Object.entries(createdByMap).sort((a, b) => b[1] - a[1]);
  const createdByTruncated = sortedCreators.length > MAX_VALUES_PER_KEY;
  const cappedCreatedBy: Record<string, number> = Object.fromEntries(
    sortedCreators.slice(0, MAX_VALUES_PER_KEY)
  );

  return {
    status: countBy(statusSet, (r) => r.status),
    severity: countBy(severitySet, (r) => r.severity),
    monitorType: countBy(monitorTypeSet, (r) => r.monitorType),
    healthStatus: countBy(healthStatusSet, (r) => r.healthStatus),
    backend: countBy(backendSet, (r) => r.datasourceType),
    createdBy: cappedCreatedBy,
    labels,
    total: totalSet.length,
    ...(scanTruncated || labelsTruncated || createdByTruncated ? { truncated: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    fetchedAt: new Date().toISOString(),
  };
}
