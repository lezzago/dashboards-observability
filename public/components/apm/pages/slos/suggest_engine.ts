/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure draft-suggestion engine for the "Suggest SLOs" page.
 *
 * Given a small slice of Prometheus metadata (metric names, label values per
 * metric), it emits `Suggestion` records: each record is already a
 * well-formed `SloCreateInput` plus a little UI-facing metadata (reason,
 * estimated rule count). The user can toggle, tweak, and then create.
 *
 * Detectors covered:
 *   - APM span-derived services (Data Prepper: `request` + `fault`
 *     + `latency_seconds_bucket` with `namespace="span_derived"`). One pair
 *     of availability + latency drafts per (service, environment).
 *   - OTel semconv HTTP server (`http_server_request_duration_seconds_*`).
 *   - OTel semconv RPC server (`rpc_server_duration_seconds_*`).
 *   - OTel DB client (`db_client_operation_duration_seconds_*`).
 *   - OTel messaging consumer (`messaging_process_duration_seconds_*`).
 *   - OTel GenAI client (`gen_ai_client_operation_duration_seconds_*`).
 *
 * Legacy OTel semconv (≤1.22) is intentionally not supported.
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
      // APM span-derived
      service?: string[];
      environment?: string[];
      // OTel HTTP (new semconv)
      job?: string[];
      service_name?: string[];
      http_route?: string[];
      http_request_method?: string[];
      // OTel RPC
      rpc_service?: string[];
      rpc_method?: string[];
      // OTel DB
      db_system?: string[];
      // OTel messaging
      messaging_system?: string[];
      messaging_destination_name?: string[];
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
  /** Chip label ("HTTP availability", "RPC latency" etc.). */
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
// APM span-derived detector
// ============================================================================

/**
 * Detect APM services from Data Prepper span-derived metrics. The `request`
 * gauge is present whenever any traces are flowing, so its `service` label
 * values enumerate the services to target.
 *
 * Each service yields two drafts — availability (non-fault ratio) and latency
 * (p95-like, 500ms via histogram bucket cut). Both use custom PromQL because
 * span-derived samples are gauge-semantic and the default generator's
 * `rate()` wrapping produces wrong values for them.
 */
function detectApmSpanDerived(input: DiscoveryInput, out: Suggestion[]): void {
  const requestMetric = 'request';
  const bucketMetric = 'latency_seconds_bucket';
  if (!input.metricNames.includes(requestMetric)) return;
  const labels = input.labelValuesByMetric[requestMetric];
  if (!labels) return;
  const services = labels.service ?? [];
  if (services.length === 0) return;
  const hasHistogram = input.metricNames.includes(bucketMetric);

  for (const service of services) {
    const serverSelector = `service="${service}",remoteService="",namespace="span_derived"`;

    out.push({
      key: `apm-avail:${service}`,
      kind: 'APM availability',
      reason: `span-derived request+fault observed for service="${service}". Non-fault ratio ≥ 99% is a sensible starting point.`,
      sourceMetric: requestMetric,
      detected: { service },
      estimatedRuleCount: estimatedRules(1),
      input: {
        spec: buildSpec({
          datasourceId: input.datasourceId,
          name: `${service} — service availability`,
          description: `Auto-suggested from span-derived metrics for service="${service}".`,
          service,
          sliDefinition: {
            backend: 'prometheus',
            type: 'custom',
            calcMethod: 'events',
            customExpr: {
              mode: 'events',
              goodQuery: `sum(request{${serverSelector}}) - sum(fault{${serverSelector}})`,
              totalQuery: `sum(request{${serverSelector}})`,
            },
          },
          // Custom SLIs don't require dimensions — PromQL already scopes.
          dimensions: [],
          objective: { name: `availability-99-${slug(service)}`, target: 0.99 },
        }),
      },
    });

    if (hasHistogram) {
      out.push({
        key: `apm-lat:${service}`,
        kind: 'APM latency',
        reason: `latency_seconds_bucket present for service="${service}". Draft targets ≥ 95% of requests under 500 ms.`,
        sourceMetric: bucketMetric,
        detected: { service },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${service} — service latency p95 < 500 ms`,
            description: `Auto-suggested from span-derived latency histogram for service="${service}".`,
            service,
            sliDefinition: {
              backend: 'prometheus',
              type: 'custom',
              calcMethod: 'events',
              customExpr: {
                mode: 'events',
                goodQuery: `sum(latency_seconds_bucket{${serverSelector},le="0.5"})`,
                totalQuery: `sum(latency_seconds_bucket{${serverSelector},le="+Inf"})`,
              },
            },
            dimensions: [],
            objective: { name: `latency-95-${slug(service)}`, target: 0.95 },
          }),
        },
      });
    }
  }
}

// ============================================================================
// OTel HTTP server detector (semconv v1.23+)
// ============================================================================

function detectHttpServer(input: DiscoveryInput, out: Suggestion[]): void {
  const bucket = 'http_server_request_duration_seconds_bucket';
  const countMetric = 'http_server_request_duration_seconds_count';
  if (!input.metricNames.includes(bucket) && !input.metricNames.includes(countMetric)) return;
  const labels = input.labelValuesByMetric[bucket] ?? input.labelValuesByMetric[countMetric];
  if (!labels) return;
  const jobs = labels.job ?? [];
  const routes = labels.http_route ?? [];
  if (jobs.length === 0) return;

  for (const job of jobs) {
    const service = jobToServiceName(job);
    const targets = routes.length > 0 ? routes : [null];
    for (const route of targets) {
      const dims: Array<{ name: string; value: string }> = [{ name: 'job', value: job }];
      if (route) dims.push({ name: 'http_route', value: route });
      const scope = route ? ` (${route})` : '';

      if (input.metricNames.includes(countMetric)) {
        out.push({
          key: `http-avail:${job}:${route ?? '*'}`,
          kind: 'HTTP availability',
          reason: `Detected ${countMetric} for job "${job}"${scope}; non-5xx ratio ≥ 99% is a sensible default.`,
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
      }

      if (input.metricNames.includes(bucket)) {
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
}

// ============================================================================
// OTel RPC (gRPC) server detector
// ============================================================================

function detectRpcServer(input: DiscoveryInput, out: Suggestion[]): void {
  const bucket = 'rpc_server_duration_seconds_bucket';
  const countMetric = 'rpc_server_duration_seconds_count';
  if (!input.metricNames.includes(bucket) && !input.metricNames.includes(countMetric)) return;
  const labels = input.labelValuesByMetric[bucket] ?? input.labelValuesByMetric[countMetric];
  if (!labels) return;
  const services = labels.rpc_service ?? [];
  if (services.length === 0) return;

  for (const rpcService of services) {
    const dims: Array<{ name: string; value: string }> = [
      { name: 'rpc_service', value: rpcService },
    ];

    if (input.metricNames.includes(countMetric)) {
      out.push({
        key: `rpc-avail:${rpcService}`,
        kind: 'RPC availability',
        reason: `Detected ${countMetric} for rpc_service="${rpcService}"; non-error status (0 = OK) = good.`,
        sourceMetric: countMetric,
        detected: { rpc_service: rpcService },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${rpcService} — RPC availability`,
            description: `Auto-suggested from ${countMetric} on rpc_service=${rpcService}.`,
            service: rpcService,
            sliDefinition: {
              backend: 'prometheus',
              type: 'availability',
              calcMethod: 'events',
              metric: countMetric,
              goodEventsFilter: 'rpc_grpc_status_code="0"',
            },
            dimensions: dims,
            objective: { name: `availability-99-${slug(rpcService)}`, target: 0.99 },
          }),
        },
      });
    }

    if (input.metricNames.includes(bucket)) {
      out.push({
        key: `rpc-lat:${rpcService}`,
        kind: 'RPC latency',
        reason: `Histogram ${bucket} is present; 95% of RPC calls under 500 ms is a common default.`,
        sourceMetric: bucket,
        detected: { rpc_service: rpcService },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${rpcService} — RPC latency p95 < 500 ms`,
            description: `Auto-suggested from ${bucket} on rpc_service=${rpcService}.`,
            service: rpcService,
            sliDefinition: {
              backend: 'prometheus',
              type: 'latency_threshold',
              calcMethod: 'events',
              metric: bucket,
              latencyThresholdUnit: 'seconds',
            },
            dimensions: dims,
            objective: {
              name: `p95-under-500ms-${slug(rpcService)}`,
              target: 0.95,
              latencyThreshold: 0.5,
            },
          }),
        },
      });
    }
  }
}

// ============================================================================
// OTel database-client detector
// ============================================================================

function detectDbClient(input: DiscoveryInput, out: Suggestion[]): void {
  const bucket = 'db_client_operation_duration_seconds_bucket';
  if (!input.metricNames.includes(bucket)) return;
  const labels = input.labelValuesByMetric[bucket];
  if (!labels) return;
  // Prefer service_name; fall back to job (Prometheus scrape label).
  const serviceLabel = labels.service_name ?? labels.job ?? [];
  if (serviceLabel.length === 0) return;
  const dbSystems = labels.db_system ?? [];

  for (const svc of serviceLabel) {
    const service = jobToServiceName(svc);
    const targets = dbSystems.length > 0 ? dbSystems : [null];
    for (const dbSystem of targets) {
      const dims: Array<{ name: string; value: string }> = [
        {
          name: labels.service_name ? 'service_name' : 'job',
          value: svc,
        },
      ];
      if (dbSystem) dims.push({ name: 'db_system', value: dbSystem });
      const scope = dbSystem ? ` (${dbSystem})` : '';
      out.push({
        key: `db-lat:${svc}:${dbSystem ?? '*'}`,
        kind: 'DB client latency',
        reason: `Histogram ${bucket} is present for service="${service}"${scope}; 95% of DB calls under 100 ms is a sensible default.`,
        sourceMetric: bucket,
        detected: { service, ...(dbSystem ? { db_system: dbSystem } : {}) },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${service}${scope} — DB client latency p95 < 100 ms`,
            description: `Auto-suggested from ${bucket} for ${service}${scope}.`,
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
              name: `p95-under-100ms-${slug(service)}`,
              target: 0.95,
              latencyThreshold: 0.1,
            },
          }),
        },
      });
    }
  }
}

// ============================================================================
// OTel messaging-consumer detector
// ============================================================================

function detectMessaging(input: DiscoveryInput, out: Suggestion[]): void {
  const bucket = 'messaging_process_duration_seconds_bucket';
  if (!input.metricNames.includes(bucket)) return;
  const labels = input.labelValuesByMetric[bucket];
  if (!labels) return;
  const serviceLabel = labels.service_name ?? labels.job ?? [];
  if (serviceLabel.length === 0) return;
  const destinations = labels.messaging_destination_name ?? [];

  for (const svc of serviceLabel) {
    const service = jobToServiceName(svc);
    const targets = destinations.length > 0 ? destinations : [null];
    for (const destination of targets) {
      const dims: Array<{ name: string; value: string }> = [
        {
          name: labels.service_name ? 'service_name' : 'job',
          value: svc,
        },
      ];
      if (destination) {
        dims.push({ name: 'messaging_destination_name', value: destination });
      }
      const scope = destination ? ` (${destination})` : '';
      out.push({
        key: `msg-lat:${svc}:${destination ?? '*'}`,
        kind: 'Messaging latency',
        reason: `Histogram ${bucket} is present for service="${service}"${scope}; 95% of messages processed under 1 s is a sensible default.`,
        sourceMetric: bucket,
        detected: {
          service,
          ...(destination ? { messaging_destination_name: destination } : {}),
        },
        estimatedRuleCount: estimatedRules(1),
        input: {
          spec: buildSpec({
            datasourceId: input.datasourceId,
            name: `${service}${scope} — messaging latency p95 < 1 s`,
            description: `Auto-suggested from ${bucket} for ${service}${scope}.`,
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
              name: `p95-under-1s-${slug(service)}`,
              target: 0.95,
              latencyThreshold: 1,
            },
          }),
        },
      });
    }
  }
}

// ============================================================================
// OTel GenAI client detector
// ============================================================================

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
          description: `Auto-suggested. error_type="" is the convention for successful GenAI operations.`,
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
  detectApmSpanDerived(input, out);
  detectHttpServer(input, out);
  detectRpcServer(input, out);
  detectDbClient(input, out);
  detectMessaging(input, out);
  detectGenAI(input, out);
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

// ============================================================================
// Service-first entry point (APM span-derived)
// ============================================================================

/**
 * One row the Suggest page feeds in — mirrors the shape the Services Home
 * page uses (`ServiceTableItem`) so discovery can share that hook.
 */
export interface DiscoveredService {
  serviceName: string;
  environment?: string;
}

export interface ServiceDiscoveryInput {
  datasourceId: string;
  services: DiscoveredService[];
}

/**
 * Produce SLO drafts for each discovered APM service. For every service we
 * emit both an availability and a latency draft built on span-derived metrics
 * (custom PromQL with `service` and `remoteService=""` scoping). This is the
 * flow the "Suggest SLOs" page uses — the same enumeration of services that
 * Services Home shows, plus the SLO shape the APM-first templates use.
 */
export function generateSuggestionsFromServices(input: ServiceDiscoveryInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const svc of input.services) {
    if (!svc.serviceName) continue;
    const service = svc.serviceName;
    const serverSelector = `service="${service}",remoteService="",namespace="span_derived"`;

    out.push({
      key: `apm-avail:${service}`,
      kind: 'APM availability',
      reason: `span-derived request+fault observed for service="${service}". Non-fault ratio ≥ 99% is a sensible starting point.`,
      sourceMetric: 'request',
      detected: svc.environment ? { service, environment: svc.environment } : { service },
      estimatedRuleCount: estimatedRules(1),
      input: {
        spec: buildSpec({
          datasourceId: input.datasourceId,
          name: `${service} — service availability`,
          description: `Auto-suggested from span-derived metrics for service="${service}".`,
          service,
          sliDefinition: {
            backend: 'prometheus',
            type: 'custom',
            calcMethod: 'events',
            customExpr: {
              mode: 'events',
              goodQuery: `sum(request{${serverSelector}}) - sum(fault{${serverSelector}})`,
              totalQuery: `sum(request{${serverSelector}})`,
            },
          },
          dimensions: [],
          objective: { name: `availability-99-${slug(service)}`, target: 0.99 },
        }),
      },
    });

    out.push({
      key: `apm-lat:${service}`,
      kind: 'APM latency',
      reason: `Draft targets ≥ 95% of requests under 500 ms for service="${service}" using span-derived latency_seconds_bucket.`,
      sourceMetric: 'latency_seconds_bucket',
      detected: svc.environment ? { service, environment: svc.environment } : { service },
      estimatedRuleCount: estimatedRules(1),
      input: {
        spec: buildSpec({
          datasourceId: input.datasourceId,
          name: `${service} — service latency p95 < 500 ms`,
          description: `Auto-suggested from span-derived latency histogram for service="${service}".`,
          service,
          sliDefinition: {
            backend: 'prometheus',
            type: 'custom',
            calcMethod: 'events',
            customExpr: {
              mode: 'events',
              goodQuery: `sum(latency_seconds_bucket{${serverSelector},le="0.5"})`,
              totalQuery: `sum(latency_seconds_bucket{${serverSelector},le="+Inf"})`,
            },
          },
          dimensions: [],
          objective: { name: `latency-95-${slug(service)}`, target: 0.95 },
        }),
      },
    });
  }
  return out;
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

  // APM span-derived — discovery via the `request` gauge label set.
  if (have('request')) {
    probes.push({ metric: 'request', labels: ['service', 'environment'] });
  }
  if (have('latency_seconds_bucket')) {
    probes.push({ metric: 'latency_seconds_bucket', labels: ['service'] });
  }
  // OTel HTTP server (v1.23+).
  if (have('http_server_request_duration_seconds_bucket')) {
    probes.push({
      metric: 'http_server_request_duration_seconds_bucket',
      labels: ['job', 'http_route'],
    });
  } else if (have('http_server_request_duration_seconds_count')) {
    probes.push({
      metric: 'http_server_request_duration_seconds_count',
      labels: ['job', 'http_route'],
    });
  }
  // OTel RPC.
  if (have('rpc_server_duration_seconds_bucket')) {
    probes.push({
      metric: 'rpc_server_duration_seconds_bucket',
      labels: ['rpc_service', 'rpc_method'],
    });
  } else if (have('rpc_server_duration_seconds_count')) {
    probes.push({
      metric: 'rpc_server_duration_seconds_count',
      labels: ['rpc_service', 'rpc_method'],
    });
  }
  // OTel DB client.
  if (have('db_client_operation_duration_seconds_bucket')) {
    probes.push({
      metric: 'db_client_operation_duration_seconds_bucket',
      labels: ['service_name', 'job', 'db_system'],
    });
  }
  // OTel messaging.
  if (have('messaging_process_duration_seconds_bucket')) {
    probes.push({
      metric: 'messaging_process_duration_seconds_bucket',
      labels: ['service_name', 'job', 'messaging_destination_name'],
    });
  }
  // OTel GenAI.
  if (have('gen_ai_client_operation_duration_seconds_count')) {
    probes.push({
      metric: 'gen_ai_client_operation_duration_seconds_count',
      labels: ['job'],
    });
  }
  return probes;
}
