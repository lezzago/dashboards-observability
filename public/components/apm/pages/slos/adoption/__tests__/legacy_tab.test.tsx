/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for Session C's Legacy-orphans tab. Focus: selection →
 * confirmation modal → purge call → post-purge toast, plus partial-failure
 * rendering. Does not exercise the feature-flag probe — that's on the
 * page-level suite.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { formatRelativeAge, LegacyTab } from '../legacy_tab';
import type {
  LegacyPurgeAuditListResponse,
  LegacyPurgeResponse,
  OrphanUnknown,
  PurgeLegacyRequestBody,
  SloApiClient,
} from '../../slo_api_client';

function makeLegacyRow(overrides: Partial<OrphanUnknown>): OrphanUnknown {
  return {
    datasourceId: 'ds-1',
    namespace: 'slo-generated-ds-1',
    groupName: 'slo:foo_abcdef12',
    diagnostic: 'pre-Phase-3 rule layout; not eligible for adoption',
    ...overrides,
  };
}

function makeApiClient(
  overrides: Partial<jest.Mocked<SloApiClient>> = {}
): jest.Mocked<SloApiClient> {
  return ({
    listOrphans: jest.fn(),
    recoverSlo: jest.fn(),
    purgeLegacyOrphans: jest
      .fn<Promise<LegacyPurgeResponse>, [PurgeLegacyRequestBody]>()
      .mockResolvedValue({ requested: 0, purged: 0, skipped_validation: [], failed: [] }),
    listLegacyPurgeAudit: jest
      .fn<Promise<LegacyPurgeAuditListResponse>, [unknown]>()
      .mockResolvedValue({ records: [], truncated: false }),
    ...overrides,
  } as unknown) as jest.Mocked<SloApiClient>;
}

function makeNotifications() {
  return {
    toasts: {
      addSuccess: jest.fn(),
      addDanger: jest.fn(),
      addWarning: jest.fn(),
    },
  };
}

function renderTab(
  apiClient: jest.Mocked<SloApiClient>,
  legacyOrphans: OrphanUnknown[],
  onPurgeComplete?: jest.Mock
): ReturnType<typeof makeNotifications> {
  const notifications = makeNotifications();
  render(
    <LegacyTab
      apiClient={apiClient}
      notifications={(notifications as unknown) as Parameters<typeof LegacyTab>[0]['notifications']}
      legacyOrphans={legacyOrphans}
      onPurgeComplete={onPurgeComplete}
    />
  );
  return notifications;
}

describe('formatRelativeAge (Session E / F3)', () => {
  const NOW = new Date('2026-04-29T12:00:00.000Z');

  it('returns "Unknown" when firstSeenAt is missing', () => {
    expect(formatRelativeAge(undefined, NOW)).toBe('Unknown');
  });

  it('returns "Unknown" when firstSeenAt is not a parseable date', () => {
    expect(formatRelativeAge('not-a-date', NOW)).toBe('Unknown');
  });

  it('returns "Just now" for deltas under 1 minute', () => {
    expect(formatRelativeAge('2026-04-29T11:59:30.000Z', NOW)).toBe('Just now');
  });

  it('returns "N minutes ago" between 1 minute and 1 hour', () => {
    expect(formatRelativeAge('2026-04-29T11:55:00.000Z', NOW)).toBe('5 minutes ago');
    // Singular form on exactly 1 minute.
    expect(formatRelativeAge('2026-04-29T11:59:00.000Z', NOW)).toBe('1 minute ago');
  });

  it('returns "N hours ago" between 1 hour and 1 day', () => {
    expect(formatRelativeAge('2026-04-29T09:00:00.000Z', NOW)).toBe('3 hours ago');
    expect(formatRelativeAge('2026-04-29T11:00:00.000Z', NOW)).toBe('1 hour ago');
  });

  it('returns "N days ago" beyond 1 day', () => {
    expect(formatRelativeAge('2026-04-26T12:00:00.000Z', NOW)).toBe('3 days ago');
    expect(formatRelativeAge('2026-04-28T12:00:00.000Z', NOW)).toBe('1 day ago');
  });
});

describe('LegacyTab — Age column (Session E / F3)', () => {
  it('renders "Unknown" when firstSeenAt is missing on the row', () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [makeLegacyRow({ groupName: 'slo:foo_abcdef12' })]);
    expect(screen.getByTestId('sloAdoption-legacyTab-age-slo:foo_abcdef12')).toHaveTextContent(
      'Unknown'
    );
  });

  it('renders a relative-time string when firstSeenAt is present', () => {
    const apiClient = makeApiClient();
    // Ten days before any realistic test run time — pins to "N days ago" regardless.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    renderTab(apiClient, [
      makeLegacyRow({ groupName: 'slo:foo_abcdef12', firstSeenAt: tenDaysAgo }),
    ]);
    expect(screen.getByTestId('sloAdoption-legacyTab-age-slo:foo_abcdef12')).toHaveTextContent(
      '10 days ago'
    );
  });
});

describe('LegacyTab — empty + callout', () => {
  it('renders the empty prompt when no legacy orphans are present', () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, []);
    expect(screen.getByTestId('sloAdoption-legacyTab-emptyPrompt')).toBeInTheDocument();
  });

  it('renders the rows + pre-dedup callout when legacy orphans are present', () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [makeLegacyRow({})]);
    expect(screen.getByTestId('sloAdoption-legacyTab-callout')).toBeInTheDocument();
    expect(screen.getByTestId('sloAdoption-legacyTab-table')).toBeInTheDocument();
    expect(
      screen.getByTestId('sloAdoption-legacyTab-groupName-slo:foo_abcdef12')
    ).toBeInTheDocument();
  });
});

describe('LegacyTab — selection → purge flow', () => {
  async function selectAll(): Promise<void> {
    // EUI's table renders one "Select all rows" checkbox in the header plus
    // one "Select this row" checkbox per row. Click each row-level checkbox
    // so we don't have to disambiguate the name-collision between the two
    // header checkboxes (the "pages" selector also shows up by that name).
    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /select this row/i });
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    for (const checkbox of rowCheckboxes) {
      await act(async () => {
        fireEvent.click(checkbox);
      });
    }
  }

  it('disables the bulk-purge button until at least one row is selected', () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [makeLegacyRow({})]);
    const button = screen.getByTestId('sloAdoption-legacyTab-purgeSelected');
    expect(button).toBeDisabled();
  });

  it('opens the confirmation modal, cancel leaves state untouched', async () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [makeLegacyRow({})]);
    await selectAll();
    const button = screen.getByTestId('sloAdoption-legacyTab-purgeSelected');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByTestId('sloAdoption-legacyTab-confirmModal')).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() =>
      expect(screen.queryByTestId('sloAdoption-legacyTab-confirmModal')).not.toBeInTheDocument()
    );
    expect(apiClient.purgeLegacyOrphans).not.toHaveBeenCalled();
  });

  it('sends the purge call on confirm and fires a success toast when all succeed', async () => {
    const apiClient = makeApiClient({
      purgeLegacyOrphans: jest
        .fn<Promise<LegacyPurgeResponse>, [PurgeLegacyRequestBody]>()
        .mockResolvedValue({
          requested: 2,
          purged: 2,
          skipped_validation: [],
          failed: [],
        }),
    });
    const onPurgeComplete = jest.fn();
    const notifications = renderTab(
      apiClient,
      [
        makeLegacyRow({ groupName: 'slo:foo_abcdef12' }),
        makeLegacyRow({ groupName: 'slo:bar_cafebabe' }),
      ],
      onPurgeComplete
    );
    await selectAll();
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-legacyTab-purgeSelected'));
    });
    const confirm = screen.getByRole('button', { name: 'Purge groups' });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(apiClient.purgeLegacyOrphans).toHaveBeenCalledTimes(1));
    expect(apiClient.purgeLegacyOrphans.mock.calls[0][0]).toEqual({
      datasourceId: 'ds-1',
      groups: [
        { groupName: 'slo:foo_abcdef12', namespace: 'slo-generated-ds-1' },
        { groupName: 'slo:bar_cafebabe', namespace: 'slo-generated-ds-1' },
      ],
    });
    await waitFor(() => expect(notifications.toasts.addSuccess).toHaveBeenCalled());
    expect(notifications.toasts.addWarning).not.toHaveBeenCalled();
    expect(onPurgeComplete).toHaveBeenCalled();
  });

  it('renders the last-result panel with a warning toast on partial failure', async () => {
    const apiClient = makeApiClient({
      purgeLegacyOrphans: jest
        .fn<Promise<LegacyPurgeResponse>, [PurgeLegacyRequestBody]>()
        .mockResolvedValue({
          requested: 2,
          purged: 1,
          skipped_validation: [
            {
              groupName: 'slo:bar_cafebabe',
              namespace: 'slo-generated-ds-1',
              reason: 'claimed_by_so',
              claimantSloId: 'slo-claim',
            },
          ],
          failed: [],
        }),
    });
    const notifications = renderTab(apiClient, [
      makeLegacyRow({ groupName: 'slo:foo_abcdef12' }),
      makeLegacyRow({ groupName: 'slo:bar_cafebabe' }),
    ]);
    await selectAll();
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-legacyTab-purgeSelected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Purge groups' }));
    });
    await waitFor(() => expect(notifications.toasts.addWarning).toHaveBeenCalled());
    expect(screen.getByTestId('sloAdoption-legacyTab-lastResultPanel')).toBeInTheDocument();
    expect(screen.getByTestId('sloAdoption-legacyTab-skippedList')).toHaveTextContent(
      'claimed_by_so'
    );
    expect(screen.getByTestId('sloAdoption-legacyTab-skippedList')).toHaveTextContent('slo-claim');
  });

  it('renders a purge-error callout when the server call rejects', async () => {
    const apiClient = makeApiClient({
      purgeLegacyOrphans: jest
        .fn<Promise<LegacyPurgeResponse>, [PurgeLegacyRequestBody]>()
        .mockRejectedValue({
          body: { message: 'ruler unreachable' },
        }),
    });
    renderTab(apiClient, [makeLegacyRow({})]);
    await selectAll();
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-legacyTab-purgeSelected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Purge groups' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-legacyTab-purgeError')).toHaveTextContent(
        'ruler unreachable'
      )
    );
  });

  it('refuses to send a multi-datasource purge and warns the operator', async () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [
      makeLegacyRow({ datasourceId: 'ds-1', groupName: 'slo:a_abcdef12' }),
      makeLegacyRow({
        datasourceId: 'ds-2',
        namespace: 'slo-generated-ds-2',
        groupName: 'slo:b_cafebabe',
      }),
    ]);
    await selectAll();
    expect(screen.getByTestId('sloAdoption-legacyTab-multiDsWarning')).toBeInTheDocument();
    const button = screen.getByTestId('sloAdoption-legacyTab-purgeSelected');
    await act(async () => {
      fireEvent.click(button);
    });
    // Confirm modal still opens; the purge call is guarded in performPurge.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Purge groups' }));
    });
    expect(apiClient.purgeLegacyOrphans).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-legacyTab-purgeError')).toHaveTextContent(
        /narrow the selection to one datasource/i
      )
    );
  });
});

describe('LegacyTab — audit row-expand (Session E / F4)', () => {
  async function expandRow(groupName: string): Promise<void> {
    const btn = screen.getByTestId(`sloAdoption-legacyTab-expand-${groupName}`);
    await act(async () => {
      fireEvent.click(btn);
    });
  }

  it('renders the empty-state when listLegacyPurgeAudit returns zero records', async () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [makeLegacyRow({ groupName: 'slo:foo_abcdef12' })]);
    await expandRow('slo:foo_abcdef12');
    await waitFor(() =>
      expect(apiClient.listLegacyPurgeAudit).toHaveBeenCalledWith({
        datasourceId: 'ds-1',
        groupName: 'slo:foo_abcdef12',
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-legacyTab-auditTimeline-empty')).toBeInTheDocument()
    );
  });

  it('renders the timeline with one record per outcome when records are returned', async () => {
    const apiClient = makeApiClient({
      listLegacyPurgeAudit: jest
        .fn<Promise<LegacyPurgeAuditListResponse>, [unknown]>()
        .mockResolvedValue({
          records: [
            {
              workspaceId: 'ds-1',
              datasourceId: 'ds-1',
              namespace: 'slo-generated-ds-1',
              groupName: 'slo:foo_abcdef12',
              outcome: 'purged',
              requestedAt: '2026-04-29T10:00:00.000Z',
              requestedBy: 'admin',
              schemaVersion: 1,
            },
            {
              workspaceId: 'ds-1',
              datasourceId: 'ds-1',
              namespace: 'slo-generated-ds-1',
              groupName: 'slo:foo_abcdef12',
              outcome: 'skipped_validation',
              reason: 'claimed_by_so',
              claimantSloId: 'slo-123',
              requestedAt: '2026-04-28T12:00:00.000Z',
              schemaVersion: 1,
            },
          ],
          truncated: false,
        }),
    });
    renderTab(apiClient, [makeLegacyRow({ groupName: 'slo:foo_abcdef12' })]);
    await expandRow('slo:foo_abcdef12');
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-legacyTab-auditTimeline')).toBeInTheDocument()
    );
    expect(screen.getByTestId('sloAdoption-legacyTab-auditRecord-purged')).toBeInTheDocument();
    expect(
      screen.getByTestId('sloAdoption-legacyTab-auditRecord-skipped_validation')
    ).toHaveTextContent('slo-123');
  });

  it('renders an error callout when listLegacyPurgeAudit rejects', async () => {
    const apiClient = makeApiClient({
      listLegacyPurgeAudit: jest
        .fn<Promise<LegacyPurgeAuditListResponse>, [unknown]>()
        .mockRejectedValue({ body: { message: 'audit store unavailable' } }),
    });
    renderTab(apiClient, [makeLegacyRow({ groupName: 'slo:foo_abcdef12' })]);
    await expandRow('slo:foo_abcdef12');
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-legacyTab-auditTimeline-error')).toHaveTextContent(
        'audit store unavailable'
      )
    );
  });

  it('collapses the row on a second click — audit panel disappears', async () => {
    const apiClient = makeApiClient();
    renderTab(apiClient, [makeLegacyRow({ groupName: 'slo:foo_abcdef12' })]);
    await expandRow('slo:foo_abcdef12');
    await waitFor(() =>
      expect(screen.getByTestId('sloAdoption-legacyTab-auditTimeline-empty')).toBeInTheDocument()
    );
    await expandRow('slo:foo_abcdef12');
    await waitFor(() =>
      expect(
        screen.queryByTestId('sloAdoption-legacyTab-auditTimeline-empty')
      ).not.toBeInTheDocument()
    );
  });
});
