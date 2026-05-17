/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from '@testing-library/react';

const mockSetOption = jest.fn();
jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: mockSetOption,
    resize: jest.fn(),
    dispose: jest.fn(),
  })),
}));

global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  disconnect: jest.fn(),
  unobserve: jest.fn(),
}));

import { AlertTimeline } from '../alerts_charts';
import type { AlertsTimelineBucket } from '../../../../common/types/alerting';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ZERO = () => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

const makeBuckets = (
  startMs: number,
  bucketCount: number,
  bucketDurationMs: number,
  fill: (i: number) => Partial<AlertsTimelineBucket['severity']> = () => ({})
): AlertsTimelineBucket[] => {
  const out: AlertsTimelineBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    out.push({
      ts: startMs + i * bucketDurationMs,
      severity: { ...ZERO(), ...fill(i) },
    });
  }
  return out;
};

const END = new Date('2026-05-08T12:00:00Z').getTime();

describe('AlertTimeline (Phase 2 — buckets prop)', () => {
  beforeEach(() => mockSetOption.mockClear());

  it('renders one stacked bar series per severity', () => {
    const buckets = makeBuckets(END - HOUR_MS, 12, HOUR_MS / 12, (i) =>
      i === 0 ? { critical: 2, high: 1 } : {}
    );
    render(<AlertTimeline buckets={buckets} bucketCount={12} bucketDurationMs={HOUR_MS / 12} />);
    const option = mockSetOption.mock.calls[0][0] as {
      series: Array<{ name: string; type: string; stack: string; data: number[] }>;
    };
    expect(option.series.map((s) => s.name)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(option.series.every((s) => s.type === 'bar' && s.stack === 'severity')).toBe(true);
    // First bucket carries the seeded counts.
    expect(option.series.find((s) => s.name === 'critical')!.data[0]).toBe(2);
    expect(option.series.find((s) => s.name === 'high')!.data[0]).toBe(1);
  });

  it('shows the empty-state message when total count is zero', () => {
    const buckets = makeBuckets(END - HOUR_MS, 12, HOUR_MS / 12);
    const { getByText } = render(
      <AlertTimeline buckets={buckets} bucketCount={12} bucketDurationMs={HOUR_MS / 12} />
    );
    expect(getByText('No timeline data')).toBeInTheDocument();
    expect(mockSetOption).not.toHaveBeenCalled();
  });

  it('shows the loading message when total count is zero AND loading=true', () => {
    const buckets = makeBuckets(END - HOUR_MS, 12, HOUR_MS / 12);
    const { getByText } = render(
      <AlertTimeline buckets={buckets} bucketCount={12} bucketDurationMs={HOUR_MS / 12} loading />
    );
    expect(getByText(/Loading timeline/)).toBeInTheDocument();
  });

  it('label format is HH:mm for ranges ≤ 24h', () => {
    const buckets = makeBuckets(END - HOUR_MS, 12, HOUR_MS / 12, (i) =>
      i === 0 ? { medium: 1 } : {}
    );
    render(<AlertTimeline buckets={buckets} bucketCount={12} bucketDurationMs={HOUR_MS / 12} />);
    const option = mockSetOption.mock.calls[0][0] as { xAxis: { data: string[] } };
    for (const label of option.xAxis.data) expect(label).toMatch(/^\d{2}:\d{2}$/);
  });

  it('label format switches to MM-DD HH:mm for 7d ranges', () => {
    const start = END - 7 * DAY_MS;
    const dur = (7 * DAY_MS) / 24;
    const buckets = makeBuckets(start, 24, dur, (i) => (i === 5 ? { high: 1 } : {}));
    render(<AlertTimeline buckets={buckets} bucketCount={24} bucketDurationMs={dur} />);
    const option = mockSetOption.mock.calls[0][0] as { xAxis: { data: string[] } };
    for (const label of option.xAxis.data) {
      expect(label).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    }
  });

  it('label format is MM-DD for ranges > 7d', () => {
    const start = END - 30 * DAY_MS;
    const dur = (30 * DAY_MS) / 24;
    const buckets = makeBuckets(start, 24, dur, (i) => (i === 0 ? { low: 1 } : {}));
    render(<AlertTimeline buckets={buckets} bucketCount={24} bucketDurationMs={dur} />);
    const option = mockSetOption.mock.calls[0][0] as { xAxis: { data: string[] } };
    for (const label of option.xAxis.data) expect(label).toMatch(/^\d{2}-\d{2}$/);
  });
});
