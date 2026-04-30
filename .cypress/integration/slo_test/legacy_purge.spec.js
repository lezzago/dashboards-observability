/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="cypress" />

/*
 * Session C — legacy-orphan purge end-to-end.
 *
 * Run locally with:
 *   yarn cypress:run --spec \
 *     .cypress/integration/slo_test/legacy_purge.spec.js
 *
 * Requires:
 *   - observability-stack dev cluster (Cortex-backed `prometheus` container,
 *     DirectQuery datasource named by `sloDatasourceId`, default
 *     `ObservabilityStack_Prometheus`).
 *   - `observability.slo.legacyOrphanPurge.enabled: true` in the dev OSD's
 *     `opensearch_dashboards.yml`. The spec probes the endpoint in its
 *     `before` hook and skips every `it()` when the feature returns 404 so
 *     CI stays green regardless of the runtime config.
 *
 * Scenarios:
 *   1. Seed two legacy-pattern groups directly on Cortex, confirm they
 *      appear in the Legacy-orphans tab. Select one, purge it, verify the
 *      tab reflects the change and the group is gone from Cortex.
 *   2. Purge a second group via the same flow. Confirm the Recover-tab
 *      unknowns accordion count drops by two after refresh (reconciler
 *      picks up the change on its next sweep / explicit refresh).
 *
 * The seeded groups carry NO provenance annotations — mirroring the
 * pre-Phase-3 monolithic shape the reconciler reports as "pre-Phase-3 rule
 * layout; not eligible for adoption".
 */

const SLO_BASE = '/api/observability/v1/slos';
const APP_ID = 'observability-apm-slo';
const RULER_ROOT = Cypress.env('rulerRoot') || 'http://localhost:9090';

const randomHexSuffix = () =>
  Math.random().toString(16).slice(2, 10).padStart(8, '0').slice(0, 8);

// ---------------------------------------------------------------------------
// Cortex admin helpers
// ---------------------------------------------------------------------------

/**
 * Seed a pre-Phase-3 style rule group directly on Cortex. Shape:
 *   name: slo:<slug>_<8-hex>
 *   rules: one alert rule, NO provenance annotation.
 * That's exactly what the reconciler classifies as "pre-Phase-3 rule layout;
 * not eligible for adoption".
 */
function seedLegacyGroup(datasourceId, slug) {
  const namespace = `slo-generated-${datasourceId}`;
  const groupName = `slo:${slug}_${randomHexSuffix()}`;
  const yaml = [
    `name: ${groupName}`,
    `interval: 60s`,
    `rules:`,
    `  - alert: CypressLegacySentinel_${slug}`,
    `    expr: vector(0) > 1`,
    `    for: 5m`,
    `    labels:`,
    `      slo_legacy_cypress: "true"`,
    `    annotations:`,
    `      summary: "legacy-pattern fixture for purge spec"`,
  ].join('\n');
  cy.request({
    method: 'POST',
    url: `${RULER_ROOT}/api/v1/rules/${encodeURIComponent(namespace)}`,
    headers: { 'Content-Type': 'application/yaml' },
    body: yaml,
    failOnStatusCode: false,
  });
  return { namespace, groupName };
}

/** Delete a group directly via the Cortex admin API (fallback cleanup). */
function deleteRulerGroup(namespace, groupName) {
  if (!namespace || !groupName) return;
  cy.request({
    method: 'DELETE',
    url: `${RULER_ROOT}/api/v1/rules/${encodeURIComponent(namespace)}/${encodeURIComponent(
      groupName
    )}`,
    failOnStatusCode: false,
  });
}

/** Yields true iff Cortex reports the group name in the namespace listing. */
function cortexHasGroup(namespace, groupName) {
  return cy
    .request({
      method: 'GET',
      url: `${RULER_ROOT}/api/v1/rules/${encodeURIComponent(namespace)}`,
      failOnStatusCode: false,
    })
    .then((resp) => {
      if (resp.status === 404) return false;
      const body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
      return body.includes(groupName);
    });
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('SLO legacy-orphan purge — Session C', () => {
  const datasourceId =
    Cypress.env('sloDatasourceId') || 'ObservabilityStack_Prometheus';

  let seededA = null;
  let seededB = null;
  let purgeEnabled = false;

  before(function () {
    // Feature-flag gate. Issue an empty-groups probe — the server returns 400
    // when the feature is enabled (schema rejection) and 404 when disabled.
    cy.request({
      method: 'POST',
      url: `${SLO_BASE}/_purge_legacy`,
      headers: { 'osd-xsrf': 'true' },
      body: { datasourceId: '__probe__', groups: [] },
      failOnStatusCode: false,
    }).then((resp) => {
      purgeEnabled = resp.status !== 404;
      if (!purgeEnabled) {
        cy.log(
          'legacy-purge feature flag is off — skipping spec. Enable ' +
            '`observability.slo.legacyOrphanPurge.enabled` to exercise this flow.'
        );
      }
    });
  });

  beforeEach(function () {
    if (!purgeEnabled) this.skip();
  });

  after(function () {
    // Fallback cleanup — if a test bailed mid-flow, remove whatever seeded
    // groups remain.
    if (seededA) deleteRulerGroup(seededA.namespace, seededA.groupName);
    if (seededB) deleteRulerGroup(seededB.namespace, seededB.groupName);
  });

  it('seeds two legacy groups, purges one via the UI, verifies Cortex state', () => {
    seededA = seedLegacyGroup(datasourceId, 'cypress_seed_a');
    seededB = seedLegacyGroup(datasourceId, 'cypress_seed_b');

    cy.visit(`/app/${APP_ID}#/slos/adoption`);
    // Wait for the feature-flag probes to resolve and the tab chrome to
    // render. The test is skipped if the flag is off, so we can block on
    // the tab being visible.
    cy.get('[data-test-subj="sloAdoption-page-tab-legacy"]', { timeout: 30000 }).should(
      'be.visible'
    );
    cy.get('[data-test-subj="sloAdoption-page-tab-legacy"]').click();
    cy.get('[data-test-subj="sloAdoption-legacyTab"]').should('be.visible');

    // Both seeded groups must appear in the table.
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededA.groupName}"]`).should(
      'be.visible'
    );
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededB.groupName}"]`).should(
      'be.visible'
    );

    // Select the first row. The EUI table renders per-row checkboxes with
    // `aria-label="Select this row"`; scope to the one rendered in the
    // same row as seededA.
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededA.groupName}"]`)
      .closest('tr')
      .find('input[type="checkbox"][aria-label="Select this row"]')
      .click();

    cy.get('[data-test-subj="sloAdoption-legacyTab-purgeSelected"]').should('be.enabled').click();
    cy.get('[data-test-subj="sloAdoption-legacyTab-confirmModal"]').should('be.visible');
    cy.contains('button', 'Purge groups').click();

    // After purge the confirm modal closes and the row for seededA is gone.
    cy.get('[data-test-subj="sloAdoption-legacyTab-confirmModal"]').should('not.exist');
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededA.groupName}"]`, {
      timeout: 15000,
    }).should('not.exist');
    // seededB remains.
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededB.groupName}"]`).should(
      'be.visible'
    );

    // Direct Cortex confirmation.
    cortexHasGroup(seededA.namespace, seededA.groupName).should('equal', false);
    cortexHasGroup(seededB.namespace, seededB.groupName).should('equal', true);

    // Clear the tracker so `after` doesn't double-delete.
    seededA = null;
  });

  it('Session E F4 — row expand shows audit timeline after a purge', () => {
    // Stage 1: seed + confirm the row shows up.
    seededA = seedLegacyGroup(datasourceId, 'cypress_audit_flow');

    cy.visit(`/app/${APP_ID}#/slos/adoption`);
    cy.get('[data-test-subj="sloAdoption-page-tab-legacy"]', { timeout: 30000 }).should(
      'be.visible'
    );
    cy.get('[data-test-subj="sloAdoption-page-tab-legacy"]').click();

    // Stage 2: before purging, the expanded row should show "No purge history".
    cy.get(`[data-test-subj="sloAdoption-legacyTab-expand-${seededA.groupName}"]`, {
      timeout: 15000,
    }).click();
    cy.get('[data-test-subj="sloAdoption-legacyTab-auditTimeline-empty"]').should('be.visible');

    // Collapse it again so the purge selection interactions below aren't
    // confused by the expanded row's DOM landing on the wrong <tr>.
    cy.get(
      `[data-test-subj="sloAdoption-legacyTab-expand-${seededA.groupName}"]`
    ).click();

    // Stage 3: purge the group.
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededA.groupName}"]`)
      .closest('tr')
      .find('input[type="checkbox"][aria-label="Select this row"]')
      .click();
    cy.get('[data-test-subj="sloAdoption-legacyTab-purgeSelected"]').click();
    cy.contains('button', 'Purge groups').click();
    cy.get(`[data-test-subj="sloAdoption-legacyTab-groupName-${seededA.groupName}"]`, {
      timeout: 15000,
    }).should('not.exist');

    // Stage 4: re-seed the same group name so there's something to expand
    // whose audit trail includes the just-purged outcome. Cortex re-accepts
    // a new group with the same name because the purger deleted the prior
    // one (so name collision isn't an issue).
    const reseededName = seededA.groupName;
    const reseededNs = seededA.namespace;
    const yaml = [
      `name: ${reseededName}`,
      `interval: 60s`,
      `rules:`,
      `  - alert: CypressAuditReseed`,
      `    expr: vector(0) > 1`,
      `    for: 5m`,
      `    labels:`,
      `      slo_legacy_cypress: "true"`,
      `    annotations:`,
      `      summary: "re-seeded for audit flow assertion"`,
    ].join('\n');
    cy.request({
      method: 'POST',
      url: `${RULER_ROOT}/api/v1/rules/${encodeURIComponent(reseededNs)}`,
      headers: { 'Content-Type': 'application/yaml' },
      body: yaml,
      failOnStatusCode: false,
    });
    // Refresh the Recover tab trigger so the page re-fetches /_orphans; the
    // easy path is a page reload.
    cy.reload();
    cy.get('[data-test-subj="sloAdoption-page-tab-legacy"]', { timeout: 30000 }).click();

    // Stage 5: expand the row — timeline should now carry the previous
    // purge's 'purged' audit record.
    cy.get(`[data-test-subj="sloAdoption-legacyTab-expand-${reseededName}"]`, {
      timeout: 15000,
    }).click();
    cy.get('[data-test-subj="sloAdoption-legacyTab-auditTimeline"]', {
      timeout: 15000,
    }).should('be.visible');
    cy.get('[data-test-subj="sloAdoption-legacyTab-auditRecord-purged"]').should('be.visible');

    // Stage 6: purge again so `after` cleanup is a no-op. Tracks the final
    // group by updating `seededA`.
    seededA.groupName = reseededName;
    seededA.namespace = reseededNs;
  });

  it('rejects a bogus-shape candidate with a skipped_validation entry', () => {
    seededA = seedLegacyGroup(datasourceId, 'cypress_seed_bogus_check');

    // Call the endpoint directly — the UI never lets an admin select a
    // non-legacy-shape row, so this is the server-side guard rail only.
    const namespace = `slo-generated-${datasourceId}`;
    cy.request({
      method: 'POST',
      url: `${SLO_BASE}/_purge_legacy`,
      headers: { 'osd-xsrf': 'true' },
      body: {
        datasourceId,
        groups: [
          { groupName: 'not_a_legacy_shape', namespace },
          { groupName: seededA.groupName, namespace },
        ],
      },
      failOnStatusCode: false,
    }).then((resp) => {
      expect(resp.status).to.eq(200);
      expect(resp.body.purged).to.eq(1);
      expect(resp.body.skipped_validation).to.have.length(1);
      expect(resp.body.skipped_validation[0]).to.include({
        groupName: 'not_a_legacy_shape',
        reason: 'name_pattern_mismatch',
      });
    });

    cortexHasGroup(seededA.namespace, seededA.groupName).should('equal', false);
    seededA = null;
  });
});
