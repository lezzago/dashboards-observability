/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * QueryPreviewResults — the "Run preview" results block shared by the
 * Metrics page "Create alert rule" flyout and the Alert Manager
 * "Create metrics rule" flyout.
 *
 * Runs the current PromQL expression as a live range query (last hour, 60s
 * step) via `AlertingPromResourcesService.runQueryPreview` and renders the
 * returned time series. Shows a loading spinner while the query runs, an
 * error callout on failure, and an empty-state when the query returns no
 * data. `runToken` changes on each "Run preview" click to force a re-fetch.
 */
import React, { useEffect, useState } from 'react';
import {
  EuiAccordion,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingChart,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { FormattedMessage } from '@osd/i18n/react';
import { i18n } from '@osd/i18n';
import { EchartsRender } from './echarts_render';
import { AlertingPromResourcesService } from './query_services/alerting_prom_resources_service';

interface PreviewPoint {
  timestamp: number;
  value: number;
}

/** Build the echarts line-chart spec from live range-query points. */
function buildChartOption(points: PreviewPoint[]): Record<string, unknown> {
  const timeLabels = points.map((p) =>
    new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
  const values = points.map((p) => p.value);
  return {
    grid: { left: 48, right: 16, top: 16, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: timeLabels },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'line',
        data: values,
        smooth: true,
        showSymbol: false,
        itemStyle: { color: '#006BB4' },
        areaStyle: { color: 'rgba(0,107,180,0.1)' },
      },
    ],
  };
}

interface PreviewState {
  loading: boolean;
  error: string | null;
  points: PreviewPoint[];
}

export const QueryPreviewResults: React.FC<{
  /** The PromQL expression to preview. */
  query: string;
  /** Datasource the query runs against; without it no preview can run. */
  datasourceId?: string;
  /** Bumped on each "Run preview" click to re-run the query. */
  runToken?: number;
  /** Unique accordion id — pass a distinct one per mount point. */
  id?: string;
}> = ({ query, datasourceId, runToken, id = 'prom-preview-results' }) => {
  const [state, setState] = useState<PreviewState>({
    loading: false,
    error: null,
    points: [],
  });

  useEffect(() => {
    const trimmed = (query || '').trim();
    if (!datasourceId || !trimmed) {
      setState({ loading: false, error: null, points: [] });
      return;
    }
    let stale = false;
    setState({ loading: true, error: null, points: [] });
    new AlertingPromResourcesService(datasourceId)
      .runQueryPreview(trimmed)
      .then(({ points }) => {
        if (!stale) setState({ loading: false, error: null, points: points || [] });
      })
      .catch((err) => {
        if (!stale) {
          setState({
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            points: [],
          });
        }
      });
    return () => {
      stale = true;
    };
  }, [datasourceId, query, runToken]);

  const resultCount = state.points.length;

  return (
    <EuiAccordion
      id={id}
      buttonContent={
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <strong>
              <FormattedMessage
                id="observability.alerting.queryPreviewResults.resultsTitle"
                defaultMessage="Results ({count})"
                values={{ count: resultCount }}
              />
            </strong>
          </EuiFlexItem>
        </EuiFlexGroup>
      }
      initialIsOpen
      paddingSize="s"
    >
      <EuiText size="xs" color="subdued">
        {query}
      </EuiText>
      <EuiSpacer size="s" />
      {state.loading ? (
        <EuiFlexGroup justifyContent="center" alignItems="center" style={{ height: 200 }}>
          <EuiFlexItem grow={false}>
            <EuiLoadingChart size="l" mono />
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : state.error ? (
        <EuiCallOut
          size="s"
          color="danger"
          iconType="alert"
          title={i18n.translate('observability.alerting.queryPreviewResults.errorTitle', {
            defaultMessage: 'Could not run preview',
          })}
        >
          <EuiText size="xs">{state.error}</EuiText>
        </EuiCallOut>
      ) : resultCount === 0 ? (
        <EuiCallOut
          size="s"
          color="warning"
          iconType="iInCircle"
          title={i18n.translate('observability.alerting.queryPreviewResults.noDataTitle', {
            defaultMessage: 'No data returned for this query in the last hour',
          })}
        />
      ) : (
        <EchartsRender spec={buildChartOption(state.points)} height={200} />
      )}
    </EuiAccordion>
  );
};
