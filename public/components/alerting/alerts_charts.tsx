/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Alerts Charts — ECharts visualizations for the Alerts dashboard.
 *
 * Currently exposes:
 *  - AlertTimeline: stacked bar chart of alerts over a variable-range time
 *    window. Phase 2 onward, the parent owns aggregation (via
 *    `useAlertsTimeline`) and passes pre-bucketed `{ buckets,
 *    bucketCount, bucketDurationMs }` so this component never iterates
 *    raw alerts to build histograms.
 */
import React, { useMemo } from 'react';
import moment from 'moment-timezone';
import { EuiText } from '@elastic/eui';
import { EchartsRender } from './echarts_render';
import type { AlertsTimelineBucket } from '../../../common/types/alerting';
import { uiSettingsService } from '../../../common/utils';

// ============================================================================
// Color map (kept for AlertTimeline severity bars)
// ============================================================================

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#BD271E',
  high: '#F5A700',
  medium: '#006BB4',
  low: '#98A2B3',
  info: '#D3DAE6',
};

// ============================================================================
// AlertTimeline — stacked bar chart by time buckets
// ============================================================================

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

/**
 * Resolve the timezone the user configured via `dateFormat:tz`. Mirrors the
 * resolution APM does in `formatDisplayTimestamp` so Discover, APM, and the
 * Alerts dashboard all render the same instant the same way for a given user.
 */
function resolveDisplayTz(): string {
  const tz = uiSettingsService.get('dateFormat:tz');
  if (!tz || tz === 'Browser') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return tz;
}

/**
 * Format a bucket-start timestamp based on the overall range length:
 *  - `HH:mm` for ranges ≤ 24h
 *  - `MM-DD HH:mm` for ranges ≤ 7d
 *  - `MM-DD` otherwise
 *
 * Honors `dateFormat:tz` so users in different timezones don't see different
 * labels for the same bucket — matches Discover / Dashboards / APM.
 */
function formatBucketLabel(ts: number, rangeMs: number, tz: string): string {
  const m = moment.tz(ts, tz);
  if (rangeMs <= ONE_DAY_MS) return m.format('HH:mm');
  if (rangeMs <= SEVEN_DAYS_MS) return m.format('MM-DD HH:mm');
  return m.format('MM-DD');
}

export interface AlertTimelineProps {
  /** Pre-bucketed timeline payload from `useAlertsTimeline`. */
  buckets: AlertsTimelineBucket[];
  /** Total bucket count — echoed by the server for axis-label sizing. */
  bucketCount: number;
  /** Bucket width in ms — echoed by the server for axis-range derivation. */
  bucketDurationMs: number;
  /** True while the timeline hook is in flight. Drives empty-state copy. */
  loading?: boolean;
}

export const AlertTimeline: React.FC<AlertTimelineProps> = ({
  buckets,
  bucketCount,
  bucketDurationMs,
  loading,
}) => {
  const totalCount = useMemo(() => {
    let sum = 0;
    for (const b of buckets) {
      sum +=
        b.severity.critical +
        b.severity.high +
        b.severity.medium +
        b.severity.low +
        b.severity.info;
    }
    return sum;
  }, [buckets]);

  const spec = useMemo(() => {
    if (buckets.length === 0) return null;
    const rangeMs = Math.max(1, bucketCount * bucketDurationMs);
    const tz = resolveDisplayTz();
    const timeLabels = buckets.map((b) => formatBucketLabel(b.ts, rangeMs, tz));
    const severities: Array<{ key: keyof AlertsTimelineBucket['severity']; color: string }> = [
      { key: 'critical', color: SEVERITY_COLORS.critical },
      { key: 'high', color: SEVERITY_COLORS.high },
      { key: 'medium', color: SEVERITY_COLORS.medium },
      { key: 'low', color: SEVERITY_COLORS.low },
      { key: 'info', color: SEVERITY_COLORS.info },
    ];

    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
      },
      legend: { bottom: 0, left: 'center', textStyle: { fontSize: 10 } },
      grid: { top: 10, right: 15, bottom: 36, left: 40 },
      xAxis: {
        type: 'category' as const,
        data: timeLabels,
        axisLabel: { fontSize: 9, color: '#98A2B3', interval: 1 },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#EDF0F5' } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { fontSize: 9, color: '#98A2B3' },
        splitLine: { lineStyle: { color: '#EDF0F5' } },
        minInterval: 1,
      },
      series: severities.map((s) => ({
        name: s.key,
        type: 'bar' as const,
        stack: 'severity',
        data: buckets.map((b) => b.severity[s.key]),
        itemStyle: { color: s.color },
        barMaxWidth: 32,
      })),
    };
  }, [buckets, bucketCount, bucketDurationMs]);

  if (totalCount === 0 || !spec) {
    return (
      <EuiText size="s" color="subdued">
        {loading ? 'Loading timeline…' : 'No timeline data'}
      </EuiText>
    );
  }

  return <EchartsRender spec={spec} height={160} />;
};
