/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * P6.1 — Alertmanager availability probe behavior. Mirrors prom_filter_probe's
 * test surface: probe returns the cached result on subsequent calls,
 * concurrent probes share one in-flight promise, error mode resolves to
 * `unavailable` (not throw), reset clears the cache.
 */
import { createAlertmanagerProbe } from '../alertmanager_probe';
import type { Datasource, Logger } from '../../../../common/types/alerting';

const mockLogger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const ds: Datasource = {
  id: 'ds-prom',
  name: 'prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prom',
};

describe('createAlertmanagerProbe (P6.1)', () => {
  it('reports `available` when getAlertmanagerStatus resolves with a status object', async () => {
    const getAlertmanagerStatus = jest.fn(async () => ({
      cluster: { status: 'ready', peers: [] },
      config: { original: '' },
      uptime: '0s',
      versionInfo: {},
    }));
    const probe = createAlertmanagerProbe({ getAlertmanagerStatus }, mockLogger);
    const result = await probe.probe({} as never, ds);
    expect(result).toEqual({ status: 'available' });
  });

  it('reports `unavailable` when getAlertmanagerStatus throws', async () => {
    const getAlertmanagerStatus = jest.fn(async () => {
      throw new Error('connection refused');
    });
    const probe = createAlertmanagerProbe({ getAlertmanagerStatus }, mockLogger);
    const result = await probe.probe({} as never, ds);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'connection refused' });
  });

  it('reports `unavailable` when the backend has no getAlertmanagerStatus method', async () => {
    const probe = createAlertmanagerProbe({}, mockLogger);
    const result = await probe.probe({} as never, ds);
    expect(result).toMatchObject({ status: 'unavailable' });
  });

  it('caches the probe result per dsId — second call does not hit upstream', async () => {
    const getAlertmanagerStatus = jest.fn(async () => ({
      cluster: { status: 'ready', peers: [] },
      config: { original: '' },
      uptime: '',
      versionInfo: {},
    }));
    const probe = createAlertmanagerProbe({ getAlertmanagerStatus }, mockLogger);
    await probe.probe({} as never, ds);
    await probe.probe({} as never, ds);
    expect(getAlertmanagerStatus).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent in-flight probes for the same dsId', async () => {
    let resolver: ((v: unknown) => void) | undefined;
    const getAlertmanagerStatus = jest.fn(
      () =>
        new Promise((resolve) => {
          resolver = resolve;
        })
    );
    const probe = createAlertmanagerProbe({ getAlertmanagerStatus } as never, mockLogger);
    const a = probe.probe({} as never, ds);
    const b = probe.probe({} as never, ds);
    resolver!({
      cluster: { status: 'ready', peers: [] },
      config: { original: '' },
      uptime: '',
      versionInfo: {},
    });
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual(resB);
    expect(getAlertmanagerStatus).toHaveBeenCalledTimes(1);
  });

  it('reset() clears the cache so the next probe runs', async () => {
    const getAlertmanagerStatus = jest.fn(async () => ({
      cluster: { status: 'ready', peers: [] },
      config: { original: '' },
      uptime: '',
      versionInfo: {},
    }));
    const probe = createAlertmanagerProbe({ getAlertmanagerStatus }, mockLogger);
    await probe.probe({} as never, ds);
    probe.reset();
    await probe.probe({} as never, ds);
    expect(getAlertmanagerStatus).toHaveBeenCalledTimes(2);
  });
});
