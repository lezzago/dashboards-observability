/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="cypress" />

/*
 * Metrics "Create alert rule" flyout — end-to-end UI.
 *
 * Requires a workspace-enabled OSD with the Explore plugin + a Prometheus
 * DirectQuery datasource (the `cypress-metrics-alerting-ui` workflow job stands
 * this up on top of the Cortex sidecar). Locally:
 *   yarn cypress:run --config baseUrl=http://localhost:5602 \
 *     --spec .cypress/integration/alerting_test/metrics_create_alert_rule_ui.spec.js \
 *     --env "sloDatasourceId=ObservabilityStack_Prometheus,workspaceId=<id>"
 *
 * Validates the two user-facing fixes in a real browser:
 *   1. The Explore PromQL query is copied into the flyout's editable
 *      "PromQL expression" field (query-copy).
 *   2. "Run preview" issues a real range query and renders results (not the
 *      old hardcoded sample data).
 */

const WORKSPACE_PREFIX = Cypress.env('workspaceId') ? `/w/${Cypress.env('workspaceId')}` : '';
const datasourceId = Cypress.env('sloDatasourceId') || 'prom_integ_test';

// `up` exists on any Prometheus/Cortex (target liveness). The trailing
// comparison is stripped server-side so the preview still returns a series.
const QUERY = 'up > 0.5';

// Metrics Explore page, Query tab (code mode), with the dataset + query seeded
// in the URL so the query is committed (the copy path the flyout reads).
const metricsUrl = () => {
  const ds = datasourceId;
  const g = `(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:now-1h,to:now))`;
  const q =
    `(dataset:(dataSource:(),id:${ds},language:PROMQL,signalType:metrics,` +
    `timeFieldName:Time,title:${ds},type:PROMETHEUS),language:PROMQL,query:'${QUERY}')`;
  const a =
    `(legacy:(columns:!(_source),interval:auto,isDirty:!f,sort:!()),` +
    `tab:(logs:(),patterns:(usingRegexPatterns:!f)),` +
    `ui:(activeTabId:logs,metricsPageMode:query,showHistogram:!t))`;
  return `${WORKSPACE_PREFIX}/app/explore/metrics/#?_g=${g}&_q=${q}&_a=${a}`;
};

describe('Metrics Create alert rule flyout', () => {
  it('copies the Explore query into the flyout and previews real data', function () {
    cy.visit(metricsUrl(), { failOnStatusCode: false });

    // The action requires explore + workspace + the alerting capabilities
    // (observability.alertManager.enabled + opensearch_alerting.pplAlertingEnabled)
    // AND the Prometheus datasource to be resolvable as a metrics dataset in
    // this workspace. If the environment isn't set up for that, skip rather
    // than hard-fail (the deterministic preview-route API spec still runs).
    cy.get('body', { timeout: 60000 }).then(($body) => {
      if ($body.find('button:contains("Create alert rule")').length === 0) {
        Cypress.log({ name: 'metrics-ui', message: 'Create alert rule button absent; skipping' });
        this.skip();
      }
    });

    cy.contains('button', 'Create alert rule', { timeout: 60000 }).click();

    // 1. Query copied into the editable PromQL expression field.
    cy.get('[data-test-subj="metricsMonitorPromQlExpression"]', { timeout: 30000 })
      .should('be.visible')
      .should('have.value', QUERY);

    // 2. Run preview issues a real range query and renders results.
    cy.intercept('POST', '**/api/alerting/prometheus/**/preview').as('preview');
    cy.get('[data-test-subj="metricsMonitorRunPreviewButton"]').click();
    cy.wait('@preview').its('response.statusCode').should('eq', 200);
    // The results accordion renders with a count (real data, no "sample data").
    cy.contains(/Results \(\d+\)/, { timeout: 30000 }).should('be.visible');
    cy.contains('Sample data').should('not.exist');
  });
});
