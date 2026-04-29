/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloneTab } from '../clone_tab';
import type { OrphanCandidate, OrphanListResponse, SloApiClient } from '../../slo_api_client';
import type { SloSpec } from '../../../../../../../common/slo/slo_types';

// Stub the datasource hook so the clone tab's source/target selects have
// predictable options without going through `http.get('/api/alerting/datasources')`.
jest.mock('../../use_prometheus_datasources', () => ({
  usePrometheusDatasources: () => ({
    datasources: [
      { id: 'ds-source', name: 'Source DS', type: 'prometheus' },
      { id: 'ds-target', name: 'Target DS', type: 'prometheus' },
    ],
    loading: false,
    error: null,
  }),
}));

function makeSpec(name: string): SloSpec {
  return {
    datasourceId: 'ds-source',
    name,
    enabled: true,
    mode: 'active',
    service: 'api',
    owner: { teams: ['sre'] },
    sli: {
      type: 'single',
      definition: {
        backend: 'prometheus',
        type: 'availability',
        calcMethod: 'events',
        metric: 'http_requests_total',
      },
      dimensions: [],
    },
    objectives: [{ name: 'obj-1', target: 0.999 }],
    budgetWarningThresholds: [],
    window: { type: 'rolling', duration: '28d' },
    alerting: { strategy: 'mwmbr', burnRates: [] },
    alarms: {
      sliHealth: { enabled: false },
      attainmentBreach: { enabled: false },
      budgetWarning: { enabled: true },
      noData: { enabled: false, forDuration: '10m' },
      resolved: { enabled: false },
    },
    exclusionWindows: [],
    labels: {},
    annotations: {},
  };
}

function makeCandidate(overrides: Partial<OrphanCandidate>): OrphanCandidate {
  return {
    sloId: 'slo-a',
    datasourceId: 'ds-source',
    workspaceId: 'ws-source',
    namespace: 'ns-1',
    groupName: 'slo:alerts:slo-a',
    spec: makeSpec('slo-a-name'),
    specSha256: 'sha-1',
    specIntegrity: 'ok',
    fingerprints: ['fp-1'],
    tombstoned: false,
    ...overrides,
  };
}

function makeApiClient(candidates: OrphanCandidate[]): jest.Mocked<SloApiClient> {
  const response: OrphanListResponse = { candidates, unknowns: [] };
  return ({
    listOrphans: jest.fn().mockResolvedValue(response),
    cloneSlo: jest.fn().mockResolvedValue({ slo: { id: 'cloned' }, sourceSpecSha256: 'sha-src' }),
  } as unknown) as jest.Mocked<SloApiClient>;
}

function renderTab(api: jest.Mocked<SloApiClient>) {
  const notifications = {
    toasts: {
      addSuccess: jest.fn(),
      addDanger: jest.fn(),
      addWarning: jest.fn(),
    },
  };
  const http = { get: jest.fn() };
  const rendered = render(
    <CloneTab
      apiClient={api}
      http={(http as unknown) as Parameters<typeof CloneTab>[0]['http']}
      notifications={(notifications as unknown) as Parameters<typeof CloneTab>[0]['notifications']}
    />
  );
  return { ...rendered, notifications };
}

async function pickSource(api: jest.Mocked<SloApiClient>) {
  await act(async () => {
    fireEvent.change(screen.getByTestId('sloAdoption-cloneTab-sourceSelect'), {
      target: { value: 'ds-source' },
    });
  });
  await waitFor(() => {
    expect(api.listOrphans).toHaveBeenCalledWith('ds-source');
  });
}

describe('CloneTab', () => {
  it('hides the form when no source is selected', () => {
    renderTab(makeApiClient([]));
    expect(screen.getByTestId('sloAdoption-cloneTab-sourcePlaceholder')).toBeInTheDocument();
    expect(screen.queryByTestId('sloAdoption-cloneTab-form')).not.toBeInTheDocument();
  });

  it('loads candidates after a source is picked', async () => {
    const api = makeApiClient([makeCandidate({ sloId: 'slo-1', spec: makeSpec('Row One') })]);
    renderTab(api);
    await pickSource(api);
    await waitFor(() => {
      expect(screen.getByText('Row One')).toBeInTheDocument();
    });
  });

  it('excludes the source datasource from the target dropdown', async () => {
    const api = makeApiClient([makeCandidate({ sloId: 'slo-1', spec: makeSpec('Row One') })]);
    renderTab(api);
    await pickSource(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-select-slo-1'));
    });
    const select = screen.getByTestId('sloAdoption-cloneTab-targetSelect') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).not.toContain('ds-source');
    expect(optionValues).toContain('ds-target');
  });

  it('submits a single clone with override name and id', async () => {
    const api = makeApiClient([makeCandidate({ sloId: 'slo-1', spec: makeSpec('Row One') })]);
    const { notifications } = renderTab(api);
    await pickSource(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-select-slo-1'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('sloAdoption-cloneTab-targetSelect'), {
        target: { value: 'ds-target' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('sloAdoption-cloneTab-overrideName'), {
        target: { value: 'new-name' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('sloAdoption-cloneTab-overrideId'), {
        target: { value: 'new-id' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-submit'));
    });
    await waitFor(() => {
      expect(api.cloneSlo).toHaveBeenCalledWith({
        sourceSloId: 'slo-1',
        sourceDatasourceId: 'ds-source',
        sourceWorkspaceId: 'ws-source',
        targetDatasourceId: 'ds-target',
        overrideName: 'new-name',
        overrideId: 'new-id',
      });
    });
    expect(notifications.toasts.addSuccess).toHaveBeenCalled();
  });

  it('issues parallel calls for bulk clone and renders a success summary toast', async () => {
    const api = makeApiClient([
      makeCandidate({ sloId: 'slo-1', spec: makeSpec('Row One') }),
      makeCandidate({
        sloId: 'slo-2',
        spec: makeSpec('Row Two'),
        namespace: 'ns-2',
        groupName: 'slo:alerts:slo-2',
      }),
    ]);
    const { notifications } = renderTab(api);
    await pickSource(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-select-slo-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-select-slo-2'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('sloAdoption-cloneTab-targetSelect'), {
        target: { value: 'ds-target' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-submit'));
    });
    await waitFor(() => {
      expect(api.cloneSlo).toHaveBeenCalledTimes(2);
    });
    expect(notifications.toasts.addSuccess).toHaveBeenCalled();
  });

  it('reports partial failures with per-row callouts when one clone fails', async () => {
    const api = makeApiClient([
      makeCandidate({ sloId: 'slo-1', spec: makeSpec('Row One') }),
      makeCandidate({
        sloId: 'slo-2',
        spec: makeSpec('Row Two'),
        namespace: 'ns-2',
        groupName: 'slo:alerts:slo-2',
      }),
    ]);
    // First call succeeds; second fails.
    (api.cloneSlo as jest.Mock)
      .mockResolvedValueOnce({ slo: { id: 'x' }, sourceSpecSha256: 'sha' })
      .mockRejectedValueOnce({ body: { message: 'collision' } });
    const { notifications } = renderTab(api);
    await pickSource(api);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-select-slo-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-select-slo-2'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('sloAdoption-cloneTab-targetSelect'), {
        target: { value: 'ds-target' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sloAdoption-cloneTab-submit'));
    });
    await waitFor(() => {
      expect(screen.getByText('collision')).toBeInTheDocument();
    });
    expect(notifications.toasts.addWarning).toHaveBeenCalled();
  });
});
