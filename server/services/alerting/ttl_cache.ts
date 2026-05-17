/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generic TTL cache with shared in-flight promise semantics.
 *
 * Phase 4 uses two instances on `DirectQueryPrometheusBackend` — one for
 * alert listings, one for rule-group listings — so the alerts table and
 * rules table can re-issue filter changes within 30s without thrashing
 * the upstream when filter pushdown isn't available (`pushdown-ignored`
 * / `unknown` per the Phase 3 probe).
 *
 * Two typed caches instead of one mixed-type map: keeps call-site casts
 * out of the hot path.
 */
export class TtlCache<K, V> {
  private store = new Map<K, { value?: V; expiresAt: number; inflight?: Promise<V> }>();

  constructor(private readonly ttlMs: number = 30_000) {}

  async get(key: K, fetcher: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry) {
      if (entry.value !== undefined && entry.expiresAt > now) return entry.value;
      if (entry.inflight) return entry.inflight;
    }
    const inflight = fetcher();
    this.store.set(key, { expiresAt: 0, inflight });
    try {
      const value = await inflight;
      this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      return value;
    } catch (err) {
      this.store.delete(key);
      throw err;
    }
  }

  invalidate(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
