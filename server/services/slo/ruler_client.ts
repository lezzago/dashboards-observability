/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ruler client — writes SLO rule groups to a Prometheus-compatible ruler
 * (Cortex / Mimir) via the OpenSearch SQL plugin's DirectQuery resource proxy.
 *
 * Path: plugin → OSD scoped cluster client → /_plugins/_directquery/_resources/
 *       {dqName}/api/v1/rules/{namespace}[/{groupName}] → SQL plugin's
 *       Prometheus connector → Cortex ruler.
 *
 * Contract (verified upstream, 2026-04-23 pre-check):
 *   - Create/update: POST .../api/v1/rules/{namespace} with body = rule-group YAML
 *   - Delete:        DELETE .../api/v1/rules/{namespace}/{groupName}
 *   Bodies are forwarded verbatim to Cortex with Content-Type: application/yaml
 *   (the SQL plugin's PrometheusClientImpl sets that header on the upstream call;
 *    the OSD transport does not expose per-request headers so we rely on that).
 *
 * Semantics (memo §Dual-write atomicity):
 *   - Synchronous, fail-loud. One call. No retry, no backoff.
 *   - Errors surface as SloRulerError with a stable code, preserving upstream
 *     HTTP status + raw body so the wizard can render a self-service message.
 *   - Tenant identity lives in the SQL plugin's Prometheus connector config;
 *     this client never injects X-Scope-OrgID per request.
 *
 * Reference pattern: `DirectQueryPrometheusBackend` (the read-path sibling).
 */

/* eslint-disable max-classes-per-file */

import { dump as yamlDump } from 'js-yaml';
import type { AlertingOSClient, Datasource, Logger } from '../../../common/types/alerting/types';
import type { GeneratedRule, GeneratedRuleGroup } from '../../../common/slo/slo_types';
import { SloRulerError } from '../../../common/slo/slo_errors';

/**
 * Ruler write surface. Reads are handled elsewhere (DirectQueryPrometheusBackend
 * exposes GET on the same resource paths) — this client is write-only.
 */
export interface RulerClient {
  /**
   * Upsert a rule group into the given namespace. Cortex's POST semantics are
   * create-or-replace within `(namespace, group.name)`, so replaying the same
   * body is idempotent — useful for the compensation retry path.
   */
  upsertRuleGroup(
    client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    group: GeneratedRuleGroup
  ): Promise<void>;

  /** Delete a single rule group. Idempotent server-side on 404. */
  deleteRuleGroup(
    client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    groupName: string
  ): Promise<void>;
}

// ============================================================================
// YAML serialization — Cortex / Prometheus rule-group format
// ============================================================================

/**
 * Serialize a GeneratedRuleGroup to the YAML shape Cortex accepts:
 *
 *   name: <groupName>
 *   interval: <Ns|Nm|Nh>
 *   rules:
 *     - record: <name>        # OR `alert: <name>`
 *       expr: <PromQL>
 *       for: <duration>?      # alerting only
 *       labels:   { k: v, ... }?
 *       annotations: { k: v, ... }?
 *
 * Uses js-yaml (already a plugin dep). `noRefs` keeps repeated label maps
 * readable; `lineWidth: -1` prevents wrapping long PromQL exprs across lines
 * (some rulers are strict about expr being one logical scalar).
 */
export function ruleGroupToYaml(group: GeneratedRuleGroup): string {
  const doc = {
    name: group.groupName,
    interval: formatInterval(group.interval),
    rules: group.rules.map(serializeRule),
  };
  return yamlDump(doc, { noRefs: true, lineWidth: -1, sortKeys: false });
}

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function serializeRule(rule: GeneratedRule): Record<string, unknown> {
  // Preserve key ordering as Prometheus convention: record/alert first, expr, for, labels, annotations.
  const out: Record<string, unknown> = {};
  if (rule.type === 'recording') {
    out.record = rule.name;
  } else {
    out.alert = rule.name;
  }
  out.expr = rule.expr;
  if (rule.for) out.for = rule.for;
  if (rule.labels && Object.keys(rule.labels).length > 0) out.labels = { ...rule.labels };
  if (rule.annotations && Object.keys(rule.annotations).length > 0) {
    out.annotations = { ...rule.annotations };
  }
  return out;
}

// ============================================================================
// DirectQueryRulerClient — real implementation
// ============================================================================

/**
 * Build the DirectQuery resource path for a datasource's ruler surface.
 * Format mirrors DirectQueryPrometheusBackend.resourcePath — both dqName and
 * any path segments are encodeURIComponent'd so `/` inside a segment gets
 * escaped to %2F (which the SQL plugin's REST router treats as a single segment).
 */
function rulesPath(ds: Datasource, suffix: string): string {
  const dqName = ds.directQueryName;
  if (!dqName) {
    throw new Error(
      `Datasource "${ds.name}" (${ds.id}) has no directQueryName. ` +
        'It must be auto-discovered from the OpenSearch SQL plugin.'
    );
  }
  return `/_plugins/_directquery/_resources/${encodeURIComponent(dqName)}${suffix}`;
}

export class DirectQueryRulerClient implements RulerClient {
  constructor(private readonly logger: Logger) {
    this.logger.info('DirectQuery ruler client configured: writes via OSD scoped cluster client');
  }

  async upsertRuleGroup(
    client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    group: GeneratedRuleGroup
  ): Promise<void> {
    const body = ruleGroupToYaml(group);
    const path = rulesPath(datasource, `/api/v1/rules/${encodeURIComponent(namespace)}`);
    this.logger.debug(
      `DirectQuery ruler POST ${path} (group=${group.groupName}, rules=${group.rules.length})`
    );

    try {
      // The OSD transport doesn't let us set Content-Type per request, but the
      // SQL plugin's PrometheusClientImpl forces Content-Type: application/yaml
      // on the upstream Cortex call — bodies are forwarded verbatim.
      await client.transport.request({
        method: 'POST',
        path,
        body,
      });
    } catch (err: unknown) {
      throw this.toRulerError(err);
    }
  }

  async deleteRuleGroup(
    client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    groupName: string
  ): Promise<void> {
    const path = rulesPath(
      datasource,
      `/api/v1/rules/${encodeURIComponent(namespace)}/${encodeURIComponent(groupName)}`
    );
    this.logger.debug(`DirectQuery ruler DELETE ${path}`);

    try {
      await client.transport.request({
        method: 'DELETE',
        path,
      });
    } catch (err: unknown) {
      throw this.toRulerError(err);
    }
  }

  /**
   * Classify a transport error into an SloRulerError. OpenSearch JS client
   * errors typically carry `statusCode`, `body`, and `meta` properties; we
   * extract defensively because the shape is not formally typed on the
   * structural AlertingOSClient transport we declare.
   */
  private toRulerError(err: unknown): SloRulerError {
    const raw = err as {
      statusCode?: number;
      body?: unknown;
      message?: string;
      meta?: { statusCode?: number; body?: unknown };
    };
    const httpStatus =
      typeof raw?.statusCode === 'number'
        ? raw.statusCode
        : typeof raw?.meta?.statusCode === 'number'
        ? raw.meta.statusCode
        : 0;
    const rawBody = stringifyBody(raw?.body ?? raw?.meta?.body ?? raw?.message ?? String(err));

    let code: 'RULER_VALIDATION_FAILED' | 'RULER_AUTH_FAILED' | 'RULER_UNREACHABLE';
    if (httpStatus === 401 || httpStatus === 403) {
      code = 'RULER_AUTH_FAILED';
    } else if (httpStatus >= 400 && httpStatus < 500) {
      code = 'RULER_VALIDATION_FAILED';
    } else {
      // 5xx, 0 (network / timeout / no response) — all unreachable for our purposes.
      code = 'RULER_UNREACHABLE';
    }

    return new SloRulerError(code, httpStatus, rawBody);
  }
}

function stringifyBody(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// ============================================================================
// MockRulerClient — dev / test
// ============================================================================

/**
 * No-op ruler client. Used in:
 *   - Unit tests that want to assert SloService ordering without a real transport.
 *   - Dev servers where the SQL plugin isn't reachable.
 *
 * `previewRules()` never touches a ruler client at all (preview is pure), so
 * this mock isn't what powers preview — it's just the "degrade gracefully"
 * companion to DirectQueryRulerClient.
 */
export class MockRulerClient implements RulerClient {
  constructor(private readonly logger: Logger) {}

  async upsertRuleGroup(
    _client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    group: GeneratedRuleGroup
  ): Promise<void> {
    this.logger.debug(
      `MockRuler upsert: ds=${datasource.id} ns=${namespace} group=${group.groupName} rules=${group.rules.length}`
    );
  }

  async deleteRuleGroup(
    _client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    groupName: string
  ): Promise<void> {
    this.logger.debug(`MockRuler delete: ds=${datasource.id} ns=${namespace} group=${groupName}`);
  }
}
