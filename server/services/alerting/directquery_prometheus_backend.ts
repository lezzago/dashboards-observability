/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prometheus backend that routes all API calls through OpenSearch Direct Query
 * resource APIs instead of connecting to Prometheus directly.
 *
 * Each Datasource object carries a `directQueryName` field that identifies which
 * Prometheus datasource (registered in the OpenSearch SQL plugin) to target.
 * This enables auto-discovery: on startup the server queries
 *   GET /_plugins/_query/_datasources
 * and seeds one Datasource per registered PROMETHEUS connector.
 *
 * API calls are routed through the OSD scoped cluster client (auth, TLS handled
 * automatically by OSD):
 *   GET/POST/DELETE /_plugins/_directquery/_resources/{directQueryName}/...
 *
 * Reference (OpenSearch SQL plugin):
 *   - RestDirectQueryResourcesManagementAction.java
 *   - PrometheusQueryHandler.java / PrometheusClient.java
 */
import { createPromFilterProbe, PromFilterProbe } from './prom_filter_probe';
import { TtlCache } from './ttl_cache';
import {
  AlertingOSClient,
  Datasource,
  Logger,
  PrometheusBackend,
  PrometheusMetadataProvider,
  PrometheusMetricMetadata,
  PromAlert,
  PromAlertingRule,
  PromHistoricalAlertCandidate,
  PromRecordingRule,
  PromRule,
  PromRuleGroup,
  PromRuleGroupsFilter,
  PromRuleGroupsOptions,
  PrometheusWorkspace,
  AlertmanagerAlert,
  AlertmanagerAlertGroup,
  AlertmanagerReceiver,
  AlertmanagerSilence,
  AlertmanagerStatus,
  PromRulesApiResponse,
  PromRawRuleGroup,
  PromRawRule,
  PromRawAlert,
  PromAlertsApiResponse,
  DatasourceDefinition,
  PromTimeSeriesPoint,
  UnifiedAlertSeverity,
} from '../../../common/types/alerting';
import {
  buildPromSelectorMatchers,
  buildAlertStateMatcher,
  escapePromRegexLiteral,
} from './alert_timeline';

/**
 * Cap on series cardinality returned by the historical alerts query. The
 * `topk(N, ...)` wrapper bounds Cortex's response shape to at most this many
 * label-sets even when the picked window saw an explosion of distinct alerts;
 * callers see `truncated: true` so the UI can surface a warning. Mirrors
 * `PROM_TIMELINE_SEARCH_TOPK` in the timeline path.
 */
export const PROM_HISTORICAL_ALERTS_TOPK = 1000;

export interface PromSeriesMatrix {
  metric: Record<string, string>;
  values: PromTimeSeriesPoint[];
}

export class DirectQueryPrometheusBackend implements PrometheusBackend, PrometheusMetadataProvider {
  readonly type = 'prometheus' as const;
  // Per-process probe cache so concurrent rule-detail flyouts share one
  // upstream check per dsId. Shared across requests intentionally — probe
  // result is a property of the upstream, not the caller.
  readonly filterProbe: PromFilterProbe;

  /**
   * Per-process listing caches keyed on `dsId`. 30s TTL so repeated
   * filter clicks (and chart-vs-table refetches) reuse one upstream
   * fetch when filter pushdown isn't honoured. Refresh-button clicks
   * bypass via `noCache: true` on `getAlerts` / `getRuleGroups`.
   *
   * Two typed caches keep call-site casts out of the hot path.
   */
  readonly alertsCache: TtlCache<string, PromAlert[]>;
  readonly ruleGroupsCache: TtlCache<string, PromRuleGroup[]>;
  /**
   * P6.7 — cache for the bounded historical-alerts query. The query is
   * structurally expensive (`last_over_time(ALERTS{...}[range])` scans
   * every sample of `ALERTS{...}` over the range at evaluation time);
   * picker / filter / refresh clicks would otherwise re-issue it every
   * render. Composite cache key includes filter shape AND a 30s
   * bucketing of the start/end so a "now"-tracking range stays
   * cache-hot for ~30s windows. Same 30s TTL as the other caches.
   */
  readonly historicalAlertsCache: TtlCache<
    string,
    { candidates: PromHistoricalAlertCandidate[]; truncated: boolean }
  >;

  constructor(private readonly logger: Logger) {
    this.logger.info(
      'DirectQuery Prometheus backend configured: routing via OSD scoped cluster client'
    );
    this.filterProbe = createPromFilterProbe(this, logger);
    this.alertsCache = new TtlCache<string, PromAlert[]>(30_000);
    this.ruleGroupsCache = new TtlCache<string, PromRuleGroup[]>(30_000);
    this.historicalAlertsCache = new TtlCache<
      string,
      { candidates: PromHistoricalAlertCandidate[]; truncated: boolean }
    >(30_000);
  }

  // =========================================================================
  // Auto-discovery — query OpenSearch SQL plugin for registered PROMETHEUS datasources
  // =========================================================================

  /**
   * Discover all Prometheus datasources registered in the OpenSearch SQL plugin.
   * Returns entries suitable for seeding into the DatasourceService.
   *
   * Endpoint: GET /_plugins/_query/_datasources
   */
  async discoverDatasources(client: AlertingOSClient): Promise<Array<Omit<Datasource, 'id'>>> {
    try {
      const resp = await client.transport.request({
        method: 'GET',
        path: '/_plugins/_query/_datasources',
      });

      const all: DatasourceDefinition[] = Array.isArray(resp.body) ? resp.body : [];
      const promSources = all.filter(
        (d: DatasourceDefinition) =>
          d.connector?.toUpperCase() === 'PROMETHEUS' && d.status !== 'DISABLED'
      );

      this.logger.info(
        `Discovered ${promSources.length} Prometheus datasource(s) in OpenSearch SQL plugin` +
          (promSources.length > 0
            ? `: ${promSources.map((d: DatasourceDefinition) => d.name).join(', ')}`
            : '')
      );

      return promSources.map((d: DatasourceDefinition) => ({
        name: d.name,
        type: 'prometheus' as const,
        // URL is unused for OSD-scoped calls but retained for Datasource shape
        url: '',
        enabled: true,
        directQueryName: d.name,
      }));
    } catch (err) {
      this.logger.warn(`Failed to discover Prometheus datasources from SQL plugin: ${err}`);
      return [];
    }
  }

  // =========================================================================
  // Helpers — build direct query resource path and dispatch via OSD client
  // =========================================================================

  private resolveDqName(ds: Datasource): string {
    const name = ds.directQueryName;
    if (!name) {
      throw new Error(
        `Datasource "${ds.name}" (${ds.id}) has no directQueryName. ` +
          'It must be auto-discovered from the OpenSearch SQL plugin.'
      );
    }
    return name;
  }

  private resourcePath(ds: Datasource, path: string): string {
    const dqName = encodeURIComponent(this.resolveDqName(ds));
    return `/_plugins/_directquery/_resources/${dqName}${path}`;
  }

  private async req<T = unknown>(
    client: AlertingOSClient,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    this.logger.debug(`DirectQuery ${method} ${path}`);
    const resp = await client.transport.request({
      method,
      path,
      body: body || undefined,
    });
    const respBody = resp.body as { data?: T } & Record<string, unknown>;
    return respBody?.data !== undefined ? (respBody.data as T) : ((respBody as unknown) as T);
  }

  private get<T = unknown>(client: AlertingOSClient, ds: Datasource, path: string): Promise<T> {
    return this.req<T>(client, 'GET', this.resourcePath(ds, path));
  }

  private post<T = unknown>(
    client: AlertingOSClient,
    ds: Datasource,
    path: string,
    body: unknown
  ): Promise<T> {
    return this.req<T>(client, 'POST', this.resourcePath(ds, path), body);
  }

  private del<T = unknown>(client: AlertingOSClient, ds: Datasource, path: string): Promise<T> {
    return this.req<T>(client, 'DELETE', this.resourcePath(ds, path));
  }

  // =========================================================================
  // Rules — GET /_plugins/_directquery/_resources/{ds}/api/v1/rules
  // =========================================================================

  async getRuleGroups(
    client: AlertingOSClient,
    ds: Datasource,
    filter?: PromRuleGroupsFilter,
    options?: PromRuleGroupsOptions
  ): Promise<PromRuleGroup[]> {
    const includeAlerts = options?.includeAlerts === true;
    const fetcher = async () => this.fetchRuleGroupsRaw(client, ds, filter, includeAlerts);

    // Cache only the listing path (no filter, no includeAlerts). Detail
    // flyout calls pass a `ruleGroup`+`ruleName` filter and bypass the
    // cache implicitly because the cache key would collide with the
    // listing entries; keeping cacheing scoped to the unfiltered listing
    // also avoids stale-result bugs when the probe says pushdown works
    // and one filter result poisons another's read.
    const cacheable = !options?.noCache && !includeAlerts && this.isCacheableRuleFilter(filter);
    if (!cacheable) return fetcher();
    return this.ruleGroupsCache.get(ds.id, fetcher);
  }

  /**
   * True when this filter shape only narrows rule-type (alert vs
   * recording) — i.e. the listing path's "give me all alerting rules"
   * call. Any rule-name / rule-group / file / labels / state filter
   * makes the result filter-specific, so caching it per-dsId would mix
   * different filter sets together. Phase 4 caches only the unscoped
   * listing.
   */
  private isCacheableRuleFilter(filter?: PromRuleGroupsFilter): boolean {
    if (!filter) return true;
    if (filter.ruleGroup || filter.ruleName || filter.file) return false;
    if (filter.labels && Object.keys(filter.labels).length > 0) return false;
    if (filter.state) return false;
    return true;
  }

  private async fetchRuleGroupsRaw(
    client: AlertingOSClient,
    ds: Datasource,
    filter: PromRuleGroupsFilter | undefined,
    includeAlerts: boolean
  ): Promise<PromRuleGroup[]> {
    const path = this.buildRulesPath(filter, ds);
    const data = await this.get<PromRulesApiResponse>(client, ds, path);

    let rawGroups: PromRawRuleGroup[];
    if (Array.isArray(data)) {
      rawGroups = (data as unknown) as PromRawRuleGroup[];
    } else if (data?.groups) {
      rawGroups = data.groups;
    } else if (data?.data?.groups) {
      rawGroups = data.data.groups;
    } else {
      this.logger.warn('Unexpected rules response shape, returning empty');
      rawGroups = [];
    }

    const groups: PromRuleGroup[] = rawGroups.map((g: PromRawRuleGroup) => ({
      name: g.name || '',
      file: g.file || '',
      interval:
        typeof g.interval === 'number'
          ? g.interval
          : this.parseDurationToSeconds(String(g.interval || '60s')),
      rules: (g.rules || []).map((r: PromRawRule) => this.mapRule(r, includeAlerts)),
    }));

    if (ds.workspaceId && ds.workspaceId !== 'default') {
      return groups.filter(
        (g) =>
          g.file.includes(ds.workspaceId!) ||
          g.rules.some((r) => r.type === 'alerting' && r.labels._workspace === ds.workspaceId)
      );
    }

    return groups;
  }

  // =========================================================================
  // Alerts — derived from rules when /api/v1/alerts is unavailable
  // =========================================================================

  async getAlerts(
    client: AlertingOSClient,
    ds: Datasource,
    options?: { noCache?: boolean }
  ): Promise<PromAlert[]> {
    if (options?.noCache) {
      this.alertsCache.invalidate(ds.id);
      return this.fetchAlertsRaw(client, ds);
    }
    return this.alertsCache.get(ds.id, () => this.fetchAlertsRaw(client, ds));
  }

  private async fetchAlertsRaw(client: AlertingOSClient, ds: Datasource): Promise<PromAlert[]> {
    try {
      const data = await this.get<PromAlertsApiResponse>(client, ds, '/api/v1/alerts');
      let rawAlerts: PromRawAlert[];
      if (Array.isArray(data)) {
        rawAlerts = (data as unknown) as PromRawAlert[];
      } else if (data?.alerts) {
        rawAlerts = data.alerts as PromRawAlert[];
      } else if (data?.data) {
        const inner = data.data;
        if (Array.isArray(inner)) {
          rawAlerts = inner;
        } else if (inner && typeof inner === 'object' && 'alerts' in inner) {
          rawAlerts = (inner as { alerts: PromRawAlert[] }).alerts;
        } else {
          rawAlerts = [];
        }
      } else {
        rawAlerts = [];
      }

      if (rawAlerts.length > 0) {
        const alerts = rawAlerts.map((a: PromRawAlert) => this.mapAlert(a));
        if (ds.workspaceId && ds.workspaceId !== 'default') {
          return alerts.filter((a) => a.labels._workspace === ds.workspaceId);
        }
        return alerts;
      }
    } catch {
      this.logger.debug('Dedicated /api/v1/alerts not available, extracting alerts from rules');
    }

    // Fallback: extract alerts from rule groups. Pass includeAlerts so the
    // embedded alerts[] stays populated through mapRule (listings strip by
    // default).
    const groups = await this.getRuleGroups(client, ds, undefined, { includeAlerts: true });
    const alerts: PromAlert[] = [];
    for (const g of groups) {
      for (const r of g.rules) {
        if (r.type === 'alerting') {
          for (const a of r.alerts) {
            alerts.push(a);
          }
        }
      }
    }
    return alerts;
  }

  /**
   * Cardinality-bounded historical alerts listing.
   *
   * Issues
   *
   *   topk(N, last_over_time(ALERTS{alertstate="firing", <matchers>}[<rangeS>s]))
   *
   * as a single instant query at `endMs`. Each returned vector entry is one
   * label-set that fired *somewhere* in `[startMs, endMs]`; the sample
   * timestamp is the most recent moment within the window when that
   * label-set was firing. Per-episode (start/end) reconstruction is NOT
   * done here — that's the deferred per-row range walk in the detail
   * flyout (`alert_detail.ts`), so listing cost stays O(label-set count).
   *
   * `topk(N, ...)` caps the returned series count regardless of how many
   * distinct label-sets fired; when N rows come back we set
   * `truncated: true` so the UI can warn the user the table may be
   * incomplete. Mirrors the `prometheus-search-truncated` boundary used
   * by the timeline endpoint.
   */
  async getHistoricalAlerts(
    client: AlertingOSClient,
    ds: Datasource,
    options: {
      startMs: number;
      endMs: number;
      severity?: UnifiedAlertSeverity[];
      labels?: Record<string, string[]>;
      search?: string;
      topk?: number;
      noCache?: boolean;
    }
  ): Promise<{ candidates: PromHistoricalAlertCandidate[]; truncated: boolean }> {
    const fetcher = () => this.fetchHistoricalAlertsRaw(client, ds, options);
    if (options.noCache) {
      // Refresh-button driven — clear the whole cache so any other in-flight
      // / cached entry for this dsId is invalidated. The cache is small
      // (one entry per dsId × filter shape × 30s bucket) so a clear is
      // cheaper than walking every key.
      this.historicalAlertsCache.clear();
      return fetcher();
    }
    const cacheKey = this.historicalAlertsCacheKey(ds, options);
    return this.historicalAlertsCache.get(cacheKey, fetcher);
  }

  /**
   * Bucket start/end timestamps to 30s granularity in the cache key so a
   * "now"-tracking range doesn't bust the cache on every second of drift.
   * Filter shape (severity/labels/search) is sorted-stringified so two
   * callers with the same filters hit the same entry regardless of map
   * iteration order. dsId is the first segment so cache.clear() can be
   * cheap on refresh — the cache is short-lived (30s TTL) anyway.
   */
  private historicalAlertsCacheKey(
    ds: Datasource,
    options: {
      startMs: number;
      endMs: number;
      severity?: UnifiedAlertSeverity[];
      labels?: Record<string, string[]>;
      search?: string;
      topk?: number;
    }
  ): string {
    const BUCKET_MS = 30_000;
    const bucketed = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
    const startBucket = bucketed(options.startMs);
    const endBucket = bucketed(options.endMs);
    const severitySorted = (options.severity ?? []).slice().sort().join(',');
    const labelsSorted = options.labels
      ? Object.entries(options.labels)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, vs]) => `${k}=${vs.slice().sort().join('|')}`)
          .join(';')
      : '';
    const search = options.search ?? '';
    const topk = options.topk ?? PROM_HISTORICAL_ALERTS_TOPK;
    return `${ds.id}:${startBucket}:${endBucket}:${severitySorted}:${labelsSorted}:${search}:${topk}`;
  }

  private async fetchHistoricalAlertsRaw(
    client: AlertingOSClient,
    ds: Datasource,
    options: {
      startMs: number;
      endMs: number;
      severity?: UnifiedAlertSeverity[];
      labels?: Record<string, string[]>;
      search?: string;
      topk?: number;
    }
  ): Promise<{ candidates: PromHistoricalAlertCandidate[]; truncated: boolean }> {
    const startSec = Math.floor(options.startMs / 1000);
    const endSec = Math.floor(options.endMs / 1000);
    const rangeSec = Math.max(1, endSec - startSec);
    const topk = options.topk ?? PROM_HISTORICAL_ALERTS_TOPK;

    const stateMatcher = buildAlertStateMatcher(['active']);
    const extraMatchers = buildPromSelectorMatchers({
      severity: options.severity,
      labels: options.labels,
    });
    const matcherList = [stateMatcher, ...extraMatchers];
    const searchTrim = options.search?.trim();
    if (searchTrim) {
      matcherList.push(`alertname=~".*${escapePromRegexLiteral(searchTrim)}.*"`);
    }
    const selector = `ALERTS{${matcherList.join(', ')}}`;
    const inner = `last_over_time(${selector}[${rangeSec}s])`;
    const query = `topk(${topk}, ${inner})`;

    const dqName = this.resolveDqName(ds);
    const path = `/_plugins/_directquery/_query/${encodeURIComponent(dqName)}`;
    this.logger.debug(`DirectQuery historical alerts: ${query.substring(0, 80)}...`);

    let resp;
    try {
      resp = await client.transport.request({
        method: 'POST',
        path,
        body: {
          datasource: dqName,
          query,
          language: 'PROMQL',
          options: {
            queryType: 'instant',
            time: endSec.toString(),
          },
        },
      });
    } catch (err) {
      this.logger.warn(`Historical alerts query failed for ${ds.name}: ${err}`);
      return { candidates: [], truncated: false };
    }

    const promResult = this.extractPrometheusResult(resp.body as Record<string, unknown>);
    if (!promResult) return { candidates: [], truncated: false };

    const rawVector = (promResult.result ?? []) as Array<{
      metric?: Record<string, string>;
      value?: unknown[];
    }>;

    const candidates: PromHistoricalAlertCandidate[] = [];
    for (const entry of rawVector) {
      if (!Array.isArray(entry.value) || entry.value.length < 2) continue;
      const ts = Number(entry.value[0]);
      if (isNaN(ts)) continue;
      const labels = entry.metric || {};
      // Workspace-scoped datasources need the same `_workspace` filter the
      // current /api/v1/alerts path applies; otherwise an AMP workspace user
      // would see other workspaces' historical alerts.
      if (ds.workspaceId && ds.workspaceId !== 'default') {
        if (labels._workspace !== ds.workspaceId) continue;
      }
      candidates.push({
        labels,
        lastSeenMs: ts * 1000,
      });
    }

    return {
      candidates,
      truncated: candidates.length >= topk,
    };
  }

  // =========================================================================
  // Workspaces
  // =========================================================================

  async listWorkspaces(_client: AlertingOSClient, ds: Datasource): Promise<PrometheusWorkspace[]> {
    const ampMatch = ds.url.match(
      /aps-workspaces\.([^.]+)\.amazonaws\.com\/workspaces\/(ws-[a-zA-Z0-9]+)/
    );
    if (ampMatch) {
      return [
        {
          id: ampMatch[2],
          name: ampMatch[2],
          alias: `AMP Workspace (${ampMatch[1]})`,
          region: ampMatch[1],
          status: 'active',
        },
      ];
    }

    return [{ id: 'default', name: 'default', alias: 'Default', status: 'active' }];
  }

  // =========================================================================
  // Alertmanager — via direct query resource APIs
  // =========================================================================

  // Alertmanager methods are global (not per-datasource). The caller must
  // supply the Prometheus datasource that owns the Alertmanager endpoint.

  async getAlertmanagerAlerts(
    client: AlertingOSClient,
    ds: Datasource
  ): Promise<AlertmanagerAlert[]> {
    try {
      const data = await this.get<AlertmanagerAlert[]>(client, ds, '/alertmanager/api/v2/alerts');
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.warn(`Failed to get alertmanager alerts via direct query: ${err}`);
      return [];
    }
  }

  async getAlertmanagerAlertGroups(
    client: AlertingOSClient,
    ds: Datasource
  ): Promise<AlertmanagerAlertGroup[]> {
    try {
      const data = await this.get<AlertmanagerAlertGroup[]>(
        client,
        ds,
        '/alertmanager/api/v2/alerts/groups'
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.warn(`Failed to get alertmanager alert groups via direct query: ${err}`);
      return [];
    }
  }

  async getAlertmanagerReceivers(
    client: AlertingOSClient,
    ds: Datasource
  ): Promise<AlertmanagerReceiver[]> {
    try {
      const data = await this.get<AlertmanagerReceiver[]>(
        client,
        ds,
        '/alertmanager/api/v2/receivers'
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.warn(`Failed to get alertmanager receivers via direct query: ${err}`);
      return [];
    }
  }

  async getSilences(client: AlertingOSClient, ds: Datasource): Promise<AlertmanagerSilence[]> {
    try {
      const data = await this.get<AlertmanagerSilence[]>(
        client,
        ds,
        '/alertmanager/api/v2/silences'
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.warn(`Failed to get alertmanager silences via direct query: ${err}`);
      return [];
    }
  }

  async createSilence(
    client: AlertingOSClient,
    ds: Datasource,
    silence: AlertmanagerSilence
  ): Promise<string> {
    const data = await this.post<string | { silenceID?: string; silenceId?: string }>(
      client,
      ds,
      '/alertmanager/api/v2/silences',
      silence
    );
    if (typeof data === 'string') return data;
    return data?.silenceID || data?.silenceId || '';
  }

  async deleteSilence(
    client: AlertingOSClient,
    ds: Datasource,
    silenceId: string
  ): Promise<boolean> {
    try {
      await this.del<unknown>(
        client,
        ds,
        `/alertmanager/api/v2/silence/${encodeURIComponent(silenceId)}`
      );
      return true;
    } catch {
      return false;
    }
  }

  async getAlertmanagerStatus(
    client: AlertingOSClient,
    ds: Datasource
  ): Promise<AlertmanagerStatus> {
    // Routes through DirectQuery: /_plugins/_directquery/_resources/{dsName}/alertmanager/api/v2/status
    return this.get<AlertmanagerStatus>(client, ds, '/alertmanager/api/v2/status');
  }

  // =========================================================================
  // Prometheus Metadata (PrometheusMetadataProvider)
  // =========================================================================

  async getMetricNames(client: AlertingOSClient, ds: Datasource): Promise<string[]> {
    try {
      const data = await this.get<string[] | Record<string, unknown>>(
        client,
        ds,
        '/api/v1/label/__name__/values'
      );
      if (Array.isArray(data)) return data;
      // Defensively handle wrapped response
      if (
        data &&
        typeof data === 'object' &&
        Array.isArray((data as Record<string, unknown>).data)
      ) {
        return (data as Record<string, unknown>).data as string[];
      }
      return [];
    } catch (err) {
      this.logger.warn(`Failed to get metric names via DirectQuery: ${err}`);
      return [];
    }
  }

  async getLabelNames(
    client: AlertingOSClient,
    ds: Datasource,
    metric?: string
  ): Promise<string[]> {
    try {
      let path = '/api/v1/labels';
      if (metric) {
        // Validate metric name to prevent PromQL injection via selector breakout
        if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric)) {
          this.logger.warn(`Invalid metric name for getLabelNames: ${metric}`);
          return [];
        }
        path = `/api/v1/labels?match[]=${encodeURIComponent(`{__name__="${metric}"}`)}`;
      }
      const data = await this.get<string[] | Record<string, unknown>>(client, ds, path);
      if (Array.isArray(data)) return data;
      if (
        data &&
        typeof data === 'object' &&
        Array.isArray((data as Record<string, unknown>).data)
      ) {
        return (data as Record<string, unknown>).data as string[];
      }
      return [];
    } catch (err) {
      this.logger.warn(`Failed to get label names via DirectQuery: ${err}`);
      return [];
    }
  }

  async getLabelValues(
    client: AlertingOSClient,
    ds: Datasource,
    labelName: string,
    selector?: string
  ): Promise<string[]> {
    try {
      const enc = encodeURIComponent(labelName);
      const path = selector
        ? `/api/v1/label/${enc}/values?match[]=${encodeURIComponent(selector)}`
        : `/api/v1/label/${enc}/values`;
      const data = await this.get<string[] | Record<string, unknown>>(client, ds, path);
      if (Array.isArray(data)) return data;
      if (
        data &&
        typeof data === 'object' &&
        Array.isArray((data as Record<string, unknown>).data)
      ) {
        return (data as Record<string, unknown>).data as string[];
      }
      return [];
    } catch (err) {
      this.logger.warn(`Failed to get label values for "${labelName}" via DirectQuery: ${err}`);
      return [];
    }
  }

  async getMetricMetadata(
    client: AlertingOSClient,
    ds: Datasource
  ): Promise<PrometheusMetricMetadata[]> {
    try {
      const raw = await this.get<Record<string, Array<{ type: string; help: string }>> | unknown>(
        client,
        ds,
        '/api/v1/metadata?limit=-1'
      );
      // The Prometheus /api/v1/metadata returns { metric: [{ type, help, unit }] }
      // DirectQuery may wrap it in a `data` envelope — the get() helper already unwraps `data`.
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return [];
      }
      const record = raw as Record<string, Array<{ type?: string; help?: string }>>;
      const result: PrometheusMetricMetadata[] = [];
      for (const [metric, entries] of Object.entries(record)) {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const entry = entries[0];
        const metricType = (entry?.type || 'unknown') as PrometheusMetricMetadata['type'];
        const validTypes: Array<PrometheusMetricMetadata['type']> = [
          'counter',
          'gauge',
          'histogram',
          'summary',
          'unknown',
        ];
        result.push({
          metric,
          type: validTypes.includes(metricType) ? metricType : 'unknown',
          help: entry?.help || '',
        });
      }
      return result;
    } catch (err) {
      this.logger.warn(`Failed to get metric metadata via DirectQuery: ${err}`);
      return [];
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private buildRulesPath(filter?: PromRuleGroupsFilter, ds?: Datasource): string {
    const params: string[] = [];
    if (filter?.ruleGroup) params.push(`rule_group=${encodeURIComponent(filter.ruleGroup)}`);
    if (filter?.ruleName) params.push(`rule_name=${encodeURIComponent(filter.ruleName)}`);
    if (filter?.file) {
      params.push(`file=${encodeURIComponent(filter.file)}`);
    } else if (ds?.workspaceId && ds.workspaceId !== 'default') {
      // P6.10 — workspace-scoped DS: push the workspace id as `?file=` so
      // the upstream returns only this workspace's rules. Older Prom /
      // Cortex versions silently ignore the param; the JS post-filter at
      // fetchRuleGroupsRaw (g.file.includes(ds.workspaceId!) /
      // _workspace label match) catches that case for correctness.
      params.push(`file=${encodeURIComponent(ds.workspaceId)}`);
    }
    // P6.2 — always push `type=alert` on the listing path. The unified
    // mapper drops recording rules anyway (`fetchRulesRaw` keeps only
    // `r.type === 'alerting'`); pushing the filter to the upstream cuts
    // ~90% of payload on recording-rule-heavy deployments. Older
    // upstreams that don't honor the param silently return the full set,
    // and the JS post-filter still produces the correct output. No
    // wrong-result mode (accept-or-ignore) so no probe is needed.
    const type = filter?.type ?? 'alert';
    params.push(`type=${encodeURIComponent(type)}`);
    // Phase 4 — Prom ≥ 2.40 / Cortex ≥ 1.13 honour `match[]` matchers on
    // /api/v1/rules. Older upstreams silently ignore them; the filter
    // probe gates whether to send these (caller responsibility) and the
    // service post-filters in JS for correctness regardless.
    if (filter?.state) {
      params.push(`match[]=${encodeURIComponent(`{alertstate="${filter.state}"}`)}`);
    }
    if (filter?.labels) {
      for (const [k, vs] of Object.entries(filter.labels)) {
        for (const v of vs) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue;
          const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          params.push(`match[]=${encodeURIComponent(`{${k}="${escaped}"}`)}`);
        }
      }
    }
    return `/api/v1/rules?${params.join('&')}`;
  }

  private mapRule(r: PromRawRule, includeAlerts: boolean = false): PromRule {
    if (r.type === 'recording' || r.record) {
      return {
        type: 'recording',
        name: r.name || r.record || '',
        query: r.query || r.expr || '',
        labels: r.labels || {},
        health: r.health || 'unknown',
        lastEvaluation: r.lastEvaluation,
        evaluationTime: r.evaluationTime,
      } as PromRecordingRule;
    }

    const name = r.name || r.alert || '';
    const query = r.query || r.expr || '';
    const duration =
      typeof r.duration === 'number'
        ? r.duration
        : this.parseDurationToSeconds(r.for || String(r.duration || '0s'));

    // Listings drop embedded alerts[] — large on busy rulers and never read
    // by UnifiedRuleSummary. Detail flyout passes includeAlerts: true.
    return {
      type: 'alerting',
      name,
      query,
      duration,
      labels: r.labels || {},
      annotations: r.annotations || {},
      alerts: includeAlerts ? (r.alerts || []).map((a: PromRawAlert) => this.mapAlert(a)) : [],
      health: r.health || 'unknown',
      state: r.state || 'inactive',
      lastEvaluation: r.lastEvaluation,
      evaluationTime: r.evaluationTime,
    } as PromAlertingRule;
  }

  /**
   * Execute a PromQL range query via the DirectQuery query execution API.
   *
   * Uses: POST /_plugins/_directquery/_query/{dataSources}
   * This is the query EXECUTION endpoint (separate from the resource proxy).
   * The SQL plugin's PrometheusQueryHandler routes to PrometheusClient.queryRange()
   * which calls Prometheus /api/v1/query_range.
   *
   * Request body: { datasource, query, language: "PROMQL", options: { queryType: "range", start, end, step } }
   * Response: Prometheus matrix result with time-series values.
   */
  async queryRange(
    client: AlertingOSClient,
    ds: Datasource,
    query: string,
    start: number,
    end: number,
    step: number
  ): Promise<PromTimeSeriesPoint[]> {
    try {
      const dqName = this.resolveDqName(ds);
      const path = `/_plugins/_directquery/_query/${encodeURIComponent(dqName)}`;

      this.logger.debug(`DirectQuery range query: ${query.substring(0, 80)}...`);

      const resp = await client.transport.request({
        method: 'POST',
        path,
        body: {
          datasource: dqName,
          query,
          language: 'PROMQL',
          options: {
            queryType: 'range',
            start: start.toString(),
            end: end.toString(),
            step: step.toString(),
          },
        },
      });

      return this.parseRangeQueryResponse(resp.body as Record<string, unknown>);
    } catch (err) {
      this.logger.warn(`Failed to execute DirectQuery range query: ${err}`);
      return [];
    }
  }

  // Multi-series variant of `queryRange`. Kept separate because `queryRange`
  // flattens to a single series and swallows errors to `[]` — behavior that
  // would silently hide a bad query in the episode-reconstruction path.
  async queryRangeMatrix(
    client: AlertingOSClient,
    ds: Datasource,
    query: string,
    startSec: number,
    endSec: number,
    stepSec: number
  ): Promise<PromSeriesMatrix[]> {
    const dqName = this.resolveDqName(ds);
    const path = `/_plugins/_directquery/_query/${encodeURIComponent(dqName)}`;

    this.logger.debug(`DirectQuery range matrix query: ${query.substring(0, 80)}...`);

    const resp = await client.transport.request({
      method: 'POST',
      path,
      body: {
        datasource: dqName,
        query,
        language: 'PROMQL',
        options: {
          queryType: 'range',
          start: startSec.toString(),
          end: endSec.toString(),
          step: stepSec.toString(),
        },
      },
    });

    const promResult = this.extractPrometheusResult(resp.body as Record<string, unknown>);
    if (!promResult) return [];

    const rawSeries = (promResult.result ?? []) as Array<{
      metric?: Record<string, string>;
      values?: unknown[][];
    }>;

    // Defensive cap on parsed sample count per series. `computeStep` in the
    // shared helper should keep steps coarse enough that a well-behaved
    // Prometheus response stays well under this, but an exporter returning
    // a fine step on a multi-day range could otherwise allocate unbounded
    // memory here. ~50k points per series accommodates a 30-day range at a
    // 60s step with headroom; anything larger is almost certainly misuse.
    const MAX_POINTS_PER_SERIES = 50_000;

    const series: PromSeriesMatrix[] = [];
    for (const s of rawSeries) {
      const metric = s.metric || {};
      const values: PromTimeSeriesPoint[] = [];
      const rawValues = s.values || [];
      for (const pair of rawValues) {
        if (values.length >= MAX_POINTS_PER_SERIES) {
          this.logger.warn(
            `queryRangeMatrix: series truncated at ${MAX_POINTS_PER_SERIES} points for query "${query.substring(
              0,
              80
            )}..."`
          );
          break;
        }
        if (Array.isArray(pair) && pair.length >= 2) {
          const ts = Number(pair[0]);
          const numVal = parseFloat(String(pair[1]));
          if (!isNaN(ts) && !isNaN(numVal)) {
            values.push({ timestamp: ts * 1000, value: numVal });
          }
        }
      }
      series.push({ metric, values });
    }

    return series;
  }

  /**
   * Range query for the alerts timeline chart. Issues
   *
   *   sum by(severity) (ALERTS{alertstate="firing", <extra>})
   *
   * over `[startEpochSec, endEpochSec]` with a step that yields
   * approximately one sample per chart bucket. Returns one
   * `PromSeriesMatrix` per distinct `severity` label value — series count
   * is bounded by severity cardinality (≤ 5), unlike the raw `ALERTS{}`
   * matrix whose cardinality is the number of distinct alert label sets.
   *
   * `extraMatchers` are appended to the selector with no validation; the
   * caller is responsible for emitting Prom-safe matchers (the
   * `alert_timeline.ts` resolver builds them from a closed allowlist of
   * filter shapes).
   */
  async queryTimelineSeverityBuckets(
    client: AlertingOSClient,
    ds: Datasource,
    startEpochSec: number,
    endEpochSec: number,
    stepSec: number,
    extraMatchers: string[] = [],
    severityKey: 'severity' | null = 'severity'
  ): Promise<PromSeriesMatrix[]> {
    const matchers = ['alertstate="firing"', ...extraMatchers].join(', ');
    const selector = `ALERTS{${matchers}}`;
    const query = severityKey ? `sum by(${severityKey}) (${selector})` : `count(${selector})`;
    return this.queryRangeMatrix(client, ds, query, startEpochSec, endEpochSec, stepSec);
  }

  /**
   * Execute a PromQL instant query via the DirectQuery query execution API.
   *
   * Uses: POST /_plugins/_directquery/_query/{dataSources}
   * Request body: { datasource, query, language: "PROMQL", options: { queryType: "instant", time } }
   * Response: Prometheus vector result with point-in-time values.
   */
  async queryInstant(
    client: AlertingOSClient,
    ds: Datasource,
    query: string,
    time?: number
  ): Promise<PromTimeSeriesPoint[]> {
    try {
      const dqName = this.resolveDqName(ds);
      const path = `/_plugins/_directquery/_query/${encodeURIComponent(dqName)}`;

      this.logger.debug(`DirectQuery instant query: ${query.substring(0, 80)}...`);

      const options: Record<string, string> = { queryType: 'instant' };
      if (time !== undefined) {
        options.time = time.toString();
      }

      const resp = await client.transport.request({
        method: 'POST',
        path,
        body: {
          datasource: dqName,
          query,
          language: 'PROMQL',
          options,
        },
      });

      return this.parseInstantQueryResponse(resp.body as Record<string, unknown>);
    } catch (err) {
      this.logger.warn(`Failed to execute DirectQuery instant query: ${err}`);
      return [];
    }
  }

  /**
   * Parse a DirectQuery query execution response.
   *
   * Response envelope from the SQL plugin:
   * {
   *   "queryId": "...",
   *   "results": {
   *     "{datasourceName}": {
   *       "resultType": "matrix" | "vector",
   *       "result": [{ metric: {...}, values: [[ts, val], ...] }]  // range
   *                  [{ metric: {...}, value: [ts, val] }]         // instant
   *     }
   *   },
   *   "sessionId": "..."
   * }
   *
   * See: sql/direct-query/.../datasource/PrometheusResult.java
   */
  private parseRangeQueryResponse(body: Record<string, unknown>): PromTimeSeriesPoint[] {
    const promResult = this.extractPrometheusResult(body);
    if (!promResult) return [];

    const points: PromTimeSeriesPoint[] = [];
    const result = (promResult.result ?? []) as Array<{
      metric?: Record<string, string>;
      values?: unknown[][];
    }>;

    if (result.length > 0) {
      const values = result[0].values || [];
      for (const pair of values) {
        if (Array.isArray(pair) && pair.length >= 2) {
          const ts = Number(pair[0]);
          const numVal = parseFloat(String(pair[1]));
          if (!isNaN(ts) && !isNaN(numVal)) {
            points.push({ timestamp: ts * 1000, value: numVal });
          }
        }
      }
    }

    return points;
  }

  private parseInstantQueryResponse(body: Record<string, unknown>): PromTimeSeriesPoint[] {
    const promResult = this.extractPrometheusResult(body);
    if (!promResult) return [];

    const points: PromTimeSeriesPoint[] = [];
    const result = (promResult.result ?? []) as Array<{
      metric?: Record<string, string>;
      value?: unknown[];
    }>;

    for (const entry of result) {
      if (Array.isArray(entry.value) && entry.value.length >= 2) {
        const ts = Number(entry.value[0]);
        const numVal = parseFloat(String(entry.value[1]));
        if (!isNaN(ts) && !isNaN(numVal)) {
          points.push({ timestamp: ts * 1000, value: numVal });
        }
      }
    }

    return points;
  }

  /**
   * Extract the PrometheusResult from the DirectQuery response envelope.
   * Handles both direct data and the nested results.{datasourceName} wrapper.
   */
  private extractPrometheusResult(
    body: Record<string, unknown>
  ): { resultType?: string; result?: unknown[] } | null {
    // Direct Prometheus response: { resultType, result }
    if (body?.resultType || body?.result) {
      return body as { resultType?: string; result?: unknown[] };
    }

    // Wrapped in data field: { data: { resultType, result } }
    if (body?.data && typeof body.data === 'object') {
      const data = body.data as Record<string, unknown>;
      if (data.resultType || data.result) {
        return data as { resultType?: string; result?: unknown[] };
      }
    }

    // DirectQuery envelope: { results: { "DatasourceName": { resultType, result } } }
    if (body?.results && typeof body.results === 'object') {
      const results = body.results as Record<string, unknown>;
      for (const val of Object.values(results)) {
        if (val && typeof val === 'object') {
          const dsResult = val as Record<string, unknown>;
          if (dsResult.resultType || dsResult.result) {
            return dsResult as { resultType?: string; result?: unknown[] };
          }
        }
      }
    }

    return null;
  }

  private parseDurationToSeconds(dur: string): number {
    if (!dur || dur === '0s') return 0;
    let total = 0;
    const hours = dur.match(/(\d+)h/);
    const mins = dur.match(/(\d+)m(?!s)/);
    const secs = dur.match(/(\d+)s/);
    if (hours) total += parseInt(hours[1], 10) * 3600;
    if (mins) total += parseInt(mins[1], 10) * 60;
    if (secs) total += parseInt(secs[1], 10);
    return total;
  }

  private mapAlert(a: PromRawAlert): PromAlert {
    return {
      labels: a.labels || {},
      annotations: a.annotations || {},
      state: (a.state || 'inactive') as PromAlert['state'],
      activeAt: a.activeAt || '',
      value: a.value != null ? String(a.value) : '',
    };
  }
}
