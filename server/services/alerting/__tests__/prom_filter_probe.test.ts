/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPromFilterProbe } from '../prom_filter_probe';
import type { Datasource, Logger } from '../../../../common/types/alerting';

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const ds: Datasource = {
  id: 'ds-1',
  name: 'prom',
  type: 'prometheus',
  url: '',
  enabled: true,
  directQueryName: 'prom',
};

const otherDs: Datasource = { ...ds, id: 'ds-2' };

const baselineGroups = [
  {
    name: 'g1',
    file: '',
    interval: 60,
    rules: [
      {
        type: 'alerting' as const,
        name: 'rule-a',
        query: '',
        duration: 0,
        labels: {},
        annotations: {},
        alerts: [],
        health: 'ok' as const,
        state: 'inactive' as const,
      },
      {
        type: 'alerting' as const,
        name: 'rule-b',
        query: '',
        duration: 0,
        labels: {},
        annotations: {},
        alerts: [],
        health: 'ok' as const,
        state: 'inactive' as const,
      },
    ],
  },
];

describe('createPromFilterProbe', () => {
  it('returns pushdown-works when scoped probe yields a single matching rule', async () => {
    const getRuleGroups = jest
      .fn()
      .mockResolvedValueOnce(baselineGroups)
      .mockResolvedValueOnce([
        { name: 'g1', file: '', interval: 60, rules: [baselineGroups[0].rules[0]] },
      ]);
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    const result = await probe.probe({} as never, ds);
    expect(result).toEqual({ status: 'pushdown-works' });
    // Baseline call had no filter (only `type: 'alert'`). Scoped call had
    // ruleGroup + ruleName.
    expect(getRuleGroups).toHaveBeenNthCalledWith(1, expect.anything(), ds, { type: 'alert' });
    expect(getRuleGroups).toHaveBeenNthCalledWith(2, expect.anything(), ds, {
      ruleGroup: 'g1',
      ruleName: 'rule-a',
      type: 'alert',
    });
  });

  it('returns pushdown-ignored when scoped probe returns the full listing', async () => {
    const getRuleGroups = jest
      .fn()
      // baseline
      .mockResolvedValueOnce(baselineGroups)
      // scoped: upstream ignored the filter and returned everything
      .mockResolvedValueOnce(baselineGroups);
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    const result = await probe.probe({} as never, ds);
    expect(result).toEqual({ status: 'pushdown-ignored' });
  });

  it('returns unknown when there are no alerting rules to probe with', async () => {
    const getRuleGroups = jest.fn().mockResolvedValueOnce([]);
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    const result = await probe.probe({} as never, ds);
    expect(result).toEqual({ status: 'unknown', reason: 'no-alerting-rules' });
    // Only the baseline call was made — no scoped probe.
    expect(getRuleGroups).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight probe across concurrent callers for the same dsId', async () => {
    const getRuleGroups = jest.fn().mockImplementation(async () => {
      // Tiny delay so both callers can latch onto the same in-flight promise
      await new Promise((r) => setTimeout(r, 5));
      return baselineGroups;
    });
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    const [a, b] = await Promise.all([probe.probe({} as never, ds), probe.probe({} as never, ds)]);
    expect(a).toEqual(b);
    // 2 calls total (one baseline, one scoped) — NOT 4 — because the second
    // probe.probe(...) saw an in-flight promise and awaited it.
    expect(getRuleGroups).toHaveBeenCalledTimes(2);
  });

  it('caches the resolved result so subsequent calls do no upstream work', async () => {
    const getRuleGroups = jest
      .fn()
      .mockResolvedValueOnce(baselineGroups)
      .mockResolvedValueOnce([
        { name: 'g1', file: '', interval: 60, rules: [baselineGroups[0].rules[0]] },
      ]);
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    await probe.probe({} as never, ds);
    await probe.probe({} as never, ds);
    expect(getRuleGroups).toHaveBeenCalledTimes(2);
  });

  it('keeps the cache per-dsId — separate datasources probe independently', async () => {
    const getRuleGroups = jest.fn().mockResolvedValue(baselineGroups);
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    await probe.probe({} as never, ds);
    await probe.probe({} as never, otherDs);
    // Two probes, each makes its own pair of calls.
    expect(getRuleGroups).toHaveBeenCalledTimes(4);
  });

  it('reset() clears the cache', async () => {
    const getRuleGroups = jest.fn().mockResolvedValue(baselineGroups);
    const probe = createPromFilterProbe({ getRuleGroups }, mockLogger);
    await probe.probe({} as never, ds);
    probe.reset();
    await probe.probe({} as never, ds);
    expect(getRuleGroups).toHaveBeenCalledTimes(4);
  });
});
