/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * use_alerts_timeline — fetches the aggregated alerts timeline for the
 * AlertTimeline chart. Mirrors the abort + monotonic-request-id guard in
 * `use_alerts.ts` so picker churn / filter changes don't let stale
 * responses overwrite newer ones.
 *
 * The hook always sends `startTime`, `endTime`, and a derived `buckets`
 * count (via `pickBucketCount`). Filter state is forwarded as serialized
 * query params so the chart and the alerts table reflect the same slice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlertsTimelineResponse } from '../../../../common/types/alerting';
import { pickBucketCount } from '../../../../common/services/alerting/timeline_buckets';
import { parseDateMathMs } from '../../../../common/services/alerting/time_range';
import { AlertingOpenSearchService } from '../query_services/alerting_opensearch_service';

export interface UseAlertsTimelineParams {
  dsIds: string[];
  startTime?: string;
  endTime?: string;
  buckets?: number;
  severity?: string[];
  state?: string[];
  labels?: Record<string, string[]>;
  refreshToken?: unknown;
}

export interface UseAlertsTimelineResult {
  data: AlertsTimelineResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

function sortedJoin(values?: string[]): string {
  if (!values || values.length === 0) return '';
  return [...values].sort().join(',');
}

function canonicalLabelsKey(labels?: Record<string, string[]>): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return JSON.stringify(keys.map((k) => [k, [...labels[k]].sort()]));
}

export function useAlertsTimeline({
  dsIds,
  startTime,
  endTime,
  buckets,
  severity,
  state,
  labels,
  refreshToken,
}: UseAlertsTimelineParams): UseAlertsTimelineResult {
  const service = useMemo(() => new AlertingOpenSearchService(), []);
  const [data, setData] = useState<AlertsTimelineResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const refetch = useCallback(() => setLocalRefresh((t) => t + 1), []);
  const lastRequestIdRef = useRef(0);

  const dsIdsKey = dsIds.join(',');
  const severityKey = sortedJoin(severity);
  const stateKey = sortedJoin(state);
  const labelsKey = canonicalLabelsKey(labels);

  useEffect(() => {
    if (dsIds.length === 0 || !startTime || !endTime) {
      setData(null);
      return;
    }
    let derivedBuckets = buckets;
    if (derivedBuckets === undefined) {
      try {
        const startMs = parseDateMathMs(startTime, /* isEndTime */ false);
        const endMs = parseDateMathMs(endTime, /* isEndTime */ true);
        derivedBuckets = pickBucketCount(startMs, endMs);
      } catch {
        // Malformed date-math — let the route validator reject it. Skip
        // the request rather than dispatch with a bogus bucket count.
        return;
      }
    }
    const requestId = ++lastRequestIdRef.current;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await service.listAlertsTimeline({
          dsIds,
          startTime,
          endTime,
          buckets: derivedBuckets,
          severity,
          state,
          labels,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    service,
    dsIdsKey,
    startTime,
    endTime,
    buckets,
    severityKey,
    stateKey,
    labelsKey,
    refreshToken,
    localRefresh,
  ]);

  return { data, isLoading, error, refetch };
}
