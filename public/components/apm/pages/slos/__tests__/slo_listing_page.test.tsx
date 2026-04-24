/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { SloListingPage } from '../slo_listing_page';
import type { SloApiClient } from '../slo_api_client';
import type { SloListFilters, SloSummary } from '../../../../../../common/slo/slo_types';

// Overview panel + header wrapper reach into chrome/portals that aren't
// wired in this jsdom setup. Inline them so the rest of the page mounts.
jest.mock('../../../../../plugin_helpers/plugin_headerControl', () => ({
  HeaderControlledComponentsWrapper: ({ components }: { components: React.ReactNode[] }) => (
    <div data-test-subj="header-wrapper">{components}</div>
  ),
}));
jest.mock('../slo_overview_panel', () => ({
  SloOverviewPanel: () => <div data-test-subj="slos-overview-stub" />,
}));

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

function renderPage(listImpl: SloApiClient['list'], initialSearch = '') {
  const apiClient = ({ list: listImpl } as unknown) as SloApiClient;
  const chrome = ({ setBreadcrumbs: jest.fn() } as unknown) as Parameters<
    typeof SloListingPage
  >[0]['chrome'];
  const notifications = ({
    toasts: { addDanger: jest.fn(), addWarning: jest.fn(), addSuccess: jest.fn() },
  } as unknown) as Parameters<typeof SloListingPage>[0]['notifications'];
  return render(
    <MemoryRouter initialEntries={[`/slos${initialSearch}`]}>
      <Route path="/slos">
        <SloListingPage
          apiClient={apiClient}
          chrome={chrome}
          notifications={notifications}
          parentBreadcrumb={{ text: 'APM', href: '#/' }}
        />
      </Route>
    </MemoryRouter>
  );
}

describe('SloListingPage — filter integration', () => {
  it('shows the "no SLOs yet" empty state when list returns zero unfiltered', async () => {
    const list = jest.fn().mockResolvedValue({
      results: [],
      total: 0,
      page: 1,
      pageSize: 100,
      hasMore: false,
    });
    await act(async () => {
      renderPage(list);
    });
    expect(await screen.findByTestId('slos-empty-no-slos')).toBeInTheDocument();
    expect(screen.queryByTestId('slos-empty-filtered-zero')).not.toBeInTheDocument();
  });

  it('shows the "no matches" empty state with Clear-filters CTA when filtered to zero', async () => {
    // First call: unfiltered (on mount, no URL params), returns 2 items.
    // Second call: after we apply a filter, returns 0.
    const list = jest
      .fn<ReturnType<SloApiClient['list']>, Parameters<SloApiClient['list']>>()
      .mockImplementation(async (filters?: SloListFilters) => {
        if (!filters || !filters.state) {
          return {
            results: [makeSummary({ id: 'a' }), makeSummary({ id: 'b', name: 'b' })],
            total: 2,
            page: 1,
            pageSize: 100,
            hasMore: false,
          };
        }
        return { results: [], total: 0, page: 1, pageSize: 100, hasMore: false };
      });

    await act(async () => {
      renderPage(list);
    });

    // Wait for the unfiltered fetch to complete and the table to mount.
    await screen.findByTestId('slos-table');

    // Apply an impossible filter via the URL-params round-trip: this exercises
    // the same code path as a facet click without depending on popover
    // rendering in jsdom.
    //
    // We re-render with an initialSearch; React Router MemoryRouter does not
    // re-parse on a remount here, so instead we trigger the filter via the
    // search input (a straightforward text input, no popover needed) and
    // confirm the listing re-calls `list` with the new search arg.
    list.mockImplementation(async (filters?: SloListFilters) => {
      // Any non-empty filter → empty result
      if (filters && (filters.search || filters.state)) {
        return { results: [], total: 0, page: 1, pageSize: 100, hasMore: false };
      }
      return {
        results: [makeSummary({ id: 'a' })],
        total: 1,
        page: 1,
        pageSize: 100,
        hasMore: false,
      };
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId('slos-listing-filter-search'), {
        target: { value: 'no-such-thing' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('slos-empty-filtered-zero')).toBeInTheDocument();
    });
    expect(screen.getByTestId('slos-empty-filtered-clear')).toBeInTheDocument();

    // Clicking the clear CTA should re-fetch without filters.
    await act(async () => {
      fireEvent.click(screen.getByTestId('slos-empty-filtered-clear'));
    });
    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(expect.not.objectContaining({ search: 'no-such-thing' }));
    });
  });

  it('passes server-side filter args — not client-side filtering — to apiClient.list', async () => {
    const list = jest
      .fn<ReturnType<SloApiClient['list']>, Parameters<SloApiClient['list']>>()
      .mockResolvedValue({
        results: [makeSummary({ id: 'a', status: { ...makeSummary().status, state: 'breached' } })],
        total: 1,
        page: 1,
        pageSize: 100,
        hasMore: false,
      });

    // Initial URL carries a state filter — the listing must forward it.
    await act(async () => {
      renderPage(list, '?state=breached');
    });

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ state: ['breached'], pageSize: 100 })
      );
    });
  });

  it('hydrates filter state from the URL so a pasted link renders chips', async () => {
    const list = jest
      .fn<ReturnType<SloApiClient['list']>, Parameters<SloApiClient['list']>>()
      .mockResolvedValue({
        results: [makeSummary()],
        total: 1,
        page: 1,
        pageSize: 100,
        hasMore: false,
      });

    await act(async () => {
      renderPage(list, '?state=breached,warning&tier=tier-1');
    });

    await screen.findByTestId('slos-table');
    expect(screen.getByTestId('slos-listing-filter-chip-state-breached')).toBeInTheDocument();
    expect(screen.getByTestId('slos-listing-filter-chip-state-warning')).toBeInTheDocument();
    expect(screen.getByTestId('slos-listing-filter-chip-tier-tier-1')).toBeInTheDocument();
  });
});
