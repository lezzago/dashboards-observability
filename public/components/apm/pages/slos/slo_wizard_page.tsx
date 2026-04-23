/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * P0 SLO creation wizard — template-driven single-page form.
 * Produces a correct SloCreateInput ({ id?, spec: SloSpec }) and submits.
 *
 * Deferred to P1: multi-step flow, live preview panel, metadata autocomplete,
 * multi-objective editor, labels/annotations editors beyond a single pair,
 * custom-PromQL editor pair.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCard,
  EuiCheckbox,
  EuiFieldText,
  EuiFieldNumber,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiForm,
  EuiFormRow,
  EuiIcon,
  EuiPage,
  EuiPageBody,
  EuiPageContent,
  EuiPageContentBody,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTextArea,
} from '@elastic/eui';
import { useHistory, useParams } from 'react-router-dom';
import { ChromeStart, NotificationsStart } from '../../../../../../../src/core/public';
import { HeaderControlledComponentsWrapper } from '../../../../plugin_helpers/plugin_headerControl';
import type { SloApiClient } from './slo_api_client';
import type {
  BurnRateConfig,
  Dimension,
  Objective,
  PrometheusSli,
  SingleSli,
  SloAlarmConfig,
  SloCreateInput,
  SloSpec,
} from '../../../../../common/slo/slo_types';
import { SLO_TEMPLATES, SloTemplate } from '../../../../../common/slo/slo_templates';
import { DEFAULT_MWMBR_TIERS } from '../../../../../common/slo/slo_promql_generator';
import { validateSloSpec } from '../../../../../common/slo/slo_validators';

export interface SloWizardPageProps {
  apiClient: SloApiClient;
  chrome: ChromeStart;
  notifications: NotificationsStart;
  parentBreadcrumb: { text: string; href: string };
}

// ============================================================================
// Form state (discriminated-union reducer per CLAUDE.md guidance)
// ============================================================================

interface FormState {
  templateId: string | null;
  datasourceId: string;
  name: string;
  description: string;
  service: string;
  ownerTeam: string;
  ownerPrimaryUser: string;
  tier: string;
  windowDuration: '7d' | '14d' | '28d' | '30d';
  objective: { name: string; target: string; latencyThreshold: string };
  dimensions: Dimension[];
  goodEventsFilter: string;
  latencyThresholdUnit: 'seconds' | 'milliseconds';
  labelsRaw: string; // key=value lines
  annotationsRaw: string;
  shadow: boolean;
}

type Action =
  | { kind: 'setTemplate'; templateId: string | null }
  | { kind: 'setField'; field: keyof FormState; value: string | boolean }
  | { kind: 'setObjectiveField'; field: keyof FormState['objective']; value: string }
  | { kind: 'setDimension'; index: number; dim: Dimension }
  | { kind: 'addDimension' }
  | { kind: 'removeDimension'; index: number };

function initialState(): FormState {
  return {
    templateId: null,
    datasourceId: '',
    name: '',
    description: '',
    service: '',
    ownerTeam: '',
    ownerPrimaryUser: '',
    tier: '',
    windowDuration: '28d',
    objective: { name: 'availability-99-9', target: '99.9', latencyThreshold: '0.5' },
    dimensions: [{ name: 'service', value: '' }],
    goodEventsFilter: '',
    latencyThresholdUnit: 'seconds',
    labelsRaw: '',
    annotationsRaw: '',
    shadow: false,
  };
}

function applyTemplate(state: FormState, template: SloTemplate | null): FormState {
  if (!template) return { ...state, templateId: null };
  return {
    ...state,
    templateId: template.id,
    goodEventsFilter: template.sli.goodEventsFilter ?? '',
    latencyThresholdUnit: template.sli.latencyThresholdUnit ?? 'seconds',
    dimensions: [
      { name: template.dimensionHints.serviceLabel, value: state.service || '' },
      ...(state.dimensions.length > 1 ? state.dimensions.slice(1) : []),
    ],
    objective: {
      ...state.objective,
      name:
        template.sli.type === 'availability'
          ? 'availability-99-9'
          : template.sli.type === 'latency_threshold'
          ? 'latency-threshold'
          : state.objective.name,
      latencyThreshold: template.defaultLatencyThreshold
        ? String(template.defaultLatencyThreshold)
        : state.objective.latencyThreshold,
    },
  };
}

function reducer(state: FormState, action: Action): FormState {
  switch (action.kind) {
    case 'setTemplate': {
      const t = SLO_TEMPLATES.find((x) => x.id === action.templateId) ?? null;
      return applyTemplate(state, t);
    }
    case 'setField':
      return { ...state, [action.field]: action.value } as FormState;
    case 'setObjectiveField':
      return { ...state, objective: { ...state.objective, [action.field]: action.value } };
    case 'setDimension': {
      const next = state.dimensions.slice();
      next[action.index] = action.dim;
      return { ...state, dimensions: next };
    }
    case 'addDimension':
      return { ...state, dimensions: [...state.dimensions, { name: '', value: '' }] };
    case 'removeDimension': {
      const next = state.dimensions.slice();
      next.splice(action.index, 1);
      return { ...state, dimensions: next };
    }
  }
}

// ============================================================================
// Builders (form state → SloCreateInput)
// ============================================================================

function parseKeyValueBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function buildAlarms(): SloAlarmConfig {
  return {
    sliHealth: { enabled: false },
    attainmentBreach: { enabled: false },
    budgetWarning: { enabled: true },
    noData: { enabled: false, forDuration: '10m' },
    resolved: { enabled: false },
  };
}

function buildBurnRates(): BurnRateConfig[] {
  return DEFAULT_MWMBR_TIERS.map((t) => ({ ...t }));
}

function buildSli(state: FormState, template: SloTemplate): SingleSli {
  const prom: PrometheusSli = {
    backend: 'prometheus',
    type: template.sli.type,
    calcMethod: template.sli.calcMethod,
    metric: template.sli.metric,
    goodEventsFilter:
      template.sli.type === 'availability' && state.goodEventsFilter
        ? state.goodEventsFilter
        : undefined,
    latencyThresholdUnit:
      template.sli.type === 'latency_threshold' ? state.latencyThresholdUnit : undefined,
  };
  return {
    type: 'single',
    definition: prom,
    dimensions: state.dimensions.filter((d) => d.name && d.value),
  };
}

function buildObjective(state: FormState, template: SloTemplate): Objective {
  const targetDecimal = Number(state.objective.target) / 100;
  const obj: Objective = {
    name: state.objective.name,
    target: Number.isFinite(targetDecimal) ? targetDecimal : 0,
  };
  if (template.sli.type === 'latency_threshold') {
    obj.latencyThreshold = Number(state.objective.latencyThreshold);
  }
  return obj;
}

function buildCreateInput(state: FormState, template: SloTemplate): SloCreateInput {
  const spec: SloSpec = {
    datasourceId: state.datasourceId,
    name: state.name,
    description: state.description || undefined,
    enabled: true,
    mode: state.shadow ? 'shadow' : 'active',
    service: state.service,
    owner: {
      teams: state.ownerTeam ? [state.ownerTeam] : [],
      primaryUser: state.ownerPrimaryUser || undefined,
    },
    tier: state.tier || undefined,
    sli: buildSli(state, template),
    objectives: [buildObjective(state, template)],
    budgetWarningThresholds: [
      { threshold: 0.5, severity: 'warning' },
      { threshold: 0.2, severity: 'critical' },
    ],
    window: { type: 'rolling', duration: state.windowDuration },
    alerting: { strategy: 'mwmbr', burnRates: buildBurnRates() },
    alarms: buildAlarms(),
    exclusionWindows: [],
    labels: parseKeyValueBlock(state.labelsRaw),
    annotations: parseKeyValueBlock(state.annotationsRaw),
  };
  return { spec };
}

// ============================================================================
// Template selector
// ============================================================================

const TemplateSelector: React.FC<{ onPick: (id: string) => void }> = ({ onPick }) => (
  <EuiPanel>
    <EuiText size="m">
      <h4>Pick a template</h4>
    </EuiText>
    <EuiText size="s" color="subdued">
      Templates pre-fill the SLI shape for common observability patterns. Choose Custom to start
      from blank PromQL.
    </EuiText>
    <EuiSpacer size="m" />
    <EuiFlexGrid columns={3}>
      {SLO_TEMPLATES.map((t) => (
        <EuiFlexItem key={t.id}>
          <EuiCard
            icon={<EuiIcon size="xl" type={t.icon} />}
            title={t.name}
            description={t.description}
            onClick={() => onPick(t.id)}
            data-test-subj={`slos-template-${t.id}`}
          />
        </EuiFlexItem>
      ))}
    </EuiFlexGrid>
  </EuiPanel>
);

// ============================================================================
// Main wizard
// ============================================================================

export const SloWizardPage: React.FC<SloWizardPageProps> = ({
  apiClient,
  chrome,
  notifications,
  parentBreadcrumb,
}) => {
  const history = useHistory();
  const { templateId: urlTemplateId } = useParams<{ templateId?: string }>();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Initialize from URL template on mount.
  useEffect(() => {
    if (urlTemplateId && state.templateId !== urlTemplateId) {
      dispatch({ kind: 'setTemplate', templateId: urlTemplateId });
    }
  }, [urlTemplateId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chrome.setBreadcrumbs([
      parentBreadcrumb,
      { text: 'SLO/SLI', href: '#/slos' },
      { text: 'Create' },
    ]);
  }, [chrome, parentBreadcrumb]);

  const template = useMemo(() => SLO_TEMPLATES.find((t) => t.id === state.templateId) ?? null, [
    state.templateId,
  ]);

  const onPickTemplate = useCallback(
    (id: string) => {
      history.replace(`/slos/create/${encodeURIComponent(id)}`);
      dispatch({ kind: 'setTemplate', templateId: id });
    },
    [history]
  );

  const onSubmit = useCallback(async () => {
    if (!template) return;
    const input = buildCreateInput(state, template);
    const { errors: specErrors } = validateSloSpec(input.spec);
    if (Object.keys(specErrors).length > 0) {
      setErrors(specErrors);
      notifications.toasts.addWarning({
        title: 'Fix validation errors',
        text: 'Some required fields are missing or invalid.',
      });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const doc = await apiClient.create(input);
      notifications.toasts.addSuccess({
        title: 'SLO created',
        text: `${doc.spec.name} is now provisioned.`,
      });
      history.push(`/slos/${encodeURIComponent(doc.id)}`);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      notifications.toasts.addDanger({
        title: 'Failed to create SLO',
        text: err.message,
      });
    } finally {
      setSubmitting(false);
    }
  }, [apiClient, history, notifications, state, template]);

  if (!template) {
    const pickActions = [
      <EuiButtonEmpty
        key="back"
        iconType="arrowLeft"
        href="#/slos"
        size="s"
        data-test-subj="slos-cancel"
      >
        Back to SLOs
      </EuiButtonEmpty>,
    ];
    return (
      <EuiPage data-test-subj="sloWizardPage">
        <EuiPageBody component="main">
          <HeaderControlledComponentsWrapper components={pickActions} />
          <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
            <EuiPageContentBody>
              <TemplateSelector onPick={onPickTemplate} />
            </EuiPageContentBody>
          </EuiPageContent>
        </EuiPageBody>
      </EuiPage>
    );
  }

  const wizardActions = [
    <EuiButtonEmpty
      key="template-back"
      iconType="arrowLeft"
      onClick={() => history.replace('/slos/create')}
      size="s"
      data-test-subj="slos-template-back"
    >
      Change template
    </EuiButtonEmpty>,
    <EuiButtonEmpty key="cancel" href="#/slos" size="s" data-test-subj="slos-wizard-cancel">
      Cancel
    </EuiButtonEmpty>,
    <EuiButton
      key="submit"
      fill
      size="s"
      isLoading={submitting}
      onClick={onSubmit}
      data-test-subj="slos-wizard-submit"
    >
      Create SLO
    </EuiButton>,
  ];

  return (
    <EuiPage data-test-subj="sloWizardPage">
      <EuiPageBody component="main">
        <HeaderControlledComponentsWrapper components={wizardActions} />
        <EuiPageContent color="transparent" hasBorder={false} paddingSize="none">
          <EuiPageContentBody>
            <EuiForm component="form">
              {/* Template indicator + identity */}
              <EuiPanel>
                <EuiText size="m">
                  <h4>{template.name} — identity</h4>
                </EuiText>
                <EuiSpacer size="s" />
                <EuiFormRow
                  label="Datasource ID"
                  isInvalid={!!errors['spec.datasourceId']}
                  error={errors['spec.datasourceId']}
                >
                  <EuiFieldText
                    value={state.datasourceId}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'datasourceId', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-datasourceId"
                    placeholder="ds-2"
                  />
                </EuiFormRow>
                <EuiFormRow
                  label="Name"
                  isInvalid={!!errors['spec.name']}
                  error={errors['spec.name']}
                >
                  <EuiFieldText
                    value={state.name}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'name', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-name"
                  />
                </EuiFormRow>
                <EuiFormRow label="Description">
                  <EuiTextArea
                    rows={2}
                    value={state.description}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'description', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-description"
                  />
                </EuiFormRow>
              </EuiPanel>

              <EuiSpacer size="m" />

              <EuiPanel>
                <EuiText size="m">
                  <h4>Service &amp; owner</h4>
                </EuiText>
                <EuiSpacer size="s" />
                <EuiFormRow
                  label="Service"
                  isInvalid={!!errors['spec.service']}
                  error={errors['spec.service']}
                >
                  <EuiFieldText
                    value={state.service}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'service', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-service"
                  />
                </EuiFormRow>
                <EuiFormRow
                  label="Primary team"
                  isInvalid={!!errors['spec.owner.teams']}
                  error={errors['spec.owner.teams']}
                >
                  <EuiFieldText
                    value={state.ownerTeam}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'ownerTeam', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-ownerTeam"
                  />
                </EuiFormRow>
                <EuiFormRow label="Primary user (optional)">
                  <EuiFieldText
                    value={state.ownerPrimaryUser}
                    onChange={(e) =>
                      dispatch({
                        kind: 'setField',
                        field: 'ownerPrimaryUser',
                        value: e.target.value,
                      })
                    }
                    data-test-subj="slos-wizard-ownerPrimaryUser"
                  />
                </EuiFormRow>
                <EuiFormRow label="Tier (optional)">
                  <EuiFieldText
                    value={state.tier}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'tier', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-tier"
                  />
                </EuiFormRow>
              </EuiPanel>

              <EuiSpacer size="m" />

              <EuiPanel>
                <EuiText size="m">
                  <h4>SLI</h4>
                </EuiText>
                <EuiSpacer size="s" />
                {template.sli.type === 'availability' && (
                  <EuiFormRow
                    label="Good events filter"
                    helpText={`Default: ${template.sli.goodEventsFilter ?? ''}`}
                  >
                    <EuiFieldText
                      value={state.goodEventsFilter}
                      onChange={(e) =>
                        dispatch({
                          kind: 'setField',
                          field: 'goodEventsFilter',
                          value: e.target.value,
                        })
                      }
                      data-test-subj="slos-wizard-goodEventsFilter"
                    />
                  </EuiFormRow>
                )}
                <EuiFormRow label="Dimensions" fullWidth>
                  <div>
                    {state.dimensions.map((dim, i) => (
                      <EuiFlexGroup
                        key={i}
                        gutterSize="s"
                        alignItems="flexEnd"
                        style={{ marginBottom: 4 }}
                      >
                        <EuiFlexItem>
                          <EuiFieldText
                            placeholder="label name"
                            value={dim.name}
                            onChange={(e) =>
                              dispatch({
                                kind: 'setDimension',
                                index: i,
                                dim: { ...dim, name: e.target.value },
                              })
                            }
                            data-test-subj={`slos-wizard-dim-name-${i}`}
                            compressed
                          />
                        </EuiFlexItem>
                        <EuiFlexItem>
                          <EuiFieldText
                            placeholder="label value"
                            value={dim.value}
                            onChange={(e) =>
                              dispatch({
                                kind: 'setDimension',
                                index: i,
                                dim: { ...dim, value: e.target.value },
                              })
                            }
                            data-test-subj={`slos-wizard-dim-value-${i}`}
                            compressed
                          />
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiButtonEmpty
                            color="danger"
                            onClick={() => dispatch({ kind: 'removeDimension', index: i })}
                            disabled={state.dimensions.length <= 1}
                            iconType="trash"
                            aria-label="Remove dimension"
                            size="s"
                            data-test-subj={`slos-wizard-dim-remove-${i}`}
                          />
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    ))}
                    <EuiButtonEmpty
                      iconType="plusInCircle"
                      size="s"
                      onClick={() => dispatch({ kind: 'addDimension' })}
                      data-test-subj="slos-wizard-dim-add"
                    >
                      Add dimension
                    </EuiButtonEmpty>
                  </div>
                </EuiFormRow>
              </EuiPanel>

              <EuiSpacer size="m" />

              <EuiPanel>
                <EuiText size="m">
                  <h4>Objective</h4>
                </EuiText>
                <EuiSpacer size="s" />
                <EuiFormRow
                  label="Objective name"
                  isInvalid={!!errors['spec.objectives[0].name']}
                  error={errors['spec.objectives[0].name']}
                >
                  <EuiFieldText
                    value={state.objective.name}
                    onChange={(e) =>
                      dispatch({
                        kind: 'setObjectiveField',
                        field: 'name',
                        value: e.target.value,
                      })
                    }
                    data-test-subj="slos-wizard-objective-name"
                  />
                </EuiFormRow>
                <EuiFormRow
                  label="Target (%)"
                  isInvalid={!!errors['spec.objectives[0].target']}
                  error={errors['spec.objectives[0].target']}
                  helpText="Stored as decimal. 99.9% = 0.999."
                >
                  <EuiFieldNumber
                    value={state.objective.target}
                    min={50}
                    max={99.999}
                    step={0.001}
                    onChange={(e) =>
                      dispatch({
                        kind: 'setObjectiveField',
                        field: 'target',
                        value: e.target.value,
                      })
                    }
                    data-test-subj="slos-wizard-objective-target"
                  />
                </EuiFormRow>
                {template.sli.type === 'latency_threshold' && (
                  <EuiFormRow
                    label={`Latency threshold (${state.latencyThresholdUnit})`}
                    isInvalid={!!errors['spec.objectives[0].latencyThreshold']}
                    error={errors['spec.objectives[0].latencyThreshold']}
                  >
                    <EuiFieldNumber
                      value={state.objective.latencyThreshold}
                      min={0}
                      step={0.01}
                      onChange={(e) =>
                        dispatch({
                          kind: 'setObjectiveField',
                          field: 'latencyThreshold',
                          value: e.target.value,
                        })
                      }
                      data-test-subj="slos-wizard-objective-latency"
                    />
                  </EuiFormRow>
                )}
              </EuiPanel>

              <EuiSpacer size="m" />

              <EuiPanel>
                <EuiText size="m">
                  <h4>Window &amp; mode</h4>
                </EuiText>
                <EuiSpacer size="s" />
                <EuiFormRow label="Rolling window">
                  <EuiSelect
                    value={state.windowDuration}
                    onChange={(e) =>
                      dispatch({
                        kind: 'setField',
                        field: 'windowDuration',
                        value: e.target.value as FormState['windowDuration'],
                      })
                    }
                    options={[
                      { value: '7d', text: '7 days' },
                      { value: '14d', text: '14 days' },
                      { value: '28d', text: '28 days (recommended)' },
                      { value: '30d', text: '30 days' },
                    ]}
                    data-test-subj="slos-wizard-window"
                  />
                </EuiFormRow>
                <EuiCheckbox
                  id="slos-wizard-shadow"
                  label="Shadow mode (deploy recording rules only; suppress alerts)"
                  checked={state.shadow}
                  onChange={(e) =>
                    dispatch({ kind: 'setField', field: 'shadow', value: e.target.checked })
                  }
                  data-test-subj="slos-wizard-shadow"
                />
              </EuiPanel>

              <EuiSpacer size="m" />

              <EuiPanel>
                <EuiText size="m">
                  <h4>Labels &amp; annotations (optional)</h4>
                </EuiText>
                <EuiText size="xs" color="subdued">
                  One per line as <code>key=value</code>. Labels propagate to rules as{' '}
                  <code>slo_label_&lt;key&gt;</code>. Annotations stay on the document.
                </EuiText>
                <EuiSpacer size="s" />
                <EuiFormRow label="Labels">
                  <EuiTextArea
                    rows={3}
                    value={state.labelsRaw}
                    onChange={(e) =>
                      dispatch({ kind: 'setField', field: 'labelsRaw', value: e.target.value })
                    }
                    data-test-subj="slos-wizard-labels"
                    placeholder={'compliance=pci\nregion=us-west-2'}
                  />
                </EuiFormRow>
                <EuiFormRow label="Annotations">
                  <EuiTextArea
                    rows={2}
                    value={state.annotationsRaw}
                    onChange={(e) =>
                      dispatch({
                        kind: 'setField',
                        field: 'annotationsRaw',
                        value: e.target.value,
                      })
                    }
                    data-test-subj="slos-wizard-annotations"
                    placeholder="runbook=https://wiki/slo/..."
                  />
                </EuiFormRow>
              </EuiPanel>
            </EuiForm>
          </EuiPageContentBody>
        </EuiPageContent>
      </EuiPageBody>
    </EuiPage>
  );
};
