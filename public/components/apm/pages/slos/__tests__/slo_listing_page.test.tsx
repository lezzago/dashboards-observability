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
  SloOverviewPanel: () => <div data-test-subj="slosOverviewStub" />,
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
    expect(await screen.findByTestId('slosEmptyNoSlos')).toBeInTheDocument();
    expect(screen.queryByTestId('slosEmptyFilteredZero')).not.toBeInTheDocument();
  });

  it('shows the "no matches" empty state with Clear-filters CTA when filtered to zero', async () => {
    const list = jest
      .fn<ReturnType<SloApiClient['list']>, Parameters<SloApiClient['list']>>()
      .mockImplementation(async (filters?: SloListFilters) => {
        if (!filters || !filters.search) {
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

    await screen.findByTestId('slosTable');

    await act(async () => {
      fireEvent.change(screen.getByTestId('slosListingFilterSearch'), {
        target: { value: 'no-such-thing' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('slosEmptyFilteredZero')).toBeInTheDocument();
    });
    expect(screen.getByTestId('slosEmptyFilteredClear')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('slosEmptyFilteredClear'));
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

    await act(async () => {
      renderPage(list, '?state=breached');
    });

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ state: ['breached'], pageSize: 100 })
      );
    });
  });

  it('hydrates filter state from the URL so a pasted link renders active badges', async () => {
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

    await screen.findByTestId('slosTable');
    expect(screen.getByTestId('activeFilterBadges')).toBeInTheDocument();
    expect(screen.getByTestId('filterBadge-state')).toHaveTextContent('State: Breached, Warning');
    expect(screen.getByTestId('filterBadge-tier')).toHaveTextContent('Tier: tier-1');
  });
});
