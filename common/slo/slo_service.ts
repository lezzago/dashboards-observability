/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SLO lifecycle service — CRUD + status + preview over ISloStore.
 *
 * Persists full SloDocument {id, spec, status}. The store is pluggable; the
 * server upgrades from InMemorySloStore to SavedObjectSloStore once the
 * saved-objects repository is available.
 *
 * Live status computation (attainment, error budget remaining, firing alerts)
 * is deferred to P0-follow-up — the server-side aggregator queries the ruler
 * directly. For now `computeStatus()` returns a conservative 'ok'/'no_data'
 * default that the UI can render without breaking.
 */

import type {
  AlertingOSClient,
  Datasource,
  Logger,
  PaginatedResponse,
} from '../types/alerting/types';
import type {
  ISloStore,
  Dimension,
  GeneratedRuleGroup,
  SloCreateInput,
  SloDocument,
  SloHealthState,
  SloLiveStatus,
  SloListFilters,
  SloSpec,
  SloSummary,
  SloUpdateInput,
  ObjectiveStatus,
} from './slo_types';
import {
  generateSloRuleGroup,
  extractGeneratedRuleNames,
  SLO_RULER_NAMESPACE,
  generateRecordingGroupForFingerprint,
  generateAlertGroupFor,
  dedupRecordingGroupName,
  dedupAlertGroupName,
} from './slo_promql_generator';
import { validateSloSpec, validateSloId } from './slo_validators';
import { InMemorySloStore } from './slo_store';
import {
  SloNotFoundError,
  SloRulerError,
  SloRulerTeardownRequiredError,
  SloValidationError,
  SloVersionConflictError,
} from './slo_errors';
import {
  computeSliFingerprint,
  FINGERPRINT_VERSION,
} from './slo_sli_fingerprint';
import {
  annotateAlertGroup,
  annotateRecordingGroup,
  buildAlertProvenance,
  buildRecordingProvenance,
  buildSentinelAlert,
} from './slo_rule_provenance';

/**
 * Status cache TTL. Rationale (design §12.12 was open):
 *   - Recording rules evaluate every 60s (DEFAULT_INTERVAL_SECONDS in the
 *     generator), so the freshest sample available is at most ~60s old. Any
 *     TTL shorter than the eval interval just wastes ruler calls on identical
 *     samples. Matching the interval gives ~1 cache miss per eval.
 *   - Listing pages poll on the order of 10–30s. Without the cache each open
 *     listing tab would issue N ruler queries per poll; with 60s TTL one batch
 *     per minute covers every open tab.
 *   - A user who fixed a breach sees their status flip within ~1m (next cache
 *     expiry + next eval), which is the right tradeoff. >5m would feel stale.
 */
const STATUS_CACHE_TTL_MS = 60_000;

export {
  SloNotFoundError,
  SloRulerError,
  SloRulerTeardownRequiredError,
  SloValidationError,
  SloVersionConflictError,
};

// ============================================================================
// Ruler deployment context
// ============================================================================

/**
 * Minimal ruler-client surface the service needs. Mirrors `RulerClient` in
 * `server/services/slo/ruler_client.ts` but declared here so `slo_service.ts`
 * (importable from both server and tests) doesn't reach into the server tree.
 */
export interface SloRulerClient {
  upsertRuleGroup(
    client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    group: GeneratedRuleGroup
  ): Promise<void>;
  deleteRuleGroup(
    client: AlertingOSClient,
    datasource: Datasource,
    namespace: string,
    groupName: string
  ): Promise<void>;
}

/**
 * Per-request deployment context passed to `create` / `update` / `delete`.
 * When absent, ruler calls are skipped entirely — e.g. unit tests, dev-server
 * paths without a real DirectQuery backend, or legacy callers that haven't
 * been plumbed through yet.
 *
 * Design choice (memo §Dual-write): methods take `deploy?`, rather than the
 * constructor taking a RulerClient, because the OS client / datasource / ws
 * are all request-scoped and can't live on the service instance.
 */
export interface SloDeployContext {
  ruler: SloRulerClient;
  client: AlertingOSClient;
  datasource: Datasource;
  /**
   * Workspace identifier for namespace scoping. Pass `'default'` if the
   * caller has no workspace concept (standalone, tests). The namespace is
   * `slo-generated-<workspaceId>` — hyphen (not slash) because the SQL
   * plugin's REST router treats `{namespace}` as a single path segment.
   */
  workspaceId: string;
}

// ============================================================================
// Phase 3 dedup: refcount registry surface (W3.2 / W3.8)
// ============================================================================

/**
 * Minimal shape the W3.8 dedup path consumes. The real implementation lives in
 * `server/services/slo/slo_rule_ref_store.ts` — declared here structurally so
 * `slo_service.ts` (common/) does not reach into the server tree.
 *
 * `incrementRef` returns `wasZero: true` iff the refcount transitioned from 0
 * (or was newly created). The service uses that to decide whether the shared
 * recording group must be upserted this call — repeated upserts are byte-equal
 * no-ops, but skipping them is still the right call (design §3 dedup intent).
 */
export interface SloRuleRefStoreLite {
  get(
    workspaceId: string,
    datasourceId: string,
    fingerprint: string
  ): Promise<{ attributes: { refcount: number } } | null>;
  incrementRef(input: {
    workspaceId: string;
    datasourceId: string;
    fingerprint: string;
    fingerprintVersion: string;
    groupName: string;
    namespace: string;
  }): Promise<{ wasZero: boolean }>;
  decrementRef(input: {
    workspaceId: string;
    datasourceId: string;
    fingerprint: string;
  }): Promise<{ droppedToZero: boolean; underflow: boolean }>;
}

// ============================================================================
// Live-status aggregator context (W3.1)
// ============================================================================

/**
 * Minimal aggregator surface the service needs. Mirrors `SloStatusAggregator`
 * in `server/services/slo/status_aggregator.ts` — declared here so
 * `slo_service.ts` (importable from browser bundles via tests) doesn't reach
 * into the server tree.
 */
export interface SloStatusAggregator {
  aggregate(docs: SloDocument[], ctx: SloStatusAggregationContext): Promise<SloLiveStatus[]>;
}

export interface SloStatusAggregationContext {
  client: AlertingOSClient;
  resolveDatasource: (datasourceId: string) => Promise<Datasource | undefined>;
  workspaceId: string;
  /**
   * Phase 3 (W3.6) — propagates the `observability.slo.ruleDedup.enabled`
   * flag so the aggregator can pick fingerprint-keyed selectors (W3.9) when
   * true, or fall back to the legacy `{slo_id="X"}` selectors when false.
   * Undefined → legacy behavior (pre-Phase-3).
   */
  ruleDedupEnabled?: boolean;
  /**
   * Optional pass-through for the aggregator's W1.6 priority-merge step.
   * Typed as `unknown` at this layer because the real checker interface
   * lives in the server tree; the server aggregator narrows it to
   * `SloRuleHealthChecker`. When undefined the aggregator leaves the
   * sample-derived state alone.
   */
  healthChecker?: unknown;
}

/**
 * Compose the per-workspace ruler namespace. Hyphen separator (not slash) so
 * the whole thing stays a single `{namespace}` path segment when routed
 * through `/_plugins/_directquery/_resources/{dqName}/api/v1/rules/{namespace}`.
 */
export function sloRulerNamespaceFor(workspaceId: string): string {
  return `${SLO_RULER_NAMESPACE}-${workspaceId}`;
}

// ============================================================================
// Rule-health + repair context (W1.5)
// ============================================================================

/**
 * Structural mirror of `RuleHealthState` from
 * `server/services/slo/rule_health_checker.ts`. Declared locally so
 * `slo_service.ts` (which is importable from browser bundles via tests) does
 * not reach into the server tree.
 */
export type SloRuleHealthStateLite = 'ok' | 'rules_partial' | 'rules_missing' | 'ruler_unreachable';

/**
 * Structural mirror of `RuleHealthReport`. Same rationale as above — we want
 * the common surface to describe its own contract without depending on server
 * types.
 */
export interface RuleHealthReportLite {
  state: SloRuleHealthStateLite;
  expectedGroups: string[];
  presentGroups: string[];
  missingGroups: string[];
  rulerErrorCode?: 'RULER_UNREACHABLE' | 'RULER_AUTH_FAILED' | 'RULER_VALIDATION_FAILED';
  computedAt: string;
}

/**
 * Input accepted by the injected rule-health `check` callback. Same shape the
 * server-side `RuleHealthChecker.check` consumes — declared locally so the
 * caller can adapt freely without ripping through `slo_service.ts`.
 */
export interface RuleHealthCheckInputLite {
  workspaceId: string;
  datasource: Datasource;
  client: AlertingOSClient;
  sloId: string;
  namespace: string;
  expectedGroups: string[];
}

/**
 * Minimal rule-health surface the `repair()` method needs. Mirrors the
 * server-side `RuleHealthChecker` contract (see
 * `server/services/slo/rule_health_checker.ts`) structurally, so the service
 * layer doesn't reach into the server tree.
 */
export interface SloRuleHealthProbe {
  check(input: RuleHealthCheckInputLite): Promise<RuleHealthReportLite>;
  invalidate(workspaceId: string, datasourceId: string, sloId: string): void;
}

/**
 * Per-request context for `SloService.repair`. Keeps the same shape as the
 * existing `SloDeployContext` + a rule-health probe, passed in alongside so
 * the service can reuse the ruler to upsert and the probe to re-verify.
 */
export interface SloRepairContext {
  health: SloRuleHealthProbe;
  deploy: SloDeployContext;
}

/**
 * Result returned by `SloService.repair`.
 *
 * - `repaired` records whether a ruler upsert actually happened this call.
 *   A healthy SLO short-circuits before any ruler mutation, so the same
 *   repair call invoked back-to-back on a healthy SLO returns
 *   `repaired: false` both times.
 * - `health` is the post-repair snapshot so the UI can re-render in one
 *   round-trip without a separate rule_health fetch.
 */
export interface SloRepairResult {
  sloId: string;
  repaired: boolean;
  health: RuleHealthReportLite;
}

// ============================================================================
// Service
// ============================================================================

export class SloService {
  private store: ISloStore;
  private statusCache = new Map<string, { status: SloLiveStatus; expiresAt: number }>();
  /**
   * Aggregator is optional — when unset, getStatuses falls back to the W1.2
   * stub (disabled/no_data). Request-scoped state (client, workspace,
   * datasource resolver) is passed per-call via `SloStatusAggregationContext`.
   */
  private aggregator?: SloStatusAggregator;
  /**
   * De-dup key for aggregator-failure warnings: one warn per (sloId × code).
   * Prevents the listing-page poll from spamming the log when the ruler is
   * down. Cleared on store swap (new env → fresh slate).
   */
  private readonly loggedAggregatorFailures = new Set<string>();

  /**
   * Phase 3 (W3.6) — reflects `observability.slo.ruleDedup.enabled`. Flipped
   * by `server/plugin.ts` at boot. Batch 2 workstreams (W3.8 service dedup,
   * W3.9 aggregator) branch on this via `isDedupEnabled()`. Default `true`
   * matches the schema default.
   */
  private dedupEnabled = true;

  /**
   * Phase 3 (W3.8) — refcount registry. Optional. When absent and
   * `dedupEnabled` is true the service still runs the dedup codepath but
   * skips the refcount bookkeeping — useful for tests that want to exercise
   * the generator split without wiring a saved-objects client. Plugin wires
   * the real `SloRuleRefStore` in `start()`.
   */
  private refStore?: SloRuleRefStoreLite;
  /**
   * Plugin version stamped into provenance annotations (W3.3). Defaults to
   * '0.0.0' — production wires the real `kibana.version` from the plugin
   * initializer context.
   */
  private pluginVersion = '0.0.0';

  constructor(private readonly logger: Logger, store?: ISloStore) {
    this.store = store ?? new InMemorySloStore();
  }

  /** Phase 3 (W3.6): update the dedup flag at runtime. See `plugin.ts`. */
  setDedupEnabled(enabled: boolean): void {
    this.dedupEnabled = enabled;
    this.logger.info(`SloService: ruleDedup ${enabled ? 'enabled' : 'disabled'}`);
  }

  isDedupEnabled(): boolean {
    return this.dedupEnabled;
  }

  /** Phase 3 (W3.8): wire the refcount registry. */
  setRuleRefStore(refStore: SloRuleRefStoreLite | undefined): void {
    this.refStore = refStore;
    this.logger.info(
      refStore
        ? 'SloService: rule-ref store configured'
        : 'SloService: rule-ref store cleared'
    );
  }

  /** Phase 3 (W3.3 provenance): set plugin version stamped on annotations. */
  setPluginVersion(version: string): void {
    this.pluginVersion = version;
  }

  setStore(store: ISloStore): void {
    this.store = store;
    this.statusCache.clear();
    this.loggedAggregatorFailures.clear();
    this.logger.info('SloService: storage backend replaced');
  }

  setStatusAggregator(aggregator: SloStatusAggregator | undefined): void {
    this.aggregator = aggregator;
    this.statusCache.clear();
    this.loggedAggregatorFailures.clear();
    this.logger.info(
      aggregator
        ? 'SloService: live status aggregator configured'
        : 'SloService: live status aggregator cleared — falling back to stub'
    );
  }

  // ---------- CRUD ----------

  async create(
    input: SloCreateInput,
    createdBy = 'system',
    deploy?: SloDeployContext
  ): Promise<SloDocument> {
    // Normalize (clamp target precision, etc.) BEFORE validation so the
    // range check and rule generation both see the canonical value.
    // Validators stay pure — never mutate — so normalization lives here.
    const spec = normalizeSpec(input.spec);
    const { errors } = validateSloSpec(spec);
    if (Object.keys(errors).length > 0) throw new SloValidationError(errors);

    const id = input.id ?? generateUuidV4();
    if (input.id) {
      const slugErr = validateSloId(input.id);
      if (slugErr) throw new SloValidationError({ id: slugErr });
    }

    // Name uniqueness within the datasource (workspace scoping is handled by
    // the saved-objects layer; the name check is best-effort here).
    await this.assertNameUnique(spec.datasourceId, spec.name, null);

    // Phase 3 (W3.8): dedup path branches here. Legacy single-group path
    // stays byte-identical to what it used to do.
    if (this.dedupEnabled && deploy) {
      return this.createDedup(id, spec, createdBy, deploy);
    }

    const now = new Date().toISOString();
    const namespace = deploy ? sloRulerNamespaceFor(deploy.workspaceId) : SLO_RULER_NAMESPACE;
    // Build the document with minimal status so we can generate rules from it,
    // then fill in the provisioning record with the resulting names.
    const doc: SloDocument = {
      id,
      spec,
      status: {
        version: 1,
        createdAt: now,
        createdBy,
        updatedAt: now,
        updatedBy: createdBy,
        provisioning: {
          backend: 'prometheus',
          ruleGroupName: '',
          rulerNamespace: namespace,
          generatedRuleNames: [],
        },
      },
    };

    const group = generateSloRuleGroup(doc, {
      workspaceId: deploy?.workspaceId,
    });
    if (doc.status.provisioning.backend === 'prometheus') {
      doc.status.provisioning.ruleGroupName = group.groupName;
      doc.status.provisioning.generatedRuleNames = extractGeneratedRuleNames(group);
    }

    // Ruler-first, SO-second (memo §Dual-write atomicity). An SloRulerError
    // here propagates unchanged — the SO is never written and the wizard
    // renders the raw upstream body so the user can self-service.
    if (deploy) {
      await deploy.ruler.upsertRuleGroup(deploy.client, deploy.datasource, namespace, group);
    }

    try {
      await this.store.save(doc);
    } catch (saveErr) {
      // Compensation: ruler wrote, SO didn't. One best-effort delete; swallow
      // + warn on compensation failure. Reconciler (W3) sweeps danglers.
      if (deploy) {
        await this.safeRollback(deploy, namespace, group.groupName);
      }
      throw saveErr;
    }
    this.logger.info(
      `Created SLO: ${doc.id} (${doc.spec.name}) — ${group.rules.length} rules generated`
    );
    return doc;
  }

  // ---------- create (dedup path, W3.8) ----------

  /**
   * Phase 3 dedup-aware create. Differences from the legacy path:
   *
   *   1. Per-objective fingerprint via `computeSliFingerprint`. Objectives
   *      whose fingerprint is `null` (composite SLIs, OpenSearch backend)
   *      fall through the dedup path but do not contribute a recording group.
   *   2. For each distinct fingerprint: `incrementRef` the registry. If the
   *      returned `wasZero` is true, upsert the shared recording group on the
   *      ruler (recording rules are byte-equal across SLOs that share a
   *      fingerprint — repeated upserts are safe no-ops but skipping them is
   *      cheaper).
   *   3. Upsert the per-SLO alert group with a W3.3 provenance annotation on
   *      its first rule. Shadow mode / all-createAlarm-false cases get a
   *      synthetic sentinel alert so the provenance annotation has a home.
   *   4. Rollback on SO save failure: decrement every ref we incremented; if
   *      any ref dropped back to zero, best-effort delete its recording
   *      group. Alert group is deleted too. Same "reconciler sweeps" tail as
   *      the legacy path if rollback itself fails.
   */
  private async createDedup(
    id: string,
    spec: SloSpec,
    createdBy: string,
    deploy: SloDeployContext
  ): Promise<SloDocument> {
    const now = new Date().toISOString();
    const namespace = sloRulerNamespaceFor(deploy.workspaceId);
    const recordingFingerprints = this.computeObjectiveFingerprints(spec);
    const uniqueFps = uniqueValues(recordingFingerprints);

    // Pre-compute the per-SLO alert group name so rollback can find it even
    // if the caller never persists the SO.
    const alertGroupName = dedupAlertGroupName(spec.name, deploy.workspaceId, id);

    // Step 1: refcount bookkeeping + recording-group upserts. Track what we
    // touched so rollback can undo it.
    const incrementedFps: string[] = [];
    const createdRecordingGroups: string[] = [];
    const rollback = async (): Promise<void> => {
      for (const fp of incrementedFps) {
        if (this.refStore) {
          try {
            const r = await this.refStore.decrementRef({
              workspaceId: deploy.workspaceId,
              datasourceId: deploy.datasource.id,
              fingerprint: fp,
            });
            if (r.droppedToZero && createdRecordingGroups.includes(fp)) {
              await this.safeRollback(deploy, namespace, dedupRecordingGroupName(fp));
            }
          } catch (err) {
            this.logger.warn(
              `SloService: rollback decrementRef failed for fingerprint=${fp}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        } else if (createdRecordingGroups.includes(fp)) {
          await this.safeRollback(deploy, namespace, dedupRecordingGroupName(fp));
        }
      }
      await this.safeRollback(deploy, namespace, alertGroupName);
    };

    for (const fp of uniqueFps) {
      const representative = pickRepresentativeForFingerprint(spec, recordingFingerprints, fp);
      if (!representative) continue;
      const groupName = dedupRecordingGroupName(fp);
      let wasZero = true;
      if (this.refStore) {
        try {
          const r = await this.refStore.incrementRef({
            workspaceId: deploy.workspaceId,
            datasourceId: deploy.datasource.id,
            fingerprint: fp,
            fingerprintVersion: FINGERPRINT_VERSION,
            groupName,
            namespace,
          });
          wasZero = r.wasZero;
          incrementedFps.push(fp);
        } catch (err) {
          await rollback();
          throw err;
        }
      }
      if (wasZero) {
        const recGroup = generateRecordingGroupForFingerprint({
          fingerprint: fp,
          sli: representative.sli,
          objectiveLatencyThreshold: representative.latencyThreshold,
        });
        if (recGroup) {
          const provenance = buildRecordingProvenance({
            pluginVersion: this.pluginVersion,
            fingerprint: fp,
            fingerprintVersion: FINGERPRINT_VERSION,
            sliSnapshot: representative.sli,
          });
          const annotated = annotateRecordingGroup(recGroup, provenance);
          try {
            await deploy.ruler.upsertRuleGroup(
              deploy.client,
              deploy.datasource,
              namespace,
              annotated
            );
            createdRecordingGroups.push(fp);
          } catch (err) {
            await rollback();
            throw err;
          }
        }
      }
    }

    // Step 2: build + upsert the per-SLO alert group with provenance.
    const doc: SloDocument = {
      id,
      spec,
      status: {
        version: 1,
        createdAt: now,
        createdBy,
        updatedAt: now,
        updatedBy: createdBy,
        provisioning: {
          backend: 'prometheus',
          ruleGroupName: alertGroupName,
          rulerNamespace: namespace,
          generatedRuleNames: [],
          recordingFingerprints,
          alertGroupName,
          needsRedeploy: false,
        },
      },
    };

    const alertGroup = buildAlertGroupWithProvenance(
      doc,
      recordingFingerprints,
      deploy.workspaceId,
      deploy.datasource.id,
      this.pluginVersion,
      now
    );
    if (doc.status.provisioning.backend === 'prometheus') {
      doc.status.provisioning.generatedRuleNames = extractGeneratedRuleNames(alertGroup);
    }
    try {
      await deploy.ruler.upsertRuleGroup(deploy.client, deploy.datasource, namespace, alertGroup);
    } catch (err) {
      await rollback();
      throw err;
    }

    try {
      await this.store.save(doc);
    } catch (saveErr) {
      await rollback();
      throw saveErr;
    }
    this.logger.info(
      `Created SLO (dedup): ${doc.id} (${doc.spec.name}) — ${uniqueFps.length} fingerprint(s), ${alertGroup.rules.length} alert rules`
    );
    return doc;
  }

  private computeObjectiveFingerprints(spec: SloSpec): Record<string, string> {
    const out: Record<string, string> = {};
    for (const objective of spec.objectives) {
      const fp = computeSliFingerprint(spec.datasourceId, spec.sli, objective);
      if (fp !== null) out[objective.name] = fp;
    }
    return out;
  }

  async get(id: string): Promise<SloDocument | null> {
    return this.store.get(id);
  }

  async update(
    id: string,
    input: SloUpdateInput,
    updatedBy = 'system',
    deploy?: SloDeployContext
  ): Promise<SloDocument> {
    const existing = await this.store.get(id);
    if (!existing) throw new SloNotFoundError(id);

    if (input.version !== existing.status.version) {
      throw new SloVersionConflictError(existing, input.version);
    }

    // Merge partial input onto the current spec, then normalize (clamp target
    // precision, etc.) BEFORE validation so rule generation sees canonical values.
    const merged: SloSpec = normalizeSpec({ ...existing.spec, ...input.spec });

    const { errors } = validateSloSpec(merged);
    if (Object.keys(errors).length > 0) throw new SloValidationError(errors);

    if (merged.name !== existing.spec.name) {
      await this.assertNameUnique(merged.datasourceId, merged.name, id);
    }

    if (this.dedupEnabled && deploy) {
      return this.updateDedup(existing, merged, updatedBy, deploy);
    }

    // If the caller provides a deploy context, derive the namespace from the
    // workspace; otherwise preserve whatever namespace the existing SO carries.
    const namespace = deploy
      ? sloRulerNamespaceFor(deploy.workspaceId)
      : existing.status.provisioning.backend === 'prometheus'
      ? existing.status.provisioning.rulerNamespace
      : SLO_RULER_NAMESPACE;

    const updated: SloDocument = {
      id: existing.id,
      spec: merged,
      status: {
        ...existing.status,
        version: existing.status.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy,
        provisioning:
          existing.status.provisioning.backend === 'prometheus'
            ? { ...existing.status.provisioning, rulerNamespace: namespace }
            : existing.status.provisioning,
      },
    };

    const group = generateSloRuleGroup(updated, {
      workspaceId: deploy?.workspaceId,
    });
    if (updated.status.provisioning.backend === 'prometheus') {
      updated.status.provisioning.ruleGroupName = group.groupName;
      updated.status.provisioning.generatedRuleNames = extractGeneratedRuleNames(group);
    }

    if (deploy) {
      await deploy.ruler.upsertRuleGroup(deploy.client, deploy.datasource, namespace, group);
    }

    try {
      await this.store.save(updated);
    } catch (saveErr) {
      if (deploy) {
        await this.safeRollback(deploy, namespace, group.groupName);
      }
      throw saveErr;
    }
    this.statusCache.delete(id);
    this.logger.info(`Updated SLO: ${id} → v${updated.status.version}`);
    return updated;
  }

  // ---------- update (dedup path, W3.8) ----------

  /**
   * Phase 3 dedup-aware update.
   *
   * Diff-based: compute fingerprints for the merged spec, increment refs on
   * any fingerprint that wasn't already claimed by this SLO, upsert recording
   * groups for refs that just became nonzero, upsert the per-SLO alert group,
   * save the SO, then decrement refs on fingerprints the SLO used to claim
   * but no longer does. On SO-save failure: undo refs we incremented and
   * delete any recording groups we created this call.
   *
   * The alert group is always upserted (spec semantics can change without a
   * fingerprint change — e.g. severity, budget-warning thresholds — so the
   * group must reflect the latest spec). The alert-group name is stable
   * across updates because it's derived from (workspaceId, sloId, 'group')
   * — meaning the upsert is a replace-in-place on the ruler.
   */
  private async updateDedup(
    existing: SloDocument,
    merged: SloSpec,
    updatedBy: string,
    deploy: SloDeployContext
  ): Promise<SloDocument> {
    const now = new Date().toISOString();
    const namespace = sloRulerNamespaceFor(deploy.workspaceId);
    const newFingerprints = this.computeObjectiveFingerprints(merged);
    const oldFingerprints =
      existing.status.provisioning.backend === 'prometheus'
        ? existing.status.provisioning.recordingFingerprints ?? {}
        : {};
    const newUnique = new Set(uniqueValues(newFingerprints));
    const oldUnique = new Set(uniqueValues(oldFingerprints));
    const toAdd = [...newUnique].filter((fp) => !oldUnique.has(fp));
    const toDrop = [...oldUnique].filter((fp) => !newUnique.has(fp));

    const alertGroupName = dedupAlertGroupName(merged.name, deploy.workspaceId, existing.id);

    // Bookkeeping for rollback.
    const incrementedFps: string[] = [];
    const createdRecordingGroups: string[] = [];

    const rollback = async (): Promise<void> => {
      for (const fp of incrementedFps) {
        if (this.refStore) {
          try {
            const r = await this.refStore.decrementRef({
              workspaceId: deploy.workspaceId,
              datasourceId: deploy.datasource.id,
              fingerprint: fp,
            });
            if (r.droppedToZero && createdRecordingGroups.includes(fp)) {
              await this.safeRollback(deploy, namespace, dedupRecordingGroupName(fp));
            }
          } catch (err) {
            this.logger.warn(
              `SloService: update rollback decrementRef failed for fingerprint=${fp}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        } else if (createdRecordingGroups.includes(fp)) {
          await this.safeRollback(deploy, namespace, dedupRecordingGroupName(fp));
        }
      }
    };

    // Add path: increment refs + upsert recording groups for new fps.
    for (const fp of toAdd) {
      const representative = pickRepresentativeForFingerprint(merged, newFingerprints, fp);
      if (!representative) continue;
      const groupName = dedupRecordingGroupName(fp);
      let wasZero = true;
      if (this.refStore) {
        try {
          const r = await this.refStore.incrementRef({
            workspaceId: deploy.workspaceId,
            datasourceId: deploy.datasource.id,
            fingerprint: fp,
            fingerprintVersion: FINGERPRINT_VERSION,
            groupName,
            namespace,
          });
          wasZero = r.wasZero;
          incrementedFps.push(fp);
        } catch (err) {
          await rollback();
          throw err;
        }
      }
      if (wasZero) {
        const recGroup = generateRecordingGroupForFingerprint({
          fingerprint: fp,
          sli: representative.sli,
          objectiveLatencyThreshold: representative.latencyThreshold,
        });
        if (recGroup) {
          const provenance = buildRecordingProvenance({
            pluginVersion: this.pluginVersion,
            fingerprint: fp,
            fingerprintVersion: FINGERPRINT_VERSION,
            sliSnapshot: representative.sli,
          });
          const annotated = annotateRecordingGroup(recGroup, provenance);
          try {
            await deploy.ruler.upsertRuleGroup(
              deploy.client,
              deploy.datasource,
              namespace,
              annotated
            );
            createdRecordingGroups.push(fp);
          } catch (err) {
            await rollback();
            throw err;
          }
        }
      }
    }

    const updated: SloDocument = {
      id: existing.id,
      spec: merged,
      status: {
        ...existing.status,
        version: existing.status.version + 1,
        updatedAt: now,
        updatedBy,
        provisioning:
          existing.status.provisioning.backend === 'prometheus'
            ? {
                ...existing.status.provisioning,
                ruleGroupName: alertGroupName,
                rulerNamespace: namespace,
                recordingFingerprints: newFingerprints,
                alertGroupName,
                needsRedeploy: false,
              }
            : existing.status.provisioning,
      },
    };

    // Upsert alert group with fresh provenance.
    const alertGroup = buildAlertGroupWithProvenance(
      updated,
      newFingerprints,
      deploy.workspaceId,
      deploy.datasource.id,
      this.pluginVersion,
      existing.status.createdAt,
      now
    );
    if (updated.status.provisioning.backend === 'prometheus') {
      updated.status.provisioning.generatedRuleNames = extractGeneratedRuleNames(alertGroup);
    }
    try {
      await deploy.ruler.upsertRuleGroup(deploy.client, deploy.datasource, namespace, alertGroup);
    } catch (err) {
      await rollback();
      throw err;
    }

    try {
      await this.store.save(updated);
    } catch (saveErr) {
      await rollback();
      throw saveErr;
    }

    // Drop path: decrement refs for fps this SLO no longer references.
    // Recording-group deletion is deferred — the reconciler's grace-period
    // sweep (W3.11) handles zero-ref cleanups. Synchronous delete here would
    // race concurrent creates that bump the ref back up.
    if (this.refStore) {
      for (const fp of toDrop) {
        try {
          await this.refStore.decrementRef({
            workspaceId: deploy.workspaceId,
            datasourceId: deploy.datasource.id,
            fingerprint: fp,
          });
        } catch (err) {
          this.logger.warn(
            `SloService: decrementRef failed for fingerprint=${fp}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    this.statusCache.delete(updated.id);
    this.logger.info(`Updated SLO (dedup): ${updated.id} → v${updated.status.version}`);
    return updated;
  }

  /**
   * Tear down an SLO.
   *
   * W1.9 note: the ruler-side `deleteRuleGroup` is 404-tolerant (W1.1 made it
   * so) — if the rule group was already removed out-of-band (someone DELETE'd
   * it in Cortex directly, or the reconciler swept an orphan), the ruler call
   * resolves successfully and we proceed to remove the SO. This keeps a live
   * out-of-band delete from wedging the SO in an un-deletable state. Any
   * other ruler failure (auth, 5xx, network) still propagates and leaves the
   * SO intact so the user can retry.
   */
  async delete(
    id: string,
    deploy?: SloDeployContext
  ): Promise<{ deleted: boolean; generatedRuleNames: string[] }> {
    const existing = await this.store.get(id);
    if (!existing) return { deleted: false, generatedRuleNames: [] };

    const provisioning = existing.status.provisioning;
    const isDedupSo =
      provisioning.backend === 'prometheus' &&
      (provisioning.recordingFingerprints !== undefined ||
        (typeof provisioning.alertGroupName === 'string' && provisioning.alertGroupName.length > 0));

    // Phase 3 dedup path: tear down the per-SLO alert group, decrement refs,
    // but never synchronously delete a shared recording group — the
    // reconciler's grace-period sweep (W3.11) owns recording-group cleanup.
    if (this.dedupEnabled && isDedupSo) {
      if (!deploy) {
        throw new SloRulerTeardownRequiredError(id, existing.spec.datasourceId);
      }
      return this.deleteDedup(existing, deploy);
    }

    const needsRulerTeardown =
      provisioning.backend === 'prometheus' && !!provisioning.ruleGroupName;

    // Ruler-first, SO-second. If the ruler delete fails (network, auth, Cortex
    // 5xx), the SO stays so the user can retry — better than silently leaking
    // a rule group that keeps evaluating dead alerts. The caller is required
    // to supply `deploy` whenever the SLO has a rule group; the route adapter
    // enforces this by surfacing an unresolvable-datasource error to the user.
    // 404s from the ruler are swallowed by the RulerClient itself (W1.1 +
    // W1.9), so an out-of-band group deletion never blocks SO teardown.
    if (needsRulerTeardown) {
      if (!deploy) {
        throw new SloRulerTeardownRequiredError(id, existing.spec.datasourceId);
      }
      // `needsRulerTeardown` gated on the prometheus branch + a non-empty
      // ruleGroupName; re-narrow explicitly because the branch predicate
      // doesn't propagate through an intermediate boolean.
      if (provisioning.backend === 'prometheus' && provisioning.ruleGroupName) {
        const namespace = provisioning.rulerNamespace || SLO_RULER_NAMESPACE;
        await deploy.ruler.deleteRuleGroup(
          deploy.client,
          deploy.datasource,
          namespace,
          provisioning.ruleGroupName
        );
      }
    }

    await this.store.delete(id);
    this.statusCache.delete(id);

    const names =
      provisioning.backend === 'prometheus' ? provisioning.generatedRuleNames : [];

    this.logger.info(`Deleted SLO: ${id}`);
    return { deleted: true, generatedRuleNames: names };
  }

  // ---------- delete (dedup path, W3.8) ----------

  /**
   * Phase 3 dedup delete.
   *
   * Order of operations, chosen so a ruler or store failure leaves the
   * cluster in a recoverable state:
   *
   *   1. Delete the per-SLO alert group from the ruler first. If this fails
   *      (5xx / auth), abort — the SO is left in place so the user can
   *      retry. 404s are swallowed by the ruler client itself.
   *   2. Delete the SO.
   *   3. Decrement every fingerprint ref the SLO claimed. Failures here are
   *      logged but do NOT throw — the SO is already gone; surfacing a ref-
   *      store error to the caller would be a worse UX than waiting for the
   *      reconciler's dangling-ref sweep to reconcile eventually (W3.11).
   *
   * Recording groups are never deleted synchronously, even at refcount=0.
   * The reconciler's grace-period sweep owns that path so a concurrent
   * create for the same fingerprint doesn't race us.
   */
  private async deleteDedup(
    existing: SloDocument,
    deploy: SloDeployContext
  ): Promise<{ deleted: boolean; generatedRuleNames: string[] }> {
    if (existing.status.provisioning.backend !== 'prometheus') {
      return { deleted: false, generatedRuleNames: [] };
    }
    const provisioning = existing.status.provisioning;
    const namespace = provisioning.rulerNamespace || sloRulerNamespaceFor(deploy.workspaceId);
    const alertGroupName =
      provisioning.alertGroupName ||
      dedupAlertGroupName(existing.spec.name, deploy.workspaceId, existing.id);

    await deploy.ruler.deleteRuleGroup(
      deploy.client,
      deploy.datasource,
      namespace,
      alertGroupName
    );

    await this.store.delete(existing.id);
    this.statusCache.delete(existing.id);

    const fingerprints = provisioning.recordingFingerprints ?? {};
    const uniqueFps = uniqueValues(fingerprints);
    if (this.refStore) {
      for (const fp of uniqueFps) {
        try {
          await this.refStore.decrementRef({
            workspaceId: deploy.workspaceId,
            datasourceId: deploy.datasource.id,
            fingerprint: fp,
          });
        } catch (err) {
          this.logger.warn(
            `SloService: delete decrementRef failed for fingerprint=${fp}: ${
              err instanceof Error ? err.message : String(err)
            }. Reconciler sweep will reconcile.`
          );
        }
      }
    }

    this.logger.info(`Deleted SLO (dedup): ${existing.id}`);
    return { deleted: true, generatedRuleNames: provisioning.generatedRuleNames };
  }

  // ---------- repair (W1.5) ----------

  /**
   * Bring a drifted SLO back to parity with its expected rule groups.
   *
   * Algorithm:
   *   1. Load the SO; throw `SloNotFoundError` if missing (route → 404).
   *   2. Compute expected groups from `status.provisioning`. Phase 1 stores a
   *      single `ruleGroupName` — wrap it in a one-element array. The shape
   *      generalizes directly to Phase 3's recording/alert split.
   *   3. Probe current rule health via the injected checker.
   *   4. If healthy (`state === 'ok'`), return `{ repaired: false, health }`
   *      without touching the ruler. Idempotent — repeat calls are cheap.
   *   5. If `ruler_unreachable`, throw `SloRulerError` with the probe's
   *      reported code (defaulting to `RULER_UNREACHABLE`) so the route
   *      adapter maps it to a 502 / upstream-gateway response.
   *   6. Otherwise (`rules_missing` / `rules_partial`) regenerate the group
   *      from the doc, upsert via the ruler, invalidate the health cache,
   *      re-probe, and return the post-repair snapshot with `repaired: true`.
   */
  async repair(id: string, ctx: SloRepairContext): Promise<SloRepairResult> {
    const doc = await this.store.get(id);
    if (!doc) throw new SloNotFoundError(id);

    const expectedGroups = deriveExpectedGroups(doc);
    const namespace =
      doc.status.provisioning.backend === 'prometheus'
        ? doc.status.provisioning.rulerNamespace || sloRulerNamespaceFor(ctx.deploy.workspaceId)
        : sloRulerNamespaceFor(ctx.deploy.workspaceId);

    const pre = await ctx.health.check({
      workspaceId: ctx.deploy.workspaceId,
      datasource: ctx.deploy.datasource,
      client: ctx.deploy.client,
      sloId: doc.id,
      namespace,
      expectedGroups,
    });

    if (pre.state === 'ok') {
      return { sloId: doc.id, repaired: false, health: pre };
    }

    if (pre.state === 'ruler_unreachable') {
      // Surface via SloRulerError so the existing route mapping (toSloError in
      // handlers.ts) translates to the right HTTP status. We prefer reusing
      // the existing typed error rather than introducing a new one — the
      // plan explicitly keeps `slo_errors.ts` out of scope for this WS.
      const code = pre.rulerErrorCode ?? 'RULER_UNREACHABLE';
      const rawBody = `Rule-health probe reported ruler_unreachable for SLO ${doc.id}`;
      throw new SloRulerError(code, 0, rawBody);
    }

    // Regenerate the group from the doc and re-upsert. Generation is pure, so
    // the recomputed group is byte-equivalent to what the original create/
    // update issued — the upsert is effectively a replay.
    const group = generateSloRuleGroup(doc, { workspaceId: ctx.deploy.workspaceId });
    await ctx.deploy.ruler.upsertRuleGroup(
      ctx.deploy.client,
      ctx.deploy.datasource,
      namespace,
      group
    );

    ctx.health.invalidate(ctx.deploy.workspaceId, ctx.deploy.datasource.id, doc.id);

    const post = await ctx.health.check({
      workspaceId: ctx.deploy.workspaceId,
      datasource: ctx.deploy.datasource,
      client: ctx.deploy.client,
      sloId: doc.id,
      namespace,
      expectedGroups,
    });

    this.logger.info(
      `Repaired SLO: ${doc.id} (namespace=${namespace}, groups=${expectedGroups.join(',')})`
    );
    return { sloId: doc.id, repaired: true, health: post };
  }

  // ---------- enable / disable ----------

  async setEnabled(
    id: string,
    enabled: boolean,
    updatedBy = 'system',
    deploy?: SloDeployContext
  ): Promise<SloDocument> {
    const existing = await this.store.get(id);
    if (!existing) throw new SloNotFoundError(id);
    return this.update(
      id,
      { spec: { enabled }, version: existing.status.version },
      updatedBy,
      deploy
    );
  }

  /**
   * Compensation rollback for the ruler-OK / SO-fails edge case.
   * Best-effort: swallow errors so the original SO failure surfaces to the
   * caller unchanged. Reconciler (W3) covers the case where this itself fails.
   */
  private async safeRollback(
    deploy: SloDeployContext,
    namespace: string,
    groupName: string
  ): Promise<void> {
    try {
      await deploy.ruler.deleteRuleGroup(deploy.client, deploy.datasource, namespace, groupName);
      this.logger.info(
        `Ruler rollback succeeded for ${groupName} in ${namespace} (SO write failed)`
      );
    } catch (err) {
      this.logger.warn(
        `Ruler rollback failed for ${groupName} in ${namespace}: ${
          err instanceof Error ? err.message : String(err)
        }. Dangling rule group; reconciler will sweep.`
      );
    }
  }

  // ---------- preview ----------

  previewRules(input: SloCreateInput) {
    // Preview and deploy must see the same normalized spec (design §9(5): what
    // the user sees is what gets deployed). Clamp targets before validation.
    const spec = normalizeSpec(input.spec);
    const { errors } = validateSloSpec(spec);
    if (Object.keys(errors).length > 0) throw new SloValidationError(errors);

    const now = new Date().toISOString();
    const id = input.id ?? 'slo-preview-00000000-0000-0000-0000-000000000000';
    const doc: SloDocument = {
      id,
      spec,
      status: {
        version: 0,
        createdAt: now,
        createdBy: 'preview',
        updatedAt: now,
        updatedBy: 'preview',
        provisioning: {
          backend: 'prometheus',
          ruleGroupName: '',
          rulerNamespace: SLO_RULER_NAMESPACE,
          generatedRuleNames: [],
        },
      },
    };
    return generateSloRuleGroup(doc);
  }

  // ---------- listing ----------

  async list(filters?: SloListFilters, ctx?: SloStatusAggregationContext): Promise<SloSummary[]> {
    const all = await this.store.list(filters?.datasourceId);
    // `store.list` already OR-filtered by `filters.datasourceId` — if for any
    // reason the store ignored it (test doubles, future backends), belt-and-
    // braces filter again in memory so the contract stays consistent.
    const dsFiltered =
      filters?.datasourceId && filters.datasourceId.length > 0
        ? all.filter((d) => filters.datasourceId!.includes(d.spec.datasourceId))
        : all;

    let filtered = dsFiltered;

    if (filters?.enabled !== undefined) {
      filtered = filtered.filter((d) => d.spec.enabled === filters.enabled);
    }
    if (filters?.mode && filters.mode.length > 0) {
      filtered = filtered.filter((d) => filters.mode!.includes(d.spec.mode));
    }
    if (filters?.service && filters.service.length > 0) {
      filtered = filtered.filter((d) => filters.service!.includes(d.spec.service));
    }
    if (filters?.team && filters.team.length > 0) {
      filtered = filtered.filter((d) => d.spec.owner.teams.some((t) => filters.team!.includes(t)));
    }
    if (filters?.tier && filters.tier.length > 0) {
      filtered = filtered.filter((d) => d.spec.tier && filters.tier!.includes(d.spec.tier));
    }
    if (filters?.sliBackend && filters.sliBackend.length > 0) {
      filtered = filtered.filter(
        (d) =>
          d.spec.sli.type === 'single' &&
          filters.sliBackend!.includes(d.spec.sli.definition.backend)
      );
    }
    if (filters?.sliLeafType && filters.sliLeafType.length > 0) {
      filtered = filtered.filter(
        (d) =>
          d.spec.sli.type === 'single' && filters.sliLeafType!.includes(d.spec.sli.definition.type)
      );
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.spec.name.toLowerCase().includes(q) ||
          d.spec.service.toLowerCase().includes(q) ||
          (d.spec.description?.toLowerCase().includes(q) ?? false)
      );
    }

    // Get statuses for all filtered SLOs
    const ids = filtered.map((d) => d.id);
    const statuses = await this.getStatuses(ids, ctx);
    const statusMap = new Map(statuses.map((s) => [s.sloId, s]));

    // State filter applied last so we don't pay for status computation on filtered-out rows.
    if (filters?.state && filters.state.length > 0) {
      filtered = filtered.filter((d) => {
        const s = statusMap.get(d.id);
        return s && filters.state!.includes(s.state);
      });
    }

    return filtered.map((d) => this.toSummary(d, statusMap.get(d.id) ?? this.noDataStatus(d)));
  }

  async getPaginated(
    filters?: SloListFilters,
    ctx?: SloStatusAggregationContext
  ): Promise<PaginatedResponse<SloSummary>> {
    const page = filters?.page ?? 1;
    const pageSize = Math.min(filters?.pageSize ?? 20, 100);
    const all = await this.list(filters, ctx);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return {
      results: all.slice(start, end),
      total: all.length,
      page,
      pageSize,
      hasMore: end < all.length,
    };
  }

  // ---------- live status ----------

  async getStatus(id: string, ctx?: SloStatusAggregationContext): Promise<SloLiveStatus> {
    const [s] = await this.getStatuses([id], ctx);
    return s;
  }

  /**
   * Batch status lookup. When a status-aggregation context is provided AND an
   * aggregator is configured, cache misses go to the live aggregator.
   * Aggregator failures are trapped — the listing page must not 500 when the
   * ruler is unreachable. Failed lookups fall through to the stub so at
   * minimum we return the disabled/no-data skeleton the UI can render.
   *
   * Call order is preserved: `out[i]` corresponds to `ids[i]`.
   */
  async getStatuses(ids: string[], ctx?: SloStatusAggregationContext): Promise<SloLiveStatus[]> {
    const now = Date.now();
    const result = new Map<string, SloLiveStatus>();
    const uncached: string[] = [];
    for (const id of ids) {
      const entry = this.statusCache.get(id);
      if (entry && entry.expiresAt > now) {
        result.set(id, entry.status);
      } else {
        uncached.push(id);
      }
    }
    if (uncached.length === 0) {
      return ids.map((id) => result.get(id) ?? this.missingStatus(id));
    }

    const docs = await Promise.all(uncached.map((id) => this.store.get(id)));
    const presentDocs: SloDocument[] = [];
    const missing: string[] = [];
    for (let i = 0; i < uncached.length; i++) {
      const doc = docs[i];
      if (doc) presentDocs.push(doc);
      else missing.push(uncached[i]);
    }
    for (const id of missing) result.set(id, this.missingStatus(id));

    if (presentDocs.length > 0) {
      let statuses: SloLiveStatus[] | null = null;
      if (this.aggregator && ctx) {
        try {
          statuses = await this.aggregator.aggregate(presentDocs, ctx);
        } catch (err) {
          // Catastrophic aggregator failure — fall through to stub. One warn
          // per distinct failure message (not per-SLO) to avoid log spam.
          this.warnAggregatorFailure('__batch__', err);
          statuses = null;
        }
      }
      for (let i = 0; i < presentDocs.length; i++) {
        const doc = presentDocs[i];
        const status = statuses ? statuses[i] : this.computeStatus(doc);
        result.set(doc.id, status);
      }
    }

    for (const id of uncached) {
      const status = result.get(id);
      if (status) this.statusCache.set(id, { status, expiresAt: now + STATUS_CACHE_TTL_MS });
    }

    return ids.map((id) => result.get(id) ?? this.missingStatus(id));
  }

  private warnAggregatorFailure(sloId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const key = `${sloId}:${msg}`;
    if (this.loggedAggregatorFailures.has(key)) return;
    this.loggedAggregatorFailures.add(key);
    this.logger.warn(
      `SloService: aggregator rejected (slo=${sloId}): ${msg}. Falling back to stub status.`
    );
  }

  /**
   * P0 placeholder: live ruler queries are handled by a follow-up aggregator.
   * Returns:
   *   - 'disabled' when spec.enabled is false
   *   - 'no_data' otherwise, with a full error budget and no measurements
   *
   * Rule count is derived from the persisted generatedRuleNames[] so the
   * listing UI can still show "X rules provisioned" without hitting the ruler.
   */
  private computeStatus(doc: SloDocument): SloLiveStatus {
    const state: SloHealthState = doc.spec.enabled ? 'no_data' : 'disabled';

    const objectiveStatuses: ObjectiveStatus[] = doc.spec.objectives.map((obj) => ({
      objectiveName: obj.name,
      currentValue: 0,
      currentValueUnit: inferUnit(doc),
      attainment: 0,
      errorBudgetRemaining: 1,
      state,
    }));
    const ruleCount =
      doc.status.provisioning.backend === 'prometheus'
        ? doc.status.provisioning.generatedRuleNames.length
        : 0;
    return {
      sloId: doc.id,
      objectives: objectiveStatuses,
      state,
      firingCount: 0,
      ruleCount,
      computedAt: new Date().toISOString(),
    };
  }

  private noDataStatus(doc: SloDocument): SloLiveStatus {
    return this.computeStatus(doc);
  }

  private missingStatus(sloId: string): SloLiveStatus {
    return {
      sloId,
      objectives: [],
      state: 'no_data',
      firingCount: 0,
      ruleCount: 0,
      computedAt: new Date().toISOString(),
    };
  }

  // ---------- helpers ----------

  private async assertNameUnique(
    datasourceId: string,
    name: string,
    excludeId: string | null
  ): Promise<void> {
    const peers = await this.store.list([datasourceId]);
    const conflict = peers.find(
      (p) => p.spec.name === name && (excludeId === null || p.id !== excludeId)
    );
    if (conflict) {
      throw new SloValidationError({
        'spec.name': `An SLO named "${name}" already exists for this datasource`,
      });
    }
  }

  private toSummary(doc: SloDocument, status: SloLiveStatus): SloSummary {
    const single = doc.spec.sli.type === 'single' ? doc.spec.sli : null;
    const worstTarget =
      doc.spec.objectives.length > 0
        ? doc.spec.objectives.reduce((acc, o) => Math.max(acc, o.target), 0)
        : 0;
    const dims: Dimension[] | undefined = single?.dimensions;
    return {
      id: doc.id,
      datasourceId: doc.spec.datasourceId,
      // datasourceType is a registry lookup; default to prometheus in P0.
      datasourceType: 'prometheus',
      name: doc.spec.name,
      description: doc.spec.description,
      enabled: doc.spec.enabled,
      mode: doc.spec.mode,
      service: doc.spec.service,
      owner: doc.spec.owner,
      tier: doc.spec.tier,
      sliNodeType: doc.spec.sli.type,
      sliBackend: single?.definition.backend,
      sliLeafType:
        single?.definition.backend === 'prometheus'
          ? single.definition.type
          : single?.definition.type,
      dimensions: dims,
      objectiveCount: doc.spec.objectives.length,
      worstTarget,
      window: doc.spec.window,
      labels: doc.spec.labels,
      status,
    };
  }
}

function inferUnit(doc: SloDocument): 'ratio' | 'seconds' | 'count' {
  if (doc.spec.sli.type !== 'single') return 'ratio';
  const def = doc.spec.sli.definition;
  if (def.backend === 'prometheus' && def.type === 'latency_threshold') return 'seconds';
  return 'ratio';
}

/**
 * Normalize an incoming SloSpec into its canonical persisted shape.
 *
 * Rules:
 *   - Each objective's `target` is clamped to 6 significant digits
 *     (design §3.2, §13.1: `target ∈ [0.5, 0.99999]`, clamped pre-rule-gen).
 *     Done here — not in the validator — because validators must stay pure.
 *
 * Pure; safe to call more than once (idempotent on an already-clamped spec).
 */
function normalizeSpec<T extends Partial<SloSpec>>(spec: T): T {
  if (!Array.isArray(spec.objectives)) return spec;
  const clamped = spec.objectives.map((obj) => {
    if (typeof obj.target !== 'number' || !Number.isFinite(obj.target)) return obj;
    return { ...obj, target: Math.round(obj.target * 1e6) / 1e6 };
  });
  return { ...spec, objectives: clamped };
}

/**
 * Derive the list of ruler group names an SLO expects to see on the ruler.
 *
 * Phase 1 stores a single `ruleGroupName`; we wrap it in a one-element array
 * so the rule-health probe (designed for arbitrary-length expected sets) can
 * consume it directly. Phase 3 dedup splits into one shared recording group
 * per fingerprint plus a per-SLO alert group — both shapes are returned from
 * the union of `recordingFingerprints` + `alertGroupName` with a fallback to
 * `ruleGroupName` when the dedup fields are absent (pre-migration docs and
 * flag-off path).
 *
 * Non-prometheus backends (reserved) return [] — nothing to probe.
 */
export function deriveExpectedGroups(doc: SloDocument): string[] {
  if (doc.status.provisioning.backend !== 'prometheus') return [];
  const p = doc.status.provisioning;
  const names: string[] = [];
  if (p.recordingFingerprints) {
    for (const fp of new Set(Object.values(p.recordingFingerprints))) {
      names.push(dedupRecordingGroupName(fp));
    }
  }
  if (p.alertGroupName) {
    names.push(p.alertGroupName);
  } else if (p.ruleGroupName) {
    // Legacy (flag-off) path — single monolithic group.
    names.push(p.ruleGroupName);
  }
  return names;
}

/**
 * Phase 3 helper — unique set of values from a Record. Order stable across
 * calls because `new Set(Object.values(...))` preserves insertion order.
 */
function uniqueValues(map: Record<string, string>): string[] {
  return [...new Set(Object.values(map))];
}

/**
 * Phase 3 helper — pick any objective that maps to the given fingerprint, so
 * we have a representative `SingleSli` + optional `latencyThreshold` to hand
 * to `generateRecordingGroupForFingerprint`. Returns null when the SLI is
 * composite / OpenSearch-backed (no fingerprint → no representative).
 */
function pickRepresentativeForFingerprint(
  spec: SloSpec,
  recordingFingerprints: Record<string, string>,
  fingerprint: string
): { sli: import('./slo_types').SingleSli; latencyThreshold?: number } | null {
  if (spec.sli.type !== 'single') return null;
  for (const objective of spec.objectives) {
    if (recordingFingerprints[objective.name] === fingerprint) {
      return { sli: spec.sli, latencyThreshold: objective.latencyThreshold };
    }
  }
  return null;
}

/**
 * Build the per-SLO alert group with provenance annotations, inserting the
 * W3.3 sentinel alert when the group would otherwise be empty (shadow mode or
 * all burn-rate tiers disabled). Pure, apart from the clock — callers pass
 * `createdAt` and `updatedAt` explicitly so tests can pin provenance values.
 */
function buildAlertGroupWithProvenance(
  doc: SloDocument,
  recordingFingerprints: Record<string, string>,
  workspaceId: string,
  datasourceId: string,
  pluginVersion: string,
  createdAt: string,
  updatedAt: string = createdAt
): GeneratedRuleGroup {
  const group = generateAlertGroupFor(doc, recordingFingerprints, { workspaceId });
  const provenance = buildAlertProvenance({
    pluginVersion,
    sloId: doc.id,
    workspaceId,
    datasourceId,
    createdAt,
    updatedAt,
    spec: doc.spec,
  });
  if (group.rules.length === 0) {
    const sentinel = buildSentinelAlert(doc.id, provenance);
    return annotateAlertGroup({ ...group, rules: [sentinel] }, provenance);
  }
  return annotateAlertGroup(group, provenance);
}

/**
 * RFC 4122 v4 UUID — crypto-safe if `crypto.randomUUID()` is available
 * (Node 14.17+ / modern browsers), falls back to Math.random otherwise.
 */
function generateUuidV4(): string {
  const g = (globalThis as unknown) as {
    crypto?: { randomUUID?: () => string };
  };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  const hex = '0123456789abcdef';
  let out = '';
  /* eslint-disable no-bitwise */
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      // RFC 4122 variant bits: %10xx — clamp to 8..11.
      out += hex[Math.floor(Math.random() * 4) | 0 | 8];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  /* eslint-enable no-bitwise */
  return out;
}
