/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * REST API handlers for Prometheus metadata discovery endpoints.
 * Framework-agnostic: returns { status, body } objects.
 * Follows the same pattern as server/routes/slo_handlers.ts.
 */

import type { PrometheusMetadataService } from '../../services/alerting/prometheus_metadata_service';
import type { Logger } from '../../../common/types/alerting/types';
import type { HandlerResult } from './route_utils';

/**
 * Upper bound on the number of names/values returned in a single response.
 *
 * Tuned for the realistic worst case: a Cortex tenant with a few hundred
 * scraped targets can easily expose thousands of distinct metric names and
 * label values. Capping at 200 silently truncates past the letter "e"
 * (alphabetical sort) so families like `http_*` and `rpc_*` fall off,
 * breaking callers that need the full metric universe — e.g. the Suggest
 * page's OTel detectors or the wizard's metric/label auto-detection.
 *
 * Interactive typeahead callers (AlarmsApiClient consumers) already bound
 * the displayed list UI-side (MAX_OPTIONS in use_prometheus_metadata.ts
 * caps at 50 for EuiComboBox), so they don't rely on this server-side cap
 * for responsiveness. The cap stays as a safety limit against pathological
 * tenants, not a UX limit.
 */
const MAX_RESULTS = 5000;

// --------------------------------------------------------------------------
// Get Metric Names
// --------------------------------------------------------------------------

export async function handleGetMetricNames(
  service: PrometheusMetadataService,
  client: any,
  dsId: string,
  search?: string,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const names = await service.getMetricNames(client, dsId, search);
    // Sort alphabetically and limit to MAX_RESULTS
    const sorted = [...names].sort();
    const limited = sorted.slice(0, MAX_RESULTS);
    return {
      status: 200,
      body: { metrics: limited, total: names.length, truncated: names.length > MAX_RESULTS },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logger) logger.warn(`handleGetMetricNames failed for ds=${dsId}: ${msg}`);
    return { status: 200, body: { metrics: [], total: 0, truncated: false } };
  }
}

// --------------------------------------------------------------------------
// Get Label Names
// --------------------------------------------------------------------------

export async function handleGetLabelNames(
  service: PrometheusMetadataService,
  client: any,
  dsId: string,
  metric?: string,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const names = await service.getLabelNames(client, dsId, metric);
    const sorted = [...names].sort();
    return { status: 200, body: { labels: sorted } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logger) logger.warn(`handleGetLabelNames failed for ds=${dsId}: ${msg}`);
    return { status: 200, body: { labels: [] } };
  }
}

// --------------------------------------------------------------------------
// Get Label Values
// --------------------------------------------------------------------------

export async function handleGetLabelValues(
  service: PrometheusMetadataService,
  client: any,
  dsId: string,
  labelName: string,
  selector?: string,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const values = await service.getLabelValues(client, dsId, labelName, selector);
    const sorted = [...values].sort();
    const limited = sorted.slice(0, MAX_RESULTS);
    return {
      status: 200,
      body: { values: limited, total: values.length, truncated: values.length > MAX_RESULTS },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logger)
      logger.warn(`handleGetLabelValues failed for ds=${dsId}, label=${labelName}: ${msg}`);
    return { status: 200, body: { values: [], total: 0, truncated: false } };
  }
}

// --------------------------------------------------------------------------
// Get Metric Metadata
// --------------------------------------------------------------------------

export async function handleGetMetricMetadata(
  service: PrometheusMetadataService,
  client: any,
  dsId: string,
  logger?: Logger
): Promise<HandlerResult> {
  try {
    const metadata = await service.getMetricMetadata(client, dsId);
    return { status: 200, body: { metadata } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logger) logger.warn(`handleGetMetricMetadata failed for ds=${dsId}: ${msg}`);
    return { status: 200, body: { metadata: [] } };
  }
}
