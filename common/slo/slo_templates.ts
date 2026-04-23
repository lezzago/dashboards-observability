/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SLO templates — pre-configured partial SloSpec fragments used by the wizard
 * to pre-fill common HTTP / gRPC / custom PromQL patterns.
 *
 * A template yields a `SloSpecPartial` with sensible defaults; the wizard
 * overlays the user's service, dimensions, objectives, and metadata on top of
 * the template before submitting.
 *
 * Separately, `detectMetricType()` attempts to infer the Prometheus metric
 * type (counter vs histogram vs ...) from metadata or naming conventions, so
 * the wizard can auto-suggest the matching template. Graceful degradation:
 * when metadata is unavailable, heuristics and plain-text fallbacks are used.
 */

import type { PrometheusSliType, SliCalcMethod } from './slo_types';
import type { PrometheusMetricMetadata } from '../types/alerting/types';

// ============================================================================
// Template interface
// ============================================================================

/**
 * A template produces the Prometheus-SLI portion of `SloSpec` plus a few
 * wizard-side defaults (service/operation label name hints, default latency
 * threshold). The wizard is responsible for filling in `objectives`, `window`,
 * owner/tier, etc.
 */
export interface SloTemplate {
  id: string;
  name: string;
  description: string;
  /** OUI icon name for the card ('globe', 'clock', 'visBarVertical', 'wrench'). */
  icon: string;

  /** SLI body the template proposes. `metric` may be empty for Custom. */
  sli: {
    type: PrometheusSliType;
    calcMethod: SliCalcMethod;
    metric?: string;
    goodEventsFilter?: string;
    latencyThresholdUnit?: 'seconds' | 'milliseconds';
  };

  /** Hints the wizard uses for the dimension pickers. */
  dimensionHints: { serviceLabel: string; operationLabel: string };

  /** Default latency bound (per-objective) in the unit above. */
  defaultLatencyThreshold?: number;

  /** Metric types the template expects when auto-detection runs. */
  expectedMetricType: 'counter' | 'histogram';

  /** Metric-name regex for auto-detection. Custom template matches everything. */
  detectionPattern: RegExp;
}

// ============================================================================
// Built-in templates (P0 set: 5 templates)
// ============================================================================

export const SLO_TEMPLATES: readonly SloTemplate[] = [
  {
    id: 'http-availability',
    name: 'HTTP Availability',
    description:
      'Track the ratio of successful HTTP requests (non-5xx) to total requests. ' +
      'Best for services exposing http_requests_total counters.',
    icon: 'globe',
    sli: {
      type: 'availability',
      calcMethod: 'events',
      metric: 'http_requests_total',
      goodEventsFilter: 'status_code!~"5.."',
    },
    dimensionHints: { serviceLabel: 'service', operationLabel: 'handler' },
    expectedMetricType: 'counter',
    detectionPattern: /^https?_requests?_total$|^http_server_requests?_total$/,
  },
  {
    id: 'http-latency',
    name: 'HTTP Latency',
    description:
      'Track the fraction of requests under a latency threshold from histogram buckets. ' +
      'Best for services exposing http_request_duration_seconds histogram.',
    icon: 'clock',
    sli: {
      type: 'latency_threshold',
      calcMethod: 'events',
      metric: 'http_request_duration_seconds_bucket',
      latencyThresholdUnit: 'seconds',
    },
    dimensionHints: { serviceLabel: 'service', operationLabel: 'handler' },
    defaultLatencyThreshold: 0.5,
    expectedMetricType: 'histogram',
    detectionPattern: /^https?_request_duration_(seconds|milliseconds)_(bucket|count|sum)$/,
  },
  {
    id: 'grpc-availability',
    name: 'gRPC Availability',
    description:
      'Track the ratio of successful gRPC calls (non-error codes) to total calls. ' +
      'Best for gRPC services exposing grpc_server_handled_total counters.',
    icon: 'visBarVertical',
    sli: {
      type: 'availability',
      calcMethod: 'events',
      metric: 'grpc_server_handled_total',
      goodEventsFilter:
        'grpc_code!~"INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED|UNKNOWN|RESOURCE_EXHAUSTED|DATA_LOSS"',
    },
    dimensionHints: { serviceLabel: 'grpc_service', operationLabel: 'grpc_method' },
    expectedMetricType: 'counter',
    detectionPattern: /^grpc_server_handled_total$/,
  },
  {
    id: 'grpc-latency',
    name: 'gRPC Latency',
    description:
      'Track the fraction of gRPC calls under a latency threshold from histogram buckets. ' +
      'Best for gRPC services exposing grpc_server_handling_seconds histogram.',
    icon: 'clock',
    sli: {
      type: 'latency_threshold',
      calcMethod: 'events',
      metric: 'grpc_server_handling_seconds_bucket',
      latencyThresholdUnit: 'seconds',
    },
    dimensionHints: { serviceLabel: 'grpc_service', operationLabel: 'grpc_method' },
    defaultLatencyThreshold: 0.5,
    expectedMetricType: 'histogram',
    detectionPattern: /^grpc_server_handling_(seconds|milliseconds)_(bucket|count|sum)$/,
  },
  {
    id: 'custom',
    name: 'Custom PromQL',
    description:
      'Start from a blank slate. Supply your own PromQL — either good + total queries, ' +
      'or a single pre-computed error-ratio query.',
    icon: 'wrench',
    sli: {
      type: 'custom',
      calcMethod: 'events',
    },
    dimensionHints: { serviceLabel: 'service', operationLabel: 'endpoint' },
    expectedMetricType: 'counter',
    detectionPattern: /./,
  },
] as const;

// ============================================================================
// Metric type detection
// ============================================================================

export type InferredMetricType = 'counter' | 'histogram' | 'gauge' | 'summary' | 'unknown';

export interface MetricDetectionResult {
  type: InferredMetricType;
  suggestedSliType: PrometheusSliType;
  suggestedTemplate: SloTemplate | null;
}

/**
 * Detect a metric's type and suggest a matching template.
 *
 *  1. Prefer metadata from `/api/v1/metadata`
 *  2. Fall back to Prometheus naming suffix heuristics (_total, _bucket, ...)
 *  3. Regex-match the metric name against each template's detectionPattern
 *     (excluding the Custom catch-all)
 *
 * Returns `suggestedTemplate: null` when nothing specific matches.
 */
export function detectMetricType(
  metricName: string,
  metadata?: PrometheusMetricMetadata
): MetricDetectionResult {
  let type: InferredMetricType = 'unknown';
  if (metadata?.type && metadata.type !== 'unknown') {
    type = metadata.type;
  } else {
    type = inferTypeFromSuffix(metricName);
  }
  const suggestedSliType: PrometheusSliType =
    type === 'histogram' ? 'latency_threshold' : 'availability';
  return {
    type,
    suggestedSliType,
    suggestedTemplate: findMatchingTemplate(metricName),
  };
}

function inferTypeFromSuffix(metricName: string): InferredMetricType {
  if (metricName.endsWith('_total')) return 'counter';
  if (metricName.endsWith('_bucket')) return 'histogram';
  if (metricName.endsWith('_count')) return 'histogram';
  if (metricName.endsWith('_sum')) return 'histogram';
  if (metricName.endsWith('_gauge')) return 'gauge';
  return 'unknown';
}

function findMatchingTemplate(metricName: string): SloTemplate | null {
  for (const t of SLO_TEMPLATES) {
    if (t.id === 'custom') continue;
    if (t.detectionPattern.test(metricName)) return t;
  }
  return null;
}

// ============================================================================
// Good-events filter presets — wizard dropdown content
// ============================================================================

export interface GoodEventsFilterPreset {
  label: string;
  value: string;
  description?: string;
}

export const GOOD_EVENTS_FILTER_PRESETS: readonly GoodEventsFilterPreset[] = [
  {
    label: 'HTTP success (non-5xx)',
    value: 'status_code!~"5.."',
    description: 'Counts every non-5xx response as good — 4xx requests are counted as good too.',
  },
  {
    label: 'HTTP 2xx only',
    value: 'status_code=~"2.."',
    description: 'Only 2xx responses are good. Stricter — redirects and 4xx count as bad.',
  },
  {
    label: 'gRPC OK',
    value: 'grpc_code="OK"',
    description: 'Only gRPC OK is good. All other codes (including NOT_FOUND) are bad.',
  },
  {
    label: 'gRPC non-error',
    value: 'grpc_code!~"INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED"',
    description: 'Excludes only severe gRPC error codes.',
  },
] as const;

// ============================================================================
// Error-budget display
// ============================================================================

export interface ErrorBudgetDisplay {
  /** Error budget in seconds. */
  raw: number;
  /** Formatted e.g. "Error budget: 43.2 minutes/month". */
  formatted: string;
}

/** Parse "7d" / "30d" / "1h" / ... to milliseconds. */
function durationToMs(duration: string): number {
  const m = duration.match(/^(\d+)(s|m|h|d|w)$/);
  if (!m) return 0;
  const v = parseInt(m[1], 10);
  const mul = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]] ?? 0;
  return v * mul;
}

export function formatErrorBudget(target: number, windowDuration: string): ErrorBudgetDisplay {
  const windowSec = durationToMs(windowDuration) / 1000;
  const raw = (1 - target) * windowSec;
  return { raw, formatted: `Error budget: ${prettyBudget(raw, windowDuration)}` };
}

function prettyBudget(budgetSeconds: number, windowDuration: string): string {
  const label = windowLabel(windowDuration);
  let value: number;
  let unit: string;
  if (budgetSeconds < 120) {
    value = budgetSeconds;
    unit = 'seconds';
  } else if (budgetSeconds < 5400) {
    value = budgetSeconds / 60;
    unit = 'minutes';
  } else {
    value = budgetSeconds / 3600;
    unit = 'hours';
  }
  return `${formatNumber(value)} ${unit}/${label}`;
}

function windowLabel(windowDuration: string): string {
  switch (windowDuration) {
    case '1d':
      return 'day';
    case '7d':
      return 'week';
    case '28d':
    case '30d':
      return 'month';
    default:
      return windowDuration;
  }
}

function formatNumber(value: number): string {
  if (value === 0) return '0';
  if (value >= 100) return value.toFixed(1).replace(/\.0$/, '');
  return parseFloat(value.toPrecision(3)).toString();
}
