/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Route handlers — pure functions that work with any HTTP framework.
 * Exposes backend-native API shapes + unified views.
 *
 * Post-Phase-3: datasource CRUD handlers and their helpers were removed —
 * datasource discovery + mutation moved to the client via saved-object
 * services (`useDatasources`, `SavedObjectDatasourceService`).
 */
import type {
  AlertingOSClient,
  OSMonitor,
  UnifiedAlertSeverity,
} from '../../../common/types/alerting';
import { MultiBackendAlertService } from '../../services/alerting';
import { toHandlerResult } from './route_utils';
import type { HandlerResult } from './route_utils';

// ============================================================================
// OpenSearch Monitor Handlers
// ============================================================================

export async function handleGetOSMonitors(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string
): Promise<HandlerResult> {
  try {
    return { status: 200, body: { monitors: await alertSvc.getOSMonitors(client, dsId) } };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleGetOSMonitor(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  monitorId: string
): Promise<HandlerResult> {
  try {
    const m = await alertSvc.getOSMonitor(client, dsId, monitorId);
    if (!m) return { status: 404, body: { error: 'Monitor not found' } };
    return { status: 200, body: m };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleCreateOSMonitor(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  body: Omit<OSMonitor, 'id'>
): Promise<HandlerResult> {
  try {
    return { status: 201, body: await alertSvc.createOSMonitor(client, dsId, body) };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleUpdateOSMonitor(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  monitorId: string,
  body: Partial<OSMonitor>
): Promise<HandlerResult> {
  try {
    const m = await alertSvc.updateOSMonitor(client, dsId, monitorId, body);
    if (!m) return { status: 404, body: { error: 'Monitor not found' } };
    return { status: 200, body: m };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleDeleteOSMonitor(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  monitorId: string
): Promise<HandlerResult> {
  try {
    const ok = await alertSvc.deleteOSMonitor(client, dsId, monitorId);
    if (!ok) return { status: 404, body: { error: 'Monitor not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

// ============================================================================
// OpenSearch Alert Handlers
// ============================================================================

export async function handleGetOSAlerts(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  query?: { startTime?: string; endTime?: string }
): Promise<HandlerResult> {
  try {
    return {
      status: 200,
      body: await alertSvc.getOSAlerts(client, dsId, {
        startTime: query?.startTime,
        endTime: query?.endTime,
      }),
    };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleAcknowledgeOSAlerts(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  monitorId: string,
  body: { alerts?: string[] }
): Promise<HandlerResult> {
  try {
    return {
      status: 200,
      body: {
        result: await alertSvc.acknowledgeOSAlerts(client, dsId, monitorId, body.alerts || []),
      },
    };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

// ============================================================================
// Prometheus Handlers
// ============================================================================

export async function handleGetPromRuleGroups(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string
): Promise<HandlerResult> {
  try {
    const groups = await alertSvc.getPromRuleGroups(client, dsId);
    return { status: 200, body: { status: 'success', data: { groups } } };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleGetPromAlerts(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  query?: { startTime?: string; endTime?: string }
): Promise<HandlerResult> {
  try {
    const alerts = await alertSvc.getPromAlerts(client, dsId, {
      startTime: query?.startTime,
      endTime: query?.endTime,
    });
    return { status: 200, body: { status: 'success', data: { alerts } } };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

// ============================================================================
// Unified View Handlers (cross-backend, parallel with per-datasource status)
// ============================================================================

export async function handleGetUnifiedAlerts(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  query?: {
    dsIds?: string;
    timeout?: string;
    maxResults?: string;
    startTime?: string;
    endTime?: string;
  }
): Promise<HandlerResult> {
  try {
    const dsIds = query?.dsIds ? query.dsIds.split(',').filter(Boolean) : undefined;
    const rawTimeout = query?.timeout ? parseInt(query.timeout, 10) : undefined;
    const timeoutMs =
      rawTimeout !== undefined && Number.isFinite(rawTimeout) ? rawTimeout : undefined;
    const rawMaxResults = query?.maxResults ? parseInt(query.maxResults, 10) : undefined;
    const maxResults =
      rawMaxResults !== undefined && Number.isFinite(rawMaxResults) ? rawMaxResults : undefined;
    const response = await alertSvc.getUnifiedAlerts(clientResolver, {
      dsIds,
      timeoutMs,
      maxResults,
      startTime: query?.startTime,
      endTime: query?.endTime,
    });
    return { status: 200, body: response };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleGetUnifiedRules(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  query?: { dsIds?: string; timeout?: string; maxResults?: string }
): Promise<HandlerResult> {
  try {
    const dsIds = query?.dsIds ? query.dsIds.split(',').filter(Boolean) : undefined;
    const rawTimeout = query?.timeout ? parseInt(query.timeout, 10) : undefined;
    const timeoutMs =
      rawTimeout !== undefined && Number.isFinite(rawTimeout) ? rawTimeout : undefined;
    const rawMaxResults = query?.maxResults ? parseInt(query.maxResults, 10) : undefined;
    const maxResults =
      rawMaxResults !== undefined && Number.isFinite(rawMaxResults) ? rawMaxResults : undefined;
    const response = await alertSvc.getUnifiedRules(clientResolver, {
      dsIds,
      timeoutMs,
      maxResults,
    });
    return { status: 200, body: response };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

// ============================================================================
// Unified Timeline Handler (Phase 2)
// ============================================================================

const SEVERITY_VALUES: ReadonlySet<UnifiedAlertSeverity> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);
type TimelineState = 'active' | 'pending' | 'acknowledged' | 'resolved' | 'error' | 'silenced';
const STATE_VALUES: ReadonlySet<TimelineState> = new Set([
  'active',
  'pending',
  'acknowledged',
  'resolved',
  'error',
  'silenced',
]);

function parseCsvSet<T extends string>(raw: string | undefined, allowed: ReadonlySet<T>): T[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is T => allowed.has(s as T));
}

function parseLabelsJson(raw: string | undefined): Record<string, string[]> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof k !== 'string') continue;
    if (!Array.isArray(v)) continue;
    const values = v.filter((x): x is string => typeof x === 'string');
    if (values.length > 0) out[k] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function handleGetUnifiedTimeline(
  alertSvc: MultiBackendAlertService,
  clientResolver: (dsId: string) => Promise<AlertingOSClient>,
  query: {
    dsIds?: string;
    startTime: string;
    endTime: string;
    buckets?: string;
    severity?: string;
    state?: string;
    labels?: string;
    timeout?: string;
  }
): Promise<HandlerResult> {
  try {
    const dsIds = query.dsIds
      ? query.dsIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const buckets = query.buckets ? parseInt(query.buckets, 10) : undefined;
    const rawTimeout = query.timeout ? parseInt(query.timeout, 10) : undefined;
    const severity = parseCsvSet(query.severity, SEVERITY_VALUES);
    const state = parseCsvSet(query.state, STATE_VALUES);
    const labels = parseLabelsJson(query.labels);
    const response = await alertSvc.getUnifiedTimeline(clientResolver, {
      dsIds,
      startTime: query.startTime,
      endTime: query.endTime,
      buckets: Number.isFinite(buckets) ? (buckets as number) : undefined,
      severity: severity.length > 0 ? severity : undefined,
      state: state.length > 0 ? state : undefined,
      labels,
      timeoutMs: rawTimeout !== undefined && Number.isFinite(rawTimeout) ? rawTimeout : undefined,
    });
    return { status: 200, body: response };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

// ============================================================================
// Detail View Handlers (on-demand, loaded when user opens flyout)
// ============================================================================

export async function handleGetRuleDetail(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  ruleId: string
): Promise<HandlerResult> {
  try {
    const rule = await alertSvc.getRuleDetail(client, dsId, ruleId);
    if (!rule) return { status: 404, body: { error: 'Rule not found' } };
    return { status: 200, body: rule };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleGetRuleRouting(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  ruleId: string
): Promise<HandlerResult> {
  try {
    const routing = await alertSvc.getRuleRouting(client, dsId, ruleId);
    if (routing === null) return { status: 404, body: { error: 'Rule not found' } };
    return { status: 200, body: { routing } };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}

export async function handleGetAlertDetail(
  alertSvc: MultiBackendAlertService,
  client: AlertingOSClient,
  dsId: string,
  alertId: string,
  monitorId?: string
): Promise<HandlerResult> {
  try {
    const alert = await alertSvc.getAlertDetail(client, dsId, alertId, monitorId);
    if (!alert) return { status: 404, body: { error: 'Alert not found' } };
    return { status: 200, body: alert };
  } catch (e: unknown) {
    return toHandlerResult(e);
  }
}
