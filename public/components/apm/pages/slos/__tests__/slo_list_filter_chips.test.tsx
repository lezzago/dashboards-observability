/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SloListFilterChips } from '../slo_list_filter_chips';
import type { SloListFilters } from '../../../../../../common/slo/slo_types';

describe('SloListFilterChips', () => {
  it('renders nothing when no filters are applied', () => {
    const { container } = render(
      <SloListFilterChips filters={{}} onChange={jest.fn()} onClearAll={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one chip per applied facet value', () => {
    const filters: SloListFilters = {
      state: ['breached', 'warning'],
      tier: ['tier-1'],
      enabled: false,
      search: 'api',
    };
    render(<SloListFilterChips filters={filters} onChange={jest.fn()} onClearAll={jest.fn()} />);
    expect(screen.getByTestId('slos-listing-filter-chip-state-breached')).toBeInTheDocument();
    expect(screen.getByTestId('slos-listing-filter-chip-state-warning')).toBeInTheDocument();
    expect(screen.getByTestId('slos-listing-filter-chip-tier-tier-1')).toBeInTheDocument();
    expect(screen.getByTestId('slos-listing-filter-chip-enabled-false')).toBeInTheDocument();
    expect(screen.getByTestId('slos-listing-filter-chip-search-api')).toBeInTheDocument();
  });

  it('emits filter patch with the value removed when a chip is clicked', () => {
    const onChange = jest.fn();
    const filters: SloListFilters = { state: ['breached', 'warning'] };
    render(<SloListFilterChips filters={filters} onChange={onChange} onClearAll={jest.fn()} />);
    fireEvent.click(screen.getByTestId('slos-listing-filter-chip-state-breached'));
    expect(onChange).toHaveBeenCalledWith({ state: ['warning'] });
  });

  it('collapses the array to undefined when the last value is removed', () => {
    const onChange = jest.fn();
    render(
      <SloListFilterChips
        filters={{ state: ['breached'] }}
        onChange={onChange}
        onClearAll={jest.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('slos-listing-filter-chip-state-breached'));
    expect(onChange).toHaveBeenCalledWith({ state: undefined });
  });

  it('clears enabled tri-state when chip removed', () => {
    const onChange = jest.fn();
    render(
      <SloListFilterChips filters={{ enabled: true }} onChange={onChange} onClearAll={jest.fn()} />
    );
    fireEvent.click(screen.getByTestId('slos-listing-filter-chip-enabled-true'));
    expect(onChange).toHaveBeenCalledWith({ enabled: undefined });
  });

  it('fires onClearAll when "Clear all" is clicked', () => {
    const onClearAll = jest.fn();
    render(
      <SloListFilterChips
        filters={{ state: ['ok'] }}
        onChange={jest.fn()}
        onClearAll={onClearAll}
      />
    );
    fireEvent.click(screen.getByTestId('slos-listing-filter-clear-all'));
    expect(onClearAll).toHaveBeenCalled();
  });
});
