/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * use_alerts_facets — server-side facet counts for the Alerts page (Phase 5).
 *
 * Mirrors `use_alerts.ts`'s monotonic-request-id + AbortController guard, but
 * adds a 200ms internal debounce. The facet panel is read-only and can lag
 * the listing by a frame; coalescing rapid filter clicks (sliding through
 * severity options) avoids three sequential cache-miss calls in the worst
 * case.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertFacetCountsResponse,
  AlertingOpenSearchService,
} from '../query_services/alerting_opensearch_service';

export interface UseAlertsFacetsParams {
  dsIds: string[];
  startTime?: string;
  endTime?: string;
  severity?: string[];
  state?: string[];
  backend?: string[];
  labels?: Record<string, string[]>;
  search?: string;
  refreshToken?: unknown;
}

export interface UseAlertsFacetsResult {
  data: AlertFacetCountsResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const FACET_DEBOUNCE_MS = 200;

export function useAlertsFacets(params: UseAlertsFacetsParams): UseAlertsFacetsResult {
  const {
    dsIds,
    startTime,
    endTime,
    severity,
    state,
    backend,
    labels,
    search,
    refreshToken,
  } = params;
  const service = useMemo(() => new AlertingOpenSearchService(), []);
  const [data, setData] = useState<AlertFacetCountsResponse | null>(null);
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
  const severityKey = severity ? severity.join(',') : '';
  const stateKey = state ? state.join(',') : '';
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
          const res = await service.listAlertFacets({
            dsIds,
            startTime,
            endTime,
            severity,
            state,
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
    startTime,
    endTime,
    refreshToken,
    localRefresh,
    severityKey,
    stateKey,
    backendKey,
    labelsKey,
    search,
  ]);

  return { data, isLoading, error, refetch };
}
