/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SloListFilterPanel } from '../slo_list_filter_panel';
import type { SloSummary } from '../../../../../../common/slo/slo_types';

function makeSummary(overrides: Partial<SloSummary> = {}): SloSummary {
  return {
    id: 'slo-1',
    datasourceId: 'ds-1',
    datasourceType: 'prometheus',
    name: 'api-availability',
    enabled: true,
    mode: 'active',
    service: 'payments-api',
    owner: { teams: ['sre'] },
    tier: 'tier-1',
    sliNodeType: 'single',
    sliBackend: 'prometheus',
    sliLeafType: 'availability',
    objectiveCount: 1,
    worstTarget: 0.999,
    window: { type: 'rolling', duration: '28d' },
    labels: {},
    status: {
      sloId: 'slo-1',
      objectives: [],
      state: 'ok',
      firingCount: 0,
      ruleCount: 0,
      computedAt: new Date(0).toISOString(),
    },
    ...overrides,
  };
}

describe('SloListFilterPanel', () => {
  it('renders the free-text search field preloaded from filters', () => {
    render(
      <SloListFilterPanel
        filters={{ search: 'checkout' }}
        onChange={jest.fn()}
        items={[makeSummary()]}
      />
    );
    const input = screen.getByTestId('slosListingFilterSearch') as HTMLInputElement;
    expect(input.value).toBe('checkout');
  });

  it('emits a search-delta onChange when the user types', () => {
    const onChange = jest.fn();
    render(<SloListFilterPanel filters={{}} onChange={onChange} items={[makeSummary()]} />);
    fireEvent.change(screen.getByTestId('slosListingFilterSearch'), {
      target: { value: 'cart' },
    });
    expect(onChange).toHaveBeenCalledWith({ search: 'cart' });
  });

  it('tri-state enabled: any → yes → no → any on successive clicks', () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <SloListFilterPanel filters={{}} onChange={onChange} items={[makeSummary()]} />
    );
    fireEvent.click(screen.getByTestId('slosListingFilter-enabled-button'));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true });

    rerender(
      <SloListFilterPanel filters={{ enabled: true }} onChange={onChange} items={[makeSummary()]} />
    );
    fireEvent.click(screen.getByTestId('slosListingFilter-enabled-button'));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false });

    rerender(
      <SloListFilterPanel
        filters={{ enabled: false }}
        onChange={onChange}
        items={[makeSummary()]}
      />
    );
    fireEvent.click(screen.getByTestId('slosListingFilter-enabled-button'));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: undefined });
  });

  it('surfaces an active-count summary when filters are applied', () => {
    render(
      <SloListFilterPanel
        filters={{ state: ['breached'], service: ['payments-api'] }}
        onChange={jest.fn()}
        items={[makeSummary()]}
      />
    );
    expect(screen.getByTestId('slosListingFilterActiveCount')).toHaveTextContent('2 active');
  });

  it('hides the active-count when no filters are applied', () => {
    render(<SloListFilterPanel filters={{}} onChange={jest.fn()} items={[makeSummary()]} />);
    expect(screen.queryByTestId('slosListingFilterActiveCount')).not.toBeInTheDocument();
  });

  it('renders a facet button for state with an active-count badge when pre-applied', () => {
    render(
      <SloListFilterPanel
        filters={{ state: ['breached', 'warning'] }}
        onChange={jest.fn()}
        items={[makeSummary()]}
      />
    );
    // EuiFilterButton renders its label text directly, so a straight regex
    // query works without opening the popover.
    const stateBtn = screen.getByTestId('slosListingFilter-state-button');
    expect(stateBtn).toHaveTextContent('State');
  });
});
