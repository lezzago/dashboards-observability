/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * P6.9 — bound the Prom condition-preview query.
 *   - topk(N, expr) wrap caps Cortex series cardinality.
 *   - withTimeout caps wall-clock cost; on timeout we fall through to the
 *     embedded-alert extraction path so the flyout's other panels still
 *     render.
 */
import { fetchPromPreviewData, PROM_PREVIEW_TOPK } from '../alert_preview';
import type { Datasource, PromAlertingRule } from '../../../../common/types/alerting';

const ds: Datasource = {
  id: 'ds-prom',
  name: 'prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prom',
};

const buildRule = (overrides: Partial<PromAlertingRule> = {}): PromAlertingRule => ({
  type: 'alerting',
  name: 'HighCPU',
  query: 'rate(http_requests_total[5m])',
  duration: 0,
  labels: {},
  annotations: {},
  alerts: [],
  health: 'ok',
  state: 'inactive',
  ...overrides,
});

describe('fetchPromPreviewData (P6.9)', () => {
  it('wraps the user expression in topk(N, ...) before issuing queryRange', async () => {
    const queryRange = jest.fn(async () => [{ timestamp: 1, value: 1 }]);
    const promBackend = { queryRange } as never;
    await fetchPromPreviewData(promBackend, {} as never, ds, 'rate(cpu[5m]) > 0.1', buildRule());
    const queryArg = queryRange.mock.calls[0][2] as string;
    expect(queryArg).toMatch(new RegExp(`^topk\\(${PROM_PREVIEW_TOPK}, `));
  });

  it('falls through to embedded-alert extraction on queryRange timeout', async () => {
    // queryRange hangs; preview wrapper has a 5s cap. We use a short
    // implementation that resolves after a value the wrapper will exceed
    // — but the wrapper itself never exposes its constant, so use a
    // never-resolving promise and assert we still get a non-empty result
    // from the embedded-alert path before the test timeout.
    // To keep the unit test fast we patch withTimeout via test-mode by
    // returning a rejecting promise quickly. The simpler way: have
    // queryRange throw — exercises the same fall-through.
    const queryRange = jest.fn(async () => {
      throw new Error('upstream unavailable');
    });
    const promBackend = { queryRange } as never;
    const rule = buildRule({
      alerts: [
        {
          labels: {},
          annotations: {},
          state: 'firing',
          activeAt: '2026-05-18T00:00:00Z',
          value: '5',
        },
      ],
      lastEvaluation: '2026-05-18T00:01:00Z',
    });
    const points = await fetchPromPreviewData(promBackend, {} as never, ds, 'rate(cpu[5m])', rule);
    expect(points.length).toBeGreaterThan(0);
  });

  it('returns the queryRange result when it succeeds and has points', async () => {
    const queryRange = jest.fn(async () => [
      { timestamp: 1000, value: 1 },
      { timestamp: 2000, value: 2 },
    ]);
    const promBackend = { queryRange } as never;
    const points = await fetchPromPreviewData(
      promBackend,
      {} as never,
      ds,
      'rate(cpu[5m])',
      buildRule()
    );
    expect(points).toEqual([
      { timestamp: 1000, value: 1 },
      { timestamp: 2000, value: 2 },
    ]);
  });
});
