/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F4) — tests for the read-only legacy-orphan purge audit
 * endpoint (`GET /api/observability/v1/slos/_purge_legacy/audit`).
 *
 * Focus:
 *   - 404 when `legacyOrphanPurge.enabled` is false (flag-off semantics
 *     inherited from the purge endpoint).
 *   - 503 when the audit store isn't wired yet (start() hasn't finished).
 *   - Happy path: query params forward to `auditStore.list`, response
 *     shape is `{records, truncated}`.
 *   - `truncated: true` is surfaced to the client.
 *
 * Same router-fake pattern as `adoption_route.test.ts`; see that file for
 * the shape of `makeRouter`, `makeRes`, etc.
 */

import { registerSloAdoptionRoutes } from '../adoption_route';
import { InMemoryDatasourceService } from '../../../services/alerting';
import type { SloService } from '../../../../common/slo/slo_service';
import type { SloLegacyPurgeAuditStore } from '../../../services/slo/slo_legacy_purge_audit_store';

interface RouteConfig {
  path: string;
  validate?: unknown;
}
type RouteHandler = (ctx: unknown, req: unknown, res: unknown) => Promise<unknown>;

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function makeRouter() {
  return { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
}

function makeRes() {
  // Match the response shape OSD's `IKibanaResponseFactory` produces: `res.ok({body})`
  // returns `{status:200, body}`; `res.customError({statusCode, body})` returns
  // `{status, body}`. We unwrap the `{body}` envelope here so callers can
  // inspect the actual payload directly.
  const ok = jest.fn((payload: { body: unknown }) => ({ status: 200, body: payload.body }));
  const customError = jest.fn((payload: { statusCode: number; body: unknown }) => ({
    status: payload.statusCode,
    body: payload.body,
  }));
  return { ok, customError };
}

function makeCtx() {
  return { core: { opensearch: { client: { asCurrentUser: {} } } } };
}

function getHandler(
  router: ReturnType<typeof makeRouter>,
  predicate: (path: string) => boolean
): RouteHandler {
  const call = (router.get.mock.calls as Array<[RouteConfig, RouteHandler]>).find(([cfg]) =>
    predicate(cfg.path)
  );
  if (!call) throw new Error('audit route not registered');
  return call[1];
}

function fakeService() {
  return {
    recover: jest.fn(),
    listRawByDatasource: jest.fn(async () => []),
  };
}

function registerWith(options: {
  legacyOrphanPurgeEnabled: boolean;
  auditStore?: SloLegacyPurgeAuditStore;
}) {
  const router = makeRouter();
  const datasourceService = new InMemoryDatasourceService(mockLogger as never);
  registerSloAdoptionRoutes({
    router: router as never,
    sloService: (fakeService() as unknown) as SloService,
    logger: mockLogger as never,
    datasourceService,
    ruleDedupEnabled: true,
    ruleAdoptionEnabled: true,
    legacyOrphanPurgeEnabled: options.legacyOrphanPurgeEnabled,
    legacyPurgeAuditStoreGetter: () => options.auditStore,
  });
  return router;
}

function fakeAuditStore(listResult: {
  records: Array<{ attributes: Record<string, unknown> }>;
  truncated: boolean;
}): { store: SloLegacyPurgeAuditStore; list: jest.Mock } {
  const list = jest.fn(async () => listResult);
  const store = ({
    list,
    writeMany: jest.fn(),
    deleteBefore: jest.fn(),
  } as unknown) as SloLegacyPurgeAuditStore;
  return { store, list };
}

describe('GET /_purge_legacy/audit — feature-flag gate', () => {
  it('returns 404 when legacyOrphanPurge.enabled is false', async () => {
    const { store } = fakeAuditStore({ records: [], truncated: false });
    const router = registerWith({ legacyOrphanPurgeEnabled: false, auditStore: store });
    const handler = getHandler(router, (p) => p.endsWith('/_purge_legacy/audit'));
    const res = makeRes();
    const out = (await handler(makeCtx(), { query: {}, headers: {} }, res)) as {
      status: number;
      body: { attributes?: { error?: string } };
    };
    expect(out.status).toBe(404);
    expect(out.body.attributes?.error).toBe('NOT_FOUND');
  });
});

describe('GET /_purge_legacy/audit — happy path', () => {
  it('returns 503 when the audit store is not yet wired', async () => {
    const router = registerWith({ legacyOrphanPurgeEnabled: true, auditStore: undefined });
    const handler = getHandler(router, (p) => p.endsWith('/_purge_legacy/audit'));
    const res = makeRes();
    const out = (await handler(makeCtx(), { query: {}, headers: {} }, res)) as {
      status: number;
      body: { attributes?: { error?: string } };
    };
    expect(out.status).toBe(503);
    expect(out.body.attributes?.error).toBe('AUDIT_STORE_UNAVAILABLE');
  });

  it('forwards query filters to auditStore.list and returns records + truncated', async () => {
    const { store, list } = fakeAuditStore({
      records: [
        {
          attributes: {
            workspaceId: 'ds-1',
            datasourceId: 'ds-1',
            namespace: 'slo-generated-ds-1',
            groupName: 'slo:foo_abcdef12',
            outcome: 'purged',
            requestedAt: '2026-04-29T10:00:00.000Z',
            schemaVersion: 1,
          },
        },
      ],
      truncated: false,
    });
    const router = registerWith({ legacyOrphanPurgeEnabled: true, auditStore: store });
    const handler = getHandler(router, (p) => p.endsWith('/_purge_legacy/audit'));
    const res = makeRes();
    const out = (await handler(
      makeCtx(),
      {
        query: {
          datasourceId: 'ds-1',
          groupName: 'slo:foo_abcdef12',
          since: '2026-04-01T00:00:00.000Z',
          limit: 100,
        },
        headers: {},
      },
      res
    )) as { status: number; body: { records: unknown[]; truncated: boolean } };
    expect(out.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      datasourceId: 'ds-1',
      groupName: 'slo:foo_abcdef12',
      since: '2026-04-01T00:00:00.000Z',
      limit: 100,
    });
    expect(out.body.records).toHaveLength(1);
    expect(out.body.truncated).toBe(false);
  });

  it('applies a default `since` of 7 days ago when not supplied', async () => {
    const { store, list } = fakeAuditStore({ records: [], truncated: false });
    const router = registerWith({ legacyOrphanPurgeEnabled: true, auditStore: store });
    const handler = getHandler(router, (p) => p.endsWith('/_purge_legacy/audit'));
    const res = makeRes();
    const nowMs = Date.now();
    await handler(makeCtx(), { query: {}, headers: {} }, res);
    const call = list.mock.calls[0][0] as { since?: string };
    expect(call.since).toBeDefined();
    const sinceMs = Date.parse(call.since!);
    const delta = nowMs - sinceMs;
    expect(delta).toBeGreaterThanOrEqual(7 * 24 * 60 * 60_000 - 1000);
    expect(delta).toBeLessThanOrEqual(7 * 24 * 60 * 60_000 + 1000);
  });

  it('passes through truncated=true when the server hit the cap', async () => {
    const { store } = fakeAuditStore({
      records: [],
      truncated: true,
    });
    const router = registerWith({ legacyOrphanPurgeEnabled: true, auditStore: store });
    const handler = getHandler(router, (p) => p.endsWith('/_purge_legacy/audit'));
    const res = makeRes();
    const out = (await handler(makeCtx(), { query: {}, headers: {} }, res)) as {
      status: number;
      body: { truncated: boolean };
    };
    expect(out.body.truncated).toBe(true);
  });
});
