/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Highest-priority classifier: inspect the *inner* upstream cause rather than
 * trusting the outer status. Upstream layers routinely wrap a specific failure
 * (e.g. a 409 "already exists" conflict) inside a generic 5xx envelope. When
 * the raw body / message reveals a more specific cause, we classify on that.
 *
 * Kept deliberately conservative — it only overrides when the inner signal is
 * unambiguous, so it never mis-promotes a generic 5xx into a conflict.
 */

import { ErrorCode } from '../messages';
import type { ErrorClassifier, RawErrorContext } from '../types';
import { rawDetails, stringifyRaw } from './util';

function haystack(ctx: RawErrorContext): string {
  return `${stringifyRaw(ctx.rawBody)}\n${ctx.message ?? ''}`;
}

/** Unambiguous "resource already exists" conflict wrapped in another status. */
function hasInnerConflict(text: string): boolean {
  return /already exists/i.test(text) || /\bHTTP 409\b/i.test(text) || /\b409\b\s*-/.test(text);
}

export const upstreamWrappedClassifier: ErrorClassifier = {
  name: 'core.upstreamWrapped',
  priority: 100,
  match: (ctx) => hasInnerConflict(haystack(ctx)),
  classify: (ctx) => ({
    category: 'CONFLICT',
    code: ErrorCode.RULE_GROUP_CONFLICT,
    retryable: false,
    // Normalize to the true inner status — the outer 5xx was misleading.
    httpStatus: 409,
    details: rawDetails(ctx.rawBody),
  }),
};
