/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Selected-filter chips row + "Clear all" CTA — Maya's principle #4
 * ("visible state over hidden state"). Each chip removes a single facet
 * value when clicked; Clear all blows the whole filter object away.
 */

import React from 'react';
import { EuiBadge, EuiButtonEmpty, EuiFlexGroup, EuiFlexItem } from '@elastic/eui';
import type { SloListFilters } from '../../../../../common/slo/slo_types';

const STATE_DISPLAY: Record<string, string> = {
  breached: 'Breached',
  warning: 'Warning',
  ok: 'Healthy',
  no_data: 'No data',
  stale: 'Stale',
  disabled: 'Disabled',
};

const BACKEND_DISPLAY: Record<string, string> = {
  prometheus: 'Prometheus',
  opensearch: 'OpenSearch',
};

const MODE_DISPLAY: Record<string, string> = {
  active: 'Active',
  shadow: 'Shadow',
};

export interface SloListFilterChipsProps {
  filters: SloListFilters;
  onChange: (next: SloListFilters) => void;
  onClearAll: () => void;
}

function removeFromArray<T>(arr: T[] | undefined, value: T): T[] | undefined {
  if (!arr) return undefined;
  const next = arr.filter((v) => v !== value);
  return next.length === 0 ? undefined : next;
}

interface Chip {
  key: string;
  facet: keyof SloListFilters;
  label: string;
  testSubj: string;
  onRemove: () => void;
}

export const SloListFilterChips: React.FC<SloListFilterChipsProps> = ({
  filters,
  onChange,
  onClearAll,
}) => {
  const chips: Chip[] = [];

  const push = (
    facet: keyof SloListFilters,
    value: string,
    display: string,
    onRemove: () => void
  ) => {
    chips.push({
      key: `${facet}:${value}`,
      facet,
      label: display,
      testSubj: `slosListingFilterChip-${facet}-${value}`,
      onRemove,
    });
  };

  filters.state?.forEach((v) =>
    push('state', v, `State: ${STATE_DISPLAY[v] ?? v}`, () =>
      onChange({ ...filters, state: removeFromArray(filters.state, v) })
    )
  );
  filters.sliBackend?.forEach((v) =>
    push('sliBackend', v, `Backend: ${BACKEND_DISPLAY[v] ?? v}`, () =>
      onChange({ ...filters, sliBackend: removeFromArray(filters.sliBackend, v) })
    )
  );
  filters.sliLeafType?.forEach((v) =>
    push('sliLeafType', v, `SLI type: ${v}`, () =>
      onChange({ ...filters, sliLeafType: removeFromArray(filters.sliLeafType, v) })
    )
  );
  filters.service?.forEach((v) =>
    push('service', v, `Service: ${v}`, () =>
      onChange({ ...filters, service: removeFromArray(filters.service, v) })
    )
  );
  filters.team?.forEach((v) =>
    push('team', v, `Team: ${v}`, () =>
      onChange({ ...filters, team: removeFromArray(filters.team, v) })
    )
  );
  filters.tier?.forEach((v) =>
    push('tier', v, `Tier: ${v}`, () =>
      onChange({ ...filters, tier: removeFromArray(filters.tier, v) })
    )
  );
  filters.mode?.forEach((v) =>
    push('mode', v, `Mode: ${MODE_DISPLAY[v] ?? v}`, () =>
      onChange({ ...filters, mode: removeFromArray(filters.mode, v) })
    )
  );
  if (filters.enabled !== undefined) {
    push('enabled', String(filters.enabled), `Enabled: ${filters.enabled ? 'Yes' : 'No'}`, () =>
      onChange({ ...filters, enabled: undefined })
    );
  }
  if (filters.search && filters.search.trim().length > 0) {
    push('search', filters.search, `Search: "${filters.search}"`, () =>
      onChange({ ...filters, search: undefined })
    );
  }

  if (chips.length === 0) return null;

  return (
    <EuiFlexGroup
      gutterSize="xs"
      alignItems="center"
      responsive={false}
      wrap
      data-test-subj="slosListingFilterChips"
    >
      {chips.map((chip) => (
        <EuiFlexItem key={chip.key} grow={false}>
          <EuiBadge
            color="hollow"
            iconType="cross"
            iconSide="right"
            iconOnClick={chip.onRemove}
            iconOnClickAriaLabel={`Remove filter ${chip.label}`}
            onClick={chip.onRemove}
            onClickAriaLabel={`Remove filter ${chip.label}`}
            data-test-subj={chip.testSubj}
          >
            {chip.label}
          </EuiBadge>
        </EuiFlexItem>
      ))}
      <EuiFlexItem grow={false}>
        <EuiButtonEmpty
          size="xs"
          iconType="cross"
          onClick={onClearAll}
          data-test-subj="slosListingFilterClearAll"
        >
          Clear all
        </EuiButtonEmpty>
      </EuiFlexItem>
    </EuiFlexGroup>
  );
};
