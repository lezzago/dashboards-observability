/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react';

jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
  })),
}));

const mockNavigateToApp = jest.fn();
jest.mock('../../../framework/core_refs', () => ({
  coreRefs: {
    application: {
      navigateToApp: (...args: unknown[]) => mockNavigateToApp(...args),
    },
  },
}));

global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  disconnect: jest.fn(),
  unobserve: jest.fn(),
}));

import { MonitorDetailFlyout } from '../monitor_detail_flyout';
import type { UnifiedRuleSummary } from '../../../../common/types/alerting';

const mockMonitor: UnifiedRuleSummary = {
  id: 'mon-1',
  datasourceId: 'ds-1',
  datasourceType: 'opensearch',
  name: 'Test Monitor',
  enabled: true,
  severity: 'medium',
  query: '{}',
  condition: 'ctx.results[0].hits.total.value > 0',
  labels: {},
  annotations: {},
  monitorType: 'metric',
  status: 'active',
  healthStatus: 'healthy',
  createdBy: '',
  createdAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
  notificationDestinations: [],
  evaluationInterval: '1m',
  pendingPeriod: '5m',
};

const mockApiClient = {
  getRuleDetail: jest.fn().mockResolvedValue(null),
  rawHttp: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
};

describe('MonitorDetailFlyout', () => {
  beforeEach(() => {
    mockNavigateToApp.mockClear();
  });

  it('renders flyout with monitor name', () => {
    const { getByText } = render(
      <MonitorDetailFlyout
        monitor={mockMonitor}
        apiClient={mockApiClient as never}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    expect(getByText('Test Monitor')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    const { getByLabelText } = render(
      <MonitorDetailFlyout
        monitor={mockMonitor}
        apiClient={mockApiClient as never}
        onClose={onClose}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    fireEvent.click(getByLabelText('Close this dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not render the SLO backlink when rule has no slo_id label', () => {
    const { queryByTestId } = render(
      <MonitorDetailFlyout
        monitor={mockMonitor}
        apiClient={mockApiClient as never}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    expect(queryByTestId('monitorDetailFlyoutSloBacklink')).not.toBeInTheDocument();
  });

  it('renders the SLO backlink with slo_name when present', () => {
    const { getByTestId } = render(
      <MonitorDetailFlyout
        monitor={{
          ...mockMonitor,
          labels: { slo_id: 'slo-abc', slo_name: 'api-availability' },
        }}
        apiClient={mockApiClient as never}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    const link = getByTestId('monitorDetailFlyoutSloBacklink');
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent('View SLO: api-availability');
  });

  it('falls back to slo_id when slo_name is absent', () => {
    const { getByTestId } = render(
      <MonitorDetailFlyout
        monitor={{ ...mockMonitor, labels: { slo_id: 'slo-legacy' } }}
        apiClient={mockApiClient as never}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    expect(getByTestId('monitorDetailFlyoutSloBacklink')).toHaveTextContent('View SLO: slo-legacy');
  });

  it('navigates to the SLO detail page when the backlink is clicked', () => {
    const { getByTestId } = render(
      <MonitorDetailFlyout
        monitor={{
          ...mockMonitor,
          labels: { slo_id: 'slo abc/123', slo_name: 'payments-latency' },
        }}
        apiClient={mockApiClient as never}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    fireEvent.click(getByTestId('monitorDetailFlyoutSloBacklink'));
    expect(mockNavigateToApp).toHaveBeenCalledWith('observability-apm-slo', {
      path: `#/slos/${encodeURIComponent('slo abc/123')}`,
    });
  });
});
