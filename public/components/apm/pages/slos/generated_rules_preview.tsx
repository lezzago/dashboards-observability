/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wizard-side preview of the Prometheus rule group that will be deployed.
 *
 * Calls the server `/preview` endpoint with a debounced input so typing in the
 * wizard doesn't generate a request per keystroke. The server runs the same
 * `generateSloRuleGroup` as the deploy path (memo §9 decision 5) — what the
 * preview shows is what will land in the ruler.
 *
 * The server response carries the rendered YAML on `yaml`; this component
 * renders it verbatim rather than recomputing client-side.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiAccordion,
  EuiBadge,
  EuiCallOut,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { GeneratedRuleGroup, SloCreateInput } from '../../../../../common/slo/slo_types';
import type { SloApiClient } from './slo_api_client';

export const PREVIEW_DEBOUNCE_MS = 500;

export interface GeneratedRulesPreviewProps {
  apiClient: Pick<SloApiClient, 'preview'>;
  /**
   * Current wizard input. Pass `null` when the form isn't yet ready for
   * preview (e.g. no template selected); the component will render a hint.
   */
  input: SloCreateInput | null;
}

interface PreviewState {
  status: 'idle' | 'loading' | 'success' | 'error';
  group?: GeneratedRuleGroup;
  error?: string;
}

const INITIAL: PreviewState = { status: 'idle' };

export const GeneratedRulesPreview: React.FC<GeneratedRulesPreviewProps> = ({
  apiClient,
  input,
}) => {
  // Debounce on the serialized input so equivalent objects don't retrigger
  // fetches (stable JSON → stable effect dep). Unlike useDebouncedValue, we
  // never seed the debounced value from the initial prop — the first preview
  // request should wait out the debounce window just like subsequent ones.
  const serialized = useMemo(() => (input ? JSON.stringify(input) : null), [input]);
  const [debouncedSerialized, setDebouncedSerialized] = useState<string | null>(null);
  const [state, setState] = useState<PreviewState>(INITIAL);

  useEffect(() => {
    if (serialized === null) {
      setDebouncedSerialized(null);
      return;
    }
    const t = setTimeout(() => setDebouncedSerialized(serialized), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [serialized]);

  useEffect(() => {
    if (!debouncedSerialized) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    apiClient
      .preview(JSON.parse(debouncedSerialized) as SloCreateInput)
      .then((group) => {
        if (cancelled) return;
        setState({ status: 'success', group });
      })
      .catch((e) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ status: 'error', error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, debouncedSerialized]);

  return (
    <EuiPanel data-test-subj="slos-wizard-preview">
      <EuiText size="m">
        <h4>Rule preview</h4>
      </EuiText>
      <EuiText size="s" color="subdued">
        The Prometheus rule group that will be deployed when you click Create.
      </EuiText>
      <EuiSpacer size="s" />
      {renderBody(state)}
    </EuiPanel>
  );
};

function renderBody(state: PreviewState): JSX.Element {
  if (state.status === 'idle') {
    return (
      <EuiText size="s" color="subdued" data-test-subj="slos-wizard-preview-idle">
        Fill in the required fields to see the generated rules.
      </EuiText>
    );
  }
  if (state.status === 'loading') {
    return (
      <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiLoadingSpinner size="m" data-test-subj="slos-wizard-preview-loading" />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="s" color="subdued">
            Generating preview…
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  }
  if (state.status === 'error') {
    return (
      <EuiCallOut
        title="Preview unavailable"
        color="warning"
        iconType="alert"
        size="s"
        data-test-subj="slos-wizard-preview-error"
      >
        <EuiText size="s">{state.error ?? 'Unable to generate preview.'}</EuiText>
      </EuiCallOut>
    );
  }
  const group = state.group!;
  return (
    <div data-test-subj="slos-wizard-preview-success">
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiBadge color="primary" data-test-subj="slos-wizard-preview-rule-count">
            {group.rules.length} {group.rules.length === 1 ? 'rule' : 'rules'}
          </EuiBadge>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="s" data-test-subj="slos-wizard-preview-group-name">
            <code>{group.groupName}</code>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            eval interval {group.interval}s
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />
      <EuiAccordion
        id="slos-wizard-preview-yaml"
        buttonContent="Show rule-group YAML"
        paddingSize="s"
        data-test-subj="slos-wizard-preview-yaml-toggle"
      >
        <EuiCodeBlock
          language="yaml"
          paddingSize="s"
          isCopyable
          overflowHeight={320}
          data-test-subj="slos-wizard-preview-yaml"
        >
          {group.yaml}
        </EuiCodeBlock>
      </EuiAccordion>
    </div>
  );
}
