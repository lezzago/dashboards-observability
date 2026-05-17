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
  ProgressiveResponse,
  UnifiedAlert,
  UnifiedAlertSummary,
  UnifiedRule,
  UnifiedRuleSummary,
} from '../../../../common/types/alerting';

export interface ListAlertsParams {
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

export interface ListRulesParams {
  dsIds: string[];
  timeout?: number;
  maxResults?: number;
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
  timeout?: number;
  signal?: AbortSignal;
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
    // Time-range fields are defined on ListAlertsParams only. Check via
    // `in` operator rather than type narrowing because ListRulesParams
    // (the other arm of the union) intentionally does not carry them.
    if ('startTime' in params && params.startTime !== undefined) q.startTime = params.startTime;
    if ('endTime' in params && params.endTime !== undefined) q.endTime = params.endTime;
    return q;
  }

  /**
   * Unified alerts list across selected datasources.
   * Returns a `ProgressiveResponse` with `results` + per-datasource status.
   */
  async listAlerts(params: ListAlertsParams): Promise<ProgressiveResponse<UnifiedAlertSummary>> {
    return (await this.requireHttp().get('/api/alerting/unified/alerts', {
      query: this.buildQuery(params),
      signal: params.signal,
    })) as ProgressiveResponse<UnifiedAlertSummary>;
  }

  /**
   * Unified rules/monitors list across selected datasources.
   * Returns a `ProgressiveResponse` with `results` + per-datasource status.
   */
  async listRules(params: ListRulesParams): Promise<ProgressiveResponse<UnifiedRuleSummary>> {
    return (await this.requireHttp().get('/api/alerting/unified/rules', {
      query: this.buildQuery(params),
      signal: params.signal,
    })) as ProgressiveResponse<UnifiedRuleSummary>;
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
    return (await this.requireHttp().get('/api/alerting/unified/alerts/timeline', {
      query: q,
      signal: params.signal,
    })) as AlertsTimelineResponse;
  }

  /** Single alert detail for the flyout. */
  async getAlertDetail(dsId: string, alertId: string, monitorId?: string): Promise<UnifiedAlert> {
    return (await this.requireHttp().get(
      `/api/alerting/alerts/${encodeURIComponent(dsId)}/${encodeURIComponent(alertId)}`,
      monitorId ? { query: { monitorId } } : undefined
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
