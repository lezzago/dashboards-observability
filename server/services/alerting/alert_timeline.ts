/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alert timeline resolver — owns the per-backend implementation of
 * `GET /api/alerting/unified/alerts/timeline`. Standalone (no `this`) so
 * the routes layer can call it directly with the backends + client +
 * datasource service injected.
 *
 * Per-backend strategy:
 *   - Prometheus: range query `sum by(severity) (ALERTS{alertstate="firing"})`
 *     — series count is bounded by severity cardinality (≤ 5), unlike the
 *     raw `ALERTS{}` matrix whose cardinality is the number of distinct
 *     alert label sets.
 *   - OpenSearch: paginate `osBackend.getAlerts({ startMs, endMs })` and
 *     bucket server-side. We deliberately do NOT issue `_search` directly
 *     against `.opendistro-alerting-alert-history-*` — that index is a
 *     system index protected by the OS security plugin, which silently
 *     masks reads to 0 hits for every caller other than the alerting
 *     plugin's own internal client. All OS alerting reads go through the
 *     alerting REST API for that reason.
 *
 * Each per-datasource result is merged into a single timeline by summing
 * `(bucketIndex, severity)` cells across datasources. Failed datasources
 * contribute zero to all buckets but appear in `datasourceStatus`.
 */
import type {
  AlertingOSClient,
  AlertsTimelineBucket,
  AlertsTimelineResponse,
  Datasource,
  DatasourceFetchFallback,
  DatasourceFetchResult,
  DatasourceService,
  Logger,
  OpenSearchBackend,
  OSAlert,
  PrometheusBackend,
  TimelineSeverityCounts,
  UnifiedAlertSeverity,
} from '../../../common/types/alerting';
import { parseDateMathMs, clampServerBucketCount } from '../../../common/services/alerting';
import { osSeverityToUnified, promSeverityFromLabels } from './alert_utils';
import type { DirectQueryPrometheusBackend } from './directquery_prometheus_backend';
import { TimeoutError } from './timeout_error';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Filters forwarded to the timeline endpoint by the chart hook. */
export interface TimelineFilterOptions {
  severity?: UnifiedAlertSeverity[];
  state?: Array<'active' | 'pending' | 'acknowledged' | 'resolved' | 'error' | 'silenced'>;
  /** Label-equality matchers; multi-value entries become regex unions. */
  labels?: Record<string, string[]>;
  /**
   * Free-text search forwarded to OS via `searchString` and to Prom via an
   * `alertname=~".*<escaped>.*"` matcher. Prom matcher is wrapped in
   * `topk(200, …)` so a broad regex never blows up series cardinality.
   */
  search?: string;
}

/** Cap on Prometheus timeline series when the user supplies a search. */
export const PROM_TIMELINE_SEARCH_TOPK = 200;

export interface GetUnifiedTimelineOptions extends TimelineFilterOptions {
  dsIds?: string[];
  startTime: string;
  endTime: string;
  buckets?: number;
  timeoutMs?: number;
}

/** Per-datasource resolver context. */
interface ResolverContext {
  datasourceService: DatasourceService;
  osBackend: OpenSearchBackend | undefined;
  promBackend: PrometheusBackend | undefined;
  clientResolver: (dsId: string) => Promise<AlertingOSClient>;
  logger: Logger;
}

const ZERO_COUNTS = (): TimelineSeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

function makeEmptyBuckets(
  startMs: number,
  bucketCount: number,
  bucketDurationMs: number
): AlertsTimelineBucket[] {
  const buckets: AlertsTimelineBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      ts: startMs + i * bucketDurationMs,
      severity: ZERO_COUNTS(),
    });
  }
  return buckets;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new TimeoutError(message, ms));
      }
    }, ms);
    promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}

/**
 * Top-level entry. Resolves date-math, picks the bucket count, fans out
 * to datasource resolvers in parallel, and merges per-bucket counts into
 * one timeline.
 */
export async function getUnifiedTimeline(
  ctx: ResolverContext,
  options: GetUnifiedTimelineOptions
): Promise<AlertsTimelineResponse> {
  const startMs = parseDateMathMs(options.startTime, /* isEndTime */ false);
  const endMs = parseDateMathMs(options.endTime, /* isEndTime */ true);
  const bucketCount = clampServerBucketCount(options.buckets ?? 24);
  const rangeMs = Math.max(1, endMs - startMs);
  const bucketDurationMs = Math.max(1, Math.floor(rangeMs / bucketCount));
  const fetchedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const datasources = await resolveDatasources(ctx.datasourceService, options.dsIds);

  const settled = await Promise.allSettled(
    datasources.map(async (ds) => {
      const client = await ctx.clientResolver(ds.id);
      return fetchTimelineFromDatasource(
        ctx,
        client,
        ds,
        startMs,
        endMs,
        bucketCount,
        bucketDurationMs,
        timeoutMs,
        options
      );
    })
  );

  const merged = makeEmptyBuckets(startMs, bucketCount, bucketDurationMs);
  const datasourceStatus: Array<DatasourceFetchResult<AlertsTimelineBucket>> = [];

  for (let i = 0; i < datasources.length; i++) {
    const ds = datasources[i];
    const res = settled[i];
    if (res.status === 'fulfilled') {
      const { result, perBucket } = res.value;
      datasourceStatus.push(result);
      if (perBucket) {
        for (let j = 0; j < bucketCount; j++) {
          const sev = perBucket[j].severity;
          merged[j].severity.critical += sev.critical;
          merged[j].severity.high += sev.high;
          merged[j].severity.medium += sev.medium;
          merged[j].severity.low += sev.low;
          merged[j].severity.info += sev.info;
        }
      }
    } else {
      datasourceStatus.push({
        datasourceId: ds.id,
        datasourceName: ds.name,
        datasourceType: ds.type,
        status: 'error',
        data: [],
        error: String(res.reason),
        durationMs: timeoutMs,
      });
    }
  }

  return {
    buckets: merged,
    bucketCount,
    bucketDurationMs,
    datasourceStatus,
    fetchedAt,
  };
}

async function resolveDatasources(
  datasourceService: DatasourceService,
  dsIds?: string[]
): Promise<Datasource[]> {
  const all = await datasourceService.list();
  const enabled = all.filter((ds) => ds.enabled);
  if (!dsIds || dsIds.length === 0) return enabled;
  const out: Datasource[] = [];
  for (const id of dsIds) {
    const match = enabled.find((ds) => ds.id === id);
    if (match) out.push(match);
  }
  return out;
}

/**
 * Run the timeline aggregation for a single datasource. Wraps the
 * per-backend implementation in the shared timeout + status envelope so
 * any error surfaces on the per-datasource status entry instead of
 * blowing up the whole request.
 */
async function fetchTimelineFromDatasource(
  ctx: ResolverContext,
  client: AlertingOSClient,
  ds: Datasource,
  startMs: number,
  endMs: number,
  bucketCount: number,
  bucketDurationMs: number,
  timeoutMs: number,
  options: GetUnifiedTimelineOptions
): Promise<{
  result: DatasourceFetchResult<AlertsTimelineBucket>;
  perBucket: AlertsTimelineBucket[] | null;
}> {
  const start = Date.now();
  try {
    const inner = await withTimeout(
      runDatasourceTimeline(
        ctx,
        client,
        ds,
        startMs,
        endMs,
        bucketCount,
        bucketDurationMs,
        options
      ),
      timeoutMs,
      `Datasource ${ds.name} timed out after ${timeoutMs}ms`
    );
    return {
      result: {
        datasourceId: ds.id,
        datasourceName: ds.name,
        datasourceType: ds.type,
        status: 'success',
        data: inner.buckets,
        durationMs: Date.now() - start,
        ...(inner.fallback ? { fallback: inner.fallback } : {}),
      },
      perBucket: inner.buckets,
    };
  } catch (err) {
    const isTimeout = err instanceof TimeoutError;
    ctx.logger.error(`Failed to fetch alerts timeline from ${ds.name}: ${err}`);
    return {
      result: {
        datasourceId: ds.id,
        datasourceName: ds.name,
        datasourceType: ds.type,
        status: isTimeout ? 'timeout' : 'error',
        data: [],
        error: String(err),
        durationMs: Date.now() - start,
      },
      perBucket: null,
    };
  }
}

async function runDatasourceTimeline(
  ctx: ResolverContext,
  client: AlertingOSClient,
  ds: Datasource,
  startMs: number,
  endMs: number,
  bucketCount: number,
  bucketDurationMs: number,
  options: GetUnifiedTimelineOptions
): Promise<{ buckets: AlertsTimelineBucket[]; fallback?: DatasourceFetchFallback }> {
  if (ds.type === 'prometheus' && ctx.promBackend) {
    return fetchPromTimelineBuckets(
      ctx.promBackend,
      client,
      ds,
      startMs,
      endMs,
      bucketCount,
      bucketDurationMs,
      options
    );
  }
  if (ds.type === 'opensearch' && ctx.osBackend) {
    return fetchOSTimelineBuckets(
      ctx.osBackend,
      client,
      startMs,
      endMs,
      bucketCount,
      bucketDurationMs,
      options
    );
  }
  return { buckets: makeEmptyBuckets(startMs, bucketCount, bucketDurationMs) };
}

// ============================================================================
// Prometheus implementation
// ============================================================================

/**
 * Build the matcher list (excluding `alertstate`) for the `ALERTS{...}`
 * selector based on the request's severity + labels filters.
 *
 * Severity values come from a fixed unified-vocabulary allowlist; label
 * keys are validated against the standard PromQL identifier grammar and
 * label values are quoted with `\\` and `"` escaped per Prom string
 * literal rules.
 */
export function buildPromSelectorMatchers(options: TimelineFilterOptions): string[] {
  const matchers: string[] = [];

  if (options.severity && options.severity.length > 0) {
    if (options.severity.length === 1) {
      matchers.push(`severity="${options.severity[0]}"`);
    } else {
      matchers.push(`severity=~"${options.severity.join('|')}"`);
    }
  }

  if (options.labels) {
    for (const [k, vs] of Object.entries(options.labels)) {
      const key = sanitizePromLabelName(k);
      if (!key || vs.length === 0) continue;
      const safeValues = vs
        .map((v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
        .filter((v) => v.length > 0);
      if (safeValues.length === 0) continue;
      if (safeValues.length === 1) {
        matchers.push(`${key}="${safeValues[0]}"`);
      } else {
        matchers.push(`${key}=~"${safeValues.join('|')}"`);
      }
    }
  }

  return matchers;
}

function sanitizePromLabelName(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : '';
}

/**
 * Determine the `alertstate=...` matcher to apply to the selector. By
 * default Prom alerts list path skips `pending` (step-flapping reasons,
 * see Phase 1 commit). An explicit `state[]` filter can override that.
 */
export function buildAlertStateMatcher(state?: TimelineFilterOptions['state']): string {
  if (!state || state.length === 0) return 'alertstate="firing"';
  const promStates = new Set<string>();
  for (const s of state) {
    if (s === 'active') promStates.add('firing');
    else if (s === 'pending') promStates.add('pending');
    // OS-only states (acknowledged / resolved / error / silenced) have no
    // Prom equivalent — drop them; the matcher stays firing-only.
  }
  if (promStates.size === 0) return 'alertstate="firing"';
  if (promStates.size === 1) return `alertstate="${[...promStates][0]}"`;
  return `alertstate=~"${[...promStates].sort().join('|')}"`;
}

/**
 * Escape user input so it's safe to embed inside a PromQL regex string
 * literal. Per Prom's grammar (RE2), the literal-string layer escapes `\`
 * and `"`; the regex layer escapes its own metacharacters. We do both,
 * since the input is treated as a literal substring.
 */
export function escapePromRegexLiteral(input: string): string {
  // Escape RE2 metacharacters first, then the string-literal escape.
  const re = input.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return re.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function fetchPromTimelineBuckets(
  promBackend: PrometheusBackend,
  client: AlertingOSClient,
  ds: Datasource,
  startMs: number,
  endMs: number,
  bucketCount: number,
  bucketDurationMs: number,
  options: TimelineFilterOptions
): Promise<{ buckets: AlertsTimelineBucket[]; fallback?: DatasourceFetchFallback }> {
  const dq = (promBackend as unknown) as Partial<DirectQueryPrometheusBackend>;
  if (!dq.queryRangeMatrix) {
    return { buckets: makeEmptyBuckets(startMs, bucketCount, bucketDurationMs) };
  }

  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  const stepSec = Math.max(1, Math.floor((endMs - startMs) / 1000 / bucketCount));

  const stateMatcher = buildAlertStateMatcher(options.state);
  const extraMatchers = buildPromSelectorMatchers(options);

  // `search` becomes an `alertname=~".*<escaped>.*"` matcher. Wrapped in
  // `topk(200, …)` to bound series cardinality — without it a broad
  // regex (e.g. `.*` or `service.*`) would re-introduce the unbounded-
  // matrix problem Phase 1 fixed.
  const searchTrim = options.search?.trim();
  const matcherList = [stateMatcher, ...extraMatchers];
  if (searchTrim) {
    matcherList.push(`alertname=~".*${escapePromRegexLiteral(searchTrim)}.*"`);
  }
  const matchers = matcherList.join(', ');
  const selector = `ALERTS{${matchers}}`;
  const grouped = `sum by(severity) (${selector})`;
  const groupedQuery = searchTrim
    ? `sum by(severity) (topk(${PROM_TIMELINE_SEARCH_TOPK}, ${selector}))`
    : grouped;
  const searchTruncated = !!searchTrim;

  const series = await dq.queryRangeMatrix!(client, ds, groupedQuery, startSec, endSec, stepSec);

  // If `sum by(severity)` returned series but none of them carries a
  // severity label (rules without a `severity:` annotation), fall back
  // to `count(...)` and bucket everything as medium so the chart still
  // renders something. Surface the fallback on the per-datasource
  // status.
  const hasSeverityLabel = series.some(
    (s) => typeof s.metric.severity === 'string' && s.metric.severity.length > 0
  );
  if (series.length === 0 || !hasSeverityLabel) {
    if (series.length === 0) {
      // Empty-matrix is a valid result (no alerts fired); no fallback.
      return {
        buckets: makeEmptyBuckets(startMs, bucketCount, bucketDurationMs),
        ...(searchTruncated ? { fallback: 'prometheus-search-truncated' as const } : {}),
      };
    }
    const innerCount = searchTrim ? `topk(${PROM_TIMELINE_SEARCH_TOPK}, ${selector})` : selector;
    const countQuery = `count(${innerCount})`;
    const countSeries = await dq.queryRangeMatrix!(
      client,
      ds,
      countQuery,
      startSec,
      endSec,
      stepSec
    );
    const buckets = makeEmptyBuckets(startMs, bucketCount, bucketDurationMs);
    for (const s of countSeries) {
      for (const point of s.values) {
        const idx = sampleToBucketIndex(point.timestamp, startMs, bucketDurationMs, bucketCount);
        if (idx < 0) continue;
        buckets[idx].severity.medium += point.value;
      }
    }
    // Search-truncated wins over the no-severity fallback for the
    // per-datasource hint; the chart still renders, but the boundary
    // is the more important signal for callers asserting on it.
    return {
      buckets,
      fallback: searchTruncated
        ? ('prometheus-search-truncated' as const)
        : ('prometheus-no-severity-labels' as const),
    };
  }

  const buckets = makeEmptyBuckets(startMs, bucketCount, bucketDurationMs);
  for (const s of series) {
    const sev = labelToSeverity(s.metric.severity || '');
    for (const point of s.values) {
      const idx = sampleToBucketIndex(point.timestamp, startMs, bucketDurationMs, bucketCount);
      if (idx < 0) continue;
      buckets[idx].severity[sev] += point.value;
    }
  }
  return {
    buckets,
    ...(searchTruncated ? { fallback: 'prometheus-search-truncated' as const } : {}),
  };
}

function sampleToBucketIndex(
  sampleMs: number,
  startMs: number,
  bucketDurationMs: number,
  bucketCount: number
): number {
  const idx = Math.floor((sampleMs - startMs) / bucketDurationMs);
  if (idx < 0 || idx >= bucketCount) return -1;
  return idx;
}

function labelToSeverity(raw: string): UnifiedAlertSeverity {
  return promSeverityFromLabels({ severity: raw });
}

// ============================================================================
// OpenSearch implementation
// ============================================================================

/**
 * OS timeline implementation. Buckets are computed server-side from
 * `osBackend.getAlerts({ startMs, endMs })`, which goes through the
 * alerting plugin's REST API (`/_plugins/_alerting/monitors/alerts`).
 *
 * We intentionally do NOT issue `_search` directly against
 * `.opendistro-alerting-alert-history-*`: that index is registered as a
 * system index by the alerting plugin and the OS security plugin
 * silently masks it (returns `hits.total: 0` with `successful: 1`
 * shards) to every caller other than the alerting plugin's own internal
 * client. A direct aggregation produces an empty chart on
 * security-enabled clusters even when alerts exist.
 */
export async function fetchOSTimelineBuckets(
  osBackend: OpenSearchBackend,
  client: AlertingOSClient,
  startMs: number,
  endMs: number,
  bucketCount: number,
  bucketDurationMs: number,
  options: TimelineFilterOptions
): Promise<{ buckets: AlertsTimelineBucket[] }> {
  const { alerts } = await osBackend.getAlerts(client, { startMs, endMs });
  const buckets = makeEmptyBuckets(startMs, bucketCount, bucketDurationMs);

  const severityFilter = options.severity ? new Set(options.severity) : null;
  const stateFilter = options.state ? new Set(options.state) : null;
  const searchTrim = options.search?.trim().toLowerCase();

  for (const a of alerts) {
    const sev: UnifiedAlertSeverity = osSeverityToUnified(a.severity);
    if (severityFilter && !severityFilter.has(sev)) continue;
    const state = osAlertStateForFilter(a);
    if (stateFilter && !stateFilter.has(state)) continue;
    if (searchTrim) {
      const haystack = `${a.monitor_name ?? ''} ${a.trigger_name ?? ''}`.toLowerCase();
      if (!haystack.includes(searchTrim)) continue;
    }

    const idx = sampleToBucketIndex(a.start_time, startMs, bucketDurationMs, bucketCount);
    if (idx < 0) continue;
    buckets[idx].severity[sev] += 1;
  }
  return { buckets };
}

function osAlertStateForFilter(
  a: OSAlert
): 'active' | 'pending' | 'acknowledged' | 'resolved' | 'error' | 'silenced' {
  switch (a.state) {
    case 'ACTIVE':
      return 'active';
    case 'ACKNOWLEDGED':
      return 'acknowledged';
    case 'COMPLETED':
      return 'resolved';
    case 'ERROR':
      return 'error';
    default:
      return 'active';
  }
}
