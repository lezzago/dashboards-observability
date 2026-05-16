/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';

// Flyout doesn't use echarts directly, but some transitive imports from
// shared_constants / child components can reach it — stub for safety.
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

// AlertDetailFlyout instantiates AlertingOpenSearchService internally via
// `useMemo(() => new AlertingOpenSearchService(), [])`. Phase 1 made the
// detail fetch lazy — it only fires when the user expands the Raw Alert
// Data accordion. The mock is hoisted into a module-level shared instance
// so individual tests can read `mockGetAlertDetail.mock.calls`.
const mockGetAlertDetail = jest.fn().mockResolvedValue(null);
jest.mock('../query_services/alerting_opensearch_service', () => ({
  AlertingOpenSearchService: jest.fn().mockImplementation(() => ({
    getAlertDetail: mockGetAlertDetail,
  })),
}));

import { AlertDetailFlyout } from '../alert_detail_flyout';
import type { Datasource, UnifiedAlertSummary } from '../../../../common/types/alerting';

const baseAlert: UnifiedAlertSummary = {
  id: 'alert-42',
  datasourceId: 'ds-prom',
  datasourceType: 'opensearch',
  name: 'HighErrorRate',
  state: 'active',
  severity: 'critical',
  message: 'Error rate above threshold',
  startTime: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastUpdated: new Date().toISOString(),
  labels: { team: 'infra', service: 'api-gateway' },
  annotations: { summary: 'Error rate above threshold' },
};

const datasources: Datasource[] = [
  {
    id: 'ds-prom',
    name: 'my-prom',
    type: 'prometheus',
    url: 'http://prom',
    enabled: true,
  },
];

describe('AlertDetailFlyout', () => {
  beforeEach(() => {
    mockGetAlertDetail.mockClear();
  });

  it('does not fetch alert detail on mount (lazy-loaded with the Raw Alert Data accordion)', () => {
    render(
      <AlertDetailFlyout
        alert={baseAlert}
        datasources={datasources}
        onClose={jest.fn()}
        onAcknowledge={jest.fn()}
      />
    );
    expect(mockGetAlertDetail).not.toHaveBeenCalled();
  });

  it('fetches alert detail when the Raw Alert Data accordion is expanded, forwarding monitorId', async () => {
    const alertWithMonitor: UnifiedAlertSummary = { ...baseAlert, monitorId: 'mon-7' };
    const { getByText } = render(
      <AlertDetailFlyout
        alert={alertWithMonitor}
        datasources={datasources}
        onClose={jest.fn()}
        onAcknowledge={jest.fn()}
      />
    );
    fireEvent.click(getByText('Raw Alert Data'));
    await waitFor(() => expect(mockGetAlertDetail).toHaveBeenCalledTimes(1));
    expect(mockGetAlertDetail).toHaveBeenCalledWith('ds-prom', 'alert-42', 'mon-7');
  });

  it('smoke renders with the alert name, severity, and datasource label', () => {
    const { getByText, getAllByText } = render(
      <AlertDetailFlyout
        alert={baseAlert}
        datasources={datasources}
        onClose={jest.fn()}
        onAcknowledge={jest.fn()}
      />
    );
    expect(getByText('HighErrorRate')).toBeInTheDocument();
    expect(getByText('OpenSearch')).toBeInTheDocument();
    // Message appears both in the header and as the `summary` annotation below.
    expect(getAllByText('Error rate above threshold').length).toBeGreaterThan(0);
  });

  it('invokes onClose when the footer close button is clicked', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <AlertDetailFlyout
        alert={baseAlert}
        datasources={datasources}
        onClose={onClose}
        onAcknowledge={jest.fn()}
      />
    );
    fireEvent.click(getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onAcknowledge for an active OpenSearch alert when the Acknowledge button is clicked', () => {
    const onAcknowledge = jest.fn();
    const { getByText } = render(
      <AlertDetailFlyout
        alert={baseAlert}
        datasources={datasources}
        onClose={jest.fn()}
        onAcknowledge={onAcknowledge}
      />
    );
    fireEvent.click(getByText('Acknowledge'));
    expect(onAcknowledge).toHaveBeenCalledWith('alert-42');
  });

  it('disables the Acknowledge button for Prometheus alerts', () => {
    const onAcknowledge = jest.fn();
    const promAlert = { ...baseAlert, datasourceType: 'prometheus' as const };
    const { getByText } = render(
      <AlertDetailFlyout
        alert={promAlert}
        datasources={datasources}
        onClose={jest.fn()}
        onAcknowledge={onAcknowledge}
      />
    );
    const btn = getByText('Acknowledge').closest('button');
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(true);
    expect(btn && btn.disabled).toBe(true);
    fireEvent.click(getByText('Acknowledge'));
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  describe('runbook URL sanitization', () => {
    it('does not render the runbook as a link when the URL uses a javascript: protocol', () => {
      const alertWithBadUrl: UnifiedAlertSummary = {
        ...baseAlert,
        annotations: {
          ...baseAlert.annotations,
          // eslint-disable-next-line no-script-url
          runbook_url: 'javascript:alert(document.cookie)',
        },
      };
      const { getByText } = render(
        <AlertDetailFlyout
          alert={alertWithBadUrl}
          datasources={datasources}
          onClose={jest.fn()}
          onAcknowledge={jest.fn()}
        />
      );
      const runbookTitle = getByText('Check related runbook');
      expect(runbookTitle.closest('a')).toBeNull();
    });

    it('renders the runbook as an external link with rel="noopener noreferrer" for an https URL', () => {
      const alertWithGoodUrl: UnifiedAlertSummary = {
        ...baseAlert,
        annotations: {
          ...baseAlert.annotations,
          runbook_url: 'https://runbooks.example.com/high-error-rate',
        },
      };
      const { getByText } = render(
        <AlertDetailFlyout
          alert={alertWithGoodUrl}
          datasources={datasources}
          onClose={jest.fn()}
          onAcknowledge={jest.fn()}
        />
      );
      const runbookTitle = getByText('Check related runbook');
      const anchor = runbookTitle.closest('a');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe('https://runbooks.example.com/high-error-rate');
      expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(anchor?.getAttribute('target')).toBe('_blank');
    });

    it('does not render the runbook as a link when no URL is configured', () => {
      const { getByText } = render(
        <AlertDetailFlyout
          alert={baseAlert}
          datasources={datasources}
          onClose={jest.fn()}
          onAcknowledge={jest.fn()}
        />
      );
      const runbookTitle = getByText('Check related runbook');
      expect(runbookTitle.closest('a')).toBeNull();
    });
  });
});
