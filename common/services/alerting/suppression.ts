/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suppression rule types and the Alertmanager-silence adapter.
 *
 * Suppression rules in this plugin are read-only projections of Alertmanager
 * silences; there is no app-side store. The `SuppressionRuleConfig` shape is
 * kept stable so the panel and detail flyout can consume the same payload.
 */

import type { AlertmanagerSilence } from '../../types/alerting/types';

export type SilenceState = 'active' | 'pending' | 'expired';

export interface SuppressionRuleConfig {
  id: string;
  name: string;
  description: string;
  matchers: Record<string, string>;
  startTime: string;
  endTime: string;
  createdBy: string;
  createdAt: string;
  active: boolean;
  source: 'silence';
  datasourceId: string;
  datasourceName: string;
  silenceState: SilenceState;
}

function computeStateFromWindow(
  startsAt: string,
  endsAt: string,
  now: Date = new Date()
): SilenceState {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const t = now.getTime();
  if (t < start) return 'pending';
  if (t > end) return 'expired';
  return 'active';
}

/**
 * Adapter: convert an Alertmanager silence into the uniform SuppressionRuleConfig
 * shape used by the Suppression Rules list. The returned rule is read-only —
 * mutations should be made via the Alertmanager API and the datasource refetched.
 *
 * Matcher encoding strategy: the `matchers` map is a flat `Record<string,string>`
 * for UI compatibility, so we encode negation and regex as a value prefix:
 *   - regex matcher    → `~value`
 *   - negated matcher  → `!value`
 *   - negated regex    → `!~value`
 */
export function silenceToSuppressionRule(
  silence: AlertmanagerSilence,
  datasource: { id: string; name: string }
): SuppressionRuleConfig {
  const silenceId = silence.id ?? '';
  const matchers: Record<string, string> = {};
  for (const m of silence.matchers || []) {
    if (Object.prototype.hasOwnProperty.call(matchers, m.name)) continue;
    const regexPrefix = m.isRegex ? '~' : '';
    const negatePrefix = m.isEqual === false ? '!' : '';
    matchers[m.name] = `${negatePrefix}${regexPrefix}${m.value}`;
  }
  const fallbackName = `Silence ${silenceId.slice(0, 8)}`;
  const displayName = silence.comment || fallbackName;
  const resolvedState =
    silence.status?.state ?? computeStateFromWindow(silence.startsAt, silence.endsAt);
  return {
    id: `silence-${datasource.id}-${silenceId}`,
    name: `${datasource.name}: ${displayName}`,
    description: silence.comment ?? '',
    matchers,
    startTime: silence.startsAt,
    endTime: silence.endsAt,
    createdAt: silence.startsAt,
    createdBy: silence.createdBy,
    active: resolvedState === 'active',
    source: 'silence',
    datasourceId: datasource.id,
    datasourceName: datasource.name,
    silenceState: resolvedState,
  };
}
