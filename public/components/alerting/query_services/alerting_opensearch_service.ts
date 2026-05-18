/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AlertingOpenSearchService — frontend transport for OpenSearch alerting reads.
 *
 * Pattern mirrors APM's PPLSearchService: no-arg constructor, uses `coreRefs.http`,
 * each method encapsulates a single request-response shape. Components consume
 * this through hooks, never directly.
 */
import { coreRefs } from '../../../framework/core_refs';
import type {
  AlertsTimelineResponse,
  NotificationRouting,
  PaginatedResponse,
  ProgressiveResponse,
  UnifiedAlert,
  UnifiedAlertSummary,
  UnifiedRule,
  UnifiedRuleSummary,
} from '../../../../common/types/alerting';

interface PaginationParams {
  /** 1-indexed; presence selects the paginated response shape. */
  page?: number;
  pageSize?: number;
  /** "field:dir", e.g. "startTime:desc". Whitelist enforced server-side. */
  sort?: string;
}

interface AlertsFilterParamsCommon {
  severity?: string[];
  state?: string[];
  backend?: string[];
  labels?: Record<string, string[]>;
  search?: string;
  /** Force-skip the per-datasource 30s response cache. */
  noCache?: boolean;
}

export interface ListAlertsParams extends PaginationParams, AlertsFilterParamsCommon {
  dsIds: string[];
  /** Optional per-datasource timeout in ms. */
  timeout?: number;
  /** Optional cap on the total number of results returned across all datasources. */
  maxResults?: number;
  /** Date-math string (e.g. "now-1h"). */
  startTime?: string;
  /** Date-math string (e.g. "now"). */
  endTime?: string;
  /** Optional AbortSignal — when triggered, cancels the in-flight HTTP request. */
  signal?: AbortSignal;
}

export interface ListRulesParams extends PaginationParams, AlertsFilterParamsCommon {
  dsIds: string[];
  timeout?: number;
  maxResults?: number;
  monitorType?: string[];
  healthStatus?: string[];
  createdBy?: string[];
  signal?: AbortSignal;
}

export interface ListAlertsTimelineParams {
  dsIds: string[];
  startTime: string;
  endTime: string;
  buckets?: number;
  severity?: string[];
  state?: string[];
  labels?: Record<string, string[]>;
  search?: string;
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Phase 5 — server-side facets. Same wire shape as the listing params
 * but `page`/`pageSize`/`sort` are ignored at the route layer (facets
 * cover the full filtered set).
 */
export interface ListAlertsFacetsParams extends AlertsFilterParamsCommon {
  dsIds: string[];
  startTime?: string;
  endTime?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ListRulesFacetsParams extends AlertsFilterParamsCommon {
  dsIds: string[];
  monitorType?: string[];
  healthStatus?: string[];
  createdBy?: string[];
  timeout?: number;
  signal?: AbortSignal;
}

export interface AlertFacetCountsResponse {
  severity: Record<string, number>;
  state: Record<string, number>;
  backend: Record<string, number>;
  labels: Record<string, Record<string, number>>;
  total: number;
  truncated?: boolean;
  fetchedAt: string;
  warnings?: Array<{
    datasourceId: string;
    datasourceName: string;
    datasourceType: string;
    error: string;
  }>;
}

export interface RuleFacetCountsResponse {
  status: Record<string, number>;
  severity: Record<string, number>;
  monitorType: Record<string, number>;
  healthStatus: Record<string, number>;
  backend: Record<string, number>;
  createdBy: Record<string, number>;
  labels: Record<string, Record<string, number>>;
  total: number;
  truncated?: boolean;
  fetchedAt: string;
  warnings?: Array<{
    datasourceId: string;
    datasourceName: string;
    datasourceType: string;
    error: string;
  }>;
}

export class AlertingOpenSearchService {
  private requireHttp() {
    const http = coreRefs.http;
    if (!http) throw new Error('HTTP client not available');
    return http;
  }

  private buildQuery(params: ListAlertsParams | ListRulesParams): Record<string, string> {
    const q: Record<string, string> = { dsIds: params.dsIds.join(',') };
    if (params.timeout !== undefined) q.timeout = String(params.timeout);
    if (params.maxResults !== undefined) q.maxResults = String(params.maxResults);
    // Time-range fields are defined on ListAlertsParams only.
    if ('startTime' in params && params.startTime !== undefined) q.startTime = params.startTime;
    if ('endTime' in params && params.endTime !== undefined) q.endTime = params.endTime;

    if (params.page !== undefined) q.page = String(params.page);
    if (params.pageSize !== undefined) q.pageSize = String(params.pageSize);
    if (params.sort) q.sort = params.sort;
    if (params.severity && params.severity.length > 0) q.severity = params.severity.join(',');
    if (params.state && params.state.length > 0) q.state = params.state.join(',');
    if (params.backend && params.backend.length > 0) q.backend = params.backend.join(',');
    if (params.labels && Object.keys(params.labels).length > 0) {
      q.labels = JSON.stringify(params.labels);
    }
    if (params.search) q.search = params.search;
    if (params.noCache) q.noCache = '1';

    if ('monitorType' in params && params.monitorType && params.monitorType.length > 0) {
      q.monitorType = params.monitorType.join(',');
    }
    if ('healthStatus' in params && params.healthStatus && params.healthStatus.length > 0) {
      q.healthStatus = params.healthStatus.join(',');
    }
    if ('createdBy' in params && params.createdBy && params.createdBy.length > 0) {
      q.createdBy = params.createdBy.join(',');
    }
    return q;
  }

  /**
   * Unified alerts list across selected datasources.
   * When `page` is set, returns the paginated response shape; otherwise
   * the legacy progressive response.
   */
  async listAlerts(
    params: ListAlertsParams
  ): Promise<ProgressiveResponse<UnifiedAlertSummary> | PaginatedResponse<UnifiedAlertSummary>> {
    return (await this.requireHttp().get('/api/alerting/unified/alerts', {
      query: this.buildQuery(params),
      signal: params.signal,
    })) as ProgressiveResponse<UnifiedAlertSummary> | PaginatedResponse<UnifiedAlertSummary>;
  }

  /**
   * Unified rules/monitors list across selected datasources.
   */
  async listRules(
    params: ListRulesParams
  ): Promise<ProgressiveResponse<UnifiedRuleSummary> | PaginatedResponse<UnifiedRuleSummary>> {
    return (await this.requireHttp().get('/api/alerting/unified/rules', {
      query: this.buildQuery(params),
      signal: params.signal,
    })) as ProgressiveResponse<UnifiedRuleSummary> | PaginatedResponse<UnifiedRuleSummary>;
  }

  /**
   * Unified alerts timeline (aggregated severity buckets per time bucket).
   * Powers the AlertTimeline chart on the Alerts dashboard.
   */
  async listAlertsTimeline(params: ListAlertsTimelineParams): Promise<AlertsTimelineResponse> {
    const q: Record<string, string> = {
      dsIds: params.dsIds.join(','),
      startTime: params.startTime,
      endTime: params.endTime,
    };
    if (params.buckets !== undefined) q.buckets = String(params.buckets);
    if (params.timeout !== undefined) q.timeout = String(params.timeout);
    if (params.severity && params.severity.length > 0) q.severity = params.severity.join(',');
    if (params.state && params.state.length > 0) q.state = params.state.join(',');
    if (params.labels && Object.keys(params.labels).length > 0) {
      q.labels = JSON.stringify(params.labels);
    }
    if (params.search) q.search = params.search;
    return (await this.requireHttp().get('/api/alerting/unified/alerts/timeline', {
      query: q,
      signal: params.signal,
    })) as AlertsTimelineResponse;
  }

  /** Phase 5 — server-computed alert facets. */
  async listAlertFacets(params: ListAlertsFacetsParams): Promise<AlertFacetCountsResponse> {
    const q: Record<string, string> = { dsIds: params.dsIds.join(',') };
    if (params.timeout !== undefined) q.timeout = String(params.timeout);
    if (params.startTime !== undefined) q.startTime = params.startTime;
    if (params.endTime !== undefined) q.endTime = params.endTime;
    if (params.severity && params.severity.length > 0) q.severity = params.severity.join(',');
    if (params.state && params.state.length > 0) q.state = params.state.join(',');
    if (params.backend && params.backend.length > 0) q.backend = params.backend.join(',');
    if (params.labels && Object.keys(params.labels).length > 0) {
      q.labels = JSON.stringify(params.labels);
    }
    if (params.search) q.search = params.search;
    if (params.noCache) q.noCache = '1';
    return (await this.requireHttp().get('/api/alerting/unified/alerts/_facets', {
      query: q,
      signal: params.signal,
    })) as AlertFacetCountsResponse;
  }

  /** Phase 5 — server-computed rule facets. */
  async listRuleFacets(params: ListRulesFacetsParams): Promise<RuleFacetCountsResponse> {
    const q: Record<string, string> = { dsIds: params.dsIds.join(',') };
    if (params.timeout !== undefined) q.timeout = String(params.timeout);
    if (params.severity && params.severity.length > 0) q.severity = params.severity.join(',');
    if (params.state && params.state.length > 0) q.state = params.state.join(',');
    if (params.backend && params.backend.length > 0) q.backend = params.backend.join(',');
    if (params.labels && Object.keys(params.labels).length > 0) {
      q.labels = JSON.stringify(params.labels);
    }
    if (params.search) q.search = params.search;
    if (params.noCache) q.noCache = '1';
    if (params.monitorType && params.monitorType.length > 0) {
      q.monitorType = params.monitorType.join(',');
    }
    if (params.healthStatus && params.healthStatus.length > 0) {
      q.healthStatus = params.healthStatus.join(',');
    }
    if (params.createdBy && params.createdBy.length > 0) {
      q.createdBy = params.createdBy.join(',');
    }
    return (await this.requireHttp().get('/api/alerting/unified/rules/_facets', {
      query: q,
      signal: params.signal,
    })) as RuleFacetCountsResponse;
  }

  /**
   * Single alert detail for the flyout.
   *
   * `labels` + `startTime` + `endTime` are Prom-only — they feed the
   * server-side range query that walks `ALERTS{<labels>}[<range>]` to
   * produce per-episode start/end times. OS callers omit them.
   */
  async getAlertDetail(
    dsId: string,
    alertId: string,
    monitorId?: string,
    labels?: Record<string, string>,
    startTime?: string,
    endTime?: string
  ): Promise<UnifiedAlert> {
    const query: Record<string, string> = {};
    if (monitorId) query.monitorId = monitorId;
    if (labels) query.labels = JSON.stringify(labels);
    if (startTime) query.startTime = startTime;
    if (endTime) query.endTime = endTime;
    return (await this.requireHttp().get(
      `/api/alerting/alerts/${encodeURIComponent(dsId)}/${encodeURIComponent(alertId)}`,
      Object.keys(query).length > 0 ? { query } : undefined
    )) as UnifiedAlert;
  }

  /** Single rule detail for the flyout. */
  async getRuleDetail(dsId: string, ruleId: string): Promise<UnifiedRule> {
    return (await this.requireHttp().get(
      `/api/alerting/rules/${encodeURIComponent(dsId)}/${encodeURIComponent(ruleId)}`
    )) as UnifiedRule;
  }

  /**
   * Notification routing for one rule. Loaded lazily by the rule flyout when
   * the user expands the Notification Routing accordion — keeps the detail
   * call cheap and avoids the per-flyout-open destinations fetch.
   */
  async getRuleRouting(dsId: string, ruleId: string): Promise<NotificationRouting[]> {
    const resp = (await this.requireHttp().get(
      `/api/alerting/rules/${encodeURIComponent(dsId)}/${encodeURIComponent(ruleId)}/routing`
    )) as { routing: NotificationRouting[] };
    return resp.routing;
  }
}
