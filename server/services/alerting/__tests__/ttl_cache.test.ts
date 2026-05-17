/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { TtlCache } from '../ttl_cache';

describe('TtlCache', () => {
  it('returns the cached value within the TTL window', async () => {
    const cache = new TtlCache<string, number>(100);
    const fetcher = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.get('a', fetcher)).toBe(1);
    expect(await cache.get('a', fetcher)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    jest.useFakeTimers();
    try {
      const cache = new TtlCache<string, number>(100);
      const fetcher = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      expect(await cache.get('a', fetcher)).toBe(1);
      jest.advanceTimersByTime(101);
      expect(await cache.get('a', fetcher)).toBe(2);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares the inflight promise for concurrent requests', async () => {
    const cache = new TtlCache<string, number>(1000);
    let resolver: ((v: number) => void) | undefined;
    const fetcher = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          resolver = resolve;
        })
    );
    const a = cache.get('k', fetcher);
    const b = cache.get('k', fetcher);
    resolver!(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('drops the entry on a fetcher rejection', async () => {
    const cache = new TtlCache<string, number>(1000);
    const fetcher = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(7);
    await expect(cache.get('k', fetcher)).rejects.toThrow('boom');
    expect(await cache.get('k', fetcher)).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces a re-fetch on the next call', async () => {
    const cache = new TtlCache<string, number>(1000);
    const fetcher = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.get('a', fetcher)).toBe(1);
    cache.invalidate('a');
    expect(await cache.get('a', fetcher)).toBe(2);
  });
});
