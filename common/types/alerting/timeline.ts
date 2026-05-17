/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatasourceFetchResult } from './unified_types';

/**
 * Per-bucket severity counts emitted by the timeline endpoint. Always
 * contains the full {critical, high, medium, low, info} key set so the
 * chart's series-level `data` arrays line up without per-bucket lookups.
 */
export interface TimelineSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** Single bucket. `ts` is the bucket-start epoch ms (UTC). */
export interface AlertsTimelineBucket {
  ts: number;
  severity: TimelineSeverityCounts;
}

/**
 * Response shape for `GET /api/alerting/unified/alerts/timeline`. Re-uses
 * `DatasourceFetchResult<AlertsTimelineBucket>` for per-datasource status
 * so the per-backend status carries the same `truncated`/`fallback` fields
 * the alerts list path already exposes.
 */
export interface AlertsTimelineResponse {
  buckets: AlertsTimelineBucket[];
  bucketCount: number;
  bucketDurationMs: number;
  datasourceStatus: Array<DatasourceFetchResult<AlertsTimelineBucket>>;
  fetchedAt: string;
}
