/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure draft-suggestion engine for the "Suggest SLOs" page.
 *
 * Given a small slice of Prometheus metadata (metric names, label values per
 * metric), it emits a list of `Suggestion` records: each record is already a
 * well-formed `SloCreateInput` plus a little UI-facing metadata (reason,
 * estimated rule count). The user can toggle, tweak, and then create.
 *
 * No I/O. All metadata fetching lives in the page component.
 */

import { DEFAULT_MWMBR_TIERS } from '../../../../../common/slo/slo_promql_generator';
import type {
  BurnRateConfig,
  PrometheusSli,
  SingleSli,
  SloAlarmConfig,
  SloCreateInput,
  SloSpec,
} from '../../../../../common/slo/slo_types';

/** Input slice the page collects from the metadata endpoints. */
export interface DiscoveryInput {
  datasourceId: string;
  /** All metric names visible on the datasource. */
  metricNames: string[];
  /**
   * For each metric we care about, the values seen on its relevant dimension
   * labels. Page fetches only what the engine needs.
   */
  labelValuesByMetric: Record<
    string,
    {
      // generic
      job?: string[];
      service_name?: string[];
      // new OTel semconv
      http_route?: string[];
      http_request_method?: string[];
      // legacy OTel semconv
      http_target?: string[];
      http_method?: string[];
      // gRPC
      grpc_service?: string[];
      grpc_method?: string[];
    }
  >;
}

/** One draft SLO the user can accept / tweak / discard. */
export interface Suggestion {
  /** Stable key for React list + selection state. */
  key: string;
  /** Pre-filled create payload. */
  input: SloCreateInput;
  /** Short human-readable reason shown in the card. */
  reason: string;
  /** Chip label ("HTTP availability", "gRPC latency" etc.). */
  kind: string;
  /** Detected metric the SLI targets — shown in the card body. */
  sourceMetric: string;
  /** Jobs / services / routes used as dimensions (for display). */
  detected: Record<string, string>;
  /**
   * Expected number of rules if created with defaults — 7 recording +
   * 4 MWMBR + N budget warnings for a single-objective SLO.
   */
  estimatedRuleCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_BURN_RATES: BurnRateConfig[] = DEFAULT_MWMBR_TIERS.map((t) => ({ ...t }));

const DEFAULT_ALARMS: SloAlarmConfig = {
  sliHealth: { enabled: false },
  attainmentBreach: { enabled: false },
  budgetWarning: { enabled: true },
  noData: { enabled: false, forDuration: '10m' },
  resolved: { enabled: false },
};

const DEFAULT_BUDGETS = [
  { threshold: 0.5, severity: 'warning' },
  { threshold: 0.2, severity: 'critical' },
];

/** `opentelemetry-demo/flagd` → `flagd`; otherwise return as-is. */
function jobToServiceName(job: string): string {
  const slash = job.lastIndexOf('/');
  return slash >= 0 ? job.slice(slash + 1) : job;
}

/** Kebab a string into a name token for objectives / defaults. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildSpec({
  datasourceId,
  name,
  description,
  service,
  sliDefinition,
  dimensions,
  objective,
}: {
  datasourceId: string;
  name: string;
  description: string;
  service: string;
  sliDefinition: PrometheusSli;
  dimensions: Array<{ name: string; value: string }>;
  objective: { name: string; target: number; latencyThreshold?: number };
}): SloSpec {
  const sli: SingleSli = {
    type: 'single',
    definition: sliDefinition,
    dimensions,
  };
  return {
    datasourceId,
    name,
    description,
    enabled: true,
    mode: 'active',
    service,
    owner: { teams: ['unassigned'] },
    tier: 'tier-2',
    sli,
    objectives: [objective],
    budgetWarningThresholds: DEFAULT_BUDGETS,
    window: { type: 'rolling', duration: '28d' },
    alerting: { strategy: 'mwmbr', burnRates: DEFAULT_BURN_RATES },
    alarms: DEFAULT_ALARMS,
    exclusionWindows: [],
    labels: {},
    annotations: {},
  };
}

function estimatedRules(objectives: number): number {
  // 7 recording windows + 4 MWMBR tiers + 2 default budget warnings, times objectives.
  return (7 + 4 + DEFAULT_BUDGETS.length) * objectives;
}

// ============================================================================
// Detectors
// ============================================================================

/**
 * Detect HTTP SLOs using the OTel semconv v1.23+ metric:
 *   http_server_request_duration_seconds_{bucket,count,sum}
 *
 * For each (job, http_route) pair seen, we propose:
 *   - an availability SLO   (non-5xx over total, 99%)
 *   - a latency-threshold SLO (p95 < 500ms, 99%)
 */
function detectHttpNewSemconv(input: DiscoveryInput, out: Suggestion[]): void {
  const bucket = 'http_server_request_duration_seconds_bucket';
  const countMetric = 'http_server_request_duration_seconds_count';
  if (!input.metricNames.includes(bucket)) return;
  const labels = input.labelValuesByMetric[bucket];
  if (!labels) return;
  const jobs = labels.job ?? [];
  const routes = labels.http_route ?? [];
  if (jobs.length === 0) return;

  for (const job of jobs) {
    const service = jobToServiceName(job);
    // If we saw routes, produce one pair per (job × route). Otherwise one pair per job.
    const targets = routes.length > 0 ? routes : [null];
    for (const route of targets) {
      const dims: Array<{ name: string; value: string }> = [{ name: 'job', value: job }];
      if (route) dims.push({ name: 'http_route', value: route });
      const scope = route ? ` (${route})` : '';

      // --- Availability
      out.push({
        key: `http-avail:${job}:${route ?? '*'}`,
        kind: 'HTTP availability',
        reason: `Detected ${bucket} scrape for job "${job}"${scope}; non-5xx ratio ≥ 99% is a sensible default.`,
        sourceMetric: countMetric,
        detected: { job, ...(route ? { http_route: route } : {}) },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${service}${scope} — HTTP availability`,
            description: `Auto-suggested from ${countMetric} on job=${job}${scope}.`,
            service,
            sliDefinition: {
              backend: 'prometheus',
              type: 'availability',
              calcMethod: 'events',
              metric: countMetric,
              goodEventsFilter: 'http_response_status_code!~"5.."',
            },
            dimensions: dims,
            objective: { name: `availability-99-${slug(service)}`, target: 0.99 },
          }),
        },
      });

      // --- Latency threshold (p95 < 500ms via distribution-cut)
      out.push({
        key: `http-lat:${job}:${route ?? '*'}`,
        kind: 'HTTP latency',
        reason: `Histogram ${bucket} is present; 95% of requests under 500 ms is a common default.`,
        sourceMetric: bucket,
        detected: { job, ...(route ? { http_route: route } : {}) },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${service}${scope} — HTTP latency p95 < 500 ms`,
            description: `Auto-suggested from ${bucket} on job=${job}${scope}.`,
            service,
            sliDefinition: {
              backend: 'prometheus',
              type: 'latency_threshold',
              calcMethod: 'events',
              metric: bucket,
              latencyThresholdUnit: 'seconds',
            },
            dimensions: dims,
            objective: {
              name: `p95-under-500ms-${slug(service)}`,
              target: 0.95,
              latencyThreshold: 0.5,
            },
          }),
        },
      });
    }
  }
}

/**
 * Detect HTTP SLOs using the OTel semconv v1.22 and earlier:
 *   http_server_duration_milliseconds_{bucket,count,sum}
 */
function detectHttpLegacySemconv(input: DiscoveryInput, out: Suggestion[]): void {
  const bucket = 'http_server_duration_milliseconds_bucket';
  const countMetric = 'http_server_duration_milliseconds_count';
  if (!input.metricNames.includes(bucket) && !input.metricNames.includes(countMetric)) return;
  const labels = input.labelValuesByMetric[countMetric] ?? input.labelValuesByMetric[bucket];
  if (!labels) return;
  const jobs = labels.job ?? [];
  const targets = labels.http_target ?? [];
  if (jobs.length === 0) return;

  for (const job of jobs) {
    const service = jobToServiceName(job);
    const tgtSet = targets.length > 0 ? targets : [null];
    for (const target of tgtSet) {
      const dims: Array<{ name: string; value: string }> = [{ name: 'job', value: job }];
      if (target) dims.push({ name: 'http_target', value: target });
      const scope = target ? ` (${target})` : '';

      out.push({
        key: `http-legacy-avail:${job}:${target ?? '*'}`,
        kind: 'HTTP availability',
        reason: `Detected legacy ${countMetric} for job "${job}"${scope}. Good = http_status_code !~ "5.."`,
        sourceMetric: countMetric,
        detected: { job, ...(target ? { http_target: target } : {}) },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${service}${scope} — HTTP availability (legacy)`,
            description: `Auto-suggested from ${countMetric} (legacy OTel semconv) on job=${job}${scope}.`,
            service,
            sliDefinition: {
              backend: 'prometheus',
              type: 'availability',
              calcMethod: 'events',
              metric: countMetric,
              goodEventsFilter: 'http_status_code!~"5.."',
            },
            dimensions: dims,
            objective: { name: `availability-99-${slug(service)}`, target: 0.99 },
          }),
        },
      });

      if (input.metricNames.includes(bucket)) {
        out.push({
          key: `http-legacy-lat:${job}:${target ?? '*'}`,
          kind: 'HTTP latency',
          reason: `Histogram ${bucket} is present; 95% of requests under 2 s is a safe starting bound on legacy demo data.`,
          sourceMetric: bucket,
          detected: { job, ...(target ? { http_target: target } : {}) },
          estimatedRuleCount: estimatedRules(1),
          input: {
            spec: buildSpec({
              datasourceId: input.datasourceId,
              name: `${service}${scope} — HTTP latency p95 < 2 s (legacy)`,
              description: `Auto-suggested from ${bucket} on job=${job}${scope}.`,
              service,
              sliDefinition: {
                backend: 'prometheus',
                type: 'latency_threshold',
                calcMethod: 'events',
                metric: bucket,
                latencyThresholdUnit: 'milliseconds',
              },
              dimensions: dims,
              objective: {
                name: `p95-under-2s-${slug(service)}`,
                target: 0.95,
                latencyThreshold: 2000,
              },
            }),
          },
        });
      }
    }
  }
}

/**
 * Detect gRPC SLOs from the canonical gRPC server metric:
 *   grpc_server_handled_total
 */
function detectGrpc(input: DiscoveryInput, out: Suggestion[]): void {
  const metric = 'grpc_server_handled_total';
  if (!input.metricNames.includes(metric)) return;
  const labels = input.labelValuesByMetric[metric];
  if (!labels) return;
  const services = labels.grpc_service ?? [];
  for (const s of services) {
    const dims: Array<{ name: string; value: string }> = [{ name: 'grpc_service', value: s }];
    out.push({
      key: `grpc-avail:${s}`,
      kind: 'gRPC availability',
      reason: `Detected ${metric}; non-error gRPC codes are "good" by default.`,
      sourceMetric: metric,
      detected: { grpc_service: s },
      estimatedRuleCount: estimatedRules(1),
      input: {
        spec: buildSpec({
          datasourceId: input.datasourceId,
          name: `${s} — gRPC availability`,
          description: `Auto-suggested from ${metric} on grpc_service=${s}.`,
          service: s,
          sliDefinition: {
            backend: 'prometheus',
            type: 'availability',
            calcMethod: 'events',
            metric,
            goodEventsFilter:
              'grpc_code!~"INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED|UNKNOWN|RESOURCE_EXHAUSTED|DATA_LOSS"',
          },
          dimensions: dims,
          objective: { name: `availability-99-${slug(s)}`, target: 0.99 },
        }),
      },
    });
  }
}

/**
 * Detect GenAI operation SLOs — very common in OTel demos.
 * Metric:   gen_ai_client_operation_duration_seconds_{count,bucket}
 */
function detectGenAI(input: DiscoveryInput, out: Suggestion[]): void {
  const countMetric = 'gen_ai_client_operation_duration_seconds_count';
  if (!input.metricNames.includes(countMetric)) return;
  const labels = input.labelValuesByMetric[countMetric];
  if (!labels) return;
  const jobs = labels.job ?? [];
  for (const job of jobs) {
    const service = jobToServiceName(job);
    out.push({
      key: `genai-avail:${job}`,
      kind: 'GenAI availability',
      reason: `GenAI invocations on job "${job}" — error_type="" means the call returned successfully.`,
      sourceMetric: countMetric,
      detected: { job },
      estimatedRuleCount: estimatedRules(1),
      input: {
        spec: buildSpec({
          datasourceId: input.datasourceId,
          name: `${service} — GenAI invocation availability`,
          description: `Auto-suggested. Custom PromQL tolerates the error_type label that gen_ai metrics emit.`,
          service,
          sliDefinition: {
            backend: 'prometheus',
            type: 'custom',
            calcMethod: 'events',
            customExpr: {
              mode: 'events',
              goodQuery: `sum(rate(${countMetric}{job="${job}", error_type=""}[5m]))`,
              totalQuery: `sum(rate(${countMetric}{job="${job}"}[5m]))`,
            },
          },
          // Custom SLIs don't require dimensions.
          dimensions: [],
          objective: { name: `availability-99-${slug(service)}`, target: 0.99 },
        }),
      },
    });
  }
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Run all detectors against the discovery input and return a deduplicated list
 * of draft SLO suggestions.
 */
export function generateSuggestions(input: DiscoveryInput): Suggestion[] {
  const out: Suggestion[] = [];
  detectHttpNewSemconv(input, out);
  detectHttpLegacySemconv(input, out);
  detectGrpc(input, out);
  detectGenAI(input, out);
  // Dedupe by key — detectors should already be distinct, but be safe.
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

/** The metrics this engine needs label-values for, given a metric-name list. */
export function metricsToProbe(
  metricNames: string[]
): Array<{
  metric: string;
  labels: string[];
}> {
  const have = (m: string) => metricNames.includes(m);
  const probes: Array<{ metric: string; labels: string[] }> = [];

  if (have('http_server_request_duration_seconds_bucket')) {
    probes.push({
      metric: 'http_server_request_duration_seconds_bucket',
      labels: ['job', 'http_route'],
    });
  }
  if (have('http_server_duration_milliseconds_count')) {
    probes.push({
      metric: 'http_server_duration_milliseconds_count',
      labels: ['job', 'http_target'],
    });
  } else if (have('http_server_duration_milliseconds_bucket')) {
    probes.push({
      metric: 'http_server_duration_milliseconds_bucket',
      labels: ['job', 'http_target'],
    });
  }
  if (have('grpc_server_handled_total')) {
    probes.push({ metric: 'grpc_server_handled_total', labels: ['grpc_service'] });
  }
  if (have('gen_ai_client_operation_duration_seconds_count')) {
    probes.push({
      metric: 'gen_ai_client_operation_duration_seconds_count',
      labels: ['job'],
    });
  }
  return probes;
}
