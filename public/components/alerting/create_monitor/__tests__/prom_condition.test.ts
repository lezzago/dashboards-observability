/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildExpr,
  ConditionBuilderState,
  DEFAULT_AGG_WINDOW,
  isAlwaysFiring,
  isRangeOp,
  parseExpr,
} from '../prom_condition';

const state = (over: Partial<ConditionBuilderState> = {}): ConditionBuilderState => ({
  metric: 'cpu_usage',
  aggFn: 'none',
  aggWindow: DEFAULT_AGG_WINDOW,
  conditionOp: 'none',
  ...over,
});

describe('buildExpr', () => {
  it('returns empty string until a metric is chosen', () => {
    expect(buildExpr(state({ metric: '' }))).toBe('');
    expect(buildExpr(state({ metric: '   ' }))).toBe('');
  });

  it('builds a bare selector', () => {
    expect(buildExpr(state())).toBe('cpu_usage');
  });

  it('builds a labelled selector, escaping the value', () => {
    expect(buildExpr(state({ labelName: 'host', labelOperator: '=', labelValue: 'web"1' }))).toBe(
      'cpu_usage{host="web\\"1"}'
    );
  });

  it('drops the label matcher when the value is empty', () => {
    expect(buildExpr(state({ labelName: 'host', labelOperator: '=', labelValue: '' }))).toBe(
      'cpu_usage'
    );
  });

  it('wraps in a reduce function over the window', () => {
    expect(buildExpr(state({ aggFn: 'avg', aggWindow: '10m' }))).toBe(
      'avg_over_time(cpu_usage[10m])'
    );
  });

  it.each([
    ['gt', 'cpu_usage > 0.5'],
    ['gte', 'cpu_usage >= 0.5'],
    ['lt', 'cpu_usage < 0.5'],
    ['lte', 'cpu_usage <= 0.5'],
    ['eq', 'cpu_usage == 0.5'],
    ['neq', 'cpu_usage != 0.5'],
  ] as const)('applies the %s comparison', (op, expected) => {
    expect(buildExpr(state({ conditionOp: op, thresholdA: 0.5 }))).toBe(expected);
  });

  it('builds an OUTSIDE RANGE condition', () => {
    expect(buildExpr(state({ conditionOp: 'outside', thresholdA: 10, thresholdB: 90 }))).toBe(
      '(cpu_usage < 10 or cpu_usage > 90)'
    );
  });

  it('builds a WITHIN RANGE condition', () => {
    expect(buildExpr(state({ conditionOp: 'within', thresholdA: 10, thresholdB: 90 }))).toBe(
      '(cpu_usage >= 10 and cpu_usage <= 90)'
    );
  });

  it('stacks reduce + label + comparison together', () => {
    expect(
      buildExpr(
        state({
          labelName: 'host',
          labelOperator: '=~',
          labelValue: 'web.*',
          aggFn: 'max',
          aggWindow: '5m',
          conditionOp: 'gt',
          thresholdA: 100,
        })
      )
    ).toBe('max_over_time(cpu_usage{host=~"web.*"}[5m]) > 100');
  });

  it('coerces a missing/NaN threshold to 0 rather than emitting NaN', () => {
    expect(buildExpr(state({ conditionOp: 'gt' }))).toBe('cpu_usage > 0');
  });
});

describe('parseExpr round-trips buildExpr', () => {
  const cases: ConditionBuilderState[] = [
    state(),
    state({ labelName: 'host', labelOperator: '=', labelValue: 'web-1' }),
    state({ labelName: 'host', labelOperator: '=~', labelValue: 'web.*' }),
    state({ aggFn: 'avg', aggWindow: '10m' }),
    state({ conditionOp: 'gt', thresholdA: 0.5 }),
    state({ conditionOp: 'lte', thresholdA: -3.5 }),
    state({ conditionOp: 'outside', thresholdA: 10, thresholdB: 90 }),
    state({ conditionOp: 'within', thresholdA: 10, thresholdB: 90 }),
    state({
      labelName: 'host',
      labelOperator: '=',
      labelValue: 'web-1',
      aggFn: 'max',
      aggWindow: '5m',
      conditionOp: 'gte',
      thresholdA: 100,
    }),
  ];

  it.each(cases)('round-trips %#', (s) => {
    const expr = buildExpr(s);
    const parsed = parseExpr(expr);
    expect(parsed).not.toBeNull();
    // Re-building from the parsed state yields the identical expression.
    expect(buildExpr(parsed!)).toBe(expr);
  });
});

describe('parseExpr', () => {
  it('returns null for an empty query', () => {
    expect(parseExpr('')).toBeNull();
    expect(parseExpr('   ')).toBeNull();
  });

  it('returns null for an expression the builder cannot represent', () => {
    expect(parseExpr('rate(http_requests_total[5m])')).toBeNull();
    expect(parseExpr('sum by (job) (up)')).toBeNull();
    expect(parseExpr('cpu_usage{a="1",b="2"}')).toBeNull(); // multiple matchers
  });

  it('parses a simple comparison', () => {
    expect(parseExpr('cpu_usage > 0.5')).toMatchObject({
      metric: 'cpu_usage',
      conditionOp: 'gt',
      thresholdA: 0.5,
      aggFn: 'none',
    });
  });

  it('does not confuse a range form for a simple comparison', () => {
    expect(parseExpr('(cpu_usage < 10 or cpu_usage > 90)')).toMatchObject({
      conditionOp: 'outside',
      thresholdA: 10,
      thresholdB: 90,
    });
  });

  it('rejects a range whose two inner expressions differ', () => {
    // Not builder-produced (different left/right selectors) → inert.
    expect(parseExpr('(cpu_usage < 10 or mem_usage > 90)')).toBeNull();
  });
});

describe('isAlwaysFiring', () => {
  it('is false for empty input (nothing yet, not a footgun)', () => {
    expect(isAlwaysFiring('')).toBe(false);
  });

  it('is true for a bare selector', () => {
    expect(isAlwaysFiring('up')).toBe(true);
    expect(isAlwaysFiring('cpu_usage{host="web-1"}')).toBe(true);
    expect(isAlwaysFiring('avg_over_time(cpu_usage[5m])')).toBe(true);
  });

  it('is false once a comparison is present', () => {
    expect(isAlwaysFiring('up == 0')).toBe(false);
    expect(isAlwaysFiring('cpu_usage{host="web-1"} > 0.5')).toBe(false);
    expect(isAlwaysFiring('(cpu_usage < 10 or cpu_usage > 90)')).toBe(false);
  });

  it('is not fooled by a comparison-like character inside a label value', () => {
    expect(isAlwaysFiring('cpu_usage{path="/a>b"}')).toBe(true);
  });
});

describe('isRangeOp', () => {
  it('is true only for range operators', () => {
    expect(isRangeOp('outside')).toBe(true);
    expect(isRangeOp('within')).toBe(true);
    expect(isRangeOp('gt')).toBe(false);
    expect(isRangeOp('none')).toBe(false);
  });
});
