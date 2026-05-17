/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor, act } from '@testing-library/react';

const mockListRuleFacets = jest.fn();

jest.mock('../../query_services/alerting_opensearch_service', () => ({
  AlertingOpenSearchService: jest.fn().mockImplementation(() => ({
    listRuleFacets: mockListRuleFacets,
  })),
}));

import { useRulesFacets } from '../use_rules_facets';

const emptyResponse = {
  status: {},
  severity: {},
  monitorType: {},
  healthStatus: {},
  backend: {},
  createdBy: {},
  labels: {},
  total: 0,
  fetchedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  mockListRuleFacets.mockReset();
  mockListRuleFacets.mockResolvedValue(emptyResponse);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useRulesFacets', () => {
  it('forwards rule-table dimensional filters to the service', async () => {
    renderHook(() =>
      useRulesFacets({
        dsIds: ['ds-1'],
        status: ['active'],
        severity: ['critical'],
        monitorType: ['metric'],
        healthStatus: ['healthy'],
        createdBy: ['admin'],
        labels: { region: ['us-east-1'] },
        search: 'CPU',
      })
    );
    act(() => {
      jest.advanceTimersByTime(200);
    });
    jest.useRealTimers();
    await waitFor(() => expect(mockListRuleFacets).toHaveBeenCalledTimes(1));
    expect(mockListRuleFacets).toHaveBeenCalledWith(
      expect.objectContaining({
        dsIds: ['ds-1'],
        // The hook maps `status` → server-wire `state`.
        state: ['active'],
        severity: ['critical'],
        monitorType: ['metric'],
        healthStatus: ['healthy'],
        createdBy: ['admin'],
        labels: { region: ['us-east-1'] },
        search: 'CPU',
      })
    );
  });

  it('does not call when dsIds is empty', () => {
    renderHook(() => useRulesFacets({ dsIds: [] }));
    act(() => {
      jest.runAllTimers();
    });
    expect(mockListRuleFacets).not.toHaveBeenCalled();
  });
});
