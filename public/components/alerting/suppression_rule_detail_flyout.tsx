/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suppression Rule Detail Flyout — read-only view of a single silence-backed
 * suppression rule's configuration (matchers, schedule, source).
 */
import React, { useMemo } from 'react';
import moment from 'moment';
import {
  EuiBadge,
  EuiButton,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { SuppressionRuleConfig } from '../../../common/services/alerting/suppression';
import { SILENCE_STATE_COLORS } from './shared_constants';

function formatTimestamp(iso: string): string {
  if (!iso) return '—';
  const m = moment(iso);
  if (!m.isValid()) return iso;
  return m.format('YYYY-MM-DD HH:mm z');
}

function durationString(startIso: string, endIso: string): string {
  if (!startIso || !endIso) return '—';
  const start = moment(startIso);
  const end = moment(endIso);
  if (!start.isValid() || !end.isValid()) return '—';
  const diffMs = end.diff(start);
  if (diffMs <= 0) return '—';
  const dur = moment.duration(diffMs);
  const parts: string[] = [];
  if (dur.days() > 0) parts.push(`${dur.days()}d`);
  if (dur.hours() > 0) parts.push(`${dur.hours()}h`);
  if (dur.minutes() > 0) parts.push(`${dur.minutes()}m`);
  return parts.join(' ') || '< 1m';
}

export interface SuppressionRuleDetailFlyoutProps {
  rule: SuppressionRuleConfig;
  onClose: () => void;
}

export const SuppressionRuleDetailFlyout: React.FC<SuppressionRuleDetailFlyoutProps> = ({
  rule,
  onClose,
}) => {
  const matcherEntries = useMemo(() => Object.entries(rule.matchers || {}), [rule.matchers]);

  const scheduleItems = useMemo(
    () => [
      { title: 'Start', description: formatTimestamp(rule.startTime) },
      { title: 'End', description: formatTimestamp(rule.endTime) },
      { title: 'Duration', description: durationString(rule.startTime, rule.endTime) },
    ],
    [rule.startTime, rule.endTime]
  );

  return (
    <EuiFlyout
      onClose={onClose}
      size="m"
      ownFocus
      aria-labelledby="suppressionRuleDetailTitle"
      data-test-subj="alertManager-suppression-detailFlyout"
    >
      <EuiFlyoutHeader hasBorder>
        <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" responsive={false}>
          <EuiFlexItem>
            <EuiTitle size="m">
              <h2 id="suppressionRuleDetailTitle">{rule.name}</h2>
            </EuiTitle>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiFlexGroup gutterSize="xs" responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiBadge color={SILENCE_STATE_COLORS[rule.silenceState] || 'default'}>
                  {rule.silenceState}
                </EuiBadge>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiBadge color="hollow">Silence</EuiBadge>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutHeader>

      <EuiFlyoutBody>
        {rule.description && (
          <>
            <EuiText size="s">
              <p>{rule.description}</p>
            </EuiText>
            <EuiSpacer size="m" />
          </>
        )}

        <EuiTitle size="xs">
          <h3>Matchers</h3>
        </EuiTitle>
        <EuiSpacer size="xs" />
        {matcherEntries.length > 0 ? (
          <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
            {matcherEntries.map(([k, v]) => (
              <EuiFlexItem key={k} grow={false}>
                <EuiBadge color="hollow">
                  {k}={v}
                </EuiBadge>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        ) : (
          <EuiText size="s" color="subdued">
            <em>No matchers — rule would apply to all alerts.</em>
          </EuiText>
        )}
        <EuiSpacer size="m" />

        <EuiTitle size="xs">
          <h3>Schedule</h3>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiDescriptionList
          type="column"
          compressed
          listItems={scheduleItems}
          data-test-subj="alertManager-suppression-detailSchedule"
        />
        <EuiSpacer size="m" />

        <EuiTitle size="xs">
          <h3>Source</h3>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiDescriptionList
          type="column"
          compressed
          listItems={[
            { title: 'Type', description: 'Silence' },
            { title: 'Datasource', description: rule.datasourceName || rule.datasourceId || '—' },
            { title: 'Rule ID', description: rule.id },
            ...(rule.createdBy ? [{ title: 'Created by', description: rule.createdBy }] : []),
            ...(rule.createdAt
              ? [{ title: 'Created at', description: formatTimestamp(rule.createdAt) }]
              : []),
          ]}
        />
      </EuiFlyoutBody>

      <EuiFlyoutFooter>
        <EuiFlexGroup justifyContent="flexEnd">
          <EuiFlexItem grow={false}>
            <EuiButton onClick={onClose} data-test-subj="alertManager-suppression-detailClose">
              Close
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutFooter>
    </EuiFlyout>
  );
};
