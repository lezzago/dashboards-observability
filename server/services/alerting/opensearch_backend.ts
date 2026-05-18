/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real OpenSearch Alerting backend — talks to _plugins/_alerting REST APIs.
 *
 * API reference: https://opensearch.org/docs/latest/observing-your-data/alerting/api/
 */
import {
  AlertingOSClient,
  Logger,
  OpenSearchBackend,
  OSGetAlertsOptions,
  OSGetMonitorsOptions,
  OSMonitor,
  OSAlert,
  OSDestination,
  OSTrigger,
  OSSearchResponse,
  OSGetMonitorResponse,
  OSCreateMonitorResponse,
  OSAlertsApiResponse,
  OSAlertRaw,
  OSMonitorSource,
  OSRawTrigger,
  OSRawAction,
  OSDestinationRaw,
  OSDestinationsApiResponse,
} from '../../../common/types/alerting';
import { createConflictError, createInternalError, isStatusCode } from './errors';

// Map UnifiedAlertSeverity → OpenSearch numeric severityLevel (1=critical … 5=info).
const OS_SEVERITY_LEVELS: Record<string, string> = {
  critical: '1',
  high: '2',
  medium: '3',
  low: '4',
  info: '5',
};

// Map UnifiedAlertState → OS Alerting alertState query param values.
const OS_ALERT_STATES: Record<string, string> = {
  active: 'ACTIVE',
  acknowledged: 'ACKNOWLEDGED',
  resolved: 'COMPLETED',
  error: 'ERROR',
};

// Map server sortField → OpenSearch alert document sort key.
const OS_ALERT_SORT_FIELDS: Record<string, string> = {
  startTime: 'start_time',
  lastUpdated: 'last_notification_time',
  severity: 'severity',
  state: 'state',
  name: 'monitor_name',
};

// Map server sortField → OpenSearch monitor document sort key.
const OS_MONITOR_SORT_FIELDS: Record<string, string> = {
  startTime: 'last_update_time',
  lastUpdated: 'last_update_time',
  severity: 'monitor.triggers.severity',
  state: 'monitor.enabled',
  name: 'monitor.name.keyword',
};

const OS_MONITOR_TYPE_MAP: Record<string, string> = {
  metric: 'query_level_monitor',
  log: 'doc_level_monitor',
  apm: 'query_level_monitor',
  composite: 'query_level_monitor',
  infrastructure: 'bucket_level_monitor',
  synthetics: 'query_level_monitor',
  cluster_metrics: 'query_level_monitor',
};

export class HttpOpenSearchBackend implements OpenSearchBackend {
  readonly type = 'opensearch' as const;

  constructor(private readonly logger: Logger) {}

  // =========================================================================
  // Monitors
  // =========================================================================

  async getMonitors(client: AlertingOSClient): Promise<OSMonitor[]>;
  async getMonitors(
    client: AlertingOSClient,
    options: OSGetMonitorsOptions
  ): Promise<{ monitors: OSMonitor[]; total: number; hasMore: boolean }>;
  async getMonitors(
    client: AlertingOSClient,
    options?: OSGetMonitorsOptions
  ): Promise<OSMonitor[] | { monitors: OSMonitor[]; total: number; hasMore: boolean }> {
    if (options) {
      return this.getMonitorsPage(client, options);
    }
    const PAGE_SIZE = 100;
    const monitors: OSMonitor[] = [];
    let searchAfter: unknown[] | undefined;

    // Use search_after pagination to retrieve all monitors
    while (true) {
      const body: Record<string, unknown> = {
        query: { match_all: {} },
        size: PAGE_SIZE,
        sort: [{ _id: 'asc' }],
      };
      if (searchAfter) {
        body.search_after = searchAfter;
      }

      const resp = await this.req<OSSearchResponse>(
        client,
        'POST',
        '/_plugins/_alerting/monitors/_search',
        body
      );
      const hits = resp.body?.hits?.hits ?? [];
      if (hits.length === 0) break;

      for (const hit of hits) {
        monitors.push(this.mapMonitor(hit._id, hit._source));
      }

      if (hits.length < PAGE_SIZE) break;
      searchAfter = hits[hits.length - 1].sort;
    }

    return monitors;
  }

  /**
   * Paginated server-side monitor listing with optional pushdown filters.
   *
   * Pushdown:
   *   - `monitor.enabled` for status (active/disabled)
   *   - `monitor.monitor_type` for monitorType
   *   - `monitor.name`/`description` `multi_match` for `search`
   *   - top-level label terms for OS PPL monitors that store labels at
   *     `monitor.ui_metadata.labels.<key>` (best-effort; labels not in the
   *     mapping fall through to post-filter on the caller side)
   *
   * Out of scope (post-filter responsibility of the caller):
   *   - `severity` (nested under `triggers[].*_trigger.severity` with
   *     trigger-type-specific paths; fragile across monitor types)
   *   - `healthStatus` (derived from recent alert history)
   *   - `createdBy` (security-plugin dependent; absent without it)
   */
  private async getMonitorsPage(
    client: AlertingOSClient,
    options: OSGetMonitorsOptions
  ): Promise<{ monitors: OSMonitor[]; total: number; hasMore: boolean }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? 20), 200);
    const from = (page - 1) * pageSize;
    const sortField =
      OS_MONITOR_SORT_FIELDS[options.sortField ?? 'startTime'] ?? 'last_update_time';
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';

    const filterClauses: Array<Record<string, unknown>> = [];

    if (options.status && options.status.length > 0) {
      const enabledClauses: Array<Record<string, unknown>> = [];
      if (options.status.includes('active')) {
        enabledClauses.push({ term: { 'monitor.enabled': true } });
      }
      if (options.status.includes('disabled')) {
        enabledClauses.push({ term: { 'monitor.enabled': false } });
      }
      if (enabledClauses.length > 0) {
        filterClauses.push({ bool: { should: enabledClauses, minimum_should_match: 1 } });
      }
    }

    if (options.monitorType && options.monitorType.length > 0) {
      const typeValues = Array.from(
        new Set(options.monitorType.map((t) => OS_MONITOR_TYPE_MAP[t] ?? t).filter(Boolean))
      );
      if (typeValues.length > 0) {
        filterClauses.push({ terms: { 'monitor.monitor_type': typeValues } });
      }
    }

    if (options.search && options.search.trim()) {
      filterClauses.push({
        multi_match: {
          query: options.search.trim(),
          fields: ['monitor.name', 'monitor.description'],
        },
      });
    }

    const body: Record<string, unknown> = {
      size: pageSize,
      from,
      sort: [{ [sortField]: { order: sortOrder } }, { _id: 'asc' }],
      query: filterClauses.length > 0 ? { bool: { filter: filterClauses } } : { match_all: {} },
      track_total_hits: true,
    };

    interface PagedResponse extends OSSearchResponse {
      hits: OSSearchResponse['hits'] & {
        total?: { value: number; relation?: string } | number;
      };
    }
    const resp = await this.req<PagedResponse>(
      client,
      'POST',
      '/_plugins/_alerting/monitors/_search',
      body
    );
    const rawHits = resp.body?.hits?.hits ?? [];
    const monitors = rawHits.map((hit) => this.mapMonitor(hit._id, hit._source));

    const totalRaw = resp.body?.hits?.total;
    const total =
      typeof totalRaw === 'number'
        ? totalRaw
        : typeof totalRaw === 'object' && totalRaw
        ? totalRaw.value ?? 0
        : 0;
    const hasMore = from + monitors.length < total;
    return { monitors, total, hasMore };
  }

  async getMonitor(client: AlertingOSClient, monitorId: string): Promise<OSMonitor | null> {
    try {
      const resp = await this.req<OSGetMonitorResponse>(
        client,
        'GET',
        `/_plugins/_alerting/monitors/${encodeURIComponent(monitorId)}`
      );
      return this.mapMonitor(resp.body._id, resp.body.monitor);
    } catch (err) {
      if (this.is404(err)) return null;
      throw err;
    }
  }

  async createMonitor(
    client: AlertingOSClient,
    monitor: Omit<OSMonitor, 'id'>
  ): Promise<OSMonitor> {
    const resp = await this.req<OSCreateMonitorResponse>(
      client,
      'POST',
      '/_plugins/_alerting/monitors',
      {
        ...monitor,
        type: 'monitor',
      }
    );
    return this.mapMonitor(resp.body._id, resp.body.monitor);
  }

  async updateMonitor(
    client: AlertingOSClient,
    monitorId: string,
    input: Partial<OSMonitor>
  ): Promise<OSMonitor | null> {
    const encodedMonitorId = encodeURIComponent(monitorId);

    // Fetch the current monitor with version info for optimistic concurrency.
    // Splitting the GET and PUT lets us distinguish a missing monitor (return
    // null) from a conflict on write (throw typed conflict).
    let getResp: { body: OSGetMonitorResponse };
    try {
      getResp = await this.req<OSGetMonitorResponse>(
        client,
        'GET',
        `/_plugins/_alerting/monitors/${encodedMonitorId}`
      );
    } catch (err) {
      if (this.is404(err)) return null;
      throw err;
    }

    const seqNo = getResp.body._seq_no;
    const primaryTerm = getResp.body._primary_term;
    // Optimistic concurrency control requires both values. If either is
    // missing, fail hard rather than silently downgrade to a non-CAS write —
    // that would allow concurrent writers to clobber each other.
    if (seqNo === undefined || primaryTerm === undefined) {
      throw createInternalError(
        'OpenSearch Alerting GET monitor response missing _seq_no or _primary_term; refusing non-CAS update'
      );
    }

    const current = this.mapMonitor(getResp.body._id, getResp.body.monitor);
    const { id: _id, ...currentFields } = current;
    const merged = { ...currentFields, ...input, last_update_time: Date.now() };

    const putPath =
      `/_plugins/_alerting/monitors/${encodedMonitorId}` +
      `?if_seq_no=${seqNo}&if_primary_term=${primaryTerm}`;

    try {
      const resp = await this.req<OSCreateMonitorResponse>(client, 'PUT', putPath, {
        ...merged,
        type: 'monitor',
      });
      return this.mapMonitor(resp.body._id, resp.body.monitor);
    } catch (err) {
      if (this.is404(err)) return null;
      if (isStatusCode(err, 409)) {
        throw createConflictError(
          `Monitor ${monitorId} was modified by another writer; re-fetch and retry`,
          monitorId
        );
      }
      throw err;
    }
  }

  async deleteMonitor(client: AlertingOSClient, monitorId: string): Promise<boolean> {
    try {
      await this.req(
        client,
        'DELETE',
        `/_plugins/_alerting/monitors/${encodeURIComponent(monitorId)}`
      );
      return true;
    } catch (err) {
      if (this.is404(err)) return false;
      throw err;
    }
  }

  async runMonitor(
    client: AlertingOSClient,
    monitorId: string,
    dryRun?: boolean
  ): Promise<unknown> {
    const resp = await this.req<unknown>(
      client,
      'POST',
      `/_plugins/_alerting/monitors/${encodeURIComponent(monitorId)}/_execute`,
      {
        dryrun: dryRun ?? false,
      }
    );
    return resp.body;
  }

  async searchQuery(
    client: AlertingOSClient,
    indices: string[],
    body: Record<string, unknown>
  ): Promise<unknown> {
    const indexPattern = indices.join(',');
    const resp = await this.req<unknown>(client, 'POST', `/${indexPattern}/_search`, body);
    return resp.body;
  }

  // =========================================================================
  // Alerts
  // =========================================================================

  async getAlerts(
    client: AlertingOSClient,
    options?: OSGetAlertsOptions
  ): Promise<{ alerts: OSAlert[]; totalAlerts: number; truncated: boolean; hasMore?: boolean }> {
    const isPaginated =
      options !== undefined &&
      (options.page !== undefined ||
        options.pageSize !== undefined ||
        options.sortField !== undefined ||
        options.sortOrder !== undefined ||
        (options.severity && options.severity.length > 0) ||
        (options.state && options.state.length > 0) ||
        (options.search !== undefined && options.search !== '') ||
        (options.labels && Object.keys(options.labels).length > 0));

    if (isPaginated) {
      return this.getAlertsPage(client, options!);
    }

    const PAGE_SIZE = 100;
    /**
     * Cap applied only when a time window is supplied. OpenSearch Alerting's
     * `GET monitors/alerts` endpoint has no documented server-side time
     * filter (as of 2.x), so we post-fetch and then paginate-stop once the
     * filtered collection reaches this limit. The UI surfaces `truncated`
     * as an `EuiCallOut` prompting the user to narrow the range.
     *
     * Scope: this cap is PER-DATASOURCE. The unified service aggregates
     * results across N datasources and forwards any `truncated: true` to
     * the UI, but does not sum alert counts — so the unified view can show
     * up to `N * FILTER_CAP` rows with no `truncated` flag if no single
     * datasource individually exceeds the cap.
     */
    const FILTER_CAP = 1000;
    // Hard ceiling on rows we'll page through, regardless of `FILTER_CAP`.
    // Without this, a cluster with 100k+ alerts where almost none fall
    // inside the window forces us to issue 1000+ sequential requests before
    // the post-filter cap can stop us. 10k rows = at most 100 pages of 100
    // — bounded worst-case latency, and any genuinely-larger backlog should
    // already be hitting `FILTER_CAP` (which assumes the filter matches).
    const SCAN_CAP = 10_000;
    const hasRange = options?.startMs !== undefined && options?.endMs !== undefined;
    const windowStart = options?.startMs ?? 0;
    const windowEnd = options?.endMs ?? Number.POSITIVE_INFINITY;
    const monitorIdParam = options?.monitorId
      ? `&monitorId=${encodeURIComponent(options.monitorId)}`
      : '';

    const allAlerts: OSAlert[] = [];
    let startIndex = 0;
    let totalAlerts = 0;
    let truncated = false;

    // Paginate through all alerts
    while (true) {
      const resp = await this.req<OSAlertsApiResponse>(
        client,
        'GET',
        `/_plugins/_alerting/monitors/alerts?size=${PAGE_SIZE}&startIndex=${startIndex}${monitorIdParam}`
      );
      totalAlerts = resp.body.totalAlerts ?? 0;
      const pageAlerts: OSAlert[] = (resp.body.alerts ?? []).map((a: OSAlertRaw) =>
        this.mapAlert(a)
      );

      if (hasRange) {
        for (const a of pageAlerts) {
          // Active alerts have no end_time — treat as "still ongoing through
          // the window end". Using `windowEnd` (the range resolved ONCE at
          // the service entry) rather than a fresh `Date.now()` keeps the
          // filter deterministic across multi-page scans: a pagination pass
          // that spans several seconds won't let `now` drift past each
          // page's comparisons and change which alerts the filter accepts.
          //
          // This gives us a standard interval-overlap predicate:
          //   alert.start_time <= windowEnd  AND  effectiveEnd >= windowStart
          // which INCLUDES alerts that started before the window and are
          // still active, and EXCLUDES alerts that resolved before the
          // window opened or started after it closed.
          const effectiveEnd = a.end_time ?? windowEnd;
          if (a.start_time <= windowEnd && effectiveEnd >= windowStart) {
            allAlerts.push(a);
            if (allAlerts.length >= FILTER_CAP) {
              truncated = true;
              break;
            }
          }
        }
        if (truncated) break;
      } else {
        allAlerts.push(...pageAlerts);
      }

      if (pageAlerts.length < PAGE_SIZE) break;
      if (!hasRange && allAlerts.length >= totalAlerts) break;
      // We intentionally do NOT early-exit on `startIndex + PAGE_SIZE >=
      // totalAlerts` when filtering — `totalAlerts` is the server's raw
      // index count, not the filtered count. If the upstream total is
      // stale (a common thing during heavy ingest) or differs from the
      // actual number of alerts we'd see paginating, cutting the loop
      // based on it can terminate BEFORE we've seen the real last page,
      // dropping matches silently. `pageAlerts.length < PAGE_SIZE` is the
      // authoritative end-of-stream signal; worst case we make one extra
      // empty request on an exact PAGE_SIZE multiple, which is cheap.
      startIndex += PAGE_SIZE;
      if (startIndex >= SCAN_CAP) {
        truncated = true;
        break;
      }
    }

    // When filtering, `totalAlerts` on the return object reflects the
    // filtered-and-capped count (what the caller actually received); the
    // raw index total is no longer a useful number for a post-filtered
    // payload and would confuse UI consumers.
    return {
      alerts: allAlerts,
      totalAlerts: hasRange ? allAlerts.length : totalAlerts,
      truncated,
    };
  }

  /**
   * Server-paginated alerts listing.
   *
   * Pushdown to upstream `_plugins/_alerting/monitors/alerts`:
   *   - `size`/`startIndex` for page math
   *   - `sortString`/`sortOrder` from `sortField`/`sortOrder`
   *   - `severityLevel` for single-value severity (multi → post-filter)
   *   - `alertState` for single-value state (multi → post-filter)
   *   - `searchString` for `search`
   *
   * Always-post-filter (correctness — same guarantee as Phase 3):
   *   - JS-side severity/state filter even when single-value pushdown was
   *     attempted. Cheap; a page is bounded by `pageSize ≤ 200`.
   *   - `labels` post-filter (alert docs aren't normalized by label).
   *   - Time-range overlap when `startMs`/`endMs` provided.
   */
  private async getAlertsPage(
    client: AlertingOSClient,
    options: OSGetAlertsOptions
  ): Promise<{ alerts: OSAlert[]; totalAlerts: number; truncated: boolean; hasMore: boolean }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? 20), 200);
    const startIndex = (page - 1) * pageSize;

    const params: string[] = [`size=${pageSize}`, `startIndex=${startIndex}`];

    if (options.monitorId) {
      params.push(`monitorId=${encodeURIComponent(options.monitorId)}`);
    }

    const sortField = options.sortField ?? 'startTime';
    const sortString = OS_ALERT_SORT_FIELDS[sortField] ?? 'start_time';
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
    params.push(`sortString=${encodeURIComponent(sortString)}`);
    params.push(`sortOrder=${sortOrder}`);

    if (options.severity && options.severity.length === 1) {
      const lvl = OS_SEVERITY_LEVELS[options.severity[0]];
      if (lvl) params.push(`severityLevel=${lvl}`);
    }
    if (options.state && options.state.length === 1) {
      const stateValue = OS_ALERT_STATES[options.state[0]];
      if (stateValue) params.push(`alertState=${stateValue}`);
    }
    if (options.search) {
      params.push(`searchString=${encodeURIComponent(options.search)}`);
    }

    const path = `/_plugins/_alerting/monitors/alerts?${params.join('&')}`;
    const resp = await this.req<OSAlertsApiResponse>(client, 'GET', path);
    const totalAlerts = resp.body.totalAlerts ?? 0;
    let alerts: OSAlert[] = (resp.body.alerts ?? []).map((a: OSAlertRaw) => this.mapAlert(a));

    // Always JS post-filter for correctness — even when pushdown is in
    // play. The upstream may not honour all combinations identically;
    // post-filter keeps the response consistent across single/multi paths.
    if (options.severity && options.severity.length > 0) {
      const wanted = new Set(options.severity.map((s) => OS_SEVERITY_LEVELS[s]).filter(Boolean));
      if (wanted.size > 0) {
        alerts = alerts.filter((a) => wanted.has(a.severity));
      }
    }
    if (options.state && options.state.length > 0) {
      const wanted = new Set(
        options.state.map((s) => OS_ALERT_STATES[s]).filter((v): v is string => Boolean(v))
      );
      if (wanted.size > 0) {
        alerts = alerts.filter((a) => wanted.has(a.state));
      }
    }
    if (options.labels) {
      const labels = options.labels;
      alerts = alerts.filter((a) => {
        // OS alerts don't carry a labels record on the base shape; fall
        // through to monitor_id / trigger_id / monitor_name lookups for the
        // `monitor_id` label key (the only one the alerts table uses for OS).
        const synthetic: Record<string, string> = {
          monitor_id: a.monitor_id,
          monitor_name: a.monitor_name,
          trigger_id: a.trigger_id,
          trigger_name: a.trigger_name,
        };
        for (const [k, vs] of Object.entries(labels)) {
          if (vs.length === 0) continue;
          const v = synthetic[k];
          if (!v || !vs.includes(v)) return false;
        }
        return true;
      });
    }

    if (options.startMs !== undefined && options.endMs !== undefined) {
      const windowStart = options.startMs;
      const windowEnd = options.endMs;
      alerts = alerts.filter((a) => {
        const effectiveEnd = a.end_time ?? windowEnd;
        return a.start_time <= windowEnd && effectiveEnd >= windowStart;
      });
    }

    // `truncated` flags whether the post-filter dropped this page below
    // `pageSize` while more pages remain — caller surfaces the partial-
    // page warning via the unified service.
    const partialAfterFilter = alerts.length < pageSize && startIndex + pageSize < totalAlerts;

    return {
      alerts,
      totalAlerts,
      truncated: partialAfterFilter,
      hasMore: startIndex + pageSize < totalAlerts,
    };
  }

  async acknowledgeAlerts(
    client: AlertingOSClient,
    monitorId: string,
    alertIds: string[]
  ): Promise<unknown> {
    const resp = await this.req<unknown>(
      client,
      'POST',
      `/_plugins/_alerting/monitors/${encodeURIComponent(monitorId)}/_acknowledge/alerts`,
      { alerts: alertIds }
    );
    return resp.body;
  }

  // =========================================================================
  // Destinations
  // =========================================================================

  async getDestinations(client: AlertingOSClient): Promise<OSDestination[]> {
    const resp = await this.req<OSDestinationsApiResponse>(
      client,
      'GET',
      '/_plugins/_alerting/destinations?size=200'
    );
    return (resp.body.destinations ?? []).map((d: OSDestinationRaw) => this.mapDestination(d));
  }

  async createDestination(
    client: AlertingOSClient,
    dest: Omit<OSDestination, 'id'>
  ): Promise<OSDestination> {
    const resp = await this.req<{ _id: string; destination: OSDestinationRaw }>(
      client,
      'POST',
      '/_plugins/_alerting/destinations',
      dest
    );
    return this.mapDestination({ id: resp.body._id, ...resp.body.destination });
  }

  async deleteDestination(client: AlertingOSClient, destId: string): Promise<boolean> {
    try {
      await this.req(
        client,
        'DELETE',
        `/_plugins/_alerting/destinations/${encodeURIComponent(destId)}`
      );
      return true;
    } catch (err) {
      if (this.is404(err)) return false;
      throw err;
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async req<T = unknown>(
    client: AlertingOSClient,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<{ body: T }> {
    const resp = await client.transport.request({
      method,
      path,
      body: body || undefined,
    });
    return { body: resp.body as T };
  }

  private mapMonitor(id: string, source: OSMonitorSource): OSMonitor {
    return {
      id,
      type: (source.type as OSMonitor['type']) || 'monitor',
      monitor_type: (source.monitor_type as OSMonitor['monitor_type']) || 'query_level_monitor',
      name: source.name || '',
      enabled: source.enabled ?? true,
      schedule: source.schedule || { period: { interval: 5, unit: 'MINUTES' } },
      inputs: source.inputs || [],
      triggers: (source.triggers || []).map((t: OSRawTrigger) => this.mapTrigger(t)),
      last_update_time: source.last_update_time || Date.now(),
      schema_version: source.schema_version,
    };
  }

  private mapTrigger(t: OSRawTrigger): OSTrigger {
    // OpenSearch returns triggers in different formats depending on monitor_type
    // For query_level_monitor: { query_level_trigger: { ... } }
    // For bucket_level_monitor: { bucket_level_trigger: { ... } }
    // Normalize to flat trigger format
    const inner = (t.query_level_trigger ||
      t.bucket_level_trigger ||
      t.doc_level_trigger ||
      t) as OSRawTrigger;
    return {
      id: inner.id || '',
      name: inner.name || '',
      severity: String(inner.severity || '3') as OSTrigger['severity'],
      condition: {
        script: {
          source: inner.condition?.script?.source || '',
          lang: inner.condition?.script?.lang || 'painless',
        },
      },
      actions: (inner.actions || []).map((a: OSRawAction) => ({
        id: a.id || '',
        name: a.name || '',
        destination_id: a.destination_id || '',
        message_template: { source: a.message_template?.source || '' },
        subject_template: a.subject_template
          ? { source: a.subject_template.source || '' }
          : undefined,
        throttle_enabled: a.throttle_enabled ?? false,
        throttle: a.throttle as OSTrigger['actions'][0]['throttle'],
      })),
    };
  }

  private mapAlert(a: OSAlertRaw): OSAlert {
    return {
      id: a.id || a.alert_id || '',
      version: a.version ?? 1,
      monitor_id: a.monitor_id || '',
      monitor_name: a.monitor_name || '',
      monitor_version: a.monitor_version ?? 1,
      trigger_id: a.trigger_id || '',
      trigger_name: a.trigger_name || '',
      state: (a.state || 'ACTIVE') as OSAlert['state'],
      severity: String(a.severity || '3') as OSAlert['severity'],
      error_message: a.error_message || null,
      start_time: a.start_time || Date.now(),
      last_notification_time: a.last_notification_time || Date.now(),
      end_time: a.end_time || null,
      acknowledged_time: a.acknowledged_time || null,
      action_execution_results: (a.action_execution_results ||
        []) as OSAlert['action_execution_results'],
    };
  }

  private mapDestination(d: OSDestinationRaw): OSDestination {
    return {
      id: d.id || '',
      type: (d.type || 'custom_webhook') as OSDestination['type'],
      name: d.name || '',
      last_update_time: d.last_update_time || Date.now(),
      schema_version: d.schema_version,
      slack: d.slack,
      custom_webhook: d.custom_webhook,
      email: d.email,
    };
  }

  private is404(err: unknown): boolean {
    return isStatusCode(err, 404);
  }
}
