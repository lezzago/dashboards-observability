/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PromQueryBuilder — the shared point-and-click PromQL alert-condition builder
 * used by both the Alert Manager "Create metrics rule" flyout and the Metrics
 * page "Create alert rule" flyout.
 *
 * Modelled on Grafana's alert-rule editor, it assembles the expression in three
 * stacked layers (see `prom_condition.ts` for the pure composition/parse core):
 *
 *   1. Series   — metric + optional `{label OP "value"}` matcher
 *   2. Reduce   — Last / Avg / Min / Max / Sum / Count over a rolling window
 *   3. Condition — IS ABOVE / BELOW / EQUAL / … or a range, i.e. the comparison
 *      that makes the alert conditional rather than always-firing
 *
 * Metric names, label names, and label values are fetched live from the
 * datasource. Selections are seeded from an existing query when that query is
 * builder-representable (`parseExpr`); anything more complex leaves the builder
 * empty and inert so a seeded Code expression is never clobbered unless the
 * user explicitly picks a new metric.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  EuiButtonIcon,
  EuiComboBox,
  EuiFieldNumber,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { i18n } from '@osd/i18n';
import { AlertingPromResourcesService } from '../query_services/alerting_prom_resources_service';
import {
  AggFn,
  buildExpr,
  ConditionBuilderState,
  ConditionOp,
  DEFAULT_AGG_WINDOW,
  isRangeOp,
  parseExpr,
} from './prom_condition';

/** Reduce-function options (value → label). */
const AGG_FN_OPTIONS: Array<{ value: AggFn; text: string }> = [
  {
    value: 'none',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggNone', {
      defaultMessage: 'None (instant value)',
    }),
  },
  {
    value: 'last',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggLast', {
      defaultMessage: 'Last',
    }),
  },
  {
    value: 'avg',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggAvg', {
      defaultMessage: 'Average',
    }),
  },
  {
    value: 'min',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggMin', {
      defaultMessage: 'Min',
    }),
  },
  {
    value: 'max',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggMax', {
      defaultMessage: 'Max',
    }),
  },
  {
    value: 'sum',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggSum', {
      defaultMessage: 'Sum',
    }),
  },
  {
    value: 'count',
    text: i18n.translate('observability.alerting.promQueryBuilder.aggCount', {
      defaultMessage: 'Count',
    }),
  },
];

/** Condition-operator options (value → label), Grafana-style wording. */
const CONDITION_OP_OPTIONS: Array<{ value: ConditionOp; text: string }> = [
  {
    value: 'none',
    text: i18n.translate('observability.alerting.promQueryBuilder.condNone', {
      defaultMessage: 'No condition (always firing)',
    }),
  },
  {
    value: 'gt',
    text: i18n.translate('observability.alerting.promQueryBuilder.condGt', {
      defaultMessage: 'IS ABOVE',
    }),
  },
  {
    value: 'gte',
    text: i18n.translate('observability.alerting.promQueryBuilder.condGte', {
      defaultMessage: 'IS ABOVE OR EQUAL',
    }),
  },
  {
    value: 'lt',
    text: i18n.translate('observability.alerting.promQueryBuilder.condLt', {
      defaultMessage: 'IS BELOW',
    }),
  },
  {
    value: 'lte',
    text: i18n.translate('observability.alerting.promQueryBuilder.condLte', {
      defaultMessage: 'IS BELOW OR EQUAL',
    }),
  },
  {
    value: 'eq',
    text: i18n.translate('observability.alerting.promQueryBuilder.condEq', {
      defaultMessage: 'IS EQUAL TO',
    }),
  },
  {
    value: 'neq',
    text: i18n.translate('observability.alerting.promQueryBuilder.condNeq', {
      defaultMessage: 'IS NOT EQUAL TO',
    }),
  },
  {
    value: 'outside',
    text: i18n.translate('observability.alerting.promQueryBuilder.condOutside', {
      defaultMessage: 'IS OUTSIDE RANGE',
    }),
  },
  {
    value: 'within',
    text: i18n.translate('observability.alerting.promQueryBuilder.condWithin', {
      defaultMessage: 'IS WITHIN RANGE',
    }),
  },
];

/** Re-export so callers (the always-firing warning) parse from one place. */
export { parseExpr, buildExpr } from './prom_condition';

export const PromQueryBuilder: React.FC<{
  /** Datasource to fetch metric/label metadata from. */
  datasourceId?: string;
  /** Current query, used to seed builder selections on mount. */
  query: string;
  /** Fired whenever builder selections produce (or clear) a query. */
  onQueryChange: (query: string) => void;
}> = ({ datasourceId, query, onQueryChange }) => {
  // Seeded once on mount — complex expressions yield null and an inert builder.
  const [seeded] = useState(() => parseExpr(query));
  const [metricOptions, setMetricOptions] = useState<Array<{ label: string }>>([]);
  const [selectedMetric, setSelectedMetric] = useState<Array<{ label: string }>>(
    seeded ? [{ label: seeded.metric }] : []
  );
  const [labelNameOptions, setLabelNameOptions] = useState<Array<{ label: string }>>([]);
  const [selectedLabelName, setSelectedLabelName] = useState<Array<{ label: string }>>(
    seeded?.labelName ? [{ label: seeded.labelName }] : []
  );
  const [labelValueOptions, setLabelValueOptions] = useState<Array<{ label: string }>>([]);
  const [selectedLabelValue, setSelectedLabelValue] = useState<Array<{ label: string }>>(
    seeded?.labelValue ? [{ label: seeded.labelValue }] : []
  );
  const [labelOperator, setLabelOperator] = useState(seeded?.labelOperator || '=');

  // Reduce + condition layers.
  const [aggFn, setAggFn] = useState<AggFn>(seeded?.aggFn ?? 'none');
  const [aggWindow, setAggWindow] = useState(seeded?.aggWindow || DEFAULT_AGG_WINDOW);
  const [conditionOp, setConditionOp] = useState<ConditionOp>(seeded?.conditionOp ?? 'none');
  // Thresholds are held as strings so the field can be cleared / mid-typed; the
  // pure core coerces a blank/NaN value to 0 when composing.
  const [thresholdA, setThresholdA] = useState(
    seeded?.thresholdA !== undefined ? String(seeded.thresholdA) : ''
  );
  const [thresholdB, setThresholdB] = useState(
    seeded?.thresholdB !== undefined ? String(seeded.thresholdB) : ''
  );

  // Fetch metric names when datasource changes. The `stale` flag guards
  // against out-of-order responses overwriting current options.
  useEffect(() => {
    if (!datasourceId) return;
    let stale = false;
    const service = new AlertingPromResourcesService(datasourceId);
    service
      .listMetricNames()
      .then(({ metrics }) => {
        if (!stale) setMetricOptions(metrics.map((m) => ({ label: m })));
      })
      .catch(() => {
        /* non-critical */
      });
    return () => {
      stale = true;
    };
  }, [datasourceId]);

  // Fetch label names when metric changes.
  useEffect(() => {
    if (!datasourceId || selectedMetric.length === 0) {
      setLabelNameOptions([]);
      return;
    }
    let stale = false;
    const service = new AlertingPromResourcesService(datasourceId);
    service
      .listLabelNames(selectedMetric[0].label)
      .then(({ labels }) => {
        if (!stale) setLabelNameOptions(labels.map((l) => ({ label: l })));
      })
      .catch(() => {
        /* non-critical */
      });
    return () => {
      stale = true;
    };
  }, [datasourceId, selectedMetric]);

  // Fetch label values when label name changes.
  useEffect(() => {
    if (!datasourceId || selectedLabelName.length === 0) {
      setLabelValueOptions([]);
      return;
    }
    let stale = false;
    const metric = selectedMetric.length > 0 ? selectedMetric[0].label : undefined;
    const selector = metric ? `{__name__="${metric}"}` : undefined;
    const service = new AlertingPromResourcesService(datasourceId);
    service
      .listLabelValues(selectedLabelName[0].label, selector)
      .then(({ values }) => {
        if (!stale) setLabelValueOptions(values.map((v) => ({ label: v })));
      })
      .catch(() => {
        /* non-critical */
      });
    return () => {
      stale = true;
    };
  }, [datasourceId, selectedLabelName, selectedMetric]);

  // Tracks whether the current query was authored by the builder. Only then
  // may clearing the metric clear the query — a complex seeded expression the
  // builder never produced must not be wiped.
  const builderOwnsQuery = useRef(false);

  const currentState = useCallback(
    (): ConditionBuilderState => ({
      metric: selectedMetric.length > 0 ? selectedMetric[0].label : '',
      labelName: selectedLabelName.length > 0 ? selectedLabelName[0].label : undefined,
      labelOperator,
      labelValue: selectedLabelValue.length > 0 ? selectedLabelValue[0].label : undefined,
      aggFn,
      aggWindow,
      conditionOp,
      thresholdA: thresholdA === '' ? undefined : Number(thresholdA),
      thresholdB: thresholdB === '' ? undefined : Number(thresholdB),
    }),
    [
      selectedMetric,
      selectedLabelName,
      selectedLabelValue,
      labelOperator,
      aggFn,
      aggWindow,
      conditionOp,
      thresholdA,
      thresholdB,
    ]
  );

  // Sync whenever any builder field changes; clearing the metric clears a
  // builder-authored query so the two stay consistent.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      // Seeded FROM the query on mount: mark ownership so a later clear can
      // reset it, but do NOT re-emit — re-emitting would normalize whitespace
      // the user never touched and spuriously mark the form dirty.
      if (seeded) builderOwnsQuery.current = true;
      return;
    }
    if (selectedMetric.length > 0) {
      builderOwnsQuery.current = true;
      onQueryChange(buildExpr(currentState()));
    } else if (builderOwnsQuery.current) {
      builderOwnsQuery.current = false;
      onQueryChange('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedMetric,
    selectedLabelName,
    selectedLabelValue,
    labelOperator,
    aggFn,
    aggWindow,
    conditionOp,
    thresholdA,
    thresholdB,
  ]);

  const showRange = isRangeOp(conditionOp);

  return (
    <>
      {/* Layer 1 — series selector */}
      <EuiFlexGroup gutterSize="m" alignItems="flexEnd" responsive={false}>
        <EuiFlexItem grow={3}>
          <EuiFormRow
            label={i18n.translate('observability.alerting.promQueryBuilder.metricLabel', {
              defaultMessage: 'Metric',
            })}
            display="rowCompressed"
          >
            <EuiComboBox
              placeholder={i18n.translate(
                'observability.alerting.promQueryBuilder.metricPlaceholder',
                { defaultMessage: 'Select metric name' }
              )}
              options={metricOptions}
              selectedOptions={selectedMetric}
              onChange={(opts) => {
                setSelectedMetric(opts);
                // Reset the label filter when the metric changes — a label
                // name/value valid for the old metric can be invalid for the
                // new one, building an incorrect `newMetric{staleLabel=…}`.
                setSelectedLabelName([]);
                setSelectedLabelValue([]);
              }}
              singleSelection={{ asPlainText: true }}
              compressed
              isClearable
              data-test-subj="promBuilderMetric"
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={3}>
          <EuiFormRow
            label={i18n.translate('observability.alerting.promQueryBuilder.labelNameLabel', {
              defaultMessage: 'Label name',
            })}
            display="rowCompressed"
          >
            <EuiComboBox
              placeholder={i18n.translate(
                'observability.alerting.promQueryBuilder.labelNamePlaceholder',
                { defaultMessage: 'Label name' }
              )}
              options={labelNameOptions}
              selectedOptions={selectedLabelName}
              onChange={(opts) => setSelectedLabelName(opts)}
              singleSelection={{ asPlainText: true }}
              compressed
              isClearable
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={false} style={{ width: 60 }}>
          <EuiFormRow label=" " display="rowCompressed">
            <EuiSelect
              options={[
                { value: '=', text: '=' },
                { value: '!=', text: '!=' },
                { value: '=~', text: '=~' },
                { value: '!~', text: '!~' },
              ]}
              value={labelOperator}
              onChange={(e) => setLabelOperator(e.target.value)}
              compressed
              aria-label={i18n.translate(
                'observability.alerting.promQueryBuilder.labelOperatorAriaLabel',
                { defaultMessage: 'Label match operator' }
              )}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={3}>
          <EuiFormRow
            label={i18n.translate('observability.alerting.promQueryBuilder.labelValueLabel', {
              defaultMessage: 'Label value',
            })}
            display="rowCompressed"
          >
            <EuiComboBox
              placeholder={i18n.translate(
                'observability.alerting.promQueryBuilder.labelValuePlaceholder',
                { defaultMessage: 'Label value' }
              )}
              options={labelValueOptions}
              selectedOptions={selectedLabelValue}
              onChange={(opts) => setSelectedLabelValue(opts)}
              singleSelection={{ asPlainText: true }}
              compressed
              isClearable
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButtonIcon
            iconType="cross"
            aria-label={i18n.translate(
              'observability.alerting.promQueryBuilder.clearFilterAriaLabel',
              { defaultMessage: 'Clear filter' }
            )}
            color="subdued"
            onClick={() => {
              setSelectedLabelName([]);
              setSelectedLabelValue([]);
            }}
          />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* Layer 2 — reduce, and Layer 3 — condition */}
      <EuiFlexGroup gutterSize="m" alignItems="flexEnd" responsive={false}>
        <EuiFlexItem grow={2}>
          <EuiFormRow
            label={i18n.translate('observability.alerting.promQueryBuilder.reduceLabel', {
              defaultMessage: 'Reduce',
            })}
            display="rowCompressed"
            helpText={
              aggFn === 'none'
                ? undefined
                : i18n.translate('observability.alerting.promQueryBuilder.reduceHelp', {
                    defaultMessage: 'over a rolling window',
                  })
            }
          >
            <EuiSelect
              options={AGG_FN_OPTIONS}
              value={aggFn}
              onChange={(e) => setAggFn(e.target.value as AggFn)}
              compressed
              data-test-subj="promBuilderReduceFn"
              aria-label={i18n.translate(
                'observability.alerting.promQueryBuilder.reduceAriaLabel',
                { defaultMessage: 'Reduce function' }
              )}
            />
          </EuiFormRow>
        </EuiFlexItem>
        {aggFn !== 'none' && (
          <EuiFlexItem grow={false} style={{ width: 90 }}>
            <EuiFormRow
              label={i18n.translate('observability.alerting.promQueryBuilder.windowLabel', {
                defaultMessage: 'Window',
              })}
              display="rowCompressed"
            >
              <EuiFieldNumber
                // A PromQL duration like `5m`; keep it a text-ish field but the
                // suffix is fixed to the unit selector below for simplicity.
                value={aggWindow.replace(/[a-z]/gi, '')}
                onChange={(e) =>
                  setAggWindow(`${e.target.value || ''}${aggWindow.replace(/[0-9.]/g, '') || 'm'}`)
                }
                append={
                  <EuiSelect
                    options={[
                      { value: 's', text: 's' },
                      { value: 'm', text: 'm' },
                      { value: 'h', text: 'h' },
                    ]}
                    value={aggWindow.replace(/[0-9.]/g, '') || 'm'}
                    onChange={(e) =>
                      setAggWindow(`${aggWindow.replace(/[a-z]/gi, '') || '5'}${e.target.value}`)
                    }
                    compressed
                    aria-label={i18n.translate(
                      'observability.alerting.promQueryBuilder.windowUnitAriaLabel',
                      { defaultMessage: 'Window unit' }
                    )}
                  />
                }
                compressed
                data-test-subj="promBuilderReduceWindow"
                aria-label={i18n.translate(
                  'observability.alerting.promQueryBuilder.windowAriaLabel',
                  { defaultMessage: 'Reduce window' }
                )}
              />
            </EuiFormRow>
          </EuiFlexItem>
        )}
        <EuiFlexItem grow={3}>
          <EuiFormRow
            label={i18n.translate('observability.alerting.promQueryBuilder.conditionLabel', {
              defaultMessage: 'Condition',
            })}
            display="rowCompressed"
          >
            <EuiSelect
              options={CONDITION_OP_OPTIONS}
              value={conditionOp}
              onChange={(e) => setConditionOp(e.target.value as ConditionOp)}
              compressed
              data-test-subj="promBuilderConditionOp"
              aria-label={i18n.translate(
                'observability.alerting.promQueryBuilder.conditionAriaLabel',
                { defaultMessage: 'Alert condition' }
              )}
            />
          </EuiFormRow>
        </EuiFlexItem>
        {conditionOp !== 'none' && (
          <EuiFlexItem grow={2}>
            <EuiFormRow
              label={
                showRange
                  ? i18n.translate('observability.alerting.promQueryBuilder.rangeLowLabel', {
                      defaultMessage: 'From',
                    })
                  : i18n.translate('observability.alerting.promQueryBuilder.thresholdLabel', {
                      defaultMessage: 'Value',
                    })
              }
              display="rowCompressed"
            >
              <EuiFieldNumber
                value={thresholdA}
                onChange={(e) => setThresholdA(e.target.value)}
                compressed
                data-test-subj="promBuilderThresholdA"
                aria-label={i18n.translate(
                  'observability.alerting.promQueryBuilder.thresholdAAriaLabel',
                  { defaultMessage: 'Threshold value' }
                )}
              />
            </EuiFormRow>
          </EuiFlexItem>
        )}
        {showRange && (
          <EuiFlexItem grow={2}>
            <EuiFormRow
              label={i18n.translate('observability.alerting.promQueryBuilder.rangeHighLabel', {
                defaultMessage: 'To',
              })}
              display="rowCompressed"
            >
              <EuiFieldNumber
                value={thresholdB}
                onChange={(e) => setThresholdB(e.target.value)}
                compressed
                data-test-subj="promBuilderThresholdB"
                aria-label={i18n.translate(
                  'observability.alerting.promQueryBuilder.thresholdBAriaLabel',
                  { defaultMessage: 'Upper threshold value' }
                )}
              />
            </EuiFormRow>
          </EuiFlexItem>
        )}
      </EuiFlexGroup>

      <EuiSpacer size="s" />
      <EuiText size="xs" color="subdued">
        {selectedMetric.length === 0
          ? i18n.translate('observability.alerting.promQueryBuilder.helpText', {
              defaultMessage: 'Select a metric to start.',
            })
          : conditionOp === 'none'
            ? i18n.translate('observability.alerting.promQueryBuilder.noConditionHint', {
                defaultMessage:
                  'No condition set — this alert fires whenever the series exists. Add a condition to make it conditional.',
              })
            : i18n.translate('observability.alerting.promQueryBuilder.previewHint', {
                defaultMessage: 'Expression: {expr}',
                values: { expr: buildExpr(currentState()) },
              })}
      </EuiText>
    </>
  );
};
