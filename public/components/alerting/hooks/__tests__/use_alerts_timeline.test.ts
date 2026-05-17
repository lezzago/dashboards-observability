/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor } from '@testing-library/react';

const mockListAlertsTimeline = jest.fn();

jest.mock('../../query_services/alerting_opensearch_service', () => ({
  AlertingOpenSearchService: jest.fn().mockImplementation(() => ({
    listAlertsTimeline: mockListAlertsTimeline,
  })),
}));

import { useAlertsTimeline } from '../use_alerts_timeline';

const emptyResponse = {
  buckets: [],
  bucketCount: 12,
  bucketDurationMs: 5 * 60 * 1000,
  datasourceStatus: [],
  fetchedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  mockListAlertsTimeline.mockReset();
  mockListAlertsTimeline.mockResolvedValue(emptyResponse);
});

describe('useAlertsTimeline', () => {
  it('does not call listAlertsTimeline when dsIds is empty', async () => {
    renderHook(() => useAlertsTimeline({ dsIds: [], startTime: 'now-1h', endTime: 'now' }));
    await waitFor(() => {
      expect(mockListAlertsTimeline).not.toHaveBeenCalled();
    });
  });

  it('does not call listAlertsTimeline when startTime/endTime are missing', async () => {
    renderHook(() => useAlertsTimeline({ dsIds: ['ds-1'] }));
    await waitFor(() => {
      expect(mockListAlertsTimeline).not.toHaveBeenCalled();
    });
  });

  it('forwards a derived bucket count when none is supplied', async () => {
    renderHook(() => useAlertsTimeline({ dsIds: ['ds-1'], startTime: 'now-1h', endTime: 'now' }));
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(1));
    // Each `parseDateMathMs(start)` and `parseDateMathMs(end)` call captures
    // `now` separately, so the resulting `(end - start)` may be exactly
    // 3_600_000 ms (→ ceil = 12 buckets) or a microsecond more (→ 13). Both
    // fall inside `[MIN_BUCKETS=12, MAX_BUCKETS=24]` and either is correct.
    expect(mockListAlertsTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        dsIds: ['ds-1'],
        startTime: 'now-1h',
        endTime: 'now',
      })
    );
    const lastBuckets = mockListAlertsTimeline.mock.calls[0][0].buckets;
    expect(lastBuckets).toBeGreaterThanOrEqual(12);
    expect(lastBuckets).toBeLessThanOrEqual(24);
  });

  it('forwards severity / state / labels filters as the service params', async () => {
    renderHook(() =>
      useAlertsTimeline({
        dsIds: ['ds-1'],
        startTime: 'now-1h',
        endTime: 'now',
        severity: ['critical'],
        state: ['active'],
        labels: { service: ['cart'] },
      })
    );
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(1));
    expect(mockListAlertsTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: ['critical'],
        state: ['active'],
        labels: { service: ['cart'] },
      })
    );
  });

  it('refetches when severity changes', async () => {
    const { rerender } = renderHook(
      ({ severity }: { severity: string[] | undefined }) =>
        useAlertsTimeline({
          dsIds: ['ds-1'],
          startTime: 'now-1h',
          endTime: 'now',
          severity,
        }),
      { initialProps: { severity: undefined as string[] | undefined } }
    );
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(1));
    rerender({ severity: ['critical'] });
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(2));
  });

  it('passes an AbortSignal to the service that aborts on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockListAlertsTimeline.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      capturedSignal = signal;
      return Promise.resolve(emptyResponse);
    });
    const { unmount } = renderHook(() =>
      useAlertsTimeline({ dsIds: ['ds-1'], startTime: 'now-1h', endTime: 'now' })
    );
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(1));
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('discards stale responses when a newer request has already started', async () => {
    let resolveFirst: (value: typeof emptyResponse) => void = () => {};
    const firstPromise = new Promise<typeof emptyResponse>((res) => {
      resolveFirst = res;
    });
    mockListAlertsTimeline.mockImplementationOnce(() => firstPromise);
    mockListAlertsTimeline.mockImplementationOnce(() =>
      Promise.resolve({ ...emptyResponse, bucketCount: 24 })
    );

    const { result, rerender } = renderHook(
      ({ startTime }: { startTime: string }) =>
        useAlertsTimeline({ dsIds: ['ds-1'], startTime, endTime: 'now' }),
      { initialProps: { startTime: 'now-1h' } }
    );
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(1));
    rerender({ startTime: 'now-2h' });
    await waitFor(() => expect(mockListAlertsTimeline).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.data?.bucketCount).toBe(24));
    // Now resolve the first request — its result must be discarded.
    resolveFirst({ ...emptyResponse, bucketCount: 999 });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.data?.bucketCount).toBe(24);
  });

  it('surfaces non-abort errors', async () => {
    mockListAlertsTimeline.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() =>
      useAlertsTimeline({ dsIds: ['ds-1'], startTime: 'now-1h', endTime: 'now' })
    );
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.error?.message).toBe('boom');
  });
});
