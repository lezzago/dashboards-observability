/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor, act } from '@testing-library/react';

const mockListAlertFacets = jest.fn();

jest.mock('../../query_services/alerting_opensearch_service', () => ({
  AlertingOpenSearchService: jest.fn().mockImplementation(() => ({
    listAlertFacets: mockListAlertFacets,
  })),
}));

import { useAlertsFacets } from '../use_alerts_facets';

const emptyResponse = {
  severity: {},
  state: {},
  backend: {},
  labels: {},
  total: 0,
  fetchedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  mockListAlertFacets.mockReset();
  mockListAlertFacets.mockResolvedValue(emptyResponse);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useAlertsFacets', () => {
  it('does not call when dsIds is empty', async () => {
    renderHook(() => useAlertsFacets({ dsIds: [] }));
    act(() => {
      jest.runAllTimers();
    });
    expect(mockListAlertFacets).not.toHaveBeenCalled();
  });

  it('debounces 200ms before firing the service call', async () => {
    renderHook(() => useAlertsFacets({ dsIds: ['ds-1'] }));
    expect(mockListAlertFacets).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(mockListAlertFacets).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    jest.useRealTimers();
    await waitFor(() => expect(mockListAlertFacets).toHaveBeenCalledTimes(1));
  });

  it('coalesces rapid filter changes within the debounce window', async () => {
    const { rerender } = renderHook(
      ({ severity }: { severity: string[] }) => useAlertsFacets({ dsIds: ['ds-1'], severity }),
      { initialProps: { severity: ['critical'] } }
    );
    rerender({ severity: ['high'] });
    rerender({ severity: ['medium'] });
    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(mockListAlertFacets).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    jest.useRealTimers();
    // Only the final severity request should fire — earlier debounced
    // timers were cleared on each rerender.
    await waitFor(() => expect(mockListAlertFacets).toHaveBeenCalledTimes(1));
    expect(mockListAlertFacets).toHaveBeenLastCalledWith(
      expect.objectContaining({ severity: ['medium'] })
    );
  });

  it('passes filter params straight through to the service', async () => {
    renderHook(() =>
      useAlertsFacets({
        dsIds: ['ds-1'],
        severity: ['critical'],
        state: ['active'],
        labels: { team: ['infra'] },
        search: 'CPU',
        startTime: 'now-1h',
        endTime: 'now',
      })
    );
    act(() => {
      jest.advanceTimersByTime(200);
    });
    jest.useRealTimers();
    await waitFor(() => expect(mockListAlertFacets).toHaveBeenCalledTimes(1));
    expect(mockListAlertFacets).toHaveBeenCalledWith(
      expect.objectContaining({
        dsIds: ['ds-1'],
        severity: ['critical'],
        state: ['active'],
        labels: { team: ['infra'] },
        search: 'CPU',
        startTime: 'now-1h',
        endTime: 'now',
      })
    );
  });

  it('sets noCache=true when refreshToken bumps', async () => {
    const { rerender } = renderHook(
      ({ refreshToken }: { refreshToken: number }) =>
        useAlertsFacets({ dsIds: ['ds-1'], refreshToken }),
      { initialProps: { refreshToken: 0 } }
    );
    act(() => {
      jest.advanceTimersByTime(200);
    });
    jest.useRealTimers();
    await waitFor(() => expect(mockListAlertFacets).toHaveBeenCalledTimes(1));
    // Initial call: not force-fresh.
    expect(mockListAlertFacets.mock.calls[0][0].noCache).toBeUndefined();

    jest.useFakeTimers();
    rerender({ refreshToken: 1 });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    jest.useRealTimers();
    await waitFor(() => expect(mockListAlertFacets).toHaveBeenCalledTimes(2));
    expect(mockListAlertFacets.mock.calls[1][0].noCache).toBe(true);
  });
});
