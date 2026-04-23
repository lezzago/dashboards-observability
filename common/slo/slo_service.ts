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

import type { Logger, PaginatedResponse } from '../types/alerting/types';
import type {
  ISloStore,
  Dimension,
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
} from './slo_promql_generator';
import { validateSloSpec, validateSloId } from './slo_validators';
import { InMemorySloStore } from './slo_store';
import { SloNotFoundError, SloValidationError, SloVersionConflictError } from './slo_errors';

/** Status cache TTL — listing pages call the batch endpoint at this cadence. */
const STATUS_CACHE_TTL_MS = 60_000;

export { SloNotFoundError, SloValidationError, SloVersionConflictError };

// ============================================================================
// Service
// ============================================================================

export class SloService {
  private store: ISloStore;
  private statusCache = new Map<string, { status: SloLiveStatus; expiresAt: number }>();

  constructor(private readonly logger: Logger, store?: ISloStore) {
    this.store = store ?? new InMemorySloStore();
  }

  setStore(store: ISloStore): void {
    this.store = store;
    this.statusCache.clear();
    this.logger.info('SloService: storage backend replaced');
  }

  // ---------- CRUD ----------

  async create(input: SloCreateInput, createdBy = 'system'): Promise<SloDocument> {
    const { errors } = validateSloSpec(input.spec);
    if (Object.keys(errors).length > 0) throw new SloValidationError(errors);

    const id = input.id ?? generateUuidV4();
    if (input.id) {
      const slugErr = validateSloId(input.id);
      if (slugErr) throw new SloValidationError({ id: slugErr });
    }

    // Name uniqueness within the datasource (workspace scoping is handled by
    // the saved-objects layer; the name check is best-effort here).
    await this.assertNameUnique(input.spec.datasourceId, input.spec.name, null);

    const now = new Date().toISOString();
    // Build the document with minimal status so we can generate rules from it,
    // then fill in the provisioning record with the resulting names.
    const doc: SloDocument = {
      id,
      spec: input.spec,
      status: {
        version: 1,
        createdAt: now,
        createdBy,
        updatedAt: now,
        updatedBy: createdBy,
        provisioning: {
          backend: 'prometheus',
          ruleGroupName: '',
          rulerNamespace: SLO_RULER_NAMESPACE,
          generatedRuleNames: [],
        },
      },
    };

    const group = generateSloRuleGroup(doc);
    if (doc.status.provisioning.backend === 'prometheus') {
      doc.status.provisioning.ruleGroupName = group.groupName;
      doc.status.provisioning.generatedRuleNames = extractGeneratedRuleNames(group);
    }

    await this.store.save(doc);
    this.logger.info(
      `Created SLO: ${doc.id} (${doc.spec.name}) — ${group.rules.length} rules generated`
    );
    return doc;
  }

  async get(id: string): Promise<SloDocument | null> {
    return this.store.get(id);
  }

  async update(id: string, input: SloUpdateInput, updatedBy = 'system'): Promise<SloDocument> {
    const existing = await this.store.get(id);
    if (!existing) throw new SloNotFoundError(id);

    if (input.version !== existing.status.version) {
      throw new SloVersionConflictError(existing, input.version);
    }

    const merged: SloSpec = { ...existing.spec, ...input.spec };

    const { errors } = validateSloSpec(merged);
    if (Object.keys(errors).length > 0) throw new SloValidationError(errors);

    if (merged.name !== existing.spec.name) {
      await this.assertNameUnique(merged.datasourceId, merged.name, id);
    }

    const updated: SloDocument = {
      id: existing.id,
      spec: merged,
      status: {
        ...existing.status,
        version: existing.status.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy,
      },
    };

    const group = generateSloRuleGroup(updated);
    if (updated.status.provisioning.backend === 'prometheus') {
      updated.status.provisioning.ruleGroupName = group.groupName;
      updated.status.provisioning.generatedRuleNames = extractGeneratedRuleNames(group);
    }

    await this.store.save(updated);
    this.statusCache.delete(id);
    this.logger.info(`Updated SLO: ${id} → v${updated.status.version}`);
    return updated;
  }

  async delete(id: string): Promise<{ deleted: boolean; generatedRuleNames: string[] }> {
    const existing = await this.store.get(id);
    if (!existing) return { deleted: false, generatedRuleNames: [] };
    await this.store.delete(id);
    this.statusCache.delete(id);
    this.logger.info(`Deleted SLO: ${id}`);
    const names =
      existing.status.provisioning.backend === 'prometheus'
        ? existing.status.provisioning.generatedRuleNames
        : [];
    return { deleted: true, generatedRuleNames: names };
  }

  // ---------- enable / disable ----------

  async setEnabled(id: string, enabled: boolean, updatedBy = 'system'): Promise<SloDocument> {
    const existing = await this.store.get(id);
    if (!existing) throw new SloNotFoundError(id);
    return this.update(id, { spec: { enabled }, version: existing.status.version }, updatedBy);
  }

  // ---------- preview ----------

  previewRules(input: SloCreateInput) {
    const { errors } = validateSloSpec(input.spec);
    if (Object.keys(errors).length > 0) throw new SloValidationError(errors);

    const now = new Date().toISOString();
    const id = input.id ?? 'slo-preview-00000000-0000-0000-0000-000000000000';
    const doc: SloDocument = {
      id,
      spec: input.spec,
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

  async list(filters?: SloListFilters): Promise<SloSummary[]> {
    const all = await this.store.list(filters?.datasourceId);

    let filtered = all;

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
    const statuses = await this.getStatuses(ids);
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

  async getPaginated(filters?: SloListFilters): Promise<PaginatedResponse<SloSummary>> {
    const page = filters?.page ?? 1;
    const pageSize = Math.min(filters?.pageSize ?? 20, 100);
    const all = await this.list(filters);
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

  async getStatus(id: string): Promise<SloLiveStatus> {
    const [s] = await this.getStatuses([id]);
    return s;
  }

  async getStatuses(ids: string[]): Promise<SloLiveStatus[]> {
    const now = Date.now();
    const out: SloLiveStatus[] = [];
    const uncached: string[] = [];
    for (const id of ids) {
      const entry = this.statusCache.get(id);
      if (entry && entry.expiresAt > now) out.push(entry.status);
      else uncached.push(id);
    }
    if (uncached.length === 0) return out;

    const docs = await Promise.all(uncached.map((id) => this.store.get(id)));
    for (let i = 0; i < uncached.length; i++) {
      const doc = docs[i];
      const status = doc ? this.computeStatus(doc) : this.missingStatus(uncached[i]);
      this.statusCache.set(uncached[i], { status, expiresAt: now + STATUS_CACHE_TTL_MS });
      out.push(status);
    }
    return out;
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
    const peers = await this.store.list(datasourceId);
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
