/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import type { SloApiClient } from '../slo_api_client';
import type { PaginatedResponse } from '../../../../../../common/types/alerting/types';
import type { SloHealthState, SloSummary } from '../../../../../../common/slo/slo_types';
import { classifySloKind, rollupSloHealth, useServiceSloHealth } from '../slo_health_summary';

function makeSummary(
  overrides: Partial<SloSummary> & Pick<SloSummary, 'id' | 'service'>
): SloSummary {
  const { id, service, status, name, ...rest } = overrides;
  const state: SloHealthState = status?.state ?? 'ok';
  return {
    id,
    datasourceId: 'ds-1',
    datasourceType: 'prometheus',
    name: name ?? id,
    enabled: true,
    mode: 'active',
    service,
    owner: { teams: [] },
    sliNodeType: 'single',
    sliBackend: 'prometheus',
    sliLeafType: 'availability',
    objectiveCount: 1,
    worstTarget: 0.99,
    window: { type: 'rolling', duration: '28d' },
    labels: {},
    status: {
      sloId: id,
      objectives: [],
      state,
      firingCount: 0,
      ruleCount: 1,
      computedAt: '2026-05-01T00:00:00Z',
      ...(status ?? {}),
    },
    ...rest,
  } as SloSummary;
}

describe('classifySloKind (heuristic)', () => {
  it('maps prometheus + availability leaf to apm-availability', () => {
    const slo = makeSummary({
      id: 'a',
      service: 'foo',
      sliBackend: 'prometheus',
      sliLeafType: 'availability',
    });
    expect(classifySloKind(slo)).toBe('apm-availability');
  });

  it('maps prometheus + latency_threshold leaf to apm-latency', () => {
    const slo = makeSummary({
      id: 'a',
      service: 'foo',
      sliBackend: 'prometheus',
      sliLeafType: 'latency_threshold',
    });
    expect(classifySloKind(slo)).toBe('apm-latency');
  });

  it('returns undefined for opensearch-backed SLIs', () => {
    const slo = makeSummary({
      id: 'a',
      service: 'foo',
      sliBackend: 'opensearch',
      sliLeafType: 'availability',
    });
    expect(classifySloKind(slo)).toBeUndefined();
  });

  it('returns undefined for unknown leaf types', () => {
    const slo = makeSummary({
      id: 'a',
      service: 'foo',
      sliBackend: 'prometheus',
      sliLeafType: 'error_count',
    });
    expect(classifySloKind(slo)).toBeUndefined();
  });
});

describe('rollupSloHealth', () => {
  it('returns empty per-service buckets with missingCanonicalPair=true', () => {
    const { bySvc, aggregate } = rollupSloHealth(['foo', 'bar'], []);
    expect(bySvc.get('foo')).toMatchObject({
      total: 0,
      hasAvailability: false,
      hasLatency: false,
      missingCanonicalPair: true,
    });
    expect(bySvc.get('bar')).toBeDefined();
    expect(aggregate.total).toBe(0);
    expect(aggregate.missingCanonicalPair).toBe(true);
  });

  it('counts state buckets using the `no_data` underscore value', () => {
    const summaries = [
      makeSummary({ id: 'a', service: 'foo', status: { state: 'ok' } as any }),
      makeSummary({ id: 'b', service: 'foo', status: { state: 'no_data' } as any }),
      makeSummary({ id: 'c', service: 'foo', status: { state: 'breached' } as any }),
    ];
    const { bySvc, aggregate } = rollupSloHealth(['foo'], summaries);
    const foo = bySvc.get('foo')!;
    expect(foo).toMatchObject({ total: 3, ok: 1, noData: 1, breached: 1 });
    expect(aggregate).toMatchObject({ total: 3, ok: 1, noData: 1, breached: 1 });
  });

  it('detects a complete canonical pair', () => {
    const summaries = [
      makeSummary({
        id: 'a',
        service: 'foo',
        sliBackend: 'prometheus',
        sliLeafType: 'availability',
      }),
      makeSummary({
        id: 'b',
        service: 'foo',
        sliBackend: 'prometheus',
        sliLeafType: 'latency_threshold',
      }),
    ];
    const { bySvc, aggregate } = rollupSloHealth(['foo'], summaries);
    expect(bySvc.get('foo')).toMatchObject({
      hasAvailability: true,
      hasLatency: true,
      missingCanonicalPair: false,
    });
    expect(aggregate.missingCanonicalPair).toBe(false);
  });

  it('flags aggregate missingCanonicalPair when any service is incomplete', () => {
    const summaries = [
      makeSummary({
        id: 'a',
        service: 'foo',
        sliBackend: 'prometheus',
        sliLeafType: 'availability',
      }),
      makeSummary({
        id: 'b',
        service: 'foo',
        sliBackend: 'prometheus',
        sliLeafType: 'latency_threshold',
      }),
      makeSummary({
        id: 'c',
        service: 'bar',
        sliBackend: 'prometheus',
        sliLeafType: 'availability',
      }),
    ];
    const { bySvc, aggregate } = rollupSloHealth(['foo', 'bar'], summaries);
    expect(bySvc.get('foo')!.missingCanonicalPair).toBe(false);
    expect(bySvc.get('bar')!.missingCanonicalPair).toBe(true);
    expect(aggregate.missingCanonicalPair).toBe(true);
  });

  it('ignores summaries for services outside the requested set', () => {
    const summaries = [
      makeSummary({ id: 'a', service: 'foo' }),
      makeSummary({ id: 'b', service: 'orphan' }),
    ];
    const { bySvc, aggregate } = rollupSloHealth(['foo'], summaries);
    expect(bySvc.has('orphan')).toBe(false);
    expect(aggregate.total).toBe(1);
    expect(bySvc.get('foo')!.total).toBe(1);
  });
});

describe('useServiceSloHealth', () => {
  function makeApiClient(list: jest.Mock): SloApiClient {
    return ({ list } as unknown) as SloApiClient;
  }

  function page(
    results: SloSummary[],
    opts: Partial<Omit<PaginatedResponse<SloSummary>, 'results'>> = {}
  ): PaginatedResponse<SloSummary> {
    return {
      results,
      total: opts.total ?? results.length,
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? results.length,
      hasMore: opts.hasMore ?? false,
    };
  }

  it('returns empty buckets and does not fetch when datasourceId is absent', async () => {
    const list = jest.fn();
    const apiClient = makeApiClient(list);
    const { result } = renderHook(() =>
      useServiceSloHealth({
        serviceNames: ['foo'],
        datasourceId: '',
        apiClient,
      })
    );
    expect(result.current.isLoading).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(result.current.aggregate.total).toBe(0);
    // Buckets are still materialized for each requested service (counts zero).
    expect(result.current.bySvc.get('foo')).toMatchObject({ total: 0 });
  });

  it('returns empty buckets and does not fetch when serviceNames is empty', () => {
    const list = jest.fn();
    const apiClient = makeApiClient(list);
    const { result } = renderHook(() =>
      useServiceSloHealth({
        serviceNames: [],
        datasourceId: 'ds-1',
        apiClient,
      })
    );
    expect(list).not.toHaveBeenCalled();
    expect(result.current.aggregate.total).toBe(0);
  });

  it('fetches, classifies, and rolls up summaries into per-service buckets', async () => {
    const list = jest.fn().mockResolvedValue(
      page([
        makeSummary({
          id: 'a',
          service: 'foo',
          sliBackend: 'prometheus',
          sliLeafType: 'availability',
          status: { state: 'ok' } as any,
        }),
        makeSummary({
          id: 'b',
          service: 'foo',
          sliBackend: 'prometheus',
          sliLeafType: 'latency_threshold',
          status: { state: 'breached' } as any,
        }),
        makeSummary({
          id: 'c',
          service: 'bar',
          sliBackend: 'prometheus',
          sliLeafType: 'availability',
          status: { state: 'no_data' } as any,
        }),
      ])
    );
    const apiClient = makeApiClient(list);

    const { result } = renderHook(() =>
      useServiceSloHealth({
        serviceNames: ['foo', 'bar'],
        datasourceId: 'ds-1',
        apiClient,
      })
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        service: ['foo', 'bar'],
        datasourceId: ['ds-1'],
        pageSize: 50,
        page: 1,
      })
    );
    expect(result.current.bySvc.get('foo')).toMatchObject({
      total: 2,
      ok: 1,
      breached: 1,
      hasAvailability: true,
      hasLatency: true,
      missingCanonicalPair: false,
    });
    expect(result.current.bySvc.get('bar')).toMatchObject({
      total: 1,
      noData: 1,
      hasAvailability: true,
      hasLatency: false,
      missingCanonicalPair: true,
    });
    expect(result.current.aggregate.total).toBe(3);
  });

  it('pages through when total exceeds pageSize and warns', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const services = Array.from({ length: 20 }, (_, i) => `svc-${i}`);
    // First call returns pageSize=80 results with total=81 (forces a second page).
    const firstResults = Array.from({ length: 80 }, (_, i) =>
      makeSummary({ id: `a-${i}`, service: services[i % services.length] })
    );
    const secondResults = [makeSummary({ id: 'b-0', service: services[0] })];
    const list = jest
      .fn()
      .mockResolvedValueOnce(
        page(firstResults, { total: 81, pageSize: 80, page: 1, hasMore: true })
      )
      .mockResolvedValueOnce(
        page(secondResults, { total: 81, pageSize: 80, page: 2, hasMore: false })
      );
    const apiClient = makeApiClient(list);

    const { result } = renderHook(() =>
      useServiceSloHealth({
        serviceNames: services,
        datasourceId: 'ds-1',
        apiClient,
      })
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({ page: 2 });
    expect(warn).toHaveBeenCalled();
    expect(result.current.aggregate.total).toBe(81);
    warn.mockRestore();
  });

  it('surfaces fetch errors', async () => {
    const list = jest.fn().mockRejectedValue(new Error('boom'));
    const apiClient = makeApiClient(list);
    const { result } = renderHook(() =>
      useServiceSloHealth({
        serviceNames: ['foo'],
        datasourceId: 'ds-1',
        apiClient,
      })
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toEqual(new Error('boom'));
    expect(result.current.aggregate.total).toBe(0);
  });

  it('does not refetch when serviceNames identity changes but content matches', async () => {
    const list = jest.fn().mockResolvedValue(page([]));
    const apiClient = makeApiClient(list);
    const { rerender } = renderHook(
      ({ names }) =>
        useServiceSloHealth({
          serviceNames: names,
          datasourceId: 'ds-1',
          apiClient,
        }),
      { initialProps: { names: ['foo', 'bar'] } }
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    rerender({ names: ['bar', 'foo'] }); // same set, different order + identity
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refetches when refetch() is called', async () => {
    const list = jest.fn().mockResolvedValue(page([]));
    const apiClient = makeApiClient(list);
    const { result } = renderHook(() =>
      useServiceSloHealth({
        serviceNames: ['foo'],
        datasourceId: 'ds-1',
        apiClient,
      })
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
