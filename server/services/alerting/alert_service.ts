/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alert service — orchestrates OpenSearch and Prometheus backends,
 * and provides a unified view for the UI.
 *
 * This file owns the `MultiBackendAlertService` class: constructor, backend
 * registration, OS/Prom pass-through delegates, unified + paginated views,
 * per-datasource fetch helpers, and the per-request timeout wrapper.
 *
 * Detail resolvers (rule/alert flyout data) live in `alert_detail.ts`.
 * Preview time-series helpers live in `alert_preview.ts`.
 * Pure utilities and unified-shape mappers live in `alert_utils.ts`.
 */
import {
  AlertingOSClient,
  AlertsTimelineResponse,
  Datasource,
  DatasourceFetchFallback,
  DatasourceFetchResult,
  DatasourceFetchStatus,
  DatasourceService,
  DatasourceWarning,
  Logger,
  NotificationRouting,
  OpenSearchBackend,
  OSGetAlertsOptions,
  OSGetMonitorsOptions,
  PrometheusBackend,
  OSAlert,
  OSMonitor,
  PromAlert,
  PromRuleGroup,
  ProgressiveResponse,
  PaginatedResponse,
  UnifiedAlertSummary,
  UnifiedFetchOptions,
  UnifiedAlert,
  UnifiedRule,
  UnifiedRuleSummary,
} from '../../../common/types/alerting';
import { parseDateMathMs } from '../../../common/services/alerting';
import { TimeoutError, withTimeout } from './timeout_error';
import {
  getAlertDetail as getAlertDetailImpl,
  getRuleDetail as getRuleDetailImpl,
} from './alert_detail';
import {
  computeAlertFacets,
  computeRuleFacets,
  AlertFacetCounts,
  RuleFacetCounts,
} from './alert_facets';
import type { PromFilterProbe } from './prom_filter_probe';
import {
  getUnifiedTimeline as getUnifiedTimelineImpl,
  GetUnifiedTimelineOptions,
} from './alert_timeline';
import {
  osAlertToUnified,
  osMonitorToUnifiedRuleSummary,
  promAlertToUnified,
  promHistoricalAlertToUnified,
  promRuleToUnified,
  requireDatasource as requireDatasourceImpl,
} from './alert_utils';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5_000;

/**
 * Resolved time window in epoch milliseconds — product of calling
 * `parseDateMathMs` once on the incoming `startTime`/`endTime` date-math
 * strings. Threaded through `fetchAlertsRaw` so each backend gets a
 * numeric window instead of re-parsing date-math at every hop.
 *
 * `endIsNow` records whether the original `endTime` string was relative
 * to `now` (e.g. `"now"`, `"now-5m"`). Backends use this signal to decide
 * whether an empty historical response should fall back to current-only
 * data; a past-only range should not. Kept on the resolved object so we
 * don't pass two values around.
 */
export interface ResolvedRange {
  startMs: number;
  endMs: number;
  endIsNow: boolean;
}

/**
 * Per-datasource shape returned by `fetchAlertsRaw`. Carries the mapped
 * `UnifiedAlertSummary[]` plus optional envelope hints (truncation,
 * Prometheus fallback, error) that propagate up into
 * `DatasourceFetchResult`.
 */
interface FetchAlertsRawResult {
  alerts: UnifiedAlertSummary[];
  truncated?: boolean;
  fallback?: DatasourceFetchFallback;
  error?: string;
}

/**
 * Parse `startTime`/`endTime` date-math strings from a fetch options object
 * into a numeric `{ startMs, endMs, endIsNow }` triple. Returns `undefined`
 * when either side is missing so callers can use the legacy "no range"
 * path via a simple nullish check. Throws if either string is present but
 * unparseable — route-layer `validateDateMath` validators should already
 * have rejected that case with a 400, so a throw here is a genuine bug.
 *
 * `endIsNow` is true when the resolved end timestamp is at or near the
 * current wall-clock instant. The Prometheus historical path uses this to
 * decide whether an empty matrix should fall back to the current-only API
 * — that fallback only makes sense for windows that include "right now".
 * `"now-1h"` is `now`-relative but its window ENDS an hour ago, so it must
 * resolve to `endIsNow: false` (otherwise we'd merge `/api/v1/alerts`
 * results — which ignore time entirely — into a window they don't belong to).
 */
const NOW_TOLERANCE_MS = 60_000;

export function resolveRangeMsFromOptions(options?: {
  startTime?: string;
  endTime?: string;
}): ResolvedRange | undefined {
  if (!options?.startTime || !options.endTime) return undefined;
  const startMs = parseDateMathMs(options.startTime, /* isEndTime */ false);
  const endMs = parseDateMathMs(options.endTime, /* isEndTime */ true);
  return {
    startMs,
    endMs,
    endIsNow: Math.abs(endMs - Date.now()) <= NOW_TOLERANCE_MS,
  };
}

// ============================================================================
// Phase 4 — pagination + filter helpers (pure)
//
// Used by `getPaginatedAlerts` / `getPaginatedRules` to do the JS-side
// post-filter, sort, and slice over per-datasource results. Filter
// pushdown happens in the backend layer; these helpers run regardless
// (correctness contract — same as Phase 3's rule-detail path).
// ============================================================================

const SEVERITY_SORT_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function filterDatasourcesByBackend(
  datasources: Datasource[],
  backend?: string[]
): Datasource[] {
  if (!backend || backend.length === 0) return datasources;
  const wanted = new Set(backend);
  return datasources.filter((ds) => wanted.has(ds.type));
}

function parseSort(
  sort: string | undefined,
  defaultField: string
): { field: string; dir: 'asc' | 'desc' } {
  if (!sort) return { field: defaultField, dir: 'desc' };
  const [rawField, rawDir] = sort.split(':');
  const field = rawField || defaultField;
  const dir = rawDir === 'asc' ? 'asc' : 'desc';
  return { field, dir };
}

/**
 * Stable fingerprint over a Prom alert's externally-visible labels. Used
 * to merge currently-firing rows (`/api/v1/alerts`) with historical
 * candidates (`topk(N, last_over_time(ALERTS{...}))`) so a re-firing
 * alert appears once in the table with current-firing identity.
 *
 * Drops the synthetic `_workspace` label (added by the workspace-scoping
 * filter on the backend); two alerts with the same upstream label-set
 * but coming through different workspace lenses must collapse to one row.
 */
export function promAlertFingerprint(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
    .filter(([k]) => k !== '_workspace')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join('\x1f');
}

export function applyAlertFilters(
  alerts: UnifiedAlertSummary[],
  options?: UnifiedFetchOptions
): UnifiedAlertSummary[] {
  if (!options) return alerts;
  let result = alerts;
  if (options.severity && options.severity.length > 0) {
    const wanted = new Set(options.severity);
    result = result.filter((a) => wanted.has(a.severity));
  }
  if (options.state && options.state.length > 0) {
    const wanted = new Set(options.state);
    result = result.filter((a) => wanted.has(a.state));
  }
  if (options.labels) {
    const labelEntries = Object.entries(options.labels).filter(([, vs]) => vs.length > 0);
    if (labelEntries.length > 0) {
      result = result.filter((a) =>
        labelEntries.every(([k, vs]) => {
          const v = a.labels[k];
          return v !== undefined && vs.includes(v);
        })
      );
    }
  }
  if (options.search && options.search.trim()) {
    const q = options.search.trim().toLowerCase();
    result = result.filter((a) => {
      if (a.name.toLowerCase().includes(q)) return true;
      if ((a.message ?? '').toLowerCase().includes(q)) return true;
      for (const v of Object.values(a.labels)) {
        if (v.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }
  return result;
}

export function applyRuleFilters(
  rules: UnifiedRuleSummary[],
  options?: UnifiedFetchOptions
): UnifiedRuleSummary[] {
  if (!options) return rules;
  let result = rules;
  if (options.state && options.state.length > 0) {
    const wanted = new Set(options.state);
    result = result.filter((r) => wanted.has(r.status));
  }
  if (options.severity && options.severity.length > 0) {
    const wanted = new Set(options.severity);
    result = result.filter((r) => wanted.has(r.severity));
  }
  if (options.monitorType && options.monitorType.length > 0) {
    const wanted = new Set(options.monitorType);
    result = result.filter((r) => wanted.has(r.monitorType));
  }
  if (options.healthStatus && options.healthStatus.length > 0) {
    const wanted = new Set(options.healthStatus);
    result = result.filter((r) => wanted.has(r.healthStatus));
  }
  if (options.createdBy && options.createdBy.length > 0) {
    const wanted = new Set(options.createdBy);
    result = result.filter((r) => wanted.has(r.createdBy));
  }
  if (options.labels) {
    const labelEntries = Object.entries(options.labels).filter(([, vs]) => vs.length > 0);
    if (labelEntries.length > 0) {
      result = result.filter((r) =>
        labelEntries.every(([k, vs]) => {
          const v = r.labels[k];
          return v !== undefined && vs.includes(v);
        })
      );
    }
  }
  if (options.search && options.search.trim()) {
    const q = options.search.trim().toLowerCase();
    result = result.filter((r) => {
      if (r.name.toLowerCase().includes(q)) return true;
      for (const v of Object.values(r.labels)) {
        if (v.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }
  return result;
}

function sortAlerts(alerts: UnifiedAlertSummary[], sort?: string): UnifiedAlertSummary[] {
  const { field, dir } = parseSort(sort, 'startTime');
  const mul = dir === 'asc' ? 1 : -1;
  const copy = alerts.slice();
  copy.sort((a, b) => {
    let cmp = 0;
    if (field === 'severity') {
      cmp = (SEVERITY_SORT_ORDER[a.severity] ?? 99) - (SEVERITY_SORT_ORDER[b.severity] ?? 99);
    } else if (field === 'state') {
      cmp = a.state.localeCompare(b.state);
    } else if (field === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (field === 'lastUpdated') {
      cmp = new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime();
    } else {
      cmp = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    }
    return cmp * mul;
  });
  return copy;
}

function sortRules(rules: UnifiedRuleSummary[], sort?: string): UnifiedRuleSummary[] {
  const { field, dir } = parseSort(sort, 'name');
  const mul = dir === 'asc' ? 1 : -1;
  const copy = rules.slice();
  copy.sort((a, b) => {
    let cmp = 0;
    if (field === 'severity') {
      cmp = (SEVERITY_SORT_ORDER[a.severity] ?? 99) - (SEVERITY_SORT_ORDER[b.severity] ?? 99);
    } else if (field === 'state') {
      cmp = a.status.localeCompare(b.status);
    } else if (field === 'lastUpdated') {
      cmp = new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime();
    } else if (field === 'startTime') {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    } else {
      cmp = a.name.localeCompare(b.name);
    }
    return cmp * mul;
  });
  return copy;
}

/**
 * Build per-datasource OS alerts options when ANY filter or range or
 * monitorId is in play. Returns undefined when no narrowing is needed —
 * caller falls through to the legacy full-scan path.
 *
 * Per-DS pageSize is intentionally generous: this is the inner fetch
 * before unified-layer pagination slices the merged set. We want
 * filter-narrowed results, not page-narrowed.
 */
function buildOsAlertOptions(
  range: ResolvedRange | undefined,
  options?: UnifiedFetchOptions
): OSGetAlertsOptions | undefined {
  if (!options && !range) return undefined;

  // Without filters, range, OR pagination, fall through to the legacy
  // full-scan. The paginated path kicks in when the caller asks for it
  // (page/pageSize) OR has any filter to push down.
  const hasPaging = !!options && (options.page !== undefined || options.pageSize !== undefined);
  const hasFilter =
    !!options &&
    ((options.severity && options.severity.length > 0) ||
      (options.state && options.state.length > 0) ||
      (options.search !== undefined && options.search !== '') ||
      (options.labels && Object.keys(options.labels).length > 0));

  if (!hasFilter && !hasPaging && !range) return undefined;

  const out: OSGetAlertsOptions = {
    pageSize: 200,
    page: 1,
    sortField: 'startTime',
    sortOrder: 'desc',
  };
  if (range) {
    out.startMs = range.startMs;
    out.endMs = range.endMs;
  }
  if (options?.severity) out.severity = options.severity;
  if (options?.state) out.state = options.state;
  if (options?.search) out.search = options.search;
  if (options?.labels) out.labels = options.labels;
  return out;
}

function buildOsMonitorOptions(options?: UnifiedFetchOptions): OSGetMonitorsOptions | undefined {
  if (!options) return undefined;
  // Switch to the paginated upstream when the caller asks for page/size
  // OR when any filter is in play. `getUnifiedRules` (legacy progressive
  // path) calls without page/size and without filters → falls through to
  // the legacy full-scan.
  const hasPaging = options.page !== undefined || options.pageSize !== undefined;
  const hasFilter =
    (options.state && options.state.length > 0) ||
    (options.severity && options.severity.length > 0) ||
    (options.monitorType && options.monitorType.length > 0) ||
    (options.healthStatus && options.healthStatus.length > 0) ||
    (options.createdBy && options.createdBy.length > 0) ||
    (options.search !== undefined && options.search !== '') ||
    (options.labels && Object.keys(options.labels).length > 0);
  if (!hasFilter && !hasPaging) return undefined;
  const out: OSGetMonitorsOptions = {
    page: 1,
    pageSize: 200,
    sortField: 'name',
    sortOrder: 'asc',
  };
  if (options.state) out.status = options.state;
  if (options.severity) out.severity = options.severity;
  if (options.monitorType) out.monitorType = options.monitorType;
  if (options.healthStatus) out.healthStatus = options.healthStatus;
  if (options.createdBy) out.createdBy = options.createdBy;
  if (options.search) out.search = options.search;
  if (options.labels) out.labels = options.labels;
  return out;
}

export class MultiBackendAlertService {
  private osBackend?: OpenSearchBackend;
  private promBackend?: PrometheusBackend;

  constructor(
    private readonly datasourceService: DatasourceService,
    private readonly logger: Logger
  ) {}

  registerOpenSearch(backend: OpenSearchBackend): void {
    this.osBackend = backend;
    // `debug` (not `info`): this service is constructed per-request, so
    // registration fires on every request. Keep out of default log output.
    this.logger.debug('Registered OpenSearch alerting backend');
  }

  /** Access the Prometheus backend (e.g. for Alertmanager config route). */
  getPrometheusBackend(): PrometheusBackend | undefined {
    return this.promBackend;
  }

  registerPrometheus(backend: PrometheusBackend): void {
    this.promBackend = backend;
    // `debug` (not `info`): see registerOpenSearch.
    this.logger.debug('Registered Prometheus alerting backend');
  }

  // =========================================================================
  // OpenSearch pass-through
  // =========================================================================

  async getOSMonitors(client: AlertingOSClient, dsId: string): Promise<OSMonitor[]> {
    await this.requireDatasource(dsId, 'opensearch');
    return this.osBackend!.getMonitors(client);
  }

  async getOSMonitor(
    client: AlertingOSClient,
    dsId: string,
    monitorId: string
  ): Promise<OSMonitor | null> {
    await this.requireDatasource(dsId, 'opensearch');
    return this.osBackend!.getMonitor(client, monitorId);
  }

  async createOSMonitor(
    client: AlertingOSClient,
    dsId: string,
    monitor: Omit<OSMonitor, 'id'>
  ): Promise<OSMonitor> {
    await this.requireDatasource(dsId, 'opensearch');
    return this.osBackend!.createMonitor(client, monitor);
  }

  async updateOSMonitor(
    client: AlertingOSClient,
    dsId: string,
    monitorId: string,
    input: Partial<OSMonitor>
  ): Promise<OSMonitor | null> {
    await this.requireDatasource(dsId, 'opensearch');
    return this.osBackend!.updateMonitor(client, monitorId, input);
  }

  async deleteOSMonitor(
    client: AlertingOSClient,
    dsId: string,
    monitorId: string
  ): Promise<boolean> {
    await this.requireDatasource(dsId, 'opensearch');
    return this.osBackend!.deleteMonitor(client, monitorId);
  }

  async getOSAlerts(
    client: AlertingOSClient,
    dsId: string,
    options?: { startTime?: string; endTime?: string }
  ): Promise<{ alerts: OSAlert[]; totalAlerts: number; truncated: boolean }> {
    await this.requireDatasource(dsId, 'opensearch');
    const range = resolveRangeMsFromOptions(options);
    return this.osBackend!.getAlerts(client, range);
  }

  async acknowledgeOSAlerts(
    client: AlertingOSClient,
    dsId: string,
    monitorId: string,
    alertIds: string[]
  ): Promise<unknown> {
    await this.requireDatasource(dsId, 'opensearch');
    return this.osBackend!.acknowledgeAlerts(client, monitorId, alertIds);
  }

  // =========================================================================
  // Prometheus pass-through
  // =========================================================================

  async getPromRuleGroups(client: AlertingOSClient, dsId: string): Promise<PromRuleGroup[]> {
    const ds = await this.requireDatasource(dsId, 'prometheus');
    return this.promBackend!.getRuleGroups(client, ds);
  }

  async getPromAlerts(
    client: AlertingOSClient,
    dsId: string,
    // Range is accepted for signature parity with the per-backend route, but
    // the per-backend `/api/alerting/prometheus/{dsId}/alerts` endpoint
    // returns raw `PromAlert[]` (not `UnifiedAlertSummary[]`), and the
    // historical-reconstruction path emits unified episodes. Per-backend
    // consumers therefore still see current-active alerts; historical
    // reconstruction is only surfaced through `getUnifiedAlerts`.
    options?: { startTime?: string; endTime?: string }
  ): Promise<PromAlert[]> {
    const ds = await this.requireDatasource(dsId, 'prometheus');
    if (options?.startTime || options?.endTime) {
      // Callers that specifically want a filtered view must go through the
      // unified endpoint; leaving this as a silent discard hides client
      // bugs (e.g. a UI assuming the per-backend route respects range).
      this.logger.debug(
        `getPromAlerts: ignoring startTime/endTime on per-backend route (ds=${dsId}); use /api/alerting/unified/alerts for historical range support`
      );
    }
    return this.promBackend!.getAlerts(client, ds);
  }

  // =========================================================================
  // Unified views (for the UI) — parallel with per-datasource timeout
  // =========================================================================

  async getUnifiedAlerts(
    clientOrResolver: AlertingOSClient | ((dsId: string) => Promise<AlertingOSClient>),
    options?: UnifiedFetchOptions
  ): Promise<ProgressiveResponse<UnifiedAlertSummary>> {
    const datasources = await this.resolveDatasources(options?.dsIds);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
    const fetchedAt = new Date().toISOString();

    // Resolve date-math once at the top — downstream hops (backend dispatch,
    // filter, post-fetch cap) take numeric epoch-ms instead of re-parsing
    // strings per-datasource. Falls back to `undefined` when either field is
    // missing so the legacy "no range" path stays unchanged.
    const resolvedRange = resolveRangeMsFromOptions(options);

    const isResolver = typeof clientOrResolver === 'function';
    const dsResults = await Promise.allSettled(
      datasources.map(async (ds) => {
        const client = isResolver ? await clientOrResolver(ds.id) : clientOrResolver;
        return this.fetchAlertsFromDatasource(
          client,
          ds,
          timeoutMs,
          resolvedRange,
          options?.onProgress
        );
      })
    );

    const allResults: UnifiedAlertSummary[] = [];
    const statusList: Array<DatasourceFetchResult<UnifiedAlertSummary>> = [];

    for (let i = 0; i < datasources.length; i++) {
      const settled = dsResults[i];
      if (settled.status === 'fulfilled') {
        allResults.push(...settled.value.data);
        statusList.push(settled.value);
      } else {
        const errResult: DatasourceFetchResult<UnifiedAlertSummary> = {
          datasourceId: datasources[i].id,
          datasourceName: datasources[i].name,
          datasourceType: datasources[i].type,
          status: 'error',
          data: [],
          error: String(settled.reason),
          durationMs: timeoutMs,
        };
        statusList.push(errResult);
      }
    }

    return {
      results: allResults.slice(0, maxResults),
      datasourceStatus: statusList,
      totalDatasources: datasources.length,
      completedDatasources: statusList.filter((s) => s.status === 'success').length,
      fetchedAt,
    };
  }

  async getUnifiedRules(
    clientOrResolver: AlertingOSClient | ((dsId: string) => Promise<AlertingOSClient>),
    options?: UnifiedFetchOptions
  ): Promise<ProgressiveResponse<UnifiedRuleSummary>> {
    const datasources = await this.resolveDatasources(options?.dsIds);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
    const fetchedAt = new Date().toISOString();

    const isResolver = typeof clientOrResolver === 'function';
    const dsResults = await Promise.allSettled(
      datasources.map(async (ds) => {
        const client = isResolver ? await clientOrResolver(ds.id) : clientOrResolver;
        return this.fetchRulesFromDatasource(client, ds, timeoutMs, options?.onProgress);
      })
    );

    const allResults: UnifiedRuleSummary[] = [];
    const statusList: Array<DatasourceFetchResult<UnifiedRuleSummary>> = [];

    for (let i = 0; i < datasources.length; i++) {
      const settled = dsResults[i];
      if (settled.status === 'fulfilled') {
        allResults.push(...settled.value.data);
        statusList.push(settled.value);
      } else {
        const errResult: DatasourceFetchResult<UnifiedRuleSummary> = {
          datasourceId: datasources[i].id,
          datasourceName: datasources[i].name,
          datasourceType: datasources[i].type,
          status: 'error',
          data: [],
          error: String(settled.reason),
          durationMs: timeoutMs,
        };
        statusList.push(errResult);
      }
    }

    return {
      results: allResults.slice(0, maxResults),
      datasourceStatus: statusList,
      totalDatasources: datasources.length,
      completedDatasources: statusList.filter((s) => s.status === 'success').length,
      fetchedAt,
    };
  }

  // =========================================================================
  // Paginated unified views — for single-datasource selection with pagination
  // =========================================================================

  async getPaginatedRules(
    clientOrResolver: AlertingOSClient | ((dsId: string) => Promise<AlertingOSClient>),
    options?: UnifiedFetchOptions
  ): Promise<PaginatedResponse<UnifiedRuleSummary>> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(Math.max(1, options?.pageSize ?? 20), 200);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const datasources = filterDatasourcesByBackend(
      await this.resolveDatasources(options?.dsIds),
      options?.backend
    );

    const allRules: UnifiedRuleSummary[] = [];
    const warnings: DatasourceWarning[] = [];

    const isResolver = typeof clientOrResolver === 'function';
    // Per-datasource timeout — restored from Phase 0's progressive
    // contract. Without it one slow upstream blocks the whole listing
    // and the user gets a 504 instead of a per-DS warning.
    const dsResults = await Promise.allSettled(
      datasources.map(async (ds) => {
        const client = isResolver ? await clientOrResolver(ds.id) : clientOrResolver;
        return withTimeout(
          this.fetchRulesRaw(client, ds, options),
          timeoutMs,
          `Datasource ${ds.name} timed out after ${timeoutMs}ms`
        );
      })
    );

    for (let i = 0; i < datasources.length; i++) {
      const settled = dsResults[i];
      if (settled.status === 'fulfilled') {
        allRules.push(...settled.value);
      } else {
        this.logger.error(
          `Failed to fetch rules from ${datasources[i].name} (${datasources[i].id}): ${settled.reason}`
        );
        if (settled.reason instanceof TimeoutError) {
          // Drop the in-flight cache entry so the next request doesn't
          // re-await an already-abandoned promise. TtlCache stores the
          // in-flight promise on miss; without invalidation the next
          // call would hand back the same rejected promise even after
          // the upstream recovered.
          (this.promBackend as
            | { ruleGroupsCache?: { invalidate?: (k: string) => void } }
            | undefined)?.ruleGroupsCache?.invalidate?.(datasources[i].id);
        }
        warnings.push({
          datasourceId: datasources[i].id,
          datasourceName: datasources[i].name,
          datasourceType: datasources[i].type,
          error: String(settled.reason),
        });
      }
    }

    const ruleHardErrors = warnings.filter((w) => w.error !== undefined);
    if (
      allRules.length === 0 &&
      ruleHardErrors.length === datasources.length &&
      datasources.length > 0
    ) {
      throw new Error(
        `All datasources failed: ${ruleHardErrors
          .map((w) => `${w.datasourceName}: ${w.error}`)
          .join('; ')}`
      );
    }

    // Always JS post-filter for correctness — even when one or more
    // datasources push down successfully, others may not.
    const filtered = applyRuleFilters(allRules, options);
    const sorted = sortRules(filtered, options?.sort);

    const total = sorted.length;
    const start = (page - 1) * pageSize;
    const results = sorted.slice(start, start + pageSize);

    return {
      results,
      total,
      page,
      pageSize,
      hasMore: start + pageSize < total,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async getPaginatedAlerts(
    clientOrResolver: AlertingOSClient | ((dsId: string) => Promise<AlertingOSClient>),
    options?: UnifiedFetchOptions
  ): Promise<PaginatedResponse<UnifiedAlertSummary>> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(Math.max(1, options?.pageSize ?? 20), 200);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const datasources = filterDatasourcesByBackend(
      await this.resolveDatasources(options?.dsIds),
      options?.backend
    );

    const allAlerts: UnifiedAlertSummary[] = [];
    const warnings: DatasourceWarning[] = [];

    const resolvedRange = resolveRangeMsFromOptions(options);

    const isResolver = typeof clientOrResolver === 'function';
    // Per-datasource timeout — restored from Phase 0's progressive
    // contract. Without it one slow upstream blocks the whole listing
    // and the user gets a 504 instead of a per-DS warning.
    const dsResults = await Promise.allSettled(
      datasources.map(async (ds) => {
        const client = isResolver ? await clientOrResolver(ds.id) : clientOrResolver;
        return withTimeout(
          this.fetchAlertsRaw(client, ds, resolvedRange, options),
          timeoutMs,
          `Datasource ${ds.name} timed out after ${timeoutMs}ms`
        );
      })
    );

    for (let i = 0; i < datasources.length; i++) {
      const settled = dsResults[i];
      if (settled.status === 'fulfilled') {
        allAlerts.push(...settled.value.alerts);
        // Soft signal — request succeeded but the backend took a fallback
        // path. Surface it as a non-error warning so the UI can render a
        // "results may be partial" callout without conflating with hard
        // failures.
        if (settled.value.fallback) {
          warnings.push({
            datasourceId: datasources[i].id,
            datasourceName: datasources[i].name,
            datasourceType: datasources[i].type,
            fallback: settled.value.fallback,
          });
        }
      } else {
        this.logger.error(
          `Failed to fetch alerts from ${datasources[i].name} (${datasources[i].id}): ${settled.reason}`
        );
        if (settled.reason instanceof TimeoutError) {
          // Drop the in-flight cache entry so the next request doesn't
          // re-await an already-abandoned promise. See getPaginatedRules
          // for the same rationale.
          (this.promBackend as
            | { alertsCache?: { invalidate?: (k: string) => void } }
            | undefined)?.alertsCache?.invalidate?.(datasources[i].id);
        }
        warnings.push({
          datasourceId: datasources[i].id,
          datasourceName: datasources[i].name,
          datasourceType: datasources[i].type,
          error: String(settled.reason),
        });
      }
    }

    const hardErrors = warnings.filter((w) => w.error !== undefined);
    if (
      allAlerts.length === 0 &&
      hardErrors.length === datasources.length &&
      datasources.length > 0
    ) {
      throw new Error(
        `All datasources failed: ${hardErrors
          .map((w) => `${w.datasourceName}: ${w.error}`)
          .join('; ')}`
      );
    }

    // Same correctness contract as Phase 3 — one Prom datasource
    // returning a partially-filtered listing must not bleed into the
    // unified response.
    const filtered = applyAlertFilters(allAlerts, options);
    const sorted = sortAlerts(filtered, options?.sort);

    const total = sorted.length;
    const start = (page - 1) * pageSize;
    const results = sorted.slice(start, start + pageSize);

    return {
      results,
      total,
      page,
      pageSize,
      hasMore: start + pageSize < total,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // =========================================================================
  // Detail views — loaded on demand when user opens a flyout
  // =========================================================================

  /**
   * Get full detail for a single rule/monitor. Delegates to the standalone
   * resolver in `alert_detail.ts` so the detail logic (history, routing,
   * preview) lives outside this class but is still reachable from the routes.
   */
  async getRuleDetail(
    client: AlertingOSClient,
    dsId: string,
    ruleId: string
  ): Promise<UnifiedRule | null> {
    // Pull the lazy filter probe off the concrete Prom backend if present.
    // The backend instance lives for the plugin process; the probe cache
    // therefore persists across requests, exactly once per dsId.
    const probe = (this.promBackend as { filterProbe?: PromFilterProbe } | undefined)?.filterProbe;
    return getRuleDetailImpl(
      this.datasourceService,
      this.osBackend,
      this.promBackend,
      client,
      dsId,
      ruleId,
      probe
    );
  }

  /**
   * Get full detail for a single alert including raw backend data. Delegates
   * to the standalone resolver in `alert_detail.ts`.
   */
  async getAlertDetail(
    client: AlertingOSClient,
    dsId: string,
    alertId: string,
    monitorId?: string,
    labels?: Record<string, string>,
    startTime?: string,
    endTime?: string
  ): Promise<UnifiedAlert | null> {
    return getAlertDetailImpl(
      this.datasourceService,
      this.osBackend,
      this.promBackend,
      client,
      dsId,
      alertId,
      monitorId,
      labels,
      startTime,
      endTime
    );
  }

  /**
   * Lazy notification-routing lookup for the rule flyout. Lifted out of the
   * detail path so the destinations fetch (an O(N) ruler call) only fires
   * when the user actually expands the Notification Routing accordion.
   *
   * Returns `null` when the rule does not exist; `[]` when it exists but
   * has no routing wired (or for Prometheus, where routing is owned by
   * Alertmanager and the flyout already shows the empty state).
   */
  async getRuleRouting(
    client: AlertingOSClient,
    dsId: string,
    ruleId: string
  ): Promise<NotificationRouting[] | null> {
    const ds = await this.datasourceService.get(dsId);
    if (!ds) return null;

    if (ds.type === 'opensearch' && this.osBackend) {
      const monitor = await this.osBackend.getMonitor(client, ruleId);
      if (!monitor) return null;
      const routing: NotificationRouting[] = [];
      try {
        const destinations = await this.osBackend.getDestinations(client);
        const destMap = new Map(destinations.map((d) => [d.id, d]));
        for (const trigger of monitor.triggers) {
          for (const action of trigger.actions) {
            const dest = destMap.get(action.destination_id);
            routing.push({
              channel: dest?.type || 'unknown',
              destination: dest?.name || action.name || action.destination_id,
              throttle: action.throttle
                ? `${action.throttle.value} ${action.throttle.unit}`
                : undefined,
            });
          }
        }
      } catch {
        // Destinations is best-effort — if the lookup fails the accordion
        // shows an empty list rather than surfacing an error.
      }
      return routing;
    }

    if (ds.type === 'prometheus') {
      // Prometheus rule routing is owned by Alertmanager; the flyout shows
      // an empty list today, so preserve that behavior.
      return [];
    }

    return null;
  }

  /**
   * Server-side facet counts for the alerts page. Reuses `fetchAlertsRaw`
   * (and therefore the Phase 4 `alertsCache`) so a facet call within 30s
   * of a listing call is a cache hit on the upstream side. Computes
   * "OR-within-dimension, AND-across-dimensions" counts.
   */
  async getAlertFacets(
    clientResolver: (dsId: string) => Promise<AlertingOSClient>,
    options?: UnifiedFetchOptions
  ): Promise<AlertFacetCounts> {
    return computeAlertFacets(this, clientResolver, options ?? {});
  }

  /** Server-side facet counts for the rules page. Same shape as alerts. */
  async getRuleFacets(
    clientResolver: (dsId: string) => Promise<AlertingOSClient>,
    options?: UnifiedFetchOptions
  ): Promise<RuleFacetCounts> {
    return computeRuleFacets(this, clientResolver, options ?? {});
  }

  /**
   * Aggregated alerts timeline across selected datasources. Delegates to
   * `alert_timeline.ts` which owns the per-backend bucket logic.
   */
  async getUnifiedTimeline(
    clientResolver: (dsId: string) => Promise<AlertingOSClient>,
    options: GetUnifiedTimelineOptions
  ): Promise<AlertsTimelineResponse> {
    return getUnifiedTimelineImpl(
      {
        datasourceService: this.datasourceService,
        osBackend: this.osBackend,
        promBackend: this.promBackend,
        clientResolver,
        logger: this.logger,
      },
      options
    );
  }

  // =========================================================================

  private async fetchAlertsFromDatasource(
    client: AlertingOSClient,
    ds: Datasource,
    timeoutMs: number,
    range: ResolvedRange | undefined,
    onProgress?: (result: DatasourceFetchResult<UnifiedAlertSummary>) => void
  ): Promise<DatasourceFetchResult<UnifiedAlertSummary>> {
    const start = Date.now();
    const makeResult = (
      status: DatasourceFetchStatus,
      data: UnifiedAlertSummary[],
      error?: string,
      extra?: { truncated?: boolean; fallback?: DatasourceFetchFallback }
    ): DatasourceFetchResult<UnifiedAlertSummary> => ({
      datasourceId: ds.id,
      datasourceName: ds.name,
      datasourceType: ds.type,
      status,
      data,
      error,
      durationMs: Date.now() - start,
      ...(extra?.truncated !== undefined ? { truncated: extra.truncated } : {}),
      ...(extra?.fallback !== undefined ? { fallback: extra.fallback } : {}),
    });

    try {
      const raw = await withTimeout(
        this.fetchAlertsRaw(client, ds, range),
        timeoutMs,
        `Datasource ${ds.name} timed out after ${timeoutMs}ms`
      );
      const result = makeResult('success', raw.alerts, raw.error, {
        truncated: raw.truncated,
        fallback: raw.fallback,
      });
      if (onProgress) onProgress(result);
      return result;
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      const result = makeResult(isTimeout ? 'timeout' : 'error', [], String(err));
      this.logger.error(`Failed to fetch alerts from ${ds.name}: ${err}`);
      if (onProgress) onProgress(result);
      return result;
    }
  }

  private async fetchRulesFromDatasource(
    client: AlertingOSClient,
    ds: Datasource,
    timeoutMs: number,
    onProgress?: (result: DatasourceFetchResult<UnifiedRuleSummary>) => void
  ): Promise<DatasourceFetchResult<UnifiedRuleSummary>> {
    const start = Date.now();
    const makeResult = (
      status: DatasourceFetchStatus,
      data: UnifiedRuleSummary[],
      error?: string
    ): DatasourceFetchResult<UnifiedRuleSummary> => ({
      datasourceId: ds.id,
      datasourceName: ds.name,
      datasourceType: ds.type,
      status,
      data,
      error,
      durationMs: Date.now() - start,
    });

    try {
      const data = await withTimeout(
        this.fetchRulesRaw(client, ds),
        timeoutMs,
        `Datasource ${ds.name} timed out after ${timeoutMs}ms`
      );
      const result = makeResult('success', data);
      if (onProgress) onProgress(result);
      return result;
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      const result = makeResult(isTimeout ? 'timeout' : 'error', [], String(err));
      this.logger.error(`Failed to fetch rules from ${ds.name}: ${err}`);
      if (onProgress) onProgress(result);
      return result;
    }
  }

  /**
   * Fetch alerts from a single datasource, mapping raw backend shape to
   * `UnifiedAlertSummary[]`. Dispatches on `ds.type` AND on whether a
   * resolved range was passed:
   *
   *   - OpenSearch + range   ⇒ `osBackend.getAlerts(client, { startMs, endMs })`
   *                            with interval-overlap filter + 1000-alert cap.
   *                            Propagates `truncated` for the UI callout.
   *   - OpenSearch + no range⇒ legacy `osBackend.getAlerts(client)` (no filter).
   *   - Prometheus (any)     ⇒ legacy `promBackend.getAlerts(...)` (current-
   *                            firing only). Range matrix reconstruction was
   *                            removed because its series count is unbounded
   *                            by alert cardinality and trips Cortex/AMP's
   *                            `-querier.max-samples` at scale. The
   *                            `prometheus-alerts-current-only` callout in
   *                            the UI tells the user the table is "now",
   *                            not the picked window. The dedicated timeline
   *                            chart endpoint (Phase 2) will own the
   *                            historical view with a bounded-cardinality
   *                            query (`sum by(severity)`).
   */
  /**
   * Per-datasource raw fetch — mapped to `UnifiedAlertSummary[]`. Public for
   * the facet path (`alert_facets.ts`) so it can fetch the dimensional
   * superset (no severity / state / labels filter) once and recount each
   * dimension client-side. The caller is responsible for any post-filter
   * via `applyAlertFilters`.
   */
  async fetchAlertsRaw(
    client: AlertingOSClient,
    ds: Datasource,
    range?: ResolvedRange,
    filterOptions?: UnifiedFetchOptions
  ): Promise<FetchAlertsRawResult> {
    if (ds.type === 'opensearch' && this.osBackend) {
      const osOptions = buildOsAlertOptions(range, filterOptions);
      if (osOptions) {
        const { alerts, truncated } = await this.osBackend.getAlerts(client, osOptions);
        return {
          alerts: alerts.map((a) => osAlertToUnified(a, ds.id)),
          truncated,
        };
      }
      const { alerts } = await this.osBackend.getAlerts(client);
      return { alerts: alerts.map((a) => osAlertToUnified(a, ds.id)) };
    }

    if (ds.type === 'prometheus' && this.promBackend) {
      // No range supplied → preserve legacy current-firing-only listing.
      if (!range) {
        const alerts = await this.promBackend.getAlerts(client, ds, {
          noCache: filterOptions?.noCache === true,
        });
        return { alerts: alerts.map((a) => promAlertToUnified(a, ds.id)) };
      }

      // Range supplied: emit a single-page listing that merges
      //   (a) currently-firing alerts (from /api/v1/alerts)
      //   (b) historical candidates (one per label-set that fired anywhere
      //       in the window, from `topk(N, last_over_time(ALERTS{...}))`).
      // Identity: label-set fingerprint. Current-firing wins when both
      // sides see the same fingerprint, so a single re-firing alert
      // appears once with `state: 'active'` (and the flyout's deferred
      // episode walk shows all prior episodes).
      //
      // (b) is only safe to do when the backend actually implements
      // `getHistoricalAlerts`; otherwise we fall back to the legacy
      // current-only behaviour with the existing callout.
      if (!this.promBackend.getHistoricalAlerts) {
        const alerts = await this.promBackend.getAlerts(client, ds, {
          noCache: filterOptions?.noCache === true,
        });
        return {
          alerts: alerts.map((a) => promAlertToUnified(a, ds.id)),
          fallback: 'prometheus-alerts-current-only',
        };
      }

      const merged = new Map<string, UnifiedAlertSummary>();

      // (a) Current-firing — only meaningful when the picked range
      // includes "now". A `now-2h..now-1h` window must NOT mix in
      // /api/v1/alerts (which ignores time entirely).
      if (range.endIsNow) {
        const currentAlerts = await this.promBackend.getAlerts(client, ds, {
          noCache: filterOptions?.noCache === true,
        });
        for (const a of currentAlerts) {
          const summary = promAlertToUnified(a, ds.id);
          merged.set(promAlertFingerprint(summary.labels), summary);
        }
      }

      // (b) Historical candidates — bounded by `topk` cap on the upstream
      // query. Surface `prometheus-search-truncated` if the cap engaged,
      // mirroring the timeline endpoint's boundary signal.
      const historical = await this.promBackend.getHistoricalAlerts(client, ds, {
        startMs: range.startMs,
        endMs: range.endMs,
        severity: filterOptions?.severity,
        labels: filterOptions?.labels,
        search: filterOptions?.search,
      });
      for (const c of historical.candidates) {
        const fp = promAlertFingerprint(c.labels);
        if (merged.has(fp)) continue; // current-firing wins
        merged.set(fp, promHistoricalAlertToUnified(c, ds.id));
      }

      return {
        alerts: Array.from(merged.values()),
        ...(historical.truncated ? { fallback: 'prometheus-search-truncated' as const } : {}),
      };
    }

    return { alerts: [] };
  }

  /** Public counterpart to `fetchAlertsRaw` for the rule-facet path. */
  async fetchRulesRaw(
    client: AlertingOSClient,
    ds: Datasource,
    filterOptions?: UnifiedFetchOptions
  ): Promise<UnifiedRuleSummary[]> {
    const results: UnifiedRuleSummary[] = [];
    if (ds.type === 'opensearch' && this.osBackend) {
      const osMonitorOptions = buildOsMonitorOptions(filterOptions);
      if (osMonitorOptions) {
        // `pageSize` here is the per-DS request size — large enough to
        // cover the post-filter cap with headroom. Multi-DS pagination
        // is Option B from PHASE_4.md: per-DS fetch all filter-narrowed,
        // server-side concat, then slice.
        const { monitors } = await this.osBackend.getMonitors(client, osMonitorOptions);
        for (const m of monitors) results.push(osMonitorToUnifiedRuleSummary(m, ds.id));
      } else {
        const monitors = await this.osBackend.getMonitors(client);
        for (const m of monitors) results.push(osMonitorToUnifiedRuleSummary(m, ds.id));
      }
    } else if (ds.type === 'prometheus' && this.promBackend) {
      const promFilter = await this.buildPromRuleFilter(client, ds, filterOptions);
      const groups = await this.promBackend.getRuleGroups(client, ds, promFilter, {
        noCache: filterOptions?.noCache === true,
      });
      for (const g of groups) {
        for (const r of g.rules) {
          if (r.type === 'alerting') results.push(promRuleToUnified(r, g.name, ds.id));
        }
      }
    }
    return results;
  }

  /**
   * Build a `PromRuleGroupsFilter` from `UnifiedFetchOptions` only when
   * the per-process probe says pushdown works for this datasource.
   * Reuses `DirectQueryPrometheusBackend.filterProbe` (Phase 3) — does
   * NOT construct a new probe instance.
   */
  private async buildPromRuleFilter(
    client: AlertingOSClient,
    ds: Datasource,
    filterOptions?: UnifiedFetchOptions
  ): Promise<import('../../../common/types/alerting').PromRuleGroupsFilter | undefined> {
    if (!filterOptions) return undefined;
    const wants =
      (filterOptions.severity && filterOptions.severity.length > 0) ||
      (filterOptions.state && filterOptions.state.length > 0) ||
      (filterOptions.labels && Object.keys(filterOptions.labels).length > 0);
    if (!wants) return undefined;
    const probe = (this.promBackend as { filterProbe?: PromFilterProbe } | undefined)?.filterProbe;
    if (!probe) return undefined;
    const result = await probe.probe(client, ds);
    if (result.status !== 'pushdown-works') return undefined;

    const filter: import('../../../common/types/alerting').PromRuleGroupsFilter = {
      type: 'alert',
    };
    const labels: Record<string, string[]> = {};
    if (filterOptions.severity && filterOptions.severity.length > 0) {
      labels.severity = filterOptions.severity;
    }
    if (filterOptions.labels) {
      for (const [k, vs] of Object.entries(filterOptions.labels)) {
        if (vs.length > 0) labels[k] = vs;
      }
    }
    if (Object.keys(labels).length > 0) filter.labels = labels;
    if (filterOptions.state && filterOptions.state.length === 1) {
      const s = filterOptions.state[0];
      // Map UnifiedAlertState → Prometheus alertstate values.
      const mapped =
        s === 'active'
          ? 'firing'
          : s === 'pending'
          ? 'pending'
          : s === 'resolved'
          ? 'inactive'
          : undefined;
      if (mapped) filter.state = mapped;
    }
    return filter;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Public for the facet path. */
  async resolveDatasources(dsIds?: string[]): Promise<Datasource[]> {
    const all = await this.datasourceService.list();
    const enabled = all.filter((ds) => ds.enabled);
    if (!dsIds || dsIds.length === 0) return enabled;

    const resolved: Datasource[] = [];
    for (const id of dsIds) {
      const match = enabled.filter((ds) => ds.id === id);
      if (match.length > 0) resolved.push(match[0]);
    }
    return resolved;
  }

  /**
   * Thin wrapper over the standalone `requireDatasource` helper that passes
   * this service's current datasource service + registered backends.
   */
  private async requireDatasource(dsId: string, expectedType: string): Promise<Datasource> {
    return requireDatasourceImpl(
      this.datasourceService,
      this.osBackend,
      this.promBackend,
      dsId,
      expectedType
    );
  }
}
