/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';

jest.mock('../../../framework/core_refs', () => ({
  coreRefs: {
    http: { basePath: { get: jest.fn().mockReturnValue('') } },
    toasts: { addWarning: jest.fn() },
  },
}));

jest.mock('../../../../common/utils/set_nav_bread_crumbs', () => ({
  setNavBreadCrumbs: jest.fn(),
}));

jest.mock('../../../../../../src/plugins/opensearch_dashboards_react/public', () => ({
  toMountPoint: jest.fn((node: unknown) => node),
}));

jest.mock('../../common/toast', () => ({
  useToast: () => ({ setToast: jest.fn() }),
}));

// Stub heavy child components — use data-test-subj (project convention)
jest.mock('../alerts_dashboard', () => ({
  AlertsDashboard: () => <div data-test-subj="alerts-dashboard" />,
}));
jest.mock('../monitors_table', () => ({
  MonitorsTable: (props: { initialLabelFilters?: Record<string, string[]> }) => (
    <div
      data-test-subj="monitors-table"
      data-initial-labels={JSON.stringify(props.initialLabelFilters ?? {})}
    />
  ),
}));
jest.mock('../notification_routing_panel', () => ({
  NotificationRoutingPanel: () => <div data-test-subj="routing-panel" />,
}));
jest.mock('../create_monitor', () => ({ CreateMonitor: () => null }));
jest.mock('../create_logs_monitor', () => ({ CreateLogsMonitor: () => null }));
jest.mock('../create_metrics_monitor', () => ({ CreateMetricsMonitor: () => null }));
jest.mock('../alert_detail_flyout', () => ({ AlertDetailFlyout: () => null }));

import { AlarmsApiClient } from '../services/alarms_client';
import { AlarmsPage } from '../alarms_page';

const makeApiClient = () =>
  (({
    listDatasources: jest.fn().mockResolvedValue([]),
    listAlertsPaginated: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    listRulesPaginated: jest.fn().mockResolvedValue({ results: [], total: 0 }),
  } as unknown) as AlarmsApiClient);

// AlarmsPage reads URL query params via `useLocation()` (react-router-dom
// v5). Wrap in a MemoryRouter so hooks have a context and we can seed the
// search string per-test.
function renderAt(initialEntry: string, initialTab?: 'alerts' | 'rules' | 'routing') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Route
        render={() => (
          <AlarmsPage
            apiClient={makeApiClient()}
            defaultDatasources={[]}
            maxDatasources={5}
            initialTab={initialTab}
          />
        )}
      />
    </MemoryRouter>
  );
}

describe('AlarmsPage', () => {
  it('renders tabs and defaults to Alerts tab', async () => {
    await act(async () => {
      renderAt('/alerts');
    });
    expect(screen.getByTestId('alerts-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('alertManager-tabs-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('alertManager-tabs-rules')).toBeInTheDocument();
    expect(screen.getByTestId('alertManager-tabs-routing')).toBeInTheDocument();
  });

  it('switches to Rules tab on click', async () => {
    await act(async () => {
      renderAt('/alerts');
    });
    fireEvent.click(screen.getByTestId('alertManager-tabs-rules'));
    expect(screen.getByTestId('monitors-table')).toBeInTheDocument();
  });

  it('opens on the Rules tab when initialTab="rules"', async () => {
    await act(async () => {
      renderAt('/rules', 'rules');
    });
    expect(screen.getByTestId('monitors-table')).toBeInTheDocument();
  });

  it('forwards query-string params as initial label filters to MonitorsTable', async () => {
    await act(async () => {
      renderAt('/rules?slo_id=abc-123&slo_burn_rate_multiplier=14.4', 'rules');
    });
    const table = screen.getByTestId('monitors-table');
    const initialLabels = JSON.parse(table.getAttribute('data-initial-labels') ?? '{}');
    expect(initialLabels).toEqual({
      slo_id: ['abc-123'],
      slo_burn_rate_multiplier: ['14.4'],
    });
  });

  it('passes an empty label-filter map when no query string is present', async () => {
    await act(async () => {
      renderAt('/rules', 'rules');
    });
    const table = screen.getByTestId('monitors-table');
    const initialLabels = JSON.parse(table.getAttribute('data-initial-labels') ?? 'null');
    expect(initialLabels).toEqual({});
  });
});
