/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema, TypeOf } from '@osd/config-schema';
import { PluginConfigDescriptor, PluginInitializerContext } from '../../../src/core/server';
import { ObservabilityPlugin } from './plugin';

export function plugin(initializerContext: PluginInitializerContext) {
  return new ObservabilityPlugin(initializerContext);
}

export { ObservabilityPluginSetup, ObservabilityPluginStart } from './types';

const observabilityConfig = {
  schema: schema.object({
    query_assist: schema.object({
      enabled: schema.boolean({ defaultValue: true }),
    }),
    summarize: schema.object({
      enabled: schema.boolean({ defaultValue: false }),
    }),
    alertManager: schema.object({
      enabled: schema.boolean({ defaultValue: false }),
    }),
    // SLO server-side behavior. `reconcilerIntervalMs` drives the Phase 2
    // background sweep that reconciles SLO saved objects against the ruler.
    // Default 5m; floor at 1s to stay safe against misconfig that would make
    // the dev server hammer Cortex. The whole `slo` block is exposed to the
    // browser (see `exposeToBrowser` below) so dedup/adoption feature-gate
    // reads resolve synchronously; the other knobs leak too but none are
    // sensitive.
    slo: schema.object({
      reconcilerIntervalMs: schema.number({ defaultValue: 300_000, min: 1_000 }),
      // Phase 3 (W3.6): dedup flag. Default-on in dev; operators flip off in
      // prod during the staged rollout. When false the service falls back to
      // the pre-Phase-3 single-group path and the aggregator uses legacy
      // selectors.
      ruleDedup: schema.object({
        enabled: schema.boolean({ defaultValue: true }),
      }),
      // Phase 4 (W4.1): rule-adoption feature flag. Default-off. Tombstones
      // are written unconditionally during SLO delete (cheap, always useful
      // for debugging), but the adoption feature that *reads* tombstones and
      // surfaces orphan rule groups in a Recover UI is gated on this flag.
      ruleAdoption: schema.object({
        enabled: schema.boolean({ defaultValue: false }),
      }),
      // Phase 3 (W3.11): grace period before the reconciler deletes a
      // zero-ref recording group. Default 24h; floor at 60s so tests can
      // pick a tight window without risking accidental prod misconfig.
      recordingGraceMs: schema.number({ defaultValue: 24 * 60 * 60_000, min: 60_000 }),
    }),
  }),
};

export type ObservabilityConfig = TypeOf<typeof observabilityConfig.schema>;

export const config: PluginConfigDescriptor<ObservabilityConfig> = {
  schema: observabilityConfig.schema,
  exposeToBrowser: {
    query_assist: true,
    summarize: true,
    alertManager: true,
    // Expose the `slo` block so the browser can read dedup / adoption
    // feature gates synchronously at mount time. OSD's `exposeToBrowser`
    // only supports top-level boolean expose, so the whole `slo` object
    // leaks — `reconcilerIntervalMs` and `recordingGraceMs` become visible
    // too. Neither is sensitive (operator-tunable intervals, not
    // credentials or URLs), so whole-object expose is acceptable.
    slo: true,
  },
};
