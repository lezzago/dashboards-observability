/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PaginatedResponse } from '../../../../../../common/types/alerting/types';
import type { SloHealthState, SloSummary } from '../../../../../../common/slo/slo_types';
import type { SloApiClient } from '../../slos/slo_api_client';

// Stub coreRefs before importing the tab so the navigate helpers resolve.
const mockNavigateToApp = jest.fn();
jest.mock('../../../../../framework/core_refs', () => ({
  coreRefs: {
    application: { navigateToApp: (...args: unknown[]) => mockNavigateToApp(...args) },
    http: { basePath: { prepend: (p: string) => p } },
  },
}));

import { ServiceSloTab, SloTabLabel } from '../service_slo_tab';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(
  overrides: Partial<SloSummary> & Pick<SloSummary, 'id' | 'service'>
): SloSummary {
  const { id, service, status, name, ...rest } = overrides;
  const state: SloHealthState = status?.state ?? 'ok';
  return {
    id,
    datasourceId: 'ds-1',
    datasourceType: 'prometheus',
    name: name ?? id,
    enabled: true,
    mode: 'active',
    service,
    owner: { teams: [] },
    sliNodeType: 'single',
    sliBackend: 'prometheus',
    sliLeafType: 'availability',
    objectiveCount: 1,
    worstTarget: 0.99,
    window: { type: 'rolling', duration: '28d' },
    labels: {},
    status: {
      sloId: id,
      objectives: [
        {
          objectiveName: 'obj1',
          currentValue: 0.995,
          currentValueUnit: 'ratio',
          attainment: 0.995,
          errorBudgetRemaining: 0.5,
          state,
        },
      ],
      state,
      firingCount: 0,
      ruleCount: 1,
      computedAt: '2026-05-01T00:00:00Z',
      ...(status ?? {}),
    },
    ...rest,
  } as SloSummary;
}

function makeApiClient(
  results: SloSummary[] = [],
  opts: Partial<Omit<PaginatedResponse<SloSummary>, 'results'>> = {}
): SloApiClient {
  const response: PaginatedResponse<SloSummary> = {
    results,
    total: opts.total ?? results.length,
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? Math.max(50, results.length),
    hasMore: opts.hasMore ?? false,
  };
  return ({
    list: jest.fn().mockResolvedValue(response),
  } as unknown) as SloApiClient;
}

function makeFailingApiClient(error: unknown): SloApiClient {
  return ({
    list: jest.fn().mockRejectedValue(error),
  } as unknown) as SloApiClient;
}

const SERVICE = 'payments-api';
const DATASOURCE = 'ds-1';

// ---------------------------------------------------------------------------
// Tab-label badge
// ---------------------------------------------------------------------------

describe('SloTabLabel', () => {
  it('renders plain label when breached=0', () => {
    render(<SloTabLabel breached={0} />);
    expect(screen.getByText('SLOs')).toBeInTheDocument();
    expect(screen.queryByTestId('serviceDetailsTab-slos-badge')).toBeNull();
  });

  it('renders a notification badge with the breached count when breached>0', () => {
    render(<SloTabLabel breached={3} />);
    const badge = screen.getByTestId('serviceDetailsTab-slos-badge');
    expect(badge).toHaveTextContent('3');
  });

  it('wraps the label in an aria-label span when badge is present', () => {
    render(<SloTabLabel breached={1} />);
    expect(screen.getByLabelText('SLOs, 1 breached')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ServiceSloTab — state-by-state rendering
// ---------------------------------------------------------------------------

describe('ServiceSloTab — empty state', () => {
  beforeEach(() => {
    mockNavigateToApp.mockClear();
  });

  it('renders the EuiEmptyPrompt when no SLOs are tracked for this service', async () => {
    const apiClient = makeApiClient([]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    await waitFor(() => {
      expect(screen.getByTestId('serviceSloTabEmptyPrompt')).toBeInTheDocument();
    });
    expect(screen.getByText('No SLOs tracked for this service')).toBeInTheDocument();
    // Missing-pair callout must not render alongside empty prompt.
    expect(screen.queryByTestId('serviceSloTabMissingPairCallout')).toBeNull();
  });

  it('primary empty-state action navigates to scoped suggest page', async () => {
    const apiClient = makeApiClient([]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    const primary = await screen.findByTestId('serviceSloTabEmptyPromptPrimary');
    fireEvent.click(primary);
    expect(mockNavigateToApp).toHaveBeenLastCalledWith('observability-apm-slo', {
      path: `#/slos/suggest?source=apm&services=${encodeURIComponent(SERVICE)}`,
    });
  });

  it('secondary empty-state action navigates to create wizard', async () => {
    const apiClient = makeApiClient([]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    const secondary = await screen.findByTestId('serviceSloTabEmptyPromptSecondary');
    fireEvent.click(secondary);
    expect(mockNavigateToApp).toHaveBeenLastCalledWith('observability-apm-slo', {
      path: '#/slos/create',
    });
  });
});

describe('ServiceSloTab — complete canonical pair', () => {
  it('renders chips and table, no missing-pair callout', async () => {
    const apiClient = makeApiClient([
      makeSummary({
        id: 'a',
        service: SERVICE,
        name: 'availability SLO',
        sliLeafType: 'availability',
        status: {
          sloId: 'a',
          objectives: [],
          state: 'ok',
          firingCount: 0,
          ruleCount: 1,
          computedAt: '',
        },
      }),
      makeSummary({
        id: 'b',
        service: SERVICE,
        name: 'latency SLO',
        sliLeafType: 'latency_threshold',
        status: {
          sloId: 'b',
          objectives: [],
          state: 'ok',
          firingCount: 0,
          ruleCount: 1,
          computedAt: '',
        },
      }),
    ]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    await waitFor(() => {
      expect(screen.getByTestId('serviceSloTabTable')).toBeInTheDocument();
    });
    expect(screen.getByTestId('serviceSloTabChipRow')).toBeInTheDocument();
    expect(screen.getByTestId('serviceSloTabFootnote')).toBeInTheDocument();
    expect(screen.queryByTestId('serviceSloTabMissingPairCallout')).toBeNull();
  });
});

describe('ServiceSloTab — missing-pair variants', () => {
  beforeEach(() => {
    mockNavigateToApp.mockClear();
  });

  it('shows "Latency SLO missing" when only availability is present', async () => {
    const apiClient = makeApiClient([
      makeSummary({
        id: 'a',
        service: SERVICE,
        sliLeafType: 'availability',
      }),
    ]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    const callout = await screen.findByTestId('serviceSloTabMissingPairCallout');
    expect(callout).toHaveTextContent('Latency SLO missing');
  });

  it('shows "Availability SLO missing" when only latency is present', async () => {
    const apiClient = makeApiClient([
      makeSummary({
        id: 'b',
        service: SERVICE,
        sliLeafType: 'latency_threshold',
      }),
    ]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    const callout = await screen.findByTestId('serviceSloTabMissingPairCallout');
    expect(callout).toHaveTextContent('Availability SLO missing');
  });

  it('shows "Canonical pair incomplete" when neither canonical kind is present but other SLOs exist', async () => {
    // A custom SLI that doesn't classify as availability or latency.
    const apiClient = makeApiClient([
      makeSummary({
        id: 'c',
        service: SERVICE,
        sliLeafType: 'custom',
      }),
    ]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    const callout = await screen.findByTestId('serviceSloTabMissingPairCallout');
    expect(callout).toHaveTextContent('Canonical pair incomplete');
  });

  it('missing-pair CTA scopes to this one service', async () => {
    const apiClient = makeApiClient([
      makeSummary({
        id: 'a',
        service: SERVICE,
        sliLeafType: 'availability',
      }),
    ]);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    const cta = await screen.findByTestId('serviceSloTabMissingPairCta');
    fireEvent.click(cta);
    expect(mockNavigateToApp).toHaveBeenLastCalledWith('observability-apm-slo', {
      path: `#/slos/suggest?source=apm&services=${encodeURIComponent(SERVICE)}`,
    });
  });
});

describe('ServiceSloTab — error + 403', () => {
  it('renders the forbidden callout and hides retry when the hook reports 403', async () => {
    const err = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    const apiClient = makeFailingApiClient(err);
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    await waitFor(() => {
      expect(screen.getByTestId('serviceSloTabForbiddenCallout')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('serviceSloTabErrorRetry')).toBeNull();
  });

  it('renders the generic error callout with retry on non-403 errors', async () => {
    const apiClient = makeFailingApiClient(new Error('boom'));
    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);
    await waitFor(() => {
      expect(screen.getByTestId('serviceSloTabErrorCallout')).toBeInTheDocument();
    });
    expect(screen.getByTestId('serviceSloTabErrorRetry')).toBeInTheDocument();
  });
});

describe('ServiceSloTab — loading grace timer', () => {
  it('waits ~150ms before showing the skeleton', async () => {
    jest.useFakeTimers();
    let resolveList: (value: PaginatedResponse<SloSummary>) => void = () => {};
    const listPromise = new Promise<PaginatedResponse<SloSummary>>((resolve) => {
      resolveList = resolve;
    });
    const apiClient = ({ list: jest.fn().mockReturnValue(listPromise) } as unknown) as SloApiClient;

    render(<ServiceSloTab serviceName={SERVICE} datasourceId={DATASOURCE} apiClient={apiClient} />);

    expect(screen.queryByTestId('serviceSloTabLoading')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(160);
    });
    expect(screen.getByTestId('serviceSloTabLoading')).toBeInTheDocument();

    // Resolve so the pending promise doesn't leak.
    await act(async () => {
      resolveList({
        results: [],
        total: 0,
        page: 1,
        pageSize: 50,
        hasMore: false,
      });
      jest.useRealTimers();
    });
  });
});
