/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SloAdoptionPage } from '../slo_adoption_page';
import type { SloApiClient } from '../../slo_api_client';

function makeApiClient(
  overrides: Partial<jest.Mocked<SloApiClient>> = {}
): jest.Mocked<SloApiClient> {
  return ({
    listOrphans: jest.fn().mockResolvedValue({ candidates: [], unknowns: [] }),
    recoverSlo: jest.fn(),
    // Session C — default the probe to "flag off" (404) so existing tests
    // see the plain Recover tab without the new tab chrome.
    purgeLegacyOrphans: jest.fn().mockRejectedValue({ response: { status: 404 } }),
    ...overrides,
  } as unknown) as jest.Mocked<SloApiClient>;
}

function renderPage(
  apiClient: jest.Mocked<SloApiClient>,
  initialSearch = ''
): { chrome: { setBreadcrumbs: jest.Mock } } {
  const chrome = { setBreadcrumbs: jest.fn() };
  const notifications = {
    toasts: {
      addSuccess: jest.fn(),
      addDanger: jest.fn(),
      addWarning: jest.fn(),
    },
  };
  const http = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  render(
    <MemoryRouter initialEntries={[`/slos/adoption${initialSearch}`]}>
      <SloAdoptionPage
        apiClient={apiClient}
        http={(http as unknown) as Parameters<typeof SloAdoptionPage>[0]['http']}
        chrome={(chrome as unknown) as Parameters<typeof SloAdoptionPage>[0]['chrome']}
        notifications={
          (notifications as unknown) as Parameters<typeof SloAdoptionPage>[0]['notifications']
        }
        parentBreadcrumb={{ text: 'APM', href: '#/' }}
      />
    </MemoryRouter>
  );
  return { chrome };
}

describe('SloAdoptionPage — feature-flag gate', () => {
  it('renders the disabled prompt when listOrphans returns a 412-shaped error', async () => {
    const listOrphans = jest.fn().mockRejectedValue({
      response: { status: 412 },
      body: {
        message: 'Feature disabled',
        attributes: {
          error: 'PRECONDITION_FAILED',
          message: 'Feature disabled',
          missingFlags: ['ruleDedup', 'ruleAdoption'],
        },
      },
    });
    await act(async () => {
      renderPage(makeApiClient({ listOrphans }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('sloAdoption-page-disabledPrompt')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sloAdoption-recoverTab')).not.toBeInTheDocument();
  });

  it('renders an error callout for non-412 errors', async () => {
    const listOrphans = jest.fn().mockRejectedValue({ body: { message: 'kaboom' } });
    await act(async () => {
      renderPage(makeApiClient({ listOrphans }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('sloAdoption-page-error')).toBeInTheDocument();
    });
    expect(screen.getByText('kaboom')).toBeInTheDocument();
  });

  it('renders the Recover tab on 200', async () => {
    const listOrphans = jest.fn().mockResolvedValue({ candidates: [], unknowns: [] });
    await act(async () => {
      renderPage(makeApiClient({ listOrphans }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('sloAdoption-recoverTab')).toBeInTheDocument();
    });
  });

  it('shows the loading state before the gate resolves', async () => {
    let resolver: ((val: { candidates: []; unknowns: [] }) => void) | undefined;
    const listOrphans = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolver = resolve;
        })
    );
    renderPage(makeApiClient({ listOrphans }));
    expect(screen.getByTestId('sloAdoption-page-loading')).toBeInTheDocument();
    await act(async () => {
      resolver?.({ candidates: [], unknowns: [] });
    });
    await waitFor(() => {
      expect(screen.getByTestId('sloAdoption-recoverTab')).toBeInTheDocument();
    });
  });
});

describe('SloAdoptionPage — Session C legacy orphans tab', () => {
  it('hides the Legacy-orphans tab when the purge flag is off (404 probe)', async () => {
    const purgeLegacyOrphans = jest.fn().mockRejectedValue({ response: { status: 404 } });
    await act(async () => {
      renderPage(makeApiClient({ purgeLegacyOrphans }));
    });
    await waitFor(() => expect(screen.getByTestId('sloAdoption-recoverTab')).toBeInTheDocument());
    expect(screen.queryByTestId('sloAdoption-page-tabs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sloAdoption-page-tab-legacy')).not.toBeInTheDocument();
  });

  it('shows the Legacy-orphans tab when the purge flag is on (400 probe)', async () => {
    // Server returns 400 when the flag is on (schema rejects empty groups).
    const purgeLegacyOrphans = jest
      .fn()
      .mockRejectedValue({ response: { status: 400 }, body: { message: 'empty' } });
    const listOrphans = jest.fn().mockResolvedValue({
      candidates: [],
      unknowns: [
        {
          datasourceId: 'ds-1',
          namespace: 'slo-generated-ds-1',
          groupName: 'slo:foo_abcdef12',
          diagnostic: 'pre-Phase-3 rule layout; not eligible for adoption',
        },
        {
          datasourceId: 'ds-1',
          namespace: 'slo-generated-ds-1',
          groupName: 'slo:unsupported',
          diagnostic: 'provenance schemaVersion 99 not supported (expected 1)',
        },
      ],
    });
    await act(async () => {
      renderPage(makeApiClient({ purgeLegacyOrphans, listOrphans }));
    });
    await waitFor(() => expect(screen.getByTestId('sloAdoption-page-tabs')).toBeInTheDocument());
    // Badge count reflects only the legacy-diagnostic row (1 of 2 unknowns).
    expect(screen.getByTestId('sloAdoption-page-tab-legacy')).toHaveTextContent(
      'Legacy orphans (1)'
    );
  });

  it('switches to the Legacy tab on click and renders the purge table', async () => {
    const purgeLegacyOrphans = jest.fn().mockRejectedValue({ response: { status: 400 } });
    const listOrphans = jest.fn().mockResolvedValue({
      candidates: [],
      unknowns: [
        {
          datasourceId: 'ds-1',
          namespace: 'slo-generated-ds-1',
          groupName: 'slo:foo_abcdef12',
          diagnostic: 'pre-Phase-3 rule layout; not eligible for adoption',
        },
      ],
    });
    await act(async () => {
      renderPage(makeApiClient({ purgeLegacyOrphans, listOrphans }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-page-tab-legacy')).toBeInTheDocument()
    );
    await act(async () => {
      screen.getByTestId('sloAdoption-page-tab-legacy').click();
    });
    expect(screen.getByTestId('sloAdoption-legacyTab')).toBeInTheDocument();
    expect(screen.getByTestId('sloAdoption-legacyTab-table')).toBeInTheDocument();
  });
});
