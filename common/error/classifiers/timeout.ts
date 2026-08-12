/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classifies client- or server-side timeouts. Matches an aborted request
 * (`AbortController` → `AbortError`), an HTTP 408, or a "timed out" message,
 * so both the acknowledge abort path and upstream request-timeouts land in the
 * TIMEOUT category consistently.
 */

import { ErrorCode } from '../messages';
import type { ErrorClassifier, RawErrorContext } from '../types';

function looksLikeTimeout(ctx: RawErrorContext): boolean {
  if (ctx.errorName === 'AbortError' || ctx.errorName === 'TimeoutError') return true;
  if (ctx.httpStatus === 408 || ctx.httpStatus === 504) return true;
  return typeof ctx.message === 'string' && /timed out|timeout/i.test(ctx.message);
}

export const timeoutClassifier: ErrorClassifier = {
  name: 'core.timeout',
  priority: 60,
  match: looksLikeTimeout,
  classify: (ctx) => ({
    category: 'TIMEOUT',
    code: ErrorCode.REQUEST_TIMEOUT,
    retryable: true,
    httpStatus: ctx.httpStatus,
  }),
};
