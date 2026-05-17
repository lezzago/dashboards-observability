/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from '@testing-library/react';

jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
  })),
  graphic: { LinearGradient: jest.fn() },
}));

global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  disconnect: jest.fn(),
  unobserve: jest.fn(),
}));

// Spy on AlertTimeline so we can assert the bucketed payload flows through.
const mockTimeline = jest.fn();
jest.mock('../alerts_charts', () => ({
  AlertTimeline: (props: {
    buckets: unknown[];
    bucketCount: number;
    bucketDurationMs: number;
    loading?: boolean;
  }) => {
    mockTimeline(props);
    return <div data-test-subj="alert-timeline-stub" />;
  },
}));

import { AlertsDashboard } from '../alerts_dashboard';
import type { UnifiedAlertSummary, Datasource } from '../../../../common/types/alerting';

const sampleAlert: UnifiedAlertSummary = {
  id: 'a-1',
  datasourceId: 'ds-1',
  datasourceType: 'opensearch',
  name: 'HighCPU',
  state: 'active',
  severity: 'critical',
  startTime: new Date().toISOString(),
  lastUpdated: new Date().toISOString(),
  labels: {},
  annotations: {},
};

const sampleDs: Datasource = {
  id: 'ds-1',
  name: 'Local',
  type: 'opensearch',
  url: '',
  enabled: true,
};

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();

const sampleTimeline = {
  buckets: [
    {
      ts: NOW - HOUR_MS,
      severity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
    },
  ],
  bucketCount: 1,
  bucketDurationMs: HOUR_MS,
  datasourceStatus: [],
  fetchedAt: new Date(NOW).toISOString(),
};

const baseProps = {
  alerts: [] as UnifiedAlertSummary[],
  datasources: [sampleDs],
  loading: false,
  onViewDetail: jest.fn(),
  onAcknowledge: jest.fn(),
  selectedDsIds: ['ds-1'],
  onDatasourceChange: jest.fn(),
  maxDatasources: 5,
  onDatasourceCapReached: jest.fn(),
  timelineData: sampleTimeline,
  timelineLoading: false,
};

beforeEach(() => {
  mockTimeline.mockClear();
});

const emptyTimeline = {
  buckets: [{ ts: NOW - HOUR_MS, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }],
  bucketCount: 1,
  bucketDurationMs: HOUR_MS,
  datasourceStatus: [],
  fetchedAt: new Date(NOW).toISOString(),
};

describe('AlertsDashboard', () => {
  it('renders the empty prompt when both alerts and timeline are empty', () => {
    // Phase 3 / Carryover-1: empty prompt only when nothing is filtered
    // AND both data signals are empty.
    const { getByText } = render(<AlertsDashboard {...baseProps} timelineData={emptyTimeline} />);
    expect(getByText('No Active Alerts')).toBeInTheDocument();
  });

  it('keeps the chart visible when the timeline has data even if the alerts list is empty', () => {
    // Phase 3 / Carryover-1: this is the regression — the chart used to
    // hide whenever alerts.length === 0 even with non-zero buckets.
    const { queryByText, getByTestId } = render(<AlertsDashboard {...baseProps} />);
    expect(queryByText('No Active Alerts')).not.toBeInTheDocument();
    expect(getByTestId('alert-timeline-stub')).toBeInTheDocument();
  });

  it('keeps the chart visible while the timeline is still loading', () => {
    // Loading flagged at the top level should suppress the page-wide empty
    // prompt — otherwise the prompt flashes briefly on every refresh.
    const { queryByText } = render(
      <AlertsDashboard {...baseProps} timelineData={null} timelineLoading />
    );
    expect(queryByText('No Active Alerts')).not.toBeInTheDocument();
  });

  it('renders alert table when alerts provided', () => {
    const { getByText } = render(<AlertsDashboard {...baseProps} alerts={[sampleAlert]} />);
    expect(getByText('HighCPU')).toBeInTheDocument();
  });

  it('renders timeline title without the (24h) suffix', () => {
    const { getByText, queryByText } = render(
      <AlertsDashboard {...baseProps} alerts={[sampleAlert]} />
    );
    expect(getByText('Alert Timeline')).toBeInTheDocument();
    expect(queryByText('Alert Timeline (24h)')).not.toBeInTheDocument();
  });

  it('forwards bucketed timeline payload to AlertTimeline', () => {
    render(<AlertsDashboard {...baseProps} alerts={[sampleAlert]} />);
    expect(mockTimeline).toHaveBeenCalled();
    const lastCall = mockTimeline.mock.calls[mockTimeline.mock.calls.length - 1][0];
    expect(lastCall.buckets).toBe(sampleTimeline.buckets);
    expect(lastCall.bucketCount).toBe(sampleTimeline.bucketCount);
    expect(lastCall.bucketDurationMs).toBe(sampleTimeline.bucketDurationMs);
  });

  it('renders the truncated callout when `truncated` is true', () => {
    const { getByTestId } = render(
      <AlertsDashboard {...baseProps} alerts={[sampleAlert]} truncated />
    );
    expect(getByTestId('alerts-truncated-callout')).toBeInTheDocument();
  });

  it('does not render the truncated callout when `truncated` is false/undefined', () => {
    const { queryByTestId } = render(<AlertsDashboard {...baseProps} alerts={[sampleAlert]} />);
    expect(queryByTestId('alerts-truncated-callout')).not.toBeInTheDocument();
  });

  it('renders the fallback callout listing each fallback datasource', () => {
    const { getByTestId, getByText } = render(
      <AlertsDashboard
        {...baseProps}
        alerts={[sampleAlert]}
        fallbackHints={[
          { datasourceName: 'prom-prod', fallback: 'prometheus-alerts-current-only' },
        ]}
      />
    );
    expect(getByTestId('alerts-fallback-callout')).toBeInTheDocument();
    expect(getByText('prom-prod')).toBeInTheDocument();
  });

  it('does not render the fallback callout when `fallbackHints` is empty', () => {
    const { queryByTestId } = render(
      <AlertsDashboard {...baseProps} alerts={[sampleAlert]} fallbackHints={[]} />
    );
    expect(queryByTestId('alerts-fallback-callout')).not.toBeInTheDocument();
  });
});
