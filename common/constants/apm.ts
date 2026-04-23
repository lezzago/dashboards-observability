/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// UI Setting key for APM feature toggle
export const APM_ENABLED_SETTING = 'observability:apmEnabled';

// APM application IDs - Services
export const observabilityApmServicesID = 'observability-apm-services';
export const observabilityApmServicesTitle = 'Services';
export const observabilityApmServicesPluginOrder = 5100;

// APM application IDs - Application Map
export const observabilityApmApplicationMapID = 'observability-apm-application-map';
export const observabilityApmApplicationMapTitle = 'Application Map';
export const observabilityApmApplicationMapPluginOrder = 5101;

// APM application IDs - Application Monitoring Config
export const observabilityApmApplicationConfigID = 'observability-apm-application-config';
export const observabilityApmApplicationConfigTitle = 'Configuration';
export const observabilityApmApplicationConfigPluginOrder = 5102;

// APM application IDs - SLO/SLI
export const observabilityApmSloID = 'observability-apm-slo';
export const observabilityApmSloTitle = 'SLO/SLI';
export const observabilityApmSloPluginOrder = 5103;

// UI Setting key for SLO feature toggle (ships dark; requires APM_ENABLED_SETTING to also be true)
export const SLO_ENABLED_SETTING = 'observability:sloEnabled';
