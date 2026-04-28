/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SloHealthState } from './slo_types';

export const SLO_HEALTH_COLOR: Record<SloHealthState, string> = {
  breached: 'danger',
  warning: 'warning',
  ok: 'success',
  no_data: 'subdued',
  stale: 'subdued',
  disabled: 'default',
  // Broken rules are as bad as a breach — alerts can't fire when the rule group is gone.
  rules_missing: 'danger',
};

export const SLO_HEALTH_ORDER: SloHealthState[] = [
  'breached',
  'rules_missing',
  'warning',
  'ok',
  'no_data',
  'stale',
  'disabled',
];

export function getSloHealthColor(state: SloHealthState | string | undefined | null): string {
  if (state && Object.prototype.hasOwnProperty.call(SLO_HEALTH_COLOR, state)) {
    return SLO_HEALTH_COLOR[state as SloHealthState];
  }
  return 'subdued';
}
