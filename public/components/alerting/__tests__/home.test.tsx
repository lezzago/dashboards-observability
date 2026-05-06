/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from '@testing-library/react';

jest.mock('../../../framework/core_refs', () => ({
  coreRefs: {
    http: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
    core: {
      uiSettings: {
        get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
      },
    },
  },
}));

jest.mock('../alarms_page', () => ({
  AlarmsPage: (props: Record<string, unknown>) => (
    <div
      data-test-subj="alarms-page"
      data-max={props.maxDatasources}
      data-initial-tab={(props.initialTab as string) ?? ''}
    />
  ),
}));

import { AlertingHome } from '../home';

// Helper to mount AlertingHome at a specific hash path. The component owns
// its HashRouter, so navigating with `location.hash` before render is how
// we exercise its routing table.
function renderAtHash(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
  return render(<AlertingHome />);
}

describe('AlertingHome', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('renders without crashing', () => {
    const { getByTestId } = render(<AlertingHome />);
    expect(getByTestId('alarms-page')).toBeInTheDocument();
  });

  it('passes maxDatasources clamped to default when uiSettings returns []', () => {
    const { getByTestId } = render(<AlertingHome />);
    expect(getByTestId('alarms-page').getAttribute('data-max')).toBe('5');
  });

  it('defaults to alerts tab when no path is given', () => {
    const { getByTestId } = renderAtHash('');
    // Default route: `initialTab` is undefined, AlarmsPage will fall back
    // to 'alerts' internally. Here we assert the prop passthrough shape.
    expect(getByTestId('alarms-page').getAttribute('data-initial-tab')).toBe('');
  });

  it('renders AlarmsPage with initialTab="rules" when hash is #/rules', () => {
    const { getByTestId } = renderAtHash('#/rules');
    expect(getByTestId('alarms-page').getAttribute('data-initial-tab')).toBe('rules');
  });

  it('renders AlarmsPage with initialTab="rules" when rules path has a query string', () => {
    const { getByTestId } = renderAtHash('#/rules?slo_id=abc');
    expect(getByTestId('alarms-page').getAttribute('data-initial-tab')).toBe('rules');
  });

  it('renders AlarmsPage with initialTab="alerts" when hash is #/alerts', () => {
    const { getByTestId } = renderAtHash('#/alerts');
    expect(getByTestId('alarms-page').getAttribute('data-initial-tab')).toBe('alerts');
  });

  it('renders AlarmsPage with initialTab="routing" when hash is #/routing', () => {
    const { getByTestId } = renderAtHash('#/routing');
    expect(getByTestId('alarms-page').getAttribute('data-initial-tab')).toBe('routing');
  });
});
