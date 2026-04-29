/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Router-level tests for Phase 4 W4.6 — adoption endpoints (`_orphans`,
 * `_recover`, `_clone`).
 *
 * Covers:
 *   - 412 feature-flag gate (ruleDedup off, ruleAdoption off, both off)
 *   - `_orphans` happy path + `datasourceId` filter forwarding
 *   - `_recover` happy path + full error-code → HTTP status mapping
 *   - `_clone` happy path + adoption-error mapping
 *   - body validation wiring (schema rejects missing `sloId` before the
 *     handler runs)
 *
 * Framework-agnostic: exercises `registerSloAdoptionRoutes` directly against
 * a fake router (same pattern `delete_registry_lookup.test.ts` uses). No real
 * OSD runtime, no real ruler, no real reconciler — all collaborators are
 * `jest.Mocked<...>` shape-matched fakes.
 */

import { registerSloAdoptionRoutes } from '../adoption_route';
import { InMemoryDatasourceService } from '../../../services/alerting';
import type { SloService } from '../../../../common/slo/slo_service';
import type { SloReconciler } from '../../../services/slo/reconciler';

// ============================================================================
// Fixtures + helpers
// ============================================================================

interface RouteConfig {
  path: string;
  validate?: {
    body?: {
      // OSD's `schema.object` returns an `ObjectType` with a `.validate`
      // method. The fake router just stores the config; we call the real
      // validate method directly in the one body-validation test.
      validate: (value: unknown) => unknown;
    };
  };
}
type RouteHandler = (ctx: unknown, req: unknown, res: unknown) => Promise<unknown>;

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function makeRouter() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };
}

function makeCtx() {
  return {
    core: {
      savedObjects: { client: { find: jest.fn(async () => ({ saved_objects: [] })) } },
      opensearch: { client: { asCurrentUser: {} } },
    },
  };
}

function makeRes() {
  const ok = jest.fn((body: unknown) => ({ status: 200, body }));
  const customError = jest.fn((body: { statusCode: number; body: unknown }) => ({
    status: body.statusCode,
    body: body.body,
  }));
  const custom = jest.fn((body: { statusCode: number; body: unknown }) => ({
    status: body.statusCode,
    body: body.body,
  }));
  return { ok, customError, custom };
}

/** Retrieve a registered route handler by its router verb + path predicate. */
function getHandler(
  router: ReturnType<typeof makeRouter>,
  verb: 'get' | 'post',
  predicate: (path: string) => boolean
): RouteHandler {
  const call = (router[verb].mock.calls as Array<[RouteConfig, RouteHandler]>).find(([cfg]) =>
    predicate(cfg.path)
  );
  if (!call) throw new Error(`route not registered for ${verb} matching predicate`);
  return call[1];
}

/** Retrieve the full route config (so tests can call `.validate.body.validate`). */
function getRouteConfig(
  router: ReturnType<typeof makeRouter>,
  verb: 'get' | 'post',
  predicate: (path: string) => boolean
): RouteConfig {
  const call = (router[verb].mock.calls as Array<[RouteConfig, RouteHandler]>).find(([cfg]) =>
    predicate(cfg.path)
  );
  if (!call) throw new Error(`route not registered for ${verb} matching predicate`);
  return call[0];
}

// ----------------------------------------------------------------------------
// Fake reconciler: structural match for `SloReconciler.reconcileOnce`.
// ----------------------------------------------------------------------------

// Loose shape used by the fake reconciler. Matches the `ReconcileResult`
// contract from `server/services/slo/reconciler.ts` but typed wide enough
// that test-specific `mockResolvedValueOnce({ … })` literals (with rich
// adoptableOrphans entries) fit without `as` casts at each call site.
interface FakeReconcileResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  datasourceIds: string[];
  missingBySlo: unknown[];
  orphans: unknown[];
  adoptableOrphans: Array<Record<string, unknown>>;
  unknownOrphans: Array<Record<string, unknown>>;
  errors: unknown[];
  danglingRefs: unknown[];
  graceDeletions: unknown[];
}

function makeFakeReconciler() {
  const baseResult: FakeReconcileResult = {
    startedAt: '2026-04-25T00:00:00Z',
    finishedAt: '2026-04-25T00:00:01Z',
    durationMs: 1000,
    datasourceIds: ['ds-7'],
    missingBySlo: [],
    orphans: [],
    adoptableOrphans: [],
    unknownOrphans: [],
    errors: [],
    danglingRefs: [],
    graceDeletions: [],
  };
  return {
    start: jest.fn(),
    stop: jest.fn(async () => undefined),
    reconcileOnce: jest.fn<Promise<FakeReconcileResult>, [{ datasourceIds?: string[] }?]>(
      async () => baseResult
    ),
  };
}

// ----------------------------------------------------------------------------
// Fake service — only the adoption surface is exercised. B2A hasn't landed
// `recover` / `clone` on `SloService` yet, so we cast the fake to the
// `SloService` slot on `registerSloAdoptionRoutes`. The cast is safe because
// the handler consumes only `recover` and `clone` methods.
//
// TODO(W4.4): swap the cast for a real `jest.Mocked<SloService>` once B2A
// exposes the methods on the class.
// ----------------------------------------------------------------------------

type AdoptionErrorCode =
  | 'ORPHAN_SPEC_DRIFT'
  | 'ORPHAN_WORKSPACE_MISMATCH'
  | 'ORPHAN_CLAIM_CONFLICT'
  | 'ORPHAN_UNSUPPORTED_SCHEMA'
  | 'ORPHAN_TOMBSTONED'
  | 'CLONE_NAME_COLLISION';

/**
 * Placeholder class matching the runtime shape of B2A's `SloAdoptionError`
 * (`name === 'SloAdoptionError'`, typed `code` property). Kept in the test
 * file so the route handler's duck-type detection lights up against the
 * real class when it ships.
 *
 * TODO(W4.4): replace with `import { SloAdoptionError } from
 * '../../../../common/slo/slo_errors'` once B2A lands.
 */
class TestSloAdoptionError extends Error {
  public readonly name = 'SloAdoptionError';
  constructor(public readonly code: AdoptionErrorCode, message: string) {
    super(message);
  }
}

function makeFakeService() {
  return {
    recover: jest.fn(),
    clone: jest.fn(),
    // Other SloService methods aren't consumed by the adoption routes; leave
    // them absent so TypeScript narrows the cast boundary at the call site.
  };
}

// ----------------------------------------------------------------------------
// Seed a realistic datasource so the deploy-context builder resolves.
// ----------------------------------------------------------------------------

async function seedDatasource(service: InMemoryDatasourceService): Promise<string> {
  const ds = await service.create({
    name: 'prometheus-test',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'prometheus-test',
  });
  return ds.id;
}

// ----------------------------------------------------------------------------
// Mock ruler (we only need the object identity for the deploy context).
// ----------------------------------------------------------------------------

const fakeRulerClient = {
  upsertRuleGroup: jest.fn(async () => undefined),
  deleteRuleGroup: jest.fn(async () => undefined),
} as never;

// ============================================================================
// Shared wiring
// ============================================================================

interface Wiring {
  router: ReturnType<typeof makeRouter>;
  datasourceService: InMemoryDatasourceService;
  reconciler: ReturnType<typeof makeFakeReconciler>;
  service: ReturnType<typeof makeFakeService>;
  datasourceId: string;
}

async function setupWiring(options: {
  ruleDedupEnabled: boolean;
  ruleAdoptionEnabled: boolean;
}): Promise<Wiring> {
  const datasourceService = new InMemoryDatasourceService(mockLogger as never);
  const datasourceId = await seedDatasource(datasourceService);
  const router = makeRouter();
  const reconciler = makeFakeReconciler();
  const service = makeFakeService();
  registerSloAdoptionRoutes({
    router: router as never,
    sloService: (service as unknown) as SloService,
    logger: mockLogger as never,
    rulerClient: fakeRulerClient,
    datasourceService,
    reconciler: (reconciler as unknown) as SloReconciler,
    ruleDedupEnabled: options.ruleDedupEnabled,
    ruleAdoptionEnabled: options.ruleAdoptionEnabled,
  });
  return { router, datasourceService, reconciler, service, datasourceId };
}

// ============================================================================
// 412 gate
// ============================================================================

describe('W4.6 adoption routes — 412 feature-flag gate', () => {
  it('returns 412 with missingFlags=["ruleDedup"] when dedup is off but adoption is on', async () => {
    const { router, reconciler } = await setupWiring({
      ruleDedupEnabled: false,
      ruleAdoptionEnabled: true,
    });

    const orphans = getHandler(router, 'get', (p) => p.endsWith('/_orphans'));
    const recover = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const clone = getHandler(router, 'post', (p) => p.endsWith('/_clone'));

    for (const [name, handler, reqBody] of [
      ['_orphans', orphans, { query: {} }],
      ['_recover', recover, { body: { sloId: 'slo-1', datasourceId: 'ds-1' }, query: {} }],
      [
        '_clone',
        clone,
        {
          body: {
            sourceSloId: 'slo-1',
            sourceDatasourceId: 'ds-1',
            targetDatasourceId: 'ds-2',
          },
          query: {},
        },
      ],
    ] as const) {
      const res = makeRes();
      await handler(makeCtx(), reqBody, res);
      expect(res.customError).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 412,
          body: expect.objectContaining({
            attributes: expect.objectContaining({
              error: 'PRECONDITION_FAILED',
              missingFlags: ['ruleDedup'],
            }),
          }),
        })
      );
      expect(res.ok).not.toHaveBeenCalled();
      expect(reconciler.reconcileOnce).not.toHaveBeenCalled();
      // Reset for next iteration so the "not called" check stays honest.
      reconciler.reconcileOnce.mockClear();
      void name; // loop label only
    }
  });

  it('returns 412 with missingFlags=["ruleAdoption"] when adoption is off but dedup is on', async () => {
    const { router } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: false,
    });

    const orphans = getHandler(router, 'get', (p) => p.endsWith('/_orphans'));
    const recover = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const clone = getHandler(router, 'post', (p) => p.endsWith('/_clone'));

    for (const [handler, reqBody] of [
      [orphans, { query: {} }],
      [recover, { body: { sloId: 'slo-1', datasourceId: 'ds-1' }, query: {} }],
      [
        clone,
        {
          body: {
            sourceSloId: 'slo-1',
            sourceDatasourceId: 'ds-1',
            targetDatasourceId: 'ds-2',
          },
          query: {},
        },
      ],
    ] as const) {
      const res = makeRes();
      await handler(makeCtx(), reqBody, res);
      expect(res.customError).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 412,
          body: expect.objectContaining({
            attributes: expect.objectContaining({
              error: 'PRECONDITION_FAILED',
              missingFlags: ['ruleAdoption'],
            }),
          }),
        })
      );
    }
  });

  it('returns 412 with both flags listed in deterministic order when both are off', async () => {
    const { router } = await setupWiring({
      ruleDedupEnabled: false,
      ruleAdoptionEnabled: false,
    });

    const orphans = getHandler(router, 'get', (p) => p.endsWith('/_orphans'));
    const res = makeRes();
    await orphans(makeCtx(), { query: {} }, res);

    expect(res.customError).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 412,
        body: expect.objectContaining({
          attributes: expect.objectContaining({
            error: 'PRECONDITION_FAILED',
            // Order: ruleDedup first, ruleAdoption second. Deterministic so
            // consumers can snapshot on the ordered array.
            missingFlags: ['ruleDedup', 'ruleAdoption'],
            message: expect.stringContaining(
              'observability.slo.ruleDedup.enabled and observability.slo.ruleAdoption.enabled'
            ),
          }),
        }),
      })
    );
  });
});

// ============================================================================
// _orphans happy path
// ============================================================================

describe('W4.6 GET /_orphans', () => {
  it('maps adoptableOrphans → candidates and unknownOrphans → unknowns', async () => {
    const { router, reconciler } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    reconciler.reconcileOnce.mockResolvedValueOnce({
      startedAt: '2026-04-25T00:00:00Z',
      finishedAt: '2026-04-25T00:00:01Z',
      durationMs: 1000,
      datasourceIds: ['ds-7'],
      missingBySlo: [],
      orphans: [],
      adoptableOrphans: [
        {
          datasourceId: 'ds-7',
          namespace: 'slo-generated-ds-7',
          groupName: 'slo:alert:group-a',
          sourceSloId: 'slo-a',
          sourceWorkspaceId: 'ds-7',
          spec: {
            datasourceId: 'ds-7',
            name: 'api-availability',
          } as Record<string, unknown>,
          fingerprints: ['fp-a-1', 'fp-a-2'],
          specIntegrity: 'ok',
          tombstoned: false,
        },
        {
          datasourceId: 'ds-7',
          namespace: 'slo-generated-ds-7',
          groupName: 'slo:alert:group-b',
          sourceSloId: 'slo-b',
          sourceWorkspaceId: 'ds-7',
          spec: { datasourceId: 'ds-7', name: 'api-latency' } as Record<string, unknown>,
          fingerprints: ['fp-b-1'],
          specIntegrity: 'ok',
          tombstoned: true,
          tombstoneCreatedAt: '2026-04-24T10:00:00Z',
        },
      ],
      unknownOrphans: [
        {
          datasourceId: 'ds-7',
          namespace: 'slo-generated-ds-7',
          groupName: 'slo:legacy-group',
          diagnostic: 'pre-Phase-3 rule layout; not eligible for adoption',
        },
      ],
      errors: [],
      danglingRefs: [],
      graceDeletions: [],
    });

    const handler = getHandler(router, 'get', (p) => p.endsWith('/_orphans'));
    const res = makeRes();
    await handler(makeCtx(), { query: {} }, res);

    expect(res.ok).toHaveBeenCalled();
    const body = (res.ok.mock.calls[0][0] as { body: unknown }).body as {
      candidates: Array<Record<string, unknown>>;
      unknowns: Array<Record<string, unknown>>;
    };
    expect(body.candidates).toHaveLength(2);
    expect(body.unknowns).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      sloId: 'slo-a',
      datasourceId: 'ds-7',
      workspaceId: 'ds-7',
      groupName: 'slo:alert:group-a',
      specIntegrity: 'ok',
      tombstoned: false,
      fingerprints: ['fp-a-1', 'fp-a-2'],
    });
    expect(body.candidates[1]).toMatchObject({
      sloId: 'slo-b',
      tombstoned: true,
      tombstoneCreatedAt: '2026-04-24T10:00:00Z',
    });
    // specSha256 is a string (recomputed from embedded spec); exact value
    // depends on `computeSpecSha256`, so we just assert presence + type.
    expect(typeof body.candidates[0].specSha256).toBe('string');
    expect(body.unknowns[0]).toMatchObject({
      datasourceId: 'ds-7',
      groupName: 'slo:legacy-group',
      diagnostic: expect.stringContaining('pre-Phase-3'),
    });
  });

  it('forwards a ?datasourceId= filter to reconcileOnce', async () => {
    const { router, reconciler } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    const handler = getHandler(router, 'get', (p) => p.endsWith('/_orphans'));
    await handler(makeCtx(), { query: { datasourceId: 'ds-42' } }, makeRes());

    expect(reconciler.reconcileOnce).toHaveBeenCalledWith({ datasourceIds: ['ds-42'] });
  });

  it('passes undefined datasourceIds when no filter is given', async () => {
    const { router, reconciler } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    const handler = getHandler(router, 'get', (p) => p.endsWith('/_orphans'));
    await handler(makeCtx(), { query: {} }, makeRes());

    expect(reconciler.reconcileOnce).toHaveBeenCalledWith({ datasourceIds: undefined });
  });
});

// ============================================================================
// _recover happy path + error mapping
// ============================================================================

describe('W4.6 POST /_recover', () => {
  it('returns 200 with the service result on happy path', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    service.recover.mockResolvedValueOnce({
      slo: { id: 'slo-a', spec: { name: 'api-availability' } },
      tombstoneCleared: false,
      refcountChanges: [{ fingerprint: 'fp-a-1', previousRefcount: 0, newRefcount: 1 }],
    });

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const res = makeRes();
    await handler(makeCtx(), { body: { sloId: 'slo-a', datasourceId }, query: {} }, res);

    expect(res.ok).toHaveBeenCalledWith({
      body: expect.objectContaining({
        slo: expect.objectContaining({ id: 'slo-a' }),
        tombstoneCleared: false,
        refcountChanges: expect.any(Array),
      }),
    });
    expect(service.recover).toHaveBeenCalledTimes(1);
    // Deploy context was built with the seeded datasource.
    const [_input, deploy] = service.recover.mock.calls[0];
    expect(deploy).toMatchObject({ workspaceId: datasourceId });
  });

  it.each<[AdoptionErrorCode, number]>([
    ['ORPHAN_SPEC_DRIFT', 422],
    ['ORPHAN_WORKSPACE_MISMATCH', 422],
    ['ORPHAN_UNSUPPORTED_SCHEMA', 422],
    ['ORPHAN_CLAIM_CONFLICT', 409],
    ['ORPHAN_TOMBSTONED', 409],
    ['CLONE_NAME_COLLISION', 409],
  ])('maps SloAdoptionError[%s] to HTTP %d', async (code, expectedStatus) => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    service.recover.mockRejectedValueOnce(new TestSloAdoptionError(code, `simulated ${code}`));

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const res = makeRes();
    await handler(makeCtx(), { body: { sloId: 'slo-a', datasourceId }, query: {} }, res);

    expect(res.customError).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: expectedStatus,
        body: expect.objectContaining({
          attributes: expect.objectContaining({ code }),
        }),
      })
    );
  });

  it('maps SloNotFoundError to HTTP 404', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    const {
      SloNotFoundError,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
    } = require('../../../../common/slo/slo_errors');
    service.recover.mockRejectedValueOnce(new SloNotFoundError('slo-missing'));

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const res = makeRes();
    await handler(makeCtx(), { body: { sloId: 'slo-missing', datasourceId }, query: {} }, res);

    expect(res.customError).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('maps SloValidationError to HTTP 400', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    const {
      SloValidationError,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
    } = require('../../../../common/slo/slo_errors');
    service.recover.mockRejectedValueOnce(
      new SloValidationError({ 'spec.name': 'must not be empty' })
    );

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const res = makeRes();
    await handler(makeCtx(), { body: { sloId: 'slo-a', datasourceId }, query: {} }, res);

    expect(res.customError).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('maps generic Error to HTTP 500', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    service.recover.mockRejectedValueOnce(new Error('unexpected kaboom'));

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_recover'));
    const res = makeRes();
    await handler(makeCtx(), { body: { sloId: 'slo-a', datasourceId }, query: {} }, res);

    expect(res.customError).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
  });

  it('rejects bodies missing `sloId` at the schema layer', async () => {
    const { router } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    const cfg = getRouteConfig(router, 'post', (p) => p.endsWith('/_recover'));
    // OSD's config-schema throws on validation failure; we catch and check.
    const bodyValidator = (cfg.validate?.body as unknown) as {
      validate: (value: unknown) => unknown;
    };
    expect(bodyValidator).toBeDefined();
    expect(() => bodyValidator.validate({ datasourceId: 'ds-7' })).toThrow();
  });
});

// ============================================================================
// _clone happy path + adoption-error mapping
// ============================================================================

describe('W4.6 POST /_clone', () => {
  it('returns 200 (server collapses 201) with the clone result on happy path', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    service.clone.mockResolvedValueOnce({
      slo: { id: 'slo-cloned', spec: { name: 'api-availability-copy' } },
      sourceSpecSha256: 'sha-test',
    });

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_clone'));
    const res = makeRes();
    await handler(
      makeCtx(),
      {
        body: {
          sourceSloId: 'slo-a',
          sourceDatasourceId: datasourceId,
          targetDatasourceId: datasourceId,
          overrideName: 'api-availability-copy',
        },
        query: {},
      },
      res
    );

    expect(res.ok).toHaveBeenCalledWith({
      body: expect.objectContaining({
        slo: expect.objectContaining({ id: 'slo-cloned' }),
        sourceSpecSha256: 'sha-test',
      }),
    });
    expect(service.clone).toHaveBeenCalledTimes(1);
    // Two deploy contexts were built (source + target).
    const [, srcDeploy, tgtDeploy] = service.clone.mock.calls[0];
    expect(srcDeploy).toMatchObject({ workspaceId: datasourceId });
    expect(tgtDeploy).toMatchObject({ workspaceId: datasourceId });
  });

  it('maps ORPHAN_SPEC_DRIFT to HTTP 422', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    service.clone.mockRejectedValueOnce(
      new TestSloAdoptionError('ORPHAN_SPEC_DRIFT', 'spec drift on source')
    );

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_clone'));
    const res = makeRes();
    await handler(
      makeCtx(),
      {
        body: {
          sourceSloId: 'slo-a',
          sourceDatasourceId: datasourceId,
          targetDatasourceId: datasourceId,
        },
        query: {},
      },
      res
    );

    expect(res.customError).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        body: expect.objectContaining({
          attributes: expect.objectContaining({ code: 'ORPHAN_SPEC_DRIFT' }),
        }),
      })
    );
  });

  it('maps CLONE_NAME_COLLISION to HTTP 409', async () => {
    const { router, service, datasourceId } = await setupWiring({
      ruleDedupEnabled: true,
      ruleAdoptionEnabled: true,
    });

    service.clone.mockRejectedValueOnce(
      new TestSloAdoptionError('CLONE_NAME_COLLISION', 'target already has an SLO named x')
    );

    const handler = getHandler(router, 'post', (p) => p.endsWith('/_clone'));
    const res = makeRes();
    await handler(
      makeCtx(),
      {
        body: {
          sourceSloId: 'slo-a',
          sourceDatasourceId: datasourceId,
          targetDatasourceId: datasourceId,
        },
        query: {},
      },
      res
    );

    expect(res.customError).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        body: expect.objectContaining({
          attributes: expect.objectContaining({ code: 'CLONE_NAME_COLLISION' }),
        }),
      })
    );
  });
});
