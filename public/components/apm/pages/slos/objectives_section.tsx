/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-objective editor (W2.1). N rows; each row is {name, target%, latency
 * threshold if the template is latency_threshold}. The validator already
 * supports N objectives; the generator emits one rule-set per objective.
 */

import React from 'react';
import {
  EuiButtonEmpty,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { SloTemplate } from '../../../../../common/slo/slo_templates';
import type { Action, FormState } from './wizard_state';

export interface ObjectivesSectionProps {
  objectives: FormState['objectives'];
  latencyThresholdUnit: FormState['latencyThresholdUnit'];
  template: SloTemplate;
  errors: Record<string, string>;
  dispatch: React.Dispatch<Action>;
}

export const ObjectivesSection: React.FC<ObjectivesSectionProps> = ({
  objectives,
  latencyThresholdUnit,
  template,
  errors,
  dispatch,
}) => {
  const showLatency = template.sli.type === 'latency_threshold';
  return (
    <EuiPanel data-test-subj="slosWizardObjectives">
      <EuiText size="m">
        <h4>Objectives</h4>
      </EuiText>
      <EuiText size="s" color="subdued">
        Each objective produces its own set of recording and alerting rules. Common pattern: a
        strict page target (p99) plus a looser ticket target (p90).
      </EuiText>
      <EuiSpacer size="s" />
      {objectives.map((row, i) => {
        const nameError = errors[`spec.objectives[${i}].name`];
        const targetError = errors[`spec.objectives[${i}].target`];
        const latencyError = errors[`spec.objectives[${i}].latencyThreshold`];
        return (
          <EuiFlexGroup
            key={i}
            gutterSize="s"
            alignItems="flexEnd"
            style={{ marginBottom: 8 }}
            data-test-subj={`slosWizardObjectiveRow-${i}`}
          >
            <EuiFlexItem>
              <EuiFormRow label="Objective name" isInvalid={!!nameError} error={nameError}>
                <EuiFieldText
                  value={row.name}
                  onChange={(e) =>
                    dispatch({
                      kind: 'setObjectiveField',
                      index: i,
                      field: 'name',
                      value: e.target.value,
                    })
                  }
                  compressed
                  data-test-subj={`slosWizardObjectiveName-${i}`}
                />
              </EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow
                label="Target (%)"
                isInvalid={!!targetError}
                error={targetError}
                helpText="99.9% = 0.999 decimal"
              >
                <EuiFieldNumber
                  value={row.target}
                  min={50}
                  max={99.999}
                  step={0.001}
                  onChange={(e) =>
                    dispatch({
                      kind: 'setObjectiveField',
                      index: i,
                      field: 'target',
                      value: e.target.value,
                    })
                  }
                  compressed
                  data-test-subj={`slosWizardObjectiveTarget-${i}`}
                />
              </EuiFormRow>
            </EuiFlexItem>
            {showLatency && (
              <EuiFlexItem>
                <EuiFormRow
                  label={`Latency (${latencyThresholdUnit})`}
                  isInvalid={!!latencyError}
                  error={latencyError}
                >
                  <EuiFieldNumber
                    value={row.latencyThreshold}
                    min={0}
                    step={0.01}
                    onChange={(e) =>
                      dispatch({
                        kind: 'setObjectiveField',
                        index: i,
                        field: 'latencyThreshold',
                        value: e.target.value,
                      })
                    }
                    compressed
                    data-test-subj={`slosWizardObjectiveLatency-${i}`}
                  />
                </EuiFormRow>
              </EuiFlexItem>
            )}
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                color="danger"
                onClick={() => dispatch({ kind: 'removeObjective', index: i })}
                disabled={objectives.length <= 1}
                iconType="trash"
                aria-label={`Remove objective ${i}`}
                size="s"
                data-test-subj={`slosWizardObjectiveRemove-${i}`}
              />
            </EuiFlexItem>
          </EuiFlexGroup>
        );
      })}
      <EuiButtonEmpty
        iconType="plusInCircle"
        size="s"
        onClick={() => dispatch({ kind: 'addObjective' })}
        data-test-subj="slosWizardObjectiveAdd"
      >
        Add objective
      </EuiButtonEmpty>
    </EuiPanel>
  );
};
