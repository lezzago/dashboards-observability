/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** Typed timeout error for reliable detection without string matching. */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wrap a promise with a per-datasource timeout. Rejects with `TimeoutError`
 * when `ms` elapses before the underlying promise settles. Standalone (not
 * a class method) so the per-datasource paginated and facet paths can use
 * the same isolation contract as the legacy progressive `getUnifiedAlerts`
 * / `getUnifiedRules` helpers without crossing module boundaries.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new TimeoutError(message, ms));
      }
    }, ms);
    promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}
