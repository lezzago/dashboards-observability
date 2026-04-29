/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { HttpStart } from '../../../../../../../src/core/public';
import type { Datasource } from '../../../../../common/types/alerting/types';

interface PrometheusDatasourcesState {
  datasources: Datasource[];
  loading: boolean;
  error: Error | null;
}

/**
 * Fetches the shared alerting datasource registry and filters to Prometheus
 * connections. Reuses the existing `/api/alerting/datasources` endpoint so
 * the SLO listing stays consistent with Alert Manager's view of the world.
 */
export function usePrometheusDatasources(http: HttpStart): PrometheusDatasourcesState {
  const [state, setState] = useState<PrometheusDatasourcesState>({
    datasources: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    http
      .get<{ datasources?: Datasource[] }>('/api/alerting/datasources')
      .then((res) => {
        if (cancelled) return;
        const all = res.datasources ?? [];
        const prometheus = all
          .filter((d) => d.type === 'prometheus' && d.enabled !== false)
          .sort((a, b) => a.name.localeCompare(b.name));
        setState({ datasources: prometheus, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          datasources: [],
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [http]);

  return state;
}
