/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alertmanager availability probe (P6.1).
 *
 * Some Prom installs don't run Alertmanager at all (small custom routers,
 * Mimir without an AM bundle). When AM is reachable, the alerts table
 * sources from `/alertmanager/api/v2/alerts` (filter pushdown + silence /
 * inhibition / receiver context); when it isn't, the table falls back to
 * the legacy `/api/v1/alerts` + bounded historical-topk path and surfaces
 * the `prometheus-alertmanager-unavailable` callout.
 *
 * Lazy: probe runs on the first AM-sourced call per dsId, not at server
 * startup. Process-lifetime cache (matches the existing
 * `prom_filter_probe`'s lifetime contract — probe result is a property of
 * the upstream, not the caller). Concurrent probes for the same dsId
 * share one in-flight promise.
 *
 * Keep the surface a tiny mirror of prom_filter_probe so a reader who's
 * read one probe understands both at a glance.
 */
import type {
  AlertingOSClient,
  Datasource,
  Logger,
  PrometheusBackend,
} from '../../../common/types/alerting';

export type AmProbeResult = { status: 'available' } | { status: 'unavailable'; reason: string };

export interface AlertmanagerProbe {
  probe(client: AlertingOSClient, ds: Datasource): Promise<AmProbeResult>;
  reset(): void;
}

type CacheEntry = AmProbeResult | Promise<AmProbeResult>;

export function createAlertmanagerProbe(
  promBackend: Pick<PrometheusBackend, 'getAlertmanagerStatus'>,
  logger: Logger
): AlertmanagerProbe {
  const cache = new Map<string, CacheEntry>();

  async function runProbe(client: AlertingOSClient, ds: Datasource): Promise<AmProbeResult> {
    if (!promBackend.getAlertmanagerStatus) {
      // Backend doesn't even support AM — treat as unavailable so the
      // dispatcher takes the legacy path. Not an error.
      return { status: 'unavailable', reason: 'backend-no-getAlertmanagerStatus' };
    }
    try {
      const status = await promBackend.getAlertmanagerStatus(client, ds);
      // The DirectQuery wrapper resolves to a parsed `AlertmanagerStatus`
      // on success. An empty / nullish response is treated as unavailable
      // — we'd rather false-negative than send AM filter pushdown to a
      // ruler that's about to 404.
      if (!status) {
        return { status: 'unavailable', reason: 'empty-status-response' };
      }
      return { status: 'available' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug(`alertmanagerProbe: status call failed for ${ds.id}: ${reason}`);
      return { status: 'unavailable', reason };
    }
  }

  return {
    async probe(client, ds) {
      const cached = cache.get(ds.id);
      if (cached) return await cached;
      const inflight = runProbe(client, ds);
      cache.set(ds.id, inflight);
      try {
        const resolved = await inflight;
        cache.set(ds.id, resolved);
        return resolved;
      } catch (err) {
        cache.delete(ds.id);
        throw err;
      }
    },
    reset() {
      cache.clear();
    },
  };
}
