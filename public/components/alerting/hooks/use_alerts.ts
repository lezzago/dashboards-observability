/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * use_alerts — unified alerts across selected datasources.
 *
 * Wraps `AlertingOpenSearchService.listAlerts`. The hook surface is
 * polymorphic on the `page` param:
 *   - `page` absent  ⇒ legacy `ProgressiveResponse<UnifiedAlertSummary>`,
 *     full set up to `maxResults`, no `total`/`hasMore`. Phase 0–3 callers.
 *   - `page` present ⇒ `PaginatedResponse<UnifiedAlertSummary>` (Phase 4),
 *     server-side filter + pagination. Caller drives the table from
 *     `data.results` + `data.total`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PaginatedResponse,
  ProgressiveResponse,
  UnifiedAlertSummary,
} from '../../../../common/types/alerting';
import { AlertingOpenSearchService } from '../query_services/alerting_opensearch_service';

export interface UseAlertsParams {
  dsIds: string[];
  /** Date-math string (e.g. "now-1h"). */
  startTime?: string;
  /** Date-math string (e.g. "now"). */
  endTime?: string;
  /** Bumping this re-issues the request and bypasses the server-side cache. */
  refreshToken?: unknown;

  // Phase 4 — server-side pagination + filter
  page?: number;
  pageSize?: number;
  sort?: string;
  severity?: string[];
  state?: string[];
  backend?: string[];
  labels?: Record<string, string[]>;
  search?: string;
}

export type AlertsResponse =
  | ProgressiveResponse<UnifiedAlertSummary>
  | PaginatedResponse<UnifiedAlertSummary>;

export interface UseAlertsResult {
  data: AlertsResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useAlerts(params: UseAlertsParams): UseAlertsResult {
  const {
    dsIds,
    startTime,
    endTime,
    refreshToken,
    page,
    pageSize,
    sort,
    severity,
    state,
    backend,
    labels,
    search,
  } = params;
  const service = useMemo(() => new AlertingOpenSearchService(), []);
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const refetch = useCallback(() => setLocalRefresh((t) => t + 1), []);

  const lastRequestIdRef = useRef(0);
  // Track previous values so we can detect a "force-fresh" intent (refresh
  // button click or `refetch()` call) — that's when we set `noCache: true`
  // so the server-side 30s listing cache is bypassed for this request.
  const prevRefreshTokenRef = useRef(refreshToken);
  const prevLocalRefreshRef = useRef(localRefresh);
  const isForceFresh =
    prevRefreshTokenRef.current !== refreshToken || prevLocalRefreshRef.current !== localRefresh;
  prevRefreshTokenRef.current = refreshToken;
  prevLocalRefreshRef.current = localRefresh;

  // Stable string projections of array/object deps so the effect only
  // re-fires when the serialized value actually changes.
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
    const requestId = ++lastRequestIdRef.current;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await service.listAlerts({
          dsIds,
          startTime,
          endTime,
          page,
          pageSize,
          sort,
          severity,
          state,
          backend,
          labels,
          search,
          // refreshToken bumps and `refetch()` calls signal a "force-fresh"
          // intent — pass through so the server bypasses its 30s listing
          // cache. The initial mount and ordinary filter / page changes
          // don't set this.
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
    return () => {
      controller.abort();
    };
    // Stable string-key deps so the effect doesn't re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    service,
    dsIdsKey,
    startTime,
    endTime,
    refreshToken,
    localRefresh,
    page,
    pageSize,
    sort,
    severityKey,
    stateKey,
    backendKey,
    labelsKey,
    search,
  ]);

  return { data, isLoading, error, refetch };
}
