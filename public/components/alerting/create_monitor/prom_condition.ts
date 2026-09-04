/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure composition + parsing core for the Grafana-style PromQL alert-condition
 * builder. Kept free of React so the (fiddly) expression assembly and its
 * inverse round-trip parser can be exhaustively unit-tested; the UI in
 * `prom_query_builder.tsx` is a thin shell over these functions.
 *
 * The builder assembles a Prometheus alerting `expr` in three stacked layers:
 *
 *   1. Series selector  — `metric` or `metric{label OP "value"}`
 *   2. Reduce (optional) — `<fn>_over_time(<selector>[<window>])`, mirroring
 *      Grafana's "reduce" step (Last / Avg / Min / Max / Sum / Count)
 *   3. Condition         — a comparison that makes the expr return samples ONLY
 *      when the alert should fire (the whole point of a conditional alert):
 *        IS ABOVE `>`, ABOVE-OR-EQUAL `>=`, BELOW `<`, BELOW-OR-EQUAL `<=`,
 *        EQUAL `==`, NOT EQUAL `!=`, and the two range forms
 *        OUTSIDE RANGE → `(<inner> < a or <inner> > b)`
 *        WITHIN RANGE  → `(<inner> >= a and <inner> <= b)`
 *
 * `buildExpr` composes the layers top-down; `parseExpr` peels them back off in
 * reverse so switching Builder↔Code (or editing then re-opening) is lossless
 * for any expression the builder itself could have produced. Anything more
 * complex parses to `null`, leaving the builder inert so a hand-written Code
 * expression is never silently rewritten.
 */

export type AggFn = 'none' | 'avg' | 'min' | 'max' | 'sum' | 'count' | 'last';

export type ConditionOp =
  'none' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'outside' | 'within';

export interface ConditionBuilderState {
  /** Metric name — the only required field; empty means "no query yet". */
  metric: string;
  /** Optional single label matcher. */
  labelName?: string;
  /** Label match operator: `=`, `!=`, `=~`, `!~`. */
  labelOperator?: string;
  labelValue?: string;
  /** Reduce function over a rolling window; `none` = raw instant selector. */
  aggFn: AggFn;
  /** Window for the reduce, e.g. `5m`. Ignored when `aggFn === 'none'`. */
  aggWindow: string;
  /** Alert condition; `none` = no comparison (an always-firing selector). */
  conditionOp: ConditionOp;
  /** Primary threshold (comparison RHS, or the LOW bound of a range). */
  thresholdA?: number;
  /** HIGH bound — only used by the `outside` / `within` range operators. */
  thresholdB?: number;
}

export const DEFAULT_AGG_WINDOW = '5m';

/** Reduce function → its PromQL `_over_time` counterpart. */
const AGG_FN_TO_PROMQL: Record<Exclude<AggFn, 'none'>, string> = {
  avg: 'avg_over_time',
  min: 'min_over_time',
  max: 'max_over_time',
  sum: 'sum_over_time',
  count: 'count_over_time',
  last: 'last_over_time',
};

const PROMQL_TO_AGG_FN: Record<string, Exclude<AggFn, 'none'>> = Object.fromEntries(
  Object.entries(AGG_FN_TO_PROMQL).map(([k, v]) => [v, k as Exclude<AggFn, 'none'>])
);

/** Single-comparison operator → PromQL symbol. */
const SIMPLE_OP_TO_SYMBOL: Record<
  Extract<ConditionOp, 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'>,
  string
> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '==',
  neq: '!=',
};

const SYMBOL_TO_SIMPLE_OP: Record<string, ConditionOp> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  '==': 'eq',
  '!=': 'neq',
};

/** True for the two-bound range operators. */
export function isRangeOp(op: ConditionOp): boolean {
  return op === 'outside' || op === 'within';
}

/** Render a number for embedding in PromQL (no locale separators, no `NaN`). */
function num(n: number | undefined): string {
  return Number.isFinite(n as number) ? String(n) : '0';
}

/** Escape a label value for a PromQL double-quoted string literal. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeLabelValue(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** Layer 1 — the bare series selector. Empty metric → empty string. */
function buildSelector(state: ConditionBuilderState): string {
  const metric = (state.metric || '').trim();
  if (!metric) return '';
  if (state.labelName && state.labelValue !== undefined && state.labelValue !== '') {
    const op = state.labelOperator || '=';
    return `${metric}{${state.labelName}${op}"${escapeLabelValue(state.labelValue)}"}`;
  }
  return metric;
}

/**
 * Compose the full PromQL expression from builder state. Returns `''` until a
 * metric is chosen (nothing to preview / save yet).
 */
export function buildExpr(state: ConditionBuilderState): string {
  const selector = buildSelector(state);
  if (!selector) return '';

  // Layer 2 — reduce over a window.
  let inner = selector;
  if (state.aggFn !== 'none') {
    const window = (state.aggWindow || DEFAULT_AGG_WINDOW).trim() || DEFAULT_AGG_WINDOW;
    inner = `${AGG_FN_TO_PROMQL[state.aggFn]}(${selector}[${window}])`;
  }

  // Layer 3 — condition.
  switch (state.conditionOp) {
    case 'none':
      return inner;
    case 'outside':
      return `(${inner} < ${num(state.thresholdA)} or ${inner} > ${num(state.thresholdB)})`;
    case 'within':
      return `(${inner} >= ${num(state.thresholdA)} and ${inner} <= ${num(state.thresholdB)})`;
    default:
      return `${inner} ${SIMPLE_OP_TO_SYMBOL[state.conditionOp]} ${num(state.thresholdA)}`;
  }
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const SELECTOR_RE = new RegExp(
  String.raw`^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"\s*\})?$`
);
const AGG_RE = new RegExp(
  String.raw`^(avg|min|max|sum|count|last)_over_time\(\s*(.+?)\s*\[\s*(\d+[smhdwy])\s*\]\s*\)$`
);
const SIMPLE_CMP_RE = new RegExp(String.raw`^(.+?)\s*(>=|<=|==|!=|>|<)\s*(${NUMBER})$`);
const OUTSIDE_RE = new RegExp(
  String.raw`^\(\s*(.+?)\s*<\s*(${NUMBER})\s+or\s+(.+?)\s*>\s*(${NUMBER})\s*\)$`
);
const WITHIN_RE = new RegExp(
  String.raw`^\(\s*(.+?)\s*>=\s*(${NUMBER})\s+and\s+(.+?)\s*<=\s*(${NUMBER})\s*\)$`
);

/** Parse a bare selector (`metric` / `metric{l OP "v"}`) into partial state. */
function parseSelector(
  selector: string
): Pick<ConditionBuilderState, 'metric' | 'labelName' | 'labelOperator' | 'labelValue'> | null {
  const m = selector.trim().match(SELECTOR_RE);
  if (!m) return null;
  const [, metric, labelName, labelOperator, escaped] = m;
  if (!labelName) return { metric };
  return { metric, labelName, labelOperator, labelValue: unescapeLabelValue(escaped) };
}

/** Peel the optional reduce layer off, returning the fn/window + inner selector. */
function parseReduce(inner: string): { aggFn: AggFn; aggWindow: string; selector: string } {
  const m = inner.trim().match(AGG_RE);
  if (!m) return { aggFn: 'none', aggWindow: DEFAULT_AGG_WINDOW, selector: inner.trim() };
  return { aggFn: PROMQL_TO_AGG_FN[`${m[1]}_over_time`], aggWindow: m[3], selector: m[2] };
}

/**
 * Inverse of {@link buildExpr}. Returns fully-populated builder state for any
 * expression the builder could have emitted, or `null` for anything else (so
 * the caller leaves the builder inert rather than clobbering a Code expression).
 */
export function parseExpr(query: string): ConditionBuilderState | null {
  const q = (query || '').trim();
  if (!q) return null;

  let conditionOp: ConditionOp = 'none';
  let thresholdA: number | undefined;
  let thresholdB: number | undefined;
  let inner = q;

  // Layer 3 — range forms first (they wrap in parens), then a simple comparison.
  const outside = q.match(OUTSIDE_RE);
  const within = q.match(WITHIN_RE);
  if (outside && outside[1].trim() === outside[3].trim()) {
    conditionOp = 'outside';
    inner = outside[1].trim();
    thresholdA = Number(outside[2]);
    thresholdB = Number(outside[4]);
  } else if (within && within[1].trim() === within[3].trim()) {
    conditionOp = 'within';
    inner = within[1].trim();
    thresholdA = Number(within[2]);
    thresholdB = Number(within[4]);
  } else {
    const cmp = q.match(SIMPLE_CMP_RE);
    if (cmp) {
      conditionOp = SYMBOL_TO_SIMPLE_OP[cmp[2]];
      inner = cmp[1].trim();
      thresholdA = Number(cmp[3]);
    }
  }

  // Layer 2 + 1.
  const { aggFn, aggWindow, selector } = parseReduce(inner);
  const parsedSelector = parseSelector(selector);
  if (!parsedSelector) return null;

  return {
    ...parsedSelector,
    aggFn,
    aggWindow,
    conditionOp,
    thresholdA,
    thresholdB,
  };
}

/**
 * Heuristic used to warn about an always-firing rule: true when the expression
 * carries no top-level comparison, so it returns samples whenever the series
 * merely exists. Conservative by design — it strips label matchers and quoted
 * strings first, so a real threshold (`… > 5`) is never flagged; only a bare
 * selector (or reduce with no comparison) trips it. Empty input is NOT
 * always-firing (there's simply nothing yet).
 */
export function isAlwaysFiring(query: string): boolean {
  const q = (query || '').trim();
  if (!q) return false;
  const stripped = q
    .replace(/\{[^}]*\}/g, '') // label matchers
    .replace(/"(?:[^"\\]|\\.)*"/g, ''); // any remaining quoted strings
  return !/(>=|<=|==|!=|>|<)/.test(stripped);
}
