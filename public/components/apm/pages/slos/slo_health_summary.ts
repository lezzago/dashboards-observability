/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared SLO health rollup for APM surfaces.
 *
 * `useServiceSloHealth` is the single source of truth for the Services Home
 * header panel, the per-row SLO health column, and the Service Details SLOs
 * tab. State is read point-in-time from server SLO summaries; each SLO
 * evaluates against its own rolling window, so the hook deliberately ignores
 * the caller's time range.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SloApiClient } from './slo_api_client';
import type {
  SloHealthState,
  SloListFilters,
  SloSummary,
  SuggestionKind,
} from '../../../../../common/slo/slo_types';

/**
 * The classifier returns the full `SuggestionKind` union so downstream
 * surfaces can distinguish http/rpc/db/etc. when the SLO was created from a
 * suggestion. `hasAvailability` / `hasLatency` roll-ups treat every kind
 * ending in `-availability` / `-latency` as the respective side, so an HTTP
 * availability SLO still counts toward the canonical pair for its service.
 */
export type CanonicalKind = SuggestionKind;

export interface SloHealthBucket {
  total: number;
  ok: number;
  warning: number;
  breached: number;
  noData: number;
  stale: number;
  disabled: number;
  rulesMissing: number;
  hasAvailability: boolean;
  hasLatency: boolean;
  missingCanonicalPair: boolean;
  slos: SloSummary[];
}

export interface UseServiceSloHealthResult {
  bySvc: Map<string, SloHealthBucket>;
  aggregate: SloHealthBucket;
  isLoading: boolean;
  error: Error | undefined;
  refetch: () => void;
}

/**
 * UI-facing reduction of the raw hook error. `forbidden` renders a dedicated
 * "you don't have access" callout; `generic` surfaces the server message.
 */
export type SloHealthAccessError = { kind: 'generic'; message?: string } | { kind: 'forbidden' };

/**
 * Reduce a raw Error from `useServiceSloHealth` into the access-error
 * discriminator consumed by Services Home header + per-row cells and the
 * Service Details SLOs tab. Keep this alongside the hook so every caller
 * collapses errors the same way.
 */
export function toSloHealthAccessError(error: Error | undefined): SloHealthAccessError | undefined {
  if (!error) return undefined;
  const body = (error as { response?: { status?: number } }).response;
  if (body?.status === 403) return { kind: 'forbidden' };
  return { kind: 'generic', message: error.message };
}

export interface UseServiceSloHealthParams {
  serviceNames: string[];
  datasourceId: string;
  apiClient: SloApiClient;
}

/**
 * Classifier. Prefers the stored `canonicalKind` tag stamped at suggest-
 * driven create time (M5A). Falls back to the heuristic over the SLI
 * definition for legacy / manually-authored SLOs that predate the tag.
 */
export function classifySloKind(slo: SloSummary): CanonicalKind | undefined {
  if (slo.canonicalKind) return slo.canonicalKind;
  if (slo.sliBackend !== 'prometheus') return undefined;
  if (slo.sliLeafType === 'availability') return 'apm-availability';
  if (slo.sliLeafType === 'latency_threshold') return 'apm-latency';
  return undefined;
}

function kindSide(kind: CanonicalKind | undefined): 'availability' | 'latency' | undefined {
  if (!kind) return undefined;
  if (kind.endsWith('-availability')) return 'availability';
  if (kind.endsWith('-latency')) return 'latency';
  return undefined;
}

function emptyBucket(): SloHealthBucket {
  return {
    total: 0,
    ok: 0,
    warning: 0,
    breached: 0,
    noData: 0,
    stale: 0,
    disabled: 0,
    rulesMissing: 0,
    hasAvailability: false,
    hasLatency: false,
    missingCanonicalPair: true,
    slos: [],
  };
}

function tallyState(bucket: SloHealthBucket, state: SloHealthState): void {
  switch (state) {
    case 'ok':
      bucket.ok += 1;
      break;
    case 'warning':
      bucket.warning += 1;
      break;
    case 'breached':
      bucket.breached += 1;
      break;
    case 'no_data':
      bucket.noData += 1;
      break;
    case 'stale':
      bucket.stale += 1;
      break;
    case 'disabled':
      bucket.disabled += 1;
      break;
    case 'rules_missing':
      bucket.rulesMissing += 1;
      break;
  }
}

function recomputeDerived(bucket: SloHealthBucket): void {
  bucket.missingCanonicalPair = !(bucket.hasAvailability && bucket.hasLatency);
}

/**
 * Roll `summaries` up into per-service + aggregate buckets. Exposed for
 * tests; the hook wraps this with fetch-state management.
 */
export function rollupSloHealth(
  serviceNames: string[],
  summaries: SloSummary[]
): { bySvc: Map<string, SloHealthBucket>; aggregate: SloHealthBucket } {
  const bySvc = new Map<string, SloHealthBucket>();
  for (const name of serviceNames) bySvc.set(name, emptyBucket());

  const aggregate = emptyBucket();
  // Aggregate tracks "every service has X", not "any summary exists" — start
  // true and flip when we find a service without availability / latency.
  aggregate.hasAvailability = serviceNames.length > 0;
  aggregate.hasLatency = serviceNames.length > 0;

  for (const slo of summaries) {
    const bucket = bySvc.get(slo.service);
    if (!bucket) continue; // summary outside the requested service set
    bucket.total += 1;
    bucket.slos.push(slo);
    tallyState(bucket, slo.status.state);

    const side = kindSide(classifySloKind(slo));
    if (side === 'availability') bucket.hasAvailability = true;
    if (side === 'latency') bucket.hasLatency = true;

    aggregate.total += 1;
    aggregate.slos.push(slo);
    tallyState(aggregate, slo.status.state);
  }

  for (const bucket of bySvc.values()) {
    recomputeDerived(bucket);
    if (!bucket.hasAvailability) aggregate.hasAvailability = false;
    if (!bucket.hasLatency) aggregate.hasLatency = false;
  }
  recomputeDerived(aggregate);

  return { bySvc, aggregate };
}

// Sorted, newline-joined key lets React compare service sets by value rather
// than array identity — callers aren't required to memoize `serviceNames`.
function serviceNamesKey(names: string[]): string {
  return [...names].sort().join('\n');
}

const MIN_PAGE_SIZE = 50;
// Canonical pair = 2 availability + 2 latency per service; anything beyond
// that is unexpected and we log a warning before paging through.
const PER_SERVICE_BUDGET = 4;

export const useServiceSloHealth = ({
  serviceNames,
  datasourceId,
  apiClient,
}: UseServiceSloHealthParams): UseServiceSloHealthResult => {
  const [summaries, setSummaries] = useState<SloSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  const key = serviceNamesKey(serviceNames);
  // Capture the latest service-names snapshot without making the fetch effect
  // depend on array identity — avoids refetch churn when callers construct
  // the list inline.
  const serviceNamesRef = useRef(serviceNames);
  serviceNamesRef.current = serviceNames;

  useEffect(() => {
    const activeNames = serviceNamesRef.current;
    if (!datasourceId || activeNames.length === 0) {
      // Guard against unstable serviceNames array identity from callers that pass
      // a fresh array per render (e.g. ServiceSloTab passes [serviceName]).
      setSummaries((prev) => (prev.length === 0 ? prev : []));
      setError((prev) => (prev === undefined ? prev : undefined));
      setIsLoading((prev) => (prev ? false : prev));
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(undefined);

    (async () => {
      try {
        const pageSize = Math.max(MIN_PAGE_SIZE, activeNames.length * PER_SERVICE_BUDGET);
        const baseFilters: SloListFilters = {
          service: activeNames,
          datasourceId: [datasourceId],
          pageSize,
        };

        const first = await apiClient.list({ ...baseFilters, page: 1 });
        if (cancelled) return;

        const collected: SloSummary[] = [...first.results];
        if (first.total > collected.length) {
          console.warn(
            '[useServiceSloHealth] SLO total (%d) exceeds pageSize (%d); paging through.',
            first.total,
            pageSize
          );
          let page = 2;
          while (collected.length < first.total) {
            const next = await apiClient.list({ ...baseFilters, page });
            if (cancelled) return;
            if (next.results.length === 0) break;
            collected.push(...next.results);
            if (!next.hasMore) break;
            page += 1;
          }
        }

        if (!cancelled) {
          setSummaries(collected);
          setIsLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setSummaries([]);
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `key` stands in for `serviceNames` content; `apiClient` identity is
    // stable across the caller's lifetime.
  }, [key, datasourceId, apiClient, refetchTrigger]);

  const { bySvc, aggregate } = useMemo(
    () => rollupSloHealth(serviceNames, summaries),
    // `key` captures serviceNames content; rolling up on `summaries` identity
    // is correct because fetch replaces the array on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, summaries]
  );

  const refetch = useCallback(() => {
    setRefetchTrigger((prev) => prev + 1);
  }, []);

  return { bySvc, aggregate, isLoading, error, refetch };
};
