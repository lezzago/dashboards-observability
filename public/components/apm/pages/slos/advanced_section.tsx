/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * W2.5 — Advanced section. Collapsed by default so the common path stays
 * minimal. Exposes the three knobs that were previously hard-coded:
 *
 *   1. MWMBR burn-rate tiers — short/long windows, multiplier, severity.
 *   2. Budget-warning thresholds — fraction remaining + severity.
 *   3. Supplemental alarm toggles — sliHealth, attainmentBreach, noData,
 *      resolved. budgetWarning is covered by the thresholds editor above.
 *
 * Maya's UX rationale: progressive disclosure. Defaults match the hardcoded
 * P0 values (google-30d.yaml burn rates, 50%/20% budget warnings, alarms
 * off-by-default except budgetWarning). Users who don't open the accordion
 * get exactly what the wizard produced before.
 */

import React from 'react';
import {
  EuiAccordion,
  EuiButtonEmpty,
  EuiCheckbox,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { BudgetWarningThreshold, BurnRateConfig } from '../../../../../common/slo/slo_types';
import type { Action, FormState, ToggleableAlarm } from './wizard_state';

export interface AdvancedSectionProps {
  burnRates: BurnRateConfig[];
  budgetWarnings: BudgetWarningThreshold[];
  alarms: FormState['alarms'];
  errors: Record<string, string>;
  dispatch: React.Dispatch<Action>;
}

const SEVERITY_OPTIONS = [
  { value: 'critical', text: 'critical' },
  { value: 'warning', text: 'warning' },
  { value: 'info', text: 'info' },
];

export const AdvancedSection: React.FC<AdvancedSectionProps> = ({
  burnRates,
  budgetWarnings,
  alarms,
  errors,
  dispatch,
}) => (
  <EuiPanel>
    <EuiAccordion
      id="slos-wizard-advanced"
      buttonContent="Advanced — burn rates, budget warnings, supplemental alarms"
      paddingSize="s"
      data-test-subj="slos-wizard-advanced-toggle"
    >
      <BurnRatesEditor burnRates={burnRates} errors={errors} dispatch={dispatch} />
      <EuiSpacer size="m" />
      <BudgetWarningsEditor budgetWarnings={budgetWarnings} errors={errors} dispatch={dispatch} />
      <EuiSpacer size="m" />
      <AlarmsEditor alarms={alarms} dispatch={dispatch} />
    </EuiAccordion>
  </EuiPanel>
);

// ---- Burn rates --------------------------------------------------------

const BurnRatesEditor: React.FC<{
  burnRates: BurnRateConfig[];
  errors: Record<string, string>;
  dispatch: React.Dispatch<Action>;
}> = ({ burnRates, errors, dispatch }) => (
  <div data-test-subj="slos-wizard-burnrates">
    <EuiText size="s">
      <h5>Burn-rate tiers (MWMBR)</h5>
    </EuiText>
    <EuiText size="xs" color="subdued">
      Multi-window, multi-burn-rate. Defaults match google-30d.yaml (14.4× / 6× / 3× / 1×).
    </EuiText>
    <EuiSpacer size="xs" />
    {burnRates.map((tier, i) => {
      const prefix = `spec.alerting.burnRates[${i}]`;
      return (
        <EuiFlexGroup
          key={i}
          gutterSize="s"
          alignItems="flexEnd"
          style={{ marginBottom: 6 }}
          data-test-subj={`slos-wizard-burnrate-row-${i}`}
          wrap
        >
          <EuiFlexItem>
            <EuiFormRow
              label="Short window"
              isInvalid={!!errors[`${prefix}.shortWindow`]}
              error={errors[`${prefix}.shortWindow`]}
            >
              <EuiFieldText
                value={tier.shortWindow}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBurnRateField',
                    index: i,
                    field: 'shortWindow',
                    value: e.target.value,
                  })
                }
                compressed
                data-test-subj={`slos-wizard-burnrate-short-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow
              label="Long window"
              isInvalid={!!errors[`${prefix}.longWindow`]}
              error={errors[`${prefix}.longWindow`]}
            >
              <EuiFieldText
                value={tier.longWindow}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBurnRateField',
                    index: i,
                    field: 'longWindow',
                    value: e.target.value,
                  })
                }
                compressed
                data-test-subj={`slos-wizard-burnrate-long-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow
              label="Multiplier"
              isInvalid={!!errors[`${prefix}.burnRateMultiplier`]}
              error={errors[`${prefix}.burnRateMultiplier`]}
            >
              <EuiFieldNumber
                value={tier.burnRateMultiplier}
                step={0.1}
                min={0.001}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBurnRateField',
                    index: i,
                    field: 'burnRateMultiplier',
                    value: Number(e.target.value),
                  })
                }
                compressed
                data-test-subj={`slos-wizard-burnrate-multiplier-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="For">
              <EuiFieldText
                value={tier.forDuration}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBurnRateField',
                    index: i,
                    field: 'forDuration',
                    value: e.target.value,
                  })
                }
                compressed
                data-test-subj={`slos-wizard-burnrate-for-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Severity">
              <EuiSelect
                value={tier.severity}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBurnRateField',
                    index: i,
                    field: 'severity',
                    value: e.target.value,
                  })
                }
                options={SEVERITY_OPTIONS}
                compressed
                data-test-subj={`slos-wizard-burnrate-severity-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiCheckbox
              id={`slos-wizard-burnrate-alarm-${i}`}
              label="Alarm"
              checked={tier.createAlarm}
              onChange={(e) =>
                dispatch({
                  kind: 'setBurnRateField',
                  index: i,
                  field: 'createAlarm',
                  value: e.target.checked,
                })
              }
              data-test-subj={`slos-wizard-burnrate-alarm-${i}`}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              color="danger"
              onClick={() => dispatch({ kind: 'removeBurnRate', index: i })}
              iconType="trash"
              aria-label={`Remove burn-rate tier ${i}`}
              size="s"
              data-test-subj={`slos-wizard-burnrate-remove-${i}`}
            />
          </EuiFlexItem>
        </EuiFlexGroup>
      );
    })}
    <EuiButtonEmpty
      iconType="plusInCircle"
      size="s"
      onClick={() => dispatch({ kind: 'addBurnRate' })}
      data-test-subj="slos-wizard-burnrate-add"
    >
      Add burn-rate tier
    </EuiButtonEmpty>
  </div>
);

// ---- Budget warnings ---------------------------------------------------

const BudgetWarningsEditor: React.FC<{
  budgetWarnings: BudgetWarningThreshold[];
  errors: Record<string, string>;
  dispatch: React.Dispatch<Action>;
}> = ({ budgetWarnings, errors, dispatch }) => (
  <div data-test-subj="slos-wizard-budget-warnings">
    <EuiText size="s">
      <h5>Budget-warning thresholds</h5>
    </EuiText>
    <EuiText size="xs" color="subdued">
      Fires when the remaining error budget drops below <code>threshold</code>. Values are fractions
      of the total budget.
    </EuiText>
    <EuiSpacer size="xs" />
    {budgetWarnings.map((bw, i) => {
      const prefix = `spec.budgetWarningThresholds[${i}]`;
      return (
        <EuiFlexGroup
          key={i}
          gutterSize="s"
          alignItems="flexEnd"
          style={{ marginBottom: 6 }}
          data-test-subj={`slos-wizard-budget-warning-row-${i}`}
        >
          <EuiFlexItem>
            <EuiFormRow
              label="Threshold (fraction remaining)"
              isInvalid={!!errors[`${prefix}.threshold`]}
              error={errors[`${prefix}.threshold`]}
            >
              <EuiFieldNumber
                value={bw.threshold}
                step={0.05}
                min={0.01}
                max={0.99}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBudgetWarningField',
                    index: i,
                    field: 'threshold',
                    value: Number(e.target.value),
                  })
                }
                compressed
                data-test-subj={`slos-wizard-budget-warning-threshold-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Severity">
              <EuiSelect
                value={bw.severity}
                onChange={(e) =>
                  dispatch({
                    kind: 'setBudgetWarningField',
                    index: i,
                    field: 'severity',
                    value: e.target.value,
                  })
                }
                options={SEVERITY_OPTIONS}
                compressed
                data-test-subj={`slos-wizard-budget-warning-severity-${i}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              color="danger"
              onClick={() => dispatch({ kind: 'removeBudgetWarning', index: i })}
              iconType="trash"
              aria-label={`Remove budget warning ${i}`}
              size="s"
              data-test-subj={`slos-wizard-budget-warning-remove-${i}`}
            />
          </EuiFlexItem>
        </EuiFlexGroup>
      );
    })}
    <EuiButtonEmpty
      iconType="plusInCircle"
      size="s"
      onClick={() => dispatch({ kind: 'addBudgetWarning' })}
      data-test-subj="slos-wizard-budget-warning-add"
    >
      Add budget-warning threshold
    </EuiButtonEmpty>
  </div>
);

// ---- Alarms ------------------------------------------------------------

interface AlarmToggle {
  id: ToggleableAlarm;
  label: string;
  caption: string;
}

const ALARM_TOGGLES: AlarmToggle[] = [
  {
    id: 'sliHealth',
    label: 'SLI health',
    caption: 'Overlaps the page-quick tier; default OFF to avoid duplicate pages.',
  },
  {
    id: 'attainmentBreach',
    label: 'Attainment breach',
    caption: 'Fires when attainment falls below the objective target for the whole window.',
  },
  {
    id: 'budgetWarning',
    label: 'Budget-warning alerts',
    caption: 'Emits one alert per (objective × threshold) defined above.',
  },
  {
    id: 'resolved',
    label: 'Resolved notifications',
    caption: 'Recovery notification when any firing SLO alert clears.',
  },
];

const AlarmsEditor: React.FC<{
  alarms: FormState['alarms'];
  dispatch: React.Dispatch<Action>;
}> = ({ alarms, dispatch }) => (
  <div data-test-subj="slos-wizard-supplemental-alarms">
    <EuiText size="s">
      <h5>Supplemental alarms</h5>
    </EuiText>
    <EuiSpacer size="xs" />
    {ALARM_TOGGLES.map((a) => (
      <div key={a.id} style={{ marginBottom: 8 }}>
        <EuiCheckbox
          id={`slos-wizard-alarm-${a.id}`}
          label={a.label}
          checked={alarms[a.id].enabled}
          onChange={(e) =>
            dispatch({ kind: 'setAlarmToggle', alarm: a.id, enabled: e.target.checked })
          }
          data-test-subj={`slos-wizard-alarm-${a.id}`}
        />
        <EuiText size="xs" color="subdued">
          {a.caption}
        </EuiText>
      </div>
    ))}
    <EuiFlexGroup gutterSize="s" alignItems="center">
      <EuiFlexItem grow={false}>
        <EuiCheckbox
          id="slos-wizard-alarm-noData"
          label="No-data alert"
          checked={alarms.noData.enabled}
          onChange={(e) =>
            dispatch({ kind: 'setAlarmToggle', alarm: 'noData', enabled: e.target.checked })
          }
          data-test-subj="slos-wizard-alarm-noData"
        />
      </EuiFlexItem>
      <EuiFlexItem>
        <EuiFormRow label="For">
          <EuiFieldText
            value={alarms.noData.forDuration}
            onChange={(e) => dispatch({ kind: 'setNoDataDuration', forDuration: e.target.value })}
            disabled={!alarms.noData.enabled}
            compressed
            data-test-subj="slos-wizard-alarm-noData-duration"
          />
        </EuiFormRow>
      </EuiFlexItem>
    </EuiFlexGroup>
  </div>
);
