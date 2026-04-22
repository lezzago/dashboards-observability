/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suppression-rule handlers — framework-agnostic. Produces a read-only list of
 * Alertmanager-silence projections fetched via the Prometheus backend. There
 * is no server-side rule store: everything is derived from silences.
 */
import {
  AlertingOSClient,
  Datasource,
  DatasourceWarning,
  PrometheusBackend,
} from '../../../common/types/alerting/types';
import {
  SuppressionRuleConfig,
  silenceToSuppressionRule,
} from '../../../common/services/alerting/suppression';
import { withTimeout } from '../../services/alerting/timeout_error';
import type { HandlerResult } from './route_utils';

const PER_DATASOURCE_TIMEOUT_MS = 10_000;

/**
 * List suppression rules. Silences are fetched in parallel from each
 * Prometheus datasource's Alertmanager; per-datasource failures (including
 * timeouts) surface via `warnings` instead of failing the overall request.
 */
export async function handleListSuppressionRules(
  promBackend: PrometheusBackend | null,
  client: AlertingOSClient,
  datasources: Datasource[]
): Promise<HandlerResult> {
  if (datasources.length === 0 || !promBackend || !promBackend.getSilences) {
    return { status: 200, body: { rules: [], warnings: [] } };
  }
  const getSilences = promBackend.getSilences.bind(promBackend);

  const settled = await Promise.allSettled(
    datasources.map((ds) =>
      withTimeout(
        getSilences(client, ds),
        PER_DATASOURCE_TIMEOUT_MS,
        `Datasource ${ds.name} timed out after ${PER_DATASOURCE_TIMEOUT_MS}ms`
      )
    )
  );

  const rules: SuppressionRuleConfig[] = [];
  const warnings: DatasourceWarning[] = [];

  settled.forEach((result, i) => {
    const ds = datasources[i];
    if (result.status === 'fulfilled') {
      for (const silence of result.value ?? []) {
        rules.push(silenceToSuppressionRule(silence, { id: ds.id, name: ds.name }));
      }
    } else {
      const err: unknown = result.reason;
      warnings.push({
        datasourceId: ds.id,
        datasourceName: ds.name,
        datasourceType: ds.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { status: 200, body: { rules, warnings } };
}
