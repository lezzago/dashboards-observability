/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Handler-level tests for W2.4 — admin `_reconcile` endpoint.
 *
 * Framework-agnostic: exercises `handleReconcile` directly, same pattern as
 * the sibling `handlers_repair_and_health.test.ts`. No real OSD router is
 * involved; the router-level wiring lives in `reconcile_route.ts` and is
 * exercised in Phase 2's integration suite (W2.7).
 */

import { handleReconcile } from '../reconcile_route';
import type { Logger } from '../../../../common/types/alerting/types';

function noopLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

/**
 * Minimal shape stand-in for the Phase-2 `ReconcileResult`. We don't import
 * the real type here — the handler treats the value as opaque and the peer
 * W2.1 agent owns the authoritative definition. This test only cares that
 * whatever object `reconcileOnce` resolves to round-trips through the
 * handler body unchanged.
 */
interface FakeReconcileResult {
  sweepId: string;
  datasourceIds: string[];
  orphans: number;
  missingRuleGroups: number;
  errors: number;
}

/**
 * Shape-matched fake of the (type-only) `SloReconciler` import in
 * `reconcile_route.ts`. Declared as a concrete interface so the mock
 * expectations are type-checked even though the real type is owned by the
 * peer agent.
 */
interface FakeReconciler {
  reconcileOnce: jest.Mock<Promise<FakeReconcileResult>, [{ datasourceIds?: string[] }]>;
}

function makeReconciler(result: FakeReconcileResult): FakeReconciler {
  return {
    reconcileOnce: jest.fn(async () => result),
  };
}

// Cast helper keeps the `any` off the call sites. The handler parameter is
// typed as `SloReconciler | undefined`, a type-only import that babel-jest
// erases at runtime, so a structurally compatible fake is sufficient.
function asReconciler(r: FakeReconciler | undefined) {
  return (r as unknown) as Parameters<typeof handleReconcile>[0];
}

describe('handleReconcile', () => {
  const fixtureResult: FakeReconcileResult = {
    sweepId: 'sweep-abc-123',
    datasourceIds: ['ds-a', 'ds-b'],
    orphans: 2,
    missingRuleGroups: 1,
    errors: 0,
  };

  it('returns 501 when the reconciler dep is missing', async () => {
    const result = await handleReconcile(asReconciler(undefined), undefined, noopLogger());

    expect(result.status).toBe(501);
    expect(result.body).toEqual({ error: 'Reconciler not configured in this environment' });
  });

  it('returns 200 with the ReconcileResult verbatim on happy path', async () => {
    const reconciler = makeReconciler(fixtureResult);

    const result = await handleReconcile(asReconciler(reconciler), undefined, noopLogger());

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ result: fixtureResult });
    expect(reconciler.reconcileOnce).toHaveBeenCalledTimes(1);
  });

  it('passes the datasource filter through to reconcileOnce', async () => {
    const reconciler = makeReconciler(fixtureResult);

    await handleReconcile(asReconciler(reconciler), ['ds-a', 'ds-b'], noopLogger());

    expect(reconciler.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileOnce).toHaveBeenCalledWith({
      datasourceIds: ['ds-a', 'ds-b'],
    });
  });

  it('normalizes an undefined filter to { datasourceIds: undefined }', async () => {
    const reconciler = makeReconciler(fixtureResult);

    await handleReconcile(asReconciler(reconciler), undefined, noopLogger());

    expect(reconciler.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileOnce).toHaveBeenCalledWith({ datasourceIds: undefined });
  });

  it('normalizes an empty filter array to { datasourceIds: undefined }', async () => {
    const reconciler = makeReconciler(fixtureResult);

    await handleReconcile(asReconciler(reconciler), [], noopLogger());

    expect(reconciler.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileOnce).toHaveBeenCalledWith({ datasourceIds: undefined });
  });

  it('propagates reconcileOnce errors as 500 with the error message', async () => {
    const reconciler: FakeReconciler = {
      reconcileOnce: jest.fn(async () => {
        throw new Error('boom — downstream ruler offline');
      }),
    };

    const result = await handleReconcile(asReconciler(reconciler), undefined, noopLogger());

    expect(result.status).toBe(500);
    // `toHandlerResult` collapses generic errors to the internal-error body
    // so we don't leak stack detail to callers.
    expect(result.body).toEqual({ error: 'An internal error occurred' });
    expect(reconciler.reconcileOnce).toHaveBeenCalledTimes(1);
  });

  it('surfaces validation-shaped errors as 400 via toHandlerResult', async () => {
    // Second branch of `toHandlerResult` message classification — verifies the
    // standard error-mapping path is wired, so callers that emit
    // `new Error('validation …')` from the reconciler pipeline still produce
    // a 4xx instead of an opaque 500.
    const reconciler: FakeReconciler = {
      reconcileOnce: jest.fn(async () => {
        throw new Error('validation failed: datasourceIds must be non-empty strings');
      }),
    };

    const result = await handleReconcile(asReconciler(reconciler), ['bad,value'], noopLogger());

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: expect.stringContaining('validation'),
    });
  });
});
