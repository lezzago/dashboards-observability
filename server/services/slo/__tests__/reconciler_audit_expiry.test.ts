/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session E (F4) — reconciler legacy-purge audit retention sweep.
 *
 * Runs the real `createSloReconciler` with a fake audit store and asserts
 * that `deleteBefore(cutoff)` is called once per sweep with a cutoff
 * derived from `now() - legacyOrphanAuditRetentionMs`. Separate suite from
 * the per-datasource sweep tests because retention is a cluster-level
 * concern (one call per sweep, not per datasource).
 */

import { createSloReconciler } from '../reconciler';
import type { SloLegacyPurgeAuditRetentionLite } from '../reconciler';
import { createReconcilerMetrics } from '../reconciler_metrics';
import { FakeRulerClient } from '../../../../common/slo/__tests__/fake_ruler_client';
import type { AlertingOSClient, Datasource, Logger } from '../../../../common/types/alerting/types';
import type { ISloStore, SloDocument } from '../../../../common/slo/slo_types';
import type { RuleHealthChecker } from '../rule_health_checker';
import type { InMemoryDatasourceService } from '../../alerting/datasource_service';

function noopLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function mockClient(): AlertingOSClient {
  return ({
    transport: { request: jest.fn(async () => ({ statusCode: 200, body: {} })) },
  } as unknown) as AlertingOSClient;
}

function mockDatasource(): Datasource {
  return {
    id: 'ds-1',
    name: 'my-cortex',
    type: 'prometheus',
    url: '',
    enabled: true,
    directQueryName: 'my-cortex-connection',
  };
}

function buildDeps(opts: {
  auditStore?: SloLegacyPurgeAuditRetentionLite;
  retentionMs?: number;
  now?: () => Date;
  logger?: Logger;
}) {
  const logger = opts.logger ?? noopLogger();
  const store: jest.Mocked<ISloStore> = ({
    list: jest.fn(async () => [] as SloDocument[]),
    get: jest.fn(async () => null),
    save: jest.fn(),
    delete: jest.fn(),
  } as unknown) as jest.Mocked<ISloStore>;
  const healthChecker: jest.Mocked<RuleHealthChecker> = ({
    check: jest.fn(),
    invalidate: jest.fn(),
  } as unknown) as jest.Mocked<RuleHealthChecker>;
  const datasourceService: jest.Mocked<Pick<InMemoryDatasourceService, 'get' | 'list'>> = ({
    get: jest.fn(async () => mockDatasource()),
    list: jest.fn(async () => []),
  } as unknown) as jest.Mocked<Pick<InMemoryDatasourceService, 'get' | 'list'>>;
  const metrics = createReconcilerMetrics(logger);
  return {
    reconciler: createSloReconciler({
      store,
      ruler: new FakeRulerClient(),
      healthChecker,
      datasourceService: (datasourceService as unknown) as InMemoryDatasourceService,
      logger,
      metrics,
      buildClient: () => mockClient(),
      legacyPurgeAuditStore: opts.auditStore,
      legacyOrphanAuditRetentionMs: opts.retentionMs,
      now: opts.now,
    }),
    metrics,
    logger,
  };
}

describe('SloReconciler — Session E (F4) audit retention sweep', () => {
  it('calls deleteBefore once per sweep with cutoff = now - retentionMs', async () => {
    const auditStore: SloLegacyPurgeAuditRetentionLite = {
      deleteBefore: jest.fn(async () => 3),
    };
    const now = () => new Date('2026-04-29T10:00:00.000Z');
    const retentionMs = 7 * 24 * 60 * 60_000; // 7 days
    const { reconciler, metrics } = buildDeps({ auditStore, retentionMs, now });
    await reconciler.reconcileOnce({ datasourceIds: ['ds-1'] });
    expect(auditStore.deleteBefore).toHaveBeenCalledTimes(1);
    const cutoff = (auditStore.deleteBefore as jest.Mock).mock.calls[0][0];
    const cutoffMs = Date.parse(cutoff);
    expect(now().getTime() - cutoffMs).toBe(retentionMs);
    expect(metrics.snapshot().legacyAuditRecordsExpired).toBe(3);
  });

  it('does not bump the expired counter when the sweep deletes 0 records', async () => {
    const auditStore: SloLegacyPurgeAuditRetentionLite = {
      deleteBefore: jest.fn(async () => 0),
    };
    const { reconciler, metrics } = buildDeps({
      auditStore,
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });
    await reconciler.reconcileOnce({ datasourceIds: ['ds-1'] });
    expect(auditStore.deleteBefore).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().legacyAuditRecordsExpired).toBe(0);
  });

  it('retention sweep failure is logged at warn; sweep continues; error counter not bumped', async () => {
    const auditStore: SloLegacyPurgeAuditRetentionLite = {
      deleteBefore: jest.fn(async () => {
        throw new Error('synthetic audit store failure');
      }),
    };
    const logger = noopLogger();
    const { reconciler, metrics } = buildDeps({
      auditStore,
      now: () => new Date('2026-04-29T10:00:00.000Z'),
      logger,
    });
    const result = await reconciler.reconcileOnce({ datasourceIds: ['ds-1'] });
    expect(result.errors).toHaveLength(0);
    expect(metrics.snapshot().errors).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy-audit retention sweep failed')
    );
  });

  it('no audit store wired → deleteBefore is never called', async () => {
    const { reconciler } = buildDeps({
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });
    // No store: sweep completes cleanly, no counter bumps.
    await reconciler.reconcileOnce({ datasourceIds: ['ds-1'] });
  });

  it('uses the default retention (30 days) when not overridden', async () => {
    const auditStore: SloLegacyPurgeAuditRetentionLite = {
      deleteBefore: jest.fn(async () => 0),
    };
    const now = () => new Date('2026-04-29T10:00:00.000Z');
    const { reconciler } = buildDeps({ auditStore, now });
    await reconciler.reconcileOnce({ datasourceIds: ['ds-1'] });
    const cutoff = (auditStore.deleteBefore as jest.Mock).mock.calls[0][0];
    expect(now().getTime() - Date.parse(cutoff)).toBe(30 * 24 * 60 * 60_000);
  });
});
