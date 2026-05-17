/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: jest.fn(),
    resize: jest.fn(),
    dispose: jest.fn(),
  })),
}));

global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  disconnect: jest.fn(),
  unobserve: jest.fn(),
}));

// Post-Phase 4: MonitorDetailFlyout instantiates AlertingOpenSearchService
// internally via `useMemo(() => new AlertingOpenSearchService(), [])` and
// calls `getRuleDetail(dsId, ruleId)` on mount. Mock the class so the
// constructor returns a stubbed instance with `getRuleDetail` resolving to
// `null` — the flyout falls back to the monitor summary in that case,
// which is what these render tests exercise. `getRuleRouting` is the
// Phase-3 lazy fetch the Notification Routing accordion calls on expand.
// Variable name MUST start with `mock` so the jest hoist rule allows it.
const mockGetRuleRouting = jest.fn().mockResolvedValue([]);
jest.mock('../query_services/alerting_opensearch_service', () => ({
  AlertingOpenSearchService: jest.fn().mockImplementation(() => ({
    getRuleDetail: jest.fn().mockResolvedValue(null),
    getRuleRouting: mockGetRuleRouting,
  })),
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

describe('MonitorDetailFlyout', () => {
  beforeEach(() => {
    mockGetRuleRouting.mockClear();
    mockGetRuleRouting.mockResolvedValue([]);
  });

  it('renders flyout with monitor name', () => {
    const { getByText } = render(
      <MonitorDetailFlyout
        monitor={mockMonitor}
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
        onClose={onClose}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    fireEvent.click(getByLabelText('Close this dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call getRuleRouting on initial render (lazy)', async () => {
    render(
      <MonitorDetailFlyout
        monitor={mockMonitor}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    // Wait one microtask so the detail-fetch effect resolves; then assert.
    await Promise.resolve();
    expect(mockGetRuleRouting).not.toHaveBeenCalled();
  });

  it('lazy-loads routing exactly once when the accordion is expanded', async () => {
    render(
      <MonitorDetailFlyout
        monitor={mockMonitor}
        onClose={jest.fn()}
        onDelete={jest.fn()}
        onClone={jest.fn()}
      />
    );
    // EuiFlyout renders to a portal under document.body, not inside the
    // RTL container. Wait until the routing accordion's button (which EUI
    // wires via aria-controls referring to the accordion id) shows up.
    const trigger = await waitFor(() => {
      const el = document.querySelector(
        'button[aria-controls="routing-mon-1"]'
      ) as HTMLButtonElement | null;
      if (!el) throw new Error('routing accordion button not yet rendered');
      return el;
    });
    fireEvent.click(trigger);
    expect(mockGetRuleRouting).toHaveBeenCalledTimes(1);
    expect(mockGetRuleRouting).toHaveBeenCalledWith('ds-1', 'mon-1');
    // Collapse then expand — no second fetch.
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(mockGetRuleRouting).toHaveBeenCalledTimes(1);
  });
});
