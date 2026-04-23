/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin HTTP client for the SLO routes registered at
 * `${OBSERVABILITY_BASE}/v1/slos`. Uses core.http so basepath + XSRF are
 * handled by OSD.
 */

import type { HttpStart } from '../../../../../../../src/core/public';
import type { PaginatedResponse } from '../../../../../common/types/alerting/types';
import { OBSERVABILITY_BASE } from '../../../../../common/constants/shared';
import type {
  GeneratedRuleGroup,
  SloCreateInput,
  SloDocument,
  SloLiveStatus,
  SloListFilters,
  SloSummary,
  SloUpdateInput,
} from '../../../../../common/slo/slo_types';

const SLO_BASE = `${OBSERVABILITY_BASE}/v1/slos`;

/** Convert filter array/boolean fields to the string form the server expects. */
function serializeFilters(filters: SloListFilters): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  if (filters.page !== undefined) query.page = filters.page;
  if (filters.pageSize !== undefined) query.pageSize = filters.pageSize;
  if (filters.datasourceId) query.datasourceId = filters.datasourceId;
  if (filters.state?.length) query.state = filters.state.join(',');
  if (filters.sliBackend?.length) query.sliBackend = filters.sliBackend.join(',');
  if (filters.sliLeafType?.length) query.sliLeafType = filters.sliLeafType.join(',');
  if (filters.service?.length) query.service = filters.service.join(',');
  if (filters.team?.length) query.team = filters.team.join(',');
  if (filters.tier?.length) query.tier = filters.tier.join(',');
  if (filters.enabled !== undefined) query.enabled = String(filters.enabled);
  if (filters.mode?.length) query.mode = filters.mode.join(',');
  if (filters.search) query.search = filters.search;
  return query;
}

export class SloApiClient {
  constructor(private readonly http: HttpStart) {}

  list(filters: SloListFilters = {}): Promise<PaginatedResponse<SloSummary>> {
    return this.http.get(SLO_BASE, { query: serializeFilters(filters) });
  }

  get(id: string): Promise<SloDocument & { liveStatus: SloLiveStatus }> {
    return this.http.get(`${SLO_BASE}/${encodeURIComponent(id)}`);
  }

  create(input: SloCreateInput): Promise<SloDocument> {
    return this.http.post(SLO_BASE, { body: JSON.stringify(input) });
  }

  update(id: string, input: SloUpdateInput): Promise<SloDocument> {
    return this.http.put(`${SLO_BASE}/${encodeURIComponent(id)}`, {
      body: JSON.stringify(input),
    });
  }

  delete(id: string): Promise<{ deleted: boolean; generatedRuleNames: string[] }> {
    return this.http.delete(`${SLO_BASE}/${encodeURIComponent(id)}`);
  }

  enable(id: string): Promise<SloDocument> {
    return this.http.post(`${SLO_BASE}/${encodeURIComponent(id)}/enable`);
  }

  disable(id: string): Promise<SloDocument> {
    return this.http.post(`${SLO_BASE}/${encodeURIComponent(id)}/disable`);
  }

  preview(input: SloCreateInput): Promise<GeneratedRuleGroup> {
    return this.http.post(`${SLO_BASE}/preview`, { body: JSON.stringify(input) });
  }

  statuses(ids: string[]): Promise<{ statuses: SloLiveStatus[] }> {
    return this.http.post(`${SLO_BASE}/statuses`, { body: JSON.stringify({ ids }) });
  }
}
