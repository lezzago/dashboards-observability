/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mapAlertFilters, mapRuleFilters, resolveBackendDsIds } from '../filter_mapping';
import type { AlertsDashboardFilterSnapshot } from '../alerts_dashboard';
import type { FilterState as RulesFilterState } from '../monitors_table/monitors_table_filters';

const emptyAlertSnapshot = (): AlertsDashboardFilterSnapshot => ({
  severity: [],
  state: [],
  backend: [],
  labels: {},
  severityCard: 'all',
  stateCard: 'all',
});

const emptyRuleFilters = (): RulesFilterState => ({
  status: [],
  severity: [],
  monitorType: [],
  healthStatus: [],
  labels: {},
  createdBy: [],
  destinations: [],
  backend: [],
});

describe('mapAlertFilters', () => {
  it('returns empty params when no filters are set', () => {
    expect(mapAlertFilters(emptyAlertSnapshot())).toEqual({});
  });

  it('panel severity wins over stat-card single-select', () => {
    const snap = emptyAlertSnapshot();
    snap.severity = ['critical', 'high'];
    snap.severityCard = 'medium';
    expect(mapAlertFilters(snap)).toEqual({ severity: ['critical', 'high'] });
  });

  it('severityCard "medium" expands to wide-medium semantics', () => {
    const snap = emptyAlertSnapshot();
    snap.severityCard = 'medium';
    expect(mapAlertFilters(snap)).toEqual({ severity: ['medium', 'low', 'info'] });
  });

  it('severityCard "critical" maps to single-severity array', () => {
    const snap = emptyAlertSnapshot();
    snap.severityCard = 'critical';
    expect(mapAlertFilters(snap)).toEqual({ severity: ['critical'] });
  });

  it('panel state wins over stat-card single-select', () => {
    const snap = emptyAlertSnapshot();
    snap.state = ['active', 'pending'];
    snap.stateCard = 'active';
    expect(mapAlertFilters(snap)).toEqual({ state: ['active', 'pending'] });
  });

  it('stateCard "active" maps to single-state array', () => {
    const snap = emptyAlertSnapshot();
    snap.stateCard = 'active';
    expect(mapAlertFilters(snap)).toEqual({ state: ['active'] });
  });

  it('drops empty label-value arrays from output', () => {
    const snap = emptyAlertSnapshot();
    snap.labels = { env: ['prod'], region: [] };
    expect(mapAlertFilters(snap)).toEqual({ labels: { env: ['prod'] } });
  });

  it('omits labels entirely when no key has values', () => {
    const snap = emptyAlertSnapshot();
    snap.labels = { env: [], region: [] };
    expect(mapAlertFilters(snap)).toEqual({});
  });

  it('does NOT pass backend through (caller resolves dsIds)', () => {
    const snap = emptyAlertSnapshot();
    snap.backend = ['prometheus'];
    expect(mapAlertFilters(snap)).toEqual({});
  });
});

describe('mapRuleFilters', () => {
  it('returns empty params when no filters are set', () => {
    expect(mapRuleFilters(emptyRuleFilters())).toEqual({});
  });

  it('forwards each supported facet category', () => {
    const filters = emptyRuleFilters();
    filters.status = ['active'];
    filters.severity = ['critical'];
    filters.monitorType = ['metric'];
    filters.healthStatus = ['healthy'];
    filters.createdBy = ['alice'];
    filters.labels = { team: ['backend'] };
    expect(mapRuleFilters(filters)).toEqual({
      status: ['active'],
      severity: ['critical'],
      monitorType: ['metric'],
      healthStatus: ['healthy'],
      createdBy: ['alice'],
      labels: { team: ['backend'] },
    });
  });

  it('drops destinations and backend (deferred / client-side)', () => {
    const filters = emptyRuleFilters();
    filters.destinations = ['#alerts'];
    filters.backend = ['opensearch'];
    expect(mapRuleFilters(filters)).toEqual({});
  });

  it('drops empty label-value arrays', () => {
    const filters = emptyRuleFilters();
    filters.labels = { env: ['prod'], region: [] };
    expect(mapRuleFilters(filters)).toEqual({ labels: { env: ['prod'] } });
  });
});

describe('resolveBackendDsIds', () => {
  const datasources = [
    { id: 'os-1', type: 'opensearch' },
    { id: 'prom-1', type: 'prometheus' },
    { id: 'os-2', type: 'opensearch' },
  ];

  it('returns input dsIds when no backend filter is applied', () => {
    expect(resolveBackendDsIds(['os-1', 'prom-1'], [], datasources)).toEqual(['os-1', 'prom-1']);
  });

  it('narrows dsIds to those matching the backend filter', () => {
    expect(resolveBackendDsIds(['os-1', 'prom-1', 'os-2'], ['prometheus'], datasources)).toEqual([
      'prom-1',
    ]);
  });

  it('keeps unknown dsIds (defensive — caller decides on validation)', () => {
    expect(resolveBackendDsIds(['os-1', 'unknown'], ['opensearch'], datasources)).toEqual([
      'os-1',
      'unknown',
    ]);
  });
});
