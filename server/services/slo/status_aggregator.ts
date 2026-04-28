/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live status aggregator — replaces the W1.2 stub in slo_service.ts with
 * real ruler queries (W3.1).
 *
 * For each SLO:
 *   1. Pick the "longest" recording-rule window — `findClosestRecordingWindow`
 *      maps the spec's rolling window (e.g. 28d) to the closest window we
 *      actually recorded (3d cap — the W2.4 approximation).
 *   2. Run one PromQL instant query per SLO against the pre-computed error
 *      ratio for that window, matching on `slo_id` so we get one sample per
 *      objective in a single call:
 *        {__name__=~"slo:sli_error:ratio_rate_<win>:.*", slo_id="<sloId>"}
 *   3. Run one alerts call per distinct datasource and group by `slo_id`
 *      label to count firing alerts per SLO.
 *   4. Map samples → ObjectiveStatus with attainment / errorBudgetRemaining
 *      and a per-objective state (ok / warning / breached).
 *
 * Error surface contract (per task): **never throw to the service**. Status
 * aggregation is a read path the listing page calls constantly; a ruler
 * outage must not 500 the listing. Partial failures degrade per-SLO to
 * `no_data`; catastrophic failures (programmer error, malformed spec) are
 * the only things allowed to reject.
 *
 * Query path: `POST /_plugins/_directquery/_query/{dqName}` — the SQL plugin's
 * query execution API. Reused from `DirectQueryPrometheusBackend.queryInstant`
 * so we know this path is wired through the SQL plugin to Cortex. The
 * resource-proxy path (`.../api/v1/query`) would also work (verified 2026-04-23
 * — GET/POST/DELETE are registered on the resource router), but reusing the
 * proven query-execution path keeps us on the same code path we already test.
 *
 * Alerts: `GET /_plugins/_directquery/_resources/{dqName}/api/v1/alerts` —
 * same path as `DirectQueryPrometheusBackend.getAlerts`.
 */

/* eslint-disable max-classes-per-file */

import type {
  AlertingOSClient,
  Datasource,
  Logger,
  PromRawAlert,
  PromAlertsApiResponse,
} from '../../../common/types/alerting/types';
import type {
  ObjectiveStatus,
  Objective,
  SloDocument,
  SloHealthState,
  SloLiveStatus,
} from '../../../common/slo/slo_types';
import {
  findClosestRecordingWindow,
  parseDurationToMs,
} from '../../../common/slo/slo_promql_generator';

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Structural shape for a rule-health checker. Intentionally declared inline
 * (not imported from `rule_health_checker.ts`) to keep the aggregator's
 * dependencies weak — callers synthesize this object from whichever checker
 * they have on hand (real in wiring, `jest.fn()` in tests).
 */
export interface SloRuleHealthCheckResult {
  state: 'ok' | 'rules_partial' | 'rules_missing' | 'ruler_unreachable';
  rulerErrorCode?: string;
  expectedGroups: string[];
  presentGroups: string[];
  missingGroups: string[];
  computedAt: string;
}

export interface SloRuleHealthChecker {
  check(input: {
    workspaceId: string;
    datasource: Datasource;
    client: AlertingOSClient;
    sloId: string;
    namespace: string;
    expectedGroups: string[];
  }): Promise<SloRuleHealthCheckResult>;
}

export interface SloStatusAggregationContext {
  client: AlertingOSClient;
  /**
   * Resolve a Datasource by its persisted `spec.datasourceId`. The aggregator
   * uses this to derive `directQueryName` per SLO — `spec.datasourceId` is a
   * logical identifier and the actual `directQueryName` is only known to the
   * alerting DatasourceService once discovery has run. Returns undefined if
   * the datasource is no longer available; those SLOs degrade to `no_data`.
   */
  resolveDatasource: (datasourceId: string) => Promise<Datasource | undefined>;
  /**
   * Workspace identifier — drives ruleSuffix(workspaceId, sloId, objective).
   * Matches what was used at create time (see `SloDeployContext.workspaceId`).
   */
  workspaceId: string;
  /**
   * Optional rule-health checker. When present, the aggregator calls it once
   * per enabled prometheus-backed SLO after ruler samples are collected and
   * overlays the result onto the top-level SloLiveStatus.state per the W1.6
   * priority rules:
   *   `disabled` > `rules_missing` > `ruler_unreachable` > existing derivation
   * Leave undefined in offline / tests that only exercise the sample-based
   * derivation. See W1.6 in SLO_RULE_DEDUP_PLAN.md.
   */
  healthChecker?: SloRuleHealthChecker;
}

export interface SloStatusAggregator {
  /**
   * Compute live status for a batch of SLOs. Returns one `SloLiveStatus` per
   * input doc in order. Never throws for routine ruler problems: when a
   * datasource is unreachable, the affected SLOs surface as `no_data`.
   */
  aggregate(docs: SloDocument[], ctx: SloStatusAggregationContext): Promise<SloLiveStatus[]>;
}

// ============================================================================
// NoopStatusAggregator — offline dev / tests
// ============================================================================

/**
 * Offline fallback. Mirrors the W1.2 stub semantics: `disabled` when
 * spec.enabled is false, `no_data` otherwise. The rule count is taken from
 * `status.provisioning.generatedRuleNames` so the listing can still show
 * "X rules provisioned".
 *
 * This is what `SloService` falls back to when no aggregator is configured
 * (or when the DirectQuery one catastrophically rejects).
 */
export class NoopStatusAggregator implements SloStatusAggregator {
  async aggregate(docs: SloDocument[]): Promise<SloLiveStatus[]> {
    return docs.map((doc) => noDataOrDisabledStatus(doc));
  }
}

// ============================================================================
// DirectQueryStatusAggregator — real implementation
// ============================================================================

/**
 * Parsed sample from a PromQL instant query. `timestamp` is in *seconds* as
 * Prometheus returns it — the aggregator scales to ms only at the stale check.
 */
interface InstantSample {
  labels: Record<string, string>;
  timestamp: number;
  value: number;
}

export class DirectQueryStatusAggregator implements SloStatusAggregator {
  /**
   * De-dup key for health-checker failure warnings: one warn per
   * (sloId × error-message). Mirrors `SloService.warnAggregatorFailure` so a
   * flapping checker doesn't spam the log during listing polls. Cleared
   * implicitly by process lifetime — the aggregator is a singleton per
   * plugin start, so this matches the lifetime of the other caches.
   */
  private readonly loggedHealthCheckerFailures = new Set<string>();

  constructor(private readonly logger: Logger) {}

  async aggregate(docs: SloDocument[], ctx: SloStatusAggregationContext): Promise<SloLiveStatus[]> {
    // Short-circuit: nothing to do.
    if (docs.length === 0) return [];

    // Group SLOs by datasourceId so we do one alerts fetch per datasource,
    // not per SLO. PromQL queries still go one-per-SLO (different series).
    const byDs = new Map<string, SloDocument[]>();
    for (const d of docs) {
      const list = byDs.get(d.spec.datasourceId) ?? [];
      list.push(d);
      byDs.set(d.spec.datasourceId, list);
    }

    const perSloStatus = new Map<string, SloLiveStatus>();

    for (const [dsId, group] of byDs.entries()) {
      let ds: Datasource | undefined;
      try {
        ds = await ctx.resolveDatasource(dsId);
      } catch (err) {
        this.logger.warn(
          `StatusAggregator: resolveDatasource threw for ${dsId}: ${errMsg(err)}. Degrading ${
            group.length
          } SLO(s) to no_data.`
        );
      }

      if (!ds || !ds.directQueryName) {
        for (const d of group) perSloStatus.set(d.id, noDataOrDisabledStatus(d));
        continue;
      }

      // Firing-alerts: one fetch per datasource, keyed by slo_id.
      let alertCountBySloId = new Map<string, number>();
      try {
        alertCountBySloId = await this.fetchFiringAlertsBySlo(ctx.client, ds);
      } catch (err) {
        // Graceful: treat as zero firing alerts for this datasource and keep
        // computing attainment — a ruler that can't serve /alerts might still
        // serve /query.
        this.logger.warn(
          `StatusAggregator: alerts fetch failed for datasource ${ds.id} (${
            ds.directQueryName
          }): ${errMsg(err)}. firingCount will be 0 for affected SLOs.`
        );
      }

      // Per-SLO: one instant query for the recording-rule samples.
      await Promise.all(
        group.map(async (doc) => {
          // W1.6 priority 1: `disabled` beats everything — don't even call the
          // ruler or the health checker for a disabled SLO.
          if (!doc.spec.enabled) {
            perSloStatus.set(doc.id, disabledStatus(doc));
            return;
          }
          let base: SloLiveStatus;
          try {
            base = await this.statusForSlo(doc, ds!, ctx, alertCountBySloId.get(doc.id) ?? 0);
          } catch (err) {
            this.logger.warn(
              `StatusAggregator: statusForSlo failed for ${doc.id}: ${errMsg(
                err
              )}. Degrading to no_data.`
            );
            base = noDataStatus(doc);
          }
          // W1.6 priority 2/3: overlay rule-health state on top of the sample
          // derivation. Health-checker errors never escape (see
          // applyRuleHealthMerge) — the listing must stay available.
          const merged = await this.applyRuleHealthMerge(doc, ds!, ctx, base);
          perSloStatus.set(doc.id, merged);
        })
      );
    }

    // Preserve input order.
    return docs.map((d) => perSloStatus.get(d.id) ?? noDataStatus(d));
  }

  // --------------------------------------------------------------------------
  // Rule-health priority merge (W1.6)
  // --------------------------------------------------------------------------

  /**
   * Apply the W1.6 rule-health priority rules to a previously-computed
   * SloLiveStatus. The priority ladder (highest first):
   *   1. `disabled` (handled upstream — disabled SLOs never reach here)
   *   2. `rules_missing` — health-checker says `rules_missing` or `rules_partial`
   *   3. `ruler_unreachable` — health-checker says `ruler_unreachable`; the
   *      public `SloHealthState` union has no `ruler_unreachable` value so
   *      we surface this as `'no_data'` with a debug log. Callers who need
   *      the precise error code can call `GET .../rule_health` directly.
   *   4. existing sample-based derivation — no overlay
   *
   * Errors from `healthChecker.check` are **never** re-thrown: the listing
   * page polls this aggregator constantly, and a ruler outage must not 500
   * the listing. Warnings are deduped per (sloId × message) so a flapping
   * ruler doesn't spam the log.
   */
  private async applyRuleHealthMerge(
    doc: SloDocument,
    ds: Datasource,
    ctx: SloStatusAggregationContext,
    base: SloLiveStatus
  ): Promise<SloLiveStatus> {
    if (!ctx.healthChecker) return base;

    const expectedGroups = expectedRuleGroupsFor(doc);
    // Nothing to check — no persisted rule group name (shouldn't happen for a
    // prometheus-backed SLO that's gone through create, but be defensive).
    if (expectedGroups.length === 0) return base;

    const provisioning = doc.status.provisioning;
    // Non-prometheus backends don't own ruler state — skip.
    if (provisioning.backend !== 'prometheus') return base;

    let result: SloRuleHealthCheckResult;
    try {
      result = await ctx.healthChecker.check({
        workspaceId: ctx.workspaceId,
        datasource: ds,
        client: ctx.client,
        sloId: doc.id,
        namespace: provisioning.rulerNamespace,
        expectedGroups,
      });
    } catch (err) {
      this.warnHealthCheckerFailure(doc.id, err);
      return base;
    }

    if (result.state === 'rules_missing' || result.state === 'rules_partial') {
      return { ...base, state: 'rules_missing' };
    }
    if (result.state === 'ruler_unreachable') {
      this.logger.debug(
        `ruler unreachable for slo=${doc.id} code=${result.rulerErrorCode ?? 'unknown'}`
      );
      return { ...base, state: 'no_data' };
    }
    // `ok` — leave the sample-derived state intact.
    return base;
  }

  private warnHealthCheckerFailure(sloId: string, err: unknown): void {
    const msg = errMsg(err);
    const key = `${sloId}:${msg}`;
    if (this.loggedHealthCheckerFailures.has(key)) return;
    this.loggedHealthCheckerFailures.add(key);
    this.logger.warn(
      `StatusAggregator: healthChecker.check rejected (slo=${sloId}): ${msg}. Leaving state untouched.`
    );
  }

  // --------------------------------------------------------------------------
  // Per-SLO aggregation
  // --------------------------------------------------------------------------

  private async statusForSlo(
    doc: SloDocument,
    ds: Datasource,
    ctx: SloStatusAggregationContext,
    firingCount: number
  ): Promise<SloLiveStatus> {
    const spec = doc.spec;
    const window =
      spec.window.type === 'rolling' ? spec.window.duration : '3d'; /* calendar: use cap */
    const longWindow = findClosestRecordingWindow(window);
    const query = buildLongWindowQuery(doc.id, longWindow);

    const samples = await this.queryInstant(ctx.client, ds, query);

    // Map samples → per-objective by matching on `slo_objective` label.
    const byObjective = new Map<string, InstantSample>();
    for (const s of samples) {
      const name = s.labels.slo_objective;
      if (name) byObjective.set(name, s);
    }

    const staleAfterMs = 2 * parseDurationToMs(longWindow);
    const nowMs = Date.now();
    let lastEvalMs: number | undefined;
    let anyStale = false;
    let anyObjectiveHasData = false;

    const objectiveStatuses: ObjectiveStatus[] = spec.objectives.map((obj) => {
      const s = byObjective.get(obj.name);
      if (!s) {
        return emptyObjectiveStatus(obj, doc);
      }
      anyObjectiveHasData = true;
      const sampleMs = s.timestamp * 1000;
      if (lastEvalMs === undefined || sampleMs > lastEvalMs) lastEvalMs = sampleMs;
      const stale = nowMs - sampleMs > staleAfterMs;
      if (stale) anyStale = true;
      return buildObjectiveStatus(obj, doc, s.value, spec.budgetWarningThresholds);
    });

    const topState = deriveTopLevelState(
      spec.enabled,
      anyStale,
      anyObjectiveHasData,
      objectiveStatuses
    );

    const ruleCount =
      doc.status.provisioning.backend === 'prometheus'
        ? doc.status.provisioning.generatedRuleNames.length
        : 0;
    return {
      sloId: doc.id,
      objectives: objectiveStatuses,
      state: topState,
      firingCount,
      ruleCount,
      computedAt: new Date().toISOString(),
      lastEvaluatedAt: lastEvalMs ? new Date(lastEvalMs).toISOString() : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Wire-level helpers
  // --------------------------------------------------------------------------

  /**
   * Fetch firing alerts and group by `slo_id` label. Uses the same
   * resource-proxy path as `DirectQueryPrometheusBackend.getAlerts` (verified
   * 2026-04-23 — GET passes through the SQL plugin's resource router). Only
   * state=firing is counted; pending/inactive aren't "active pages".
   */
  private async fetchFiringAlertsBySlo(
    client: AlertingOSClient,
    ds: Datasource
  ): Promise<Map<string, number>> {
    const path = `/_plugins/_directquery/_resources/${encodeURIComponent(
      ds.directQueryName as string
    )}/api/v1/alerts`;
    const resp = await client.transport.request({ method: 'GET', path });
    const body = resp.body as PromAlertsApiResponse | Record<string, unknown> | PromRawAlert[];
    const alerts = extractAlerts(body);
    const counts = new Map<string, number>();
    for (const a of alerts) {
      if (a.state !== 'firing') continue;
      const sloId = a.labels?.slo_id;
      if (!sloId) continue;
      counts.set(sloId, (counts.get(sloId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Run a PromQL instant query through the SQL plugin's query execution
   * endpoint. Response is unwrapped to the `{resultType, result}` Prometheus
   * shape and mapped to `InstantSample[]`.
   *
   * The SQL plugin's `PrometheusQueryHandler` requires `options.time` for
   * instant queries — it rejects the request with
   * `"Time parameter is required for instant queries"` otherwise. We pass
   * "now" in epoch seconds; Prometheus returns the most recent sample at
   * that wall-clock moment.
   */
  private async queryInstant(
    client: AlertingOSClient,
    ds: Datasource,
    query: string
  ): Promise<InstantSample[]> {
    const dqName = ds.directQueryName as string;
    const path = `/_plugins/_directquery/_query/${encodeURIComponent(dqName)}`;
    const resp = await client.transport.request({
      method: 'POST',
      path,
      body: {
        datasource: dqName,
        query,
        language: 'PROMQL',
        options: {
          queryType: 'instant',
          time: Math.floor(Date.now() / 1000).toString(),
        },
      },
    });
    return parseInstantResponse(resp.body as Record<string, unknown>);
  }
}

// ============================================================================
// Pure helpers — unit-testable without a transport
// ============================================================================

/**
 * Build a PromQL instant query that returns one sample per objective for a
 * given SLO at the long-window recording rule. The regex anchors on the
 * metric-name prefix so we only match our generated recording rules.
 */
export function buildLongWindowQuery(sloId: string, longWindow: string): string {
  const esc = sloId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `{__name__=~"slo:sli_error:ratio_rate_${longWindow}:.*", slo_id="${esc}"}`;
}

/**
 * Per-objective state ladder.
 *  - `breached` when the sampled error ratio exceeds the full budget
 *    (attainment < target, equivalently errorBudgetRemaining < 0).
 *  - `warning` when any configured budget-warning threshold is tripped —
 *    threshold = "fraction of budget remaining below which we warn". We
 *    pick the **largest** threshold that still triggers (i.e. the earliest
 *    warn), since that's the severity tier the user asked us to flag at.
 *  - `ok` otherwise.
 *
 * Pinned test cases (see __tests__/status_aggregator.test.ts):
 *   target=0.999, errorBudgetTotal=0.001
 *   errorRatio=0.002  → attainment=0.998, budget=-1.0  → breached
 *   errorRatio=0.0006 → attainment=0.9994, budget=+0.4 → warning (threshold=0.5)
 *   errorRatio=0.0002 → attainment=0.9998, budget=+0.8 → ok
 */
export function objectiveState(
  attainment: number,
  target: number,
  errorBudgetRemaining: number,
  budgetWarningThresholds: ReadonlyArray<{ threshold: number; severity: string }>
): 'ok' | 'warning' | 'breached' {
  if (attainment < target) return 'breached';
  for (const t of sortThresholdsDesc(budgetWarningThresholds)) {
    if (errorBudgetRemaining < t.threshold) return 'warning';
  }
  return 'ok';
}

function sortThresholdsDesc(
  thresholds: ReadonlyArray<{ threshold: number; severity: string }>
): Array<{ threshold: number; severity: string }> {
  return [...thresholds].sort((a, b) => b.threshold - a.threshold);
}

/**
 * Top-level state per design §3.6 — `disabled` and `stale` pre-empt the
 * per-objective roll-up. For the worst-of we consider breached > warning >
 * no_data > ok: no_data sits *below* warning because "we don't know yet" is
 * less alarming than "we know the budget is burning" — but above ok because
 * an SLO with no signal at all warrants visibility on the listing.
 */
export function deriveTopLevelState(
  enabled: boolean,
  anyStale: boolean,
  anyObjectiveHasData: boolean,
  objectives: readonly ObjectiveStatus[]
): SloHealthState {
  if (!enabled) return 'disabled';
  if (anyStale) return 'stale';
  if (!anyObjectiveHasData) return 'no_data';
  const severity: Record<SloHealthState, number> = {
    disabled: -1,
    stale: -1,
    ok: 0,
    no_data: 1,
    warning: 2,
    breached: 3,
  };
  let worst: SloHealthState = 'ok';
  for (const o of objectives) {
    if (severity[o.state] > severity[worst]) worst = o.state;
  }
  return worst;
}

// ============================================================================
// Status-builder helpers
// ============================================================================

function buildObjectiveStatus(
  objective: Objective,
  doc: SloDocument,
  errorRatio: number,
  budgetWarningThresholds: ReadonlyArray<{ threshold: number; severity: string }>
): ObjectiveStatus {
  const attainment = clampAttainment(1 - errorRatio);
  const target = objective.target;
  // errorBudgetRemaining as fraction of budget (0..1 when healthy, negative
  // when breached). Matches SRE Workbook + Sloth/Pyrra convention.
  const errorBudgetRemaining = target < 1 ? (attainment - target) / (1 - target) : 0;
  const state = objectiveState(attainment, target, errorBudgetRemaining, budgetWarningThresholds);
  return {
    objectiveName: objective.name,
    currentValue: errorRatio,
    currentValueUnit: inferUnit(doc),
    attainment,
    errorBudgetRemaining,
    state,
  };
}

function emptyObjectiveStatus(objective: Objective, doc: SloDocument): ObjectiveStatus {
  return {
    objectiveName: objective.name,
    currentValue: 0,
    currentValueUnit: inferUnit(doc),
    attainment: 0,
    errorBudgetRemaining: 1,
    state: 'no_data',
  };
}

function noDataOrDisabledStatus(doc: SloDocument): SloLiveStatus {
  return doc.spec.enabled ? noDataStatus(doc) : disabledStatus(doc);
}

function noDataStatus(doc: SloDocument): SloLiveStatus {
  return {
    sloId: doc.id,
    objectives: doc.spec.objectives.map((o) => emptyObjectiveStatus(o, doc)),
    state: 'no_data',
    firingCount: 0,
    ruleCount:
      doc.status.provisioning.backend === 'prometheus'
        ? doc.status.provisioning.generatedRuleNames.length
        : 0,
    computedAt: new Date().toISOString(),
  };
}

function disabledStatus(doc: SloDocument): SloLiveStatus {
  return {
    sloId: doc.id,
    objectives: doc.spec.objectives.map((o) => ({
      objectiveName: o.name,
      currentValue: 0,
      currentValueUnit: inferUnit(doc),
      attainment: 0,
      errorBudgetRemaining: 1,
      state: 'disabled',
    })),
    state: 'disabled',
    firingCount: 0,
    ruleCount:
      doc.status.provisioning.backend === 'prometheus'
        ? doc.status.provisioning.generatedRuleNames.length
        : 0,
    computedAt: new Date().toISOString(),
  };
}

// Values sometimes arrive as NaN (dividing by zero rate on a scraped-once
// metric). Clamp so downstream charts don't render garbage.
function clampAttainment(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function inferUnit(doc: SloDocument): 'ratio' | 'seconds' | 'count' {
  if (doc.spec.sli.type !== 'single') return 'ratio';
  const def = doc.spec.sli.definition;
  if (def.backend === 'prometheus' && def.type === 'latency_threshold') return 'seconds';
  return 'ratio';
}

// ============================================================================
// Response parsers — defensive against the DirectQuery envelope variants
// (see DirectQueryPrometheusBackend.extractPrometheusResult for prior art)
// ============================================================================

/**
 * Walk the possible DirectQuery response envelopes and return the Prometheus
 * `{resultType, result}` object, or `null` if nothing usable is present.
 * Mirrors DirectQueryPrometheusBackend.extractPrometheusResult.
 */
function extractPrometheusResult(
  body: Record<string, unknown>
): { resultType?: string; result?: unknown[] } | null {
  if (body?.resultType || body?.result) return body as { resultType?: string; result?: unknown[] };
  if (body?.data && typeof body.data === 'object') {
    const data = body.data as Record<string, unknown>;
    if (data.resultType || data.result) {
      return data as { resultType?: string; result?: unknown[] };
    }
  }
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

export function parseInstantResponse(body: Record<string, unknown>): InstantSample[] {
  const promResult = extractPrometheusResult(body);
  if (!promResult) return [];
  const result = (promResult.result ?? []) as Array<{
    metric?: Record<string, string>;
    value?: unknown[];
  }>;
  const out: InstantSample[] = [];
  for (const entry of result) {
    if (Array.isArray(entry.value) && entry.value.length >= 2) {
      const ts = Number(entry.value[0]);
      const numVal = parseFloat(String(entry.value[1]));
      if (Number.isFinite(ts) && Number.isFinite(numVal)) {
        out.push({ labels: entry.metric || {}, timestamp: ts, value: numVal });
      }
    }
  }
  return out;
}

function extractAlerts(
  body: PromAlertsApiResponse | Record<string, unknown> | PromRawAlert[]
): PromRawAlert[] {
  if (Array.isArray(body)) return body as PromRawAlert[];
  const b = body as PromAlertsApiResponse;
  if (b?.alerts) return b.alerts;
  if (b?.data) {
    const inner = b.data;
    if (Array.isArray(inner)) return inner;
    if (typeof inner === 'object' && inner !== null && 'alerts' in inner) {
      return (inner as { alerts: PromRawAlert[] }).alerts;
    }
  }
  return [];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Derive the list of rule-group names the ruler is expected to serve for
 * this SLO. Phase 1: one group per SLO for prometheus-backed docs — the
 * generator emits `provisioning.ruleGroupName` and writes exactly that group
 * under the SLO's workspace namespace. Future phases (per-objective rule
 * groups, burn-rate groups) can extend this to return multiple names.
 *
 * Returns an empty array when there's nothing to probe (non-prometheus
 * backend or an empty group name) — callers treat that as "skip the health
 * check for this SLO".
 */
export function expectedRuleGroupsFor(doc: SloDocument): string[] {
  const p = doc.status.provisioning;
  if (p.backend !== 'prometheus') return [];
  if (!p.ruleGroupName) return [];
  return [p.ruleGroupName];
}
