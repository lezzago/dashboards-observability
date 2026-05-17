/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * use_rules_facets — server-side facet counts for the Rules page (Phase 5).
 * Same pattern as `use_alerts_facets` (200ms debounce, monotonic
 * request id, AbortController), but with the rule-table dimensions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertingOpenSearchService,
  RuleFacetCountsResponse,
} from '../query_services/alerting_opensearch_service';

export interface UseRulesFacetsParams {
  dsIds: string[];
  status?: string[];
  severity?: string[];
  monitorType?: string[];
  healthStatus?: string[];
  createdBy?: string[];
  backend?: string[];
  labels?: Record<string, string[]>;
  search?: string;
  refreshToken?: unknown;
}

export interface UseRulesFacetsResult {
  data: RuleFacetCountsResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const FACET_DEBOUNCE_MS = 200;

export function useRulesFacets(params: UseRulesFacetsParams): UseRulesFacetsResult {
  const {
    dsIds,
    status,
    severity,
    monitorType,
    healthStatus,
    createdBy,
    backend,
    labels,
    search,
    refreshToken,
  } = params;
  const service = useMemo(() => new AlertingOpenSearchService(), []);
  const [data, setData] = useState<RuleFacetCountsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const refetch = useCallback(() => setLocalRefresh((t) => t + 1), []);

  const lastRequestIdRef = useRef(0);
  const prevRefreshTokenRef = useRef(refreshToken);
  const prevLocalRefreshRef = useRef(localRefresh);
  const isForceFresh =
    prevRefreshTokenRef.current !== refreshToken || prevLocalRefreshRef.current !== localRefresh;
  prevRefreshTokenRef.current = refreshToken;
  prevLocalRefreshRef.current = localRefresh;

  const dsIdsKey = dsIds.join(',');
  const statusKey = status ? status.join(',') : '';
  const severityKey = severity ? severity.join(',') : '';
  const monitorTypeKey = monitorType ? monitorType.join(',') : '';
  const healthStatusKey = healthStatus ? healthStatus.join(',') : '';
  const createdByKey = createdBy ? createdBy.join(',') : '';
  const backendKey = backend ? backend.join(',') : '';
  const labelsKey = useMemo(() => (labels ? JSON.stringify(labels) : ''), [labels]);

  useEffect(() => {
    if (dsIds.length === 0) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    const debounce = setTimeout(() => {
      const requestId = ++lastRequestIdRef.current;
      setIsLoading(true);
      setError(null);
      (async () => {
        try {
          const res = await service.listRuleFacets({
            dsIds,
            // The server treats `state` as the unified-listing field,
            // mapping to monitor `status` in the rules path.
            state: status,
            severity,
            monitorType,
            healthStatus,
            createdBy,
            backend,
            labels,
            search,
            noCache: isForceFresh ? true : undefined,
            signal: controller.signal,
          });
          if (requestId !== lastRequestIdRef.current) return;
          setData(res);
        } catch (e) {
          if (requestId !== lastRequestIdRef.current) return;
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setError(e instanceof Error ? e : new Error(String(e)));
        } finally {
          if (requestId === lastRequestIdRef.current) setIsLoading(false);
        }
      })();
    }, FACET_DEBOUNCE_MS);
    return () => {
      clearTimeout(debounce);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    service,
    dsIdsKey,
    refreshToken,
    localRefresh,
    statusKey,
    severityKey,
    monitorTypeKey,
    healthStatusKey,
    createdByKey,
    backendKey,
    labelsKey,
    search,
  ]);

  return { data, isLoading, error, refetch };
}
