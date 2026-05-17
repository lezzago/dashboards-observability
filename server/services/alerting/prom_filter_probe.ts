/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prometheus rule-filter pushdown probe.
 *
 * Cortex / Prometheus expose `?rule_group=&rule_name=&type=alert` on
 * `/api/v1/rules` since Prom 2.40 / Cortex 1.13. Older upstreams silently
 * ignore the params and return the full listing. The probe runs once per
 * datasource: it picks the first alerting rule from a one-shot listing and
 * issues a scoped request for that exact `(group, rule)` pair. If the
 * upstream returns exactly that one match, pushdown works; anything else
 * means the upstream is ignoring filters and the detail path falls back to
 * full listings + post-filter.
 *
 * The cache lives for the lifetime of the plugin process. Concurrent probes
 * for the same `dsId` share one in-flight promise so two cold flyout opens
 * don't race two upstream probes.
 */
import type {
  AlertingOSClient,
  Datasource,
  Logger,
  PrometheusBackend,
} from '../../../common/types/alerting';

export type ProbeResult =
  | { status: 'pushdown-works' }
  | { status: 'pushdown-ignored' }
  | { status: 'unknown'; reason: string };

export interface PromFilterProbe {
  probe(client: AlertingOSClient, ds: Datasource): Promise<ProbeResult>;
  reset(): void;
}

type CacheEntry = ProbeResult | Promise<ProbeResult>;

export function createPromFilterProbe(
  promBackend: Pick<PrometheusBackend, 'getRuleGroups'>,
  logger: Logger
): PromFilterProbe {
  const cache = new Map<string, CacheEntry>();

  async function runProbe(client: AlertingOSClient, ds: Datasource): Promise<ProbeResult> {
    let firstGroup: string | undefined;
    let firstRule: string | undefined;
    try {
      const baseline = await promBackend.getRuleGroups(client, ds, { type: 'alert' });
      for (const g of baseline) {
        const alertingRule = g.rules.find((r) => r.type === 'alerting');
        if (alertingRule) {
          firstGroup = g.name;
          firstRule = alertingRule.name;
          break;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug(`promFilterProbe: baseline listing failed for ${ds.id}: ${reason}`);
      return { status: 'unknown', reason };
    }

    if (!firstGroup || !firstRule) {
      return { status: 'unknown', reason: 'no-alerting-rules' };
    }

    try {
      const scoped = await promBackend.getRuleGroups(client, ds, {
        ruleGroup: firstGroup,
        ruleName: firstRule,
        type: 'alert',
      });
      const single =
        scoped.length === 1 &&
        scoped[0].rules.length === 1 &&
        scoped[0].name === firstGroup &&
        scoped[0].rules[0].name === firstRule;
      return single ? { status: 'pushdown-works' } : { status: 'pushdown-ignored' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug(`promFilterProbe: scoped probe failed for ${ds.id}: ${reason}`);
      return { status: 'unknown', reason };
    }
  }

  return {
    async probe(client, ds) {
      const cached = cache.get(ds.id);
      if (cached) {
        return await cached;
      }
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
