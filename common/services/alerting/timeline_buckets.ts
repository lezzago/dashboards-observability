/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared bucket-count helper for the alerts timeline chart.
 *
 * Picks a bucket count for a `[startMs, endMs]` window by targeting a
 * 5-minute bucket width, clamped to `[MIN_BUCKETS, MAX_BUCKETS]`. Used by
 * `useAlertsTimeline` to derive the request param and by the server-side
 * timeline resolver as a defense-in-depth clamp.
 *
 * Pure, framework-free — safe to import from both the browser bundle and
 * the server.
 */

/** Target bucket width — 5 minutes. With a 1h range, this yields exactly 12
 *  buckets (ceil(60m / 5m) = 12), matching the fixed bucketCount used in the
 *  pre-Phase-2 client-side bucketing. */
export const TARGET_BUCKET_MS = 5 * 60 * 1000;

/** Client-side floor / ceiling. Within this clamp the X-axis stays readable
 *  across ranges from 5 minutes up to 30 days. */
export const MIN_BUCKETS = 12;
export const MAX_BUCKETS = 24;

/** Server-side defense-in-depth ceiling. The hook's [12, 24] always falls
 *  inside [12, 48], so the server clamp only fires on misuse. */
export const SERVER_MAX_BUCKETS = 48;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Pick a bucket count for the timeline chart. Mirrors the pre-Phase-2
 * client-side logic from `alerts_charts.tsx`:
 *
 *   `clamp(ceil(rangeMs / 5min), 12, 24)`
 *
 * Defends against zero / inverted ranges by treating them as a 1ms window.
 */
export function pickBucketCount(startMs: number, endMs: number): number {
  const rangeMs = Math.max(1, endMs - startMs);
  const raw = Math.ceil(rangeMs / TARGET_BUCKET_MS);
  return clamp(raw, MIN_BUCKETS, MAX_BUCKETS);
}

/**
 * Server-side clamp applied to the `buckets` query param. Allows the
 * client to request a finer count than the client-side default
 * (`MAX_BUCKETS = 24`) for future visualizations, capped at
 * `SERVER_MAX_BUCKETS = 48`.
 */
export function clampServerBucketCount(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return MIN_BUCKETS;
  return clamp(Math.floor(requested), MIN_BUCKETS, SERVER_MAX_BUCKETS);
}
