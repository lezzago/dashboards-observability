# SLO/SLI Cypress test plan

This is the per-scenario blueprint for translating the PASS rows of
`SLO_BUG_BASH_RESULTS.md` (v1) and `SLO_BUG_BASH_PLAN_v2.md` into
Cypress specs under `.cypress/integration/slo_test/`.

**Ground rule — no mocking**: do not use `cy.intercept(...).as()` with a
fixture body for any SLO, Cortex, or OpenSearch call. Tests hit the
real plugin routes against the real `observability-stack`. The only
authorized fake is pushing **old-timestamp** Prometheus samples via
remote-write — call that out explicitly in the spec with a comment
pointing at this plan.

Corollary rules:

- Use `cy.intercept('**/api/observability/v1/slos*')` **only** to
  observe (spy on) a request — never to replace the response. That's
  the difference between validating "what the UI does" vs. validating
  "what we told the UI to render", and we need the former.
- The plugin under test is OpenSearch Dashboards observability plugin
  on `http://localhost:5602`. Cypress's `baseUrl` points there in dev;
  CI uses a fresh stack.
- Don't use `cy.wait(<ms>)`. Wait on network intercepts or DOM
  `should('be.visible')` assertions. The `cypress/no-unnecessary-waiting`
  rule is currently disabled (see `.cypress/.eslintrc.js`) — that's a
  temporary eslint-plugin-cypress bug, not permission to regress.
- Every spec cleans up the SLOs it created (both the SO and the
  Cortex rule group) in `after()` or via the shared `cleanupSlos`
  helper below.

---

## How to run this plan in a fresh Claude session

Paste this at the start of a new session, with the working directory
set to the plugin root (`.../plugins/dashboards-observability`):

> You are translating the v2 bug bash PASS scenarios (S1–S12) into
> Cypress specs under `.cypress/integration/slo_test/`. Source of
> truth: `SLO_CYPRESS_TEST_PLAN.md` — read end-to-end before writing
> any spec, then work scenario-by-scenario in the order listed in
> "Per-scenario spec blueprints".
>
> Prior bug-bash context lives in `SLO_BUG_BASH_RESULTS.md` (do NOT
> re-run those scenarios unless asked — every row S1–S12 is already
> PASS live on this branch). S13/S14/S15 are explicitly deferred per
> the "Out of scope" section at the bottom of this plan.
>
> **Pre-flight before writing any spec** — run each of these and stop
> if any fail:
>
>   1. Dev OSD up on 5602 (`curl -s http://localhost:5602/api/status |
>      jq -r .status.overall.state` → `"green"`).
>   2. observability-stack healthy (`docker compose -f
>      /Users/ashisagr/Documents/workspace/observability-stack/docker-compose.yml
>      ps | awk '$5 !~ /healthy|Up/'` → only the header).
>   3. Cortex live-traffic sanity:
>      ```
>      curl -s -G http://localhost:9090/prometheus/api/v1/query \
>        --data-urlencode 'query=sum(rate(envoy_http_downstream_rq_xx_total[1m]))' \
>        | jq '.data.result[0].value[1]'
>      ```
>      → non-zero string.
>   4. Datasource `ObservabilityStack_Prometheus` has both
>      `prometheus.uri` and `prometheus.ruler.uri` set:
>      ```
>      curl -sk -u 'admin:My_password_123!@#' \
>        'https://localhost:9200/_plugins/_query/_datasources/ObservabilityStack_Prometheus' \
>        | jq '.properties | {query:."prometheus.uri", ruler:."prometheus.ruler.uri"}'
>      ```
>   5. Ruler namespace clean of prior scenario state:
>      ```
>      curl -s http://localhost:9090/prometheus/api/v1/rules \
>        | jq '[.data.groups[].name | select(test("scenario_|^slo:cy_"))] | length'
>      ```
>      → `0`.
>
> If any pre-flight fails, stop and ask the user — stack fixes are the
> user's call, not yours.
>
> **Work order**: build the shared infra first (it blocks every spec),
> then one PR per scenario in the v2 run order. Within a scenario,
> implement every `it(...)` in the blueprint — don't cherry-pick. The
> fast/slow split is load-bearing: S1, S2, S6, S7, S8, S9, S10, S11,
> S12 go to the PR gate; S3, S4, S5 go to nightly.
>
> **Ground rules (non-negotiable)**:
>
> - **No mocking**. `cy.intercept()` may only spy (observe), never
>   replace a response. The backfill helper in
>   `.cypress/fixtures/backfill/cortex_backfill.py` is the one
>   authorized fake and is only for scenario S15 (currently deferred —
>   don't use it in any spec yet).
> - Every spec must leave the stack clean: SOs deleted, Cortex rule
>   groups gone. Use `after()` + the catch-all sweeper from the harness
>   section.
> - Use `data-test-subj` for every selector. If one is missing, that's
>   a component bug — stop and ask; don't work around with CSS or text
>   matching.
> - DCO sign-off on every commit (`git commit -s`). Don't use
>   `--no-verify`.
>
> **Scope this session**: translate the 12 PASS scenarios (S1–S12).
> S13/S14/S15 are deferred — the "Out of scope" section at the bottom
> of this plan names each of their blockers and what would unblock
> them. When any of those blockers clear, return here and flip that
> entry into a spec blueprint plus a row in the scenario table.
>
> When you finish a scenario's spec, run it once green locally
> (`yarn cypress:run-without-security --spec
> .cypress/integration/slo_test/<file>`) before committing. Commit one
> scenario per PR so reviewers can triage failures to a single spec.

---

## Shared infrastructure to build first (blocks every spec)

Check these into the plugin before any spec:

### 1. `.cypress/utils/slo_helpers.js`

```js
// Sketch — not a drop-in; fill in from the existing helpers.js patterns.

export const SLO_API_BASE = '/api/observability/v1/slos';
export const CORTEX_BASE =
  Cypress.env('cortexUrl') || 'http://localhost:9090';
export const CORTEX_RULER_API = `${CORTEX_BASE}/api/v1/rules`;

export function createSloViaApi(spec) {
  return cy.request({
    method: 'POST',
    url: SLO_API_BASE,
    headers: { 'osd-xsrf': 'true' },
    body: { spec },
  });
}

export function deleteSloViaApi(id) {
  return cy.request({
    method: 'DELETE',
    url: `${SLO_API_BASE}/${id}`,
    headers: { 'osd-xsrf': 'true' },
    failOnStatusCode: false,
  });
}

export function cleanupSlos(namePrefix) {
  return cy
    .request({ url: SLO_API_BASE, headers: { 'osd-xsrf': 'true' } })
    .then((resp) =>
      Cypress.Promise.all(
        resp.body.items
          .filter((x) => x.spec.name.startsWith(namePrefix))
          .map((x) => deleteSloViaApi(x.id))
      )
    );
}

export function cortexRuleCount({ workspaceId, namePattern }) {
  return cy
    .request(`${CORTEX_BASE}/api/v1/rules/slo-generated-${workspaceId}`)
    .then((resp) => {
      const groups = (resp.body.data && resp.body.data.groups) || [];
      return groups
        .filter((g) => namePattern.test(g.name))
        .flatMap((g) => g.rules).length;
    });
}

export function pollUntil(fn, predicate, { interval = 1000, timeoutMs = 30000 } = {}) {
  const start = Date.now();
  function step() {
    return fn().then((value) => {
      if (predicate(value)) return value;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
      }
      return Cypress.Promise.delay(interval).then(step);
    });
  }
  return step();
}
```

### 2. `.cypress/fixtures/slo/spec_factories.js`

Small pure-JS factories that return well-formed `SloSpec` objects for
each scenario. No fixture JSON — fixtures are for mocks, and we aren't
mocking. Factories let each spec parameterize name / service / target /
custom PromQL expression inline so cross-spec state doesn't leak.

```js
export function httpAvailabilitySpec({ name, target = 0.99, window = '28d', service = 'frontend-proxy' }) {
  return {
    name,
    datasourceId: 'ObservabilityStack_Prometheus',
    service,
    owner: { teams: ['sre'] },
    mode: 'active',
    enabled: true,
    sli: { /* fill in: envoy 5xx / total, single calc method */ },
    objectives: [{ name: 'availability', target }],
    window,
    burnRateTiers: DEFAULT_TIERS,
    budgetWarningThresholds: [{ severity: 'warning', threshold: 0.5 }, { severity: 'critical', threshold: 0.2 }],
  };
}

export function customPromqlSpec({ name, errorRatioQuery, target = 0.99 }) { /* … */ }
export function multiObjectiveSpec({ name, targets }) { /* … */ }
```

### 3. `.cypress/fixtures/backfill/cortex_backfill.py`

Move the `/tmp/cortex_backfill_s345.py` helper into the repo (it was
left in `/tmp` during v1 and should not be the source of truth). The
script encodes Prometheus `remote.proto` v1 WriteRequests with
`field 1 = value` (double, wire type 1), `field 2 = timestamp` (int64,
wire type 0); POSTs them snappy-compressed to
`/api/v1/push`. Scenario **S15** (historical burn) invokes it from
`cy.exec(...)`.

**Only** S15 is allowed to use it. Every other spec must drive live
data through flagd flips + real traffic, or skip the burn verification
entirely.

### 4. `.cypress/support/commands.js` additions

```js
Cypress.Commands.add('setFlagdVariant', (flagKey, variant) => {
  // flagd's HTTP overlay (docker-compose/flagd/...) — check which endpoint
  // observability-stack exposes. If only JSON-reload is available, edit
  // the JSON via cy.exec('docker exec flagd sh -c "cat > /flags.json"')
  // and wait for the hot-reload signal rather than polling.
});

Cypress.Commands.add('assertCortexGroupCount', ({ workspaceId, namePattern, expected }) => {
  // cortexRuleCount + assertion
});
```

---

## Per-scenario spec blueprints

One `describe` block per scenario. **Status column** reflects the v1
bug bash result; FAIL rows are intentionally excluded (this doc is for
PASS scenarios — translate failing scenarios only after they land on
PASS in v2).

| # | Scenario                              | v1 status | Cypress spec filename                        | Needs live burn? |
|---|---------------------------------------|-----------|----------------------------------------------|------------------|
| 1 | Ruler dual-write                      | PASS      | `ruler_dual_write.spec.js`                   | no               |
| 2 | Listing filters                       | PASS      | `listing_filters.spec.js`                    | no               |
| 3 | Status transitions                    | PASS      | `status_transitions.spec.js`                 | yes (flagd)      |
| 4 | Budget chart                          | PASS      | `budget_chart.spec.js`                       | yes (flagd)      |
| 5 | Burn-rate chart + ruler + AM          | PASS      | `burn_rate_chart.spec.js`                    | yes (flagd)      |
| 6 | Metadata panel                        | PASS      | `metadata_panel.spec.js`                     | no               |
| 7 | Multi-objective                       | PASS      | `multi_objective.spec.js`                    | no               |
| 8 | Custom PromQL                         | PASS      | `custom_promql.spec.js`                      | no (preview/create only) |
| 9 | Approx warning                        | PASS      | `window_approximation.spec.js`               | no               |
| 10| Advanced editors                      | PASS      | `advanced_editors.spec.js`                   | no               |
| 11| Exclusion windows                     | PASS      | `exclusion_windows.spec.js`                  | no               |
| 12| Validators (3 sub-cases)              | PASS      | `validators.spec.js`                         | no               |

Everything below is self-contained — a Cypress engineer should be able
to take one section and implement it without reading the others.

---

### S1 — `ruler_dual_write.spec.js`

**Given** the stack is healthy and no SLO named `cy-s1-*` exists in
either the SO store or Cortex.

**When** I complete the HTTP Availability wizard with:
- `slos-wizard-datasourceId` = `ObservabilityStack_Prometheus`
- `slos-wizard-name` = `cy-s1-<randomSuffix>`
- `slos-wizard-service` = `frontend-proxy`
- `slos-wizard-ownerTeam` = `sre`
- Target = `99`, Window = `28d`
- wait for `slos-wizard-preview-success`
- click `slos-wizard-submit`

**Then**:
1. POST to `/api/observability/v1/slos` returns `200` (observed via
   `cy.intercept('POST', '**/api/observability/v1/slos').as('create')`
   + `cy.wait('@create').its('response.statusCode').should('eq', 200)`).
2. Page redirects to `#/slos/<uuid>`.
3. `sloDetailPage` is visible.
4. `slos-detail-metadata-provisioning-empty` is NOT in the DOM; the
   provisioning section shows 13 named rules.
5. Cortex group count (via direct `cy.request` to
   `http://localhost:9090/api/v1/rules/slo-generated-<workspaceId>`) =
   `13`, with `pollUntil` up to 5 s (ruler write is immediate but the
   admin API can lag one scrape interval).

**Cleanup (always, even on failure)**:
- `cy.get('[data-test-subj="slos-detail-delete"]').click()`; confirm
  modal.
- `pollUntil(cortexRuleCount, (n) => n === 0, { timeoutMs: 10000 })`.
- As a belt-and-braces in `afterEach`, call `cleanupSlos('cy-s1-')`.

**Flaky-test guard**: if the preview panel doesn't transition to
`success` within 3 s, fail the test with a clear message rather than
retrying — a slow preview is almost always a stack issue (datasource
missing the ruler URI) and retrying masks it.

---

### S2 — `listing_filters.spec.js`

**Given** three SLOs seeded via direct API POST (skip wizard; this
spec is about the listing, not the wizard):
- `cy-s2-a`: `service=shipping`, `team=sre`, `mode=active`
- `cy-s2-b`: `service=shipping`, `team=platform`, `mode=active`
- `cy-s2-c`: `service=weather-agent`, `team=sre`, `mode=shadow`

**When**/**Then** — one `it(...)` per assertion, not one giant
procedure; the listing is stateless enough that each filter combo can
be its own test:

- **`it('initial load shows 3 rows')`**: visit `#/slos`, assert
  `slos-listing-result-count` contains `3`.
- **`it('service=shipping narrows to 2 rows and writes URL')`**:
  click `slos-listing-filter-enabled-button`, pick `shipping` in the
  Service facet, assert:
  - URL ends with `?service=shipping`
  - `slos-listing-result-count` contains `2`
  - `slos-listing-filter-active-count` contains `1`
  - `slos-listing-filter-chips` contains `Service: shipping`
- **`it('service+team narrows to 1 row')`**: add `team=platform`,
  assert URL has both keys, count = `1`.
- **`it('reload with filter URL rehydrates state')`**:
  `cy.visit('#/slos?service=shipping&team=platform')`, assert count =
  `1` + chips present without needing to re-click anything.
- **`it('clear-all resets to 3 rows')`**: click
  `slos-listing-filter-clear-all`, assert URL has no query params,
  count = `3`.
- **`it('unknown value shows filtered-empty state')`**:
  `cy.visit('#/slos?service=does-not-exist')`, assert
  `slos-empty-filtered-zero` is visible and `slos-table` has no
  interactive rows.
- **`it('clear-action in filtered-empty state resets')`**: click
  `slos-empty-filtered-clear`, assert count = `3`.

**No mocking anywhere** — the listing hits `/api/observability/v1/slos`
and the counts come from the live SO store.

**Cleanup**: `after(() => cleanupSlos('cy-s2-'))`.

---

### S3 — `status_transitions.spec.js`

**Given** the stack is healthy, `paymentFailure` is `off`, one SLO
`cy-s3-availability` exists (seeded via API with the envoy custom
PromQL from v2 plan).

**When** I flip `paymentFailure` through `off → 75% → off` via the
shared `cy.setFlagdVariant(...)` command.

**Then**:
1. Initial listing row state cell = `ok` (green). Use `pollUntil` up
   to `5 min` — real burn takes time; aggressive timeouts cause
   flakiness.
2. After flip to `75%`, state cell transitions `ok → warning` (within
   3–5 min) then `warning → breached` (within ~10–15 min).
3. After flip back to `off`, state cell returns to `ok` within ~5 min
   of the 5m rolling window healing.

**Assertion harness**: use `pollUntil` to read the listing row every
30 s (matching the listing poll interval) and record the sequence of
state pills. The test passes if the sequence matches `['ok', 'warning',
'breached', 'warning', 'ok']` (or any monotone subsequence — we don't
mandate which intermediate states the poll catches).

**Real-Cortex cross-check** (don't skip — this separates "UI said it"
from "the data actually moved"):
```
cy.request({
  url: '/prometheus/api/v1/query',
  qs: { query: 'sum(rate(envoy_cluster_upstream_rq_xx_total{envoy_cluster_name="frontend", envoy_response_code_class="5"}[1m]))' },
  baseUrl: CORTEX_BASE,
}).then((resp) => expect(Number(resp.body.data.result[0].value[1])).to.be.greaterThan(0.03));
```

**This spec is slow (20+ min total) and should NOT run on every PR.**
Mark it `it.skip` under `describe('@slow', …)` and gate via
`--env slow=true` or equivalent env var. The PR-gate CI should run
`@fast` only.

**Cleanup**: `afterEach(() => cy.setFlagdVariant('paymentFailure', 'off'))`,
then `after(() => cleanupSlos('cy-s3-'))`.

---

### S4 — `budget_chart.spec.js`

Parallel to S3 and equally slow (`@slow`). Reuses the same flagd flip
sequence but watches the detail-page budget chart instead of the
listing.

**Given** the S3 SLO exists and `paymentFailure=75%` has been on long
enough for budget to have measurably decreased.

**When** I open the detail page.

**Then**:
1. `slos-budget-panel` renders.
2. `slos-budget-remaining-chart` visible; not
   `slos-budget-remaining-empty` / `-error`.
3. Capture the chart's tail value (read from ECharts via
   `cy.window().its('echarts')` or from the `data-echart-datajson`
   attribute if exposed). Poll over 15 min; assert the tail decreases
   monotonically by at least 5 percentage points.
4. Flip `paymentFailure=100%`. Within 5 min,
   `slos-budget-remaining-exhausted` appears.

**Real-Cortex cross-check**: query the same
`clamp_min((budget - consumed)/budget, -0.5)` expression from v2 plan
§ S4 and assert the numeric value matches the chart's tail within 2
percentage points (accounting for one scrape interval skew).

**Cleanup**: flag off, SLO deleted.

---

### S5 — `burn_rate_chart.spec.js`

Also `@slow`. Reuses the S3/S4 SLO.

**Given** `paymentFailure=75%` and the SLO has been burning for at
least 5 min.

**When** I open the detail page.

**Then**:
1. `slos-burnrate-panel` shows 4 tier cards, each labeled `firing`.
2. `slos-burn-rate-chart` has 4 series climbing past their dashed
   thresholds.
3. Ruler agrees:
   ```
   cy.request(`${CORTEX_BASE}/api/v1/rules`).then((resp) => {
     const firing = resp.body.data.groups
       .filter((g) => /cy_s3_availability/.test(g.name))
       .flatMap((g) => g.rules)
       .filter((r) => r.type === 'alerting' && /^SLO_BurnRate_/.test(r.name))
       .filter((r) => r.state === 'firing');
     expect(firing.length).to.eq(4);
   });
   ```
4. Alertmanager agrees: call `/api/v2/alerts` and assert 4 active
   `SLO_BurnRate_*` alerts for this SLO.

**Regression guard for `#S5-burnrate-label-mismatch` (fix `554c66da`)**:
if step 3 returns `0` while step 1 returns `4`, this is the specific
regression the commit targets. Fail with a clear message naming the
fix SHA.

**Cleanup**: flag off. After the `for: 2m` delay all 4 alerts should
return to `inactive`; poll for that in `afterEach`.

---

### S6 — `metadata_panel.spec.js`

**Given** an SLO `cy-s6-full` seeded via API with labels + annotations
+ budget-warning thresholds + supplemental alarms + one cron exclusion
window.

**When** I open the detail page.

**Then** — one `it(...)` per subsection, so a single failure points
cleanly at the component:

- Labels row: `slos-detail-metadata-labels` has exactly 3 rows with
  `team=sre`, `env=dev`, `compliance=pci`, each tagged with the
  `slo_label_<key>` badge.
- Annotations row: `slos-detail-metadata-annotations` has 1 row; the
  runbook URL is rendered as a link with `href="https://example.com/runbook"`.
- Burn-rate tiers: `slos-detail-metadata-burn-rates` has 4 rows; each
  has a `slos-detail-metadata-burn-rate-severity` dot (query for
  `data-severity` attribute matching the tier severity).
- Budget-warning thresholds: `slos-detail-metadata-budget-warnings`
  has 2 rows (`warning@50%`, `critical@20%`).
- Advanced accordion: `slos-detail-metadata-advanced` has
  `aria-expanded="false"` on mount. Click → `aria-expanded="true"` →
  `slos-detail-metadata-alarms` contains 5 badges with the text above.
- Exclusion windows: `slos-detail-metadata-exclusion-windows` has 1
  row + `slos-detail-metadata-exclusion-deferred` badge. Reason text
  matches the seed.
- Provisioning: does NOT contain `slos-detail-metadata-provisioning-empty`;
  has 13 rule names + the `slo-generated-<workspaceId>` namespace.

**Cleanup**: delete SLO.

---

### S7 — `multi_objective.spec.js`

**Given** the wizard is open at `/slos/create/custom-promql`.

**When** I fill in:
- Datasource, service, team, mode (standard boilerplate)
- Mode = raw error-ratio; Expression = the envoy retry ratio from v2 § S8
- Objective 1: `availability-99` target `99`
- Click `slos-wizard-objective-add`
- Objective 2: `availability-999` target `99.9`

**Then**:
1. `slos-wizard-preview-rule-count` contains `26`.
2. `slos-wizard-submit` click triggers a POST (observed via spy
   intercept). Status `200`.
3. On detail page: `slos-objective-selector` visible. Toggling it
   updates `slos-budget-attainment` and `slos-burnrate-panel` values
   (capture snapshot before toggle, after toggle, assert they differ).
4. Cortex rule count for this SLO = `26`.

**Cleanup**: delete SLO.

---

### S8 — `custom_promql.spec.js`

**Given** the wizard is open at `/slos/create/custom-promql`.

**When** I fill:
- Standard boilerplate
- `slos-wizard-custom-promql-mode` = `Raw error-ratio`
- `slos-wizard-custom-promql-raw` = `sum(rate(envoy_cluster_upstream_rq_retry[5m])) / sum(rate(envoy_cluster_upstream_rq[5m]))`

**Then**:
1. `slos-wizard-preview-success` appears within 2 s.
2. Click `slos-wizard-preview-yaml-toggle`. `slos-wizard-preview-yaml`
   content contains the raw expression **verbatim** at least 7 times
   (one per SLI recording rule).
3. Submit, detail page renders.
4. Cortex group contains 7 rules whose `expr` mentions
   `envoy_cluster_upstream_rq_retry`.

**Negative branch (`it('shows preview error on missing Total')`)**:
- In raw mode, clear the `slos-wizard-custom-promql-total` field.
- Assert `slos-wizard-preview-error` appears and
  `slos-wizard-submit` is `disabled`.

**Cleanup**: delete SLO from the positive branch.

---

### S9 — `window_approximation.spec.js`

**Given** the wizard is open and required fields are filled.

**When** I set `slos-wizard-window` to `14d`.

**Then**:
1. `slos-wizard-window-warning` renders with the approximation text.
2. Submit. Detail page renders.
3. Cortex rule labels for this SLO all have
   `slo_window_approximated="true"` (no `null`, no `"false"`).

**Reverse branch**: set window back to `3d` while still on the wizard;
`slos-wizard-window-warning` disappears before submit.

**Cleanup**: delete SLO.

---

### S10 — `advanced_editors.spec.js`

**Given** the wizard is open for HTTP Availability.

**When** I:
1. Click `slos-wizard-advanced-toggle`.
2. Change the Page·Quick row under `slos-wizard-burnrates` multiplier
   from `14.4` → `20`.
3. Click `slos-wizard-budget-warning-add`; add `severity=info`
   `threshold=0.75`.
4. Toggle `slos-wizard-alarm-noData` on; set
   `slos-wizard-alarm-noData-duration` to `10m`.
5. Submit.

**Then** — on detail page:
- `slos-detail-metadata-burn-rates` Page·Quick row shows `20.0x`.
- `slos-detail-metadata-budget-warnings` has 3 rows with `info@75%`
  as the third.
- `slos-detail-metadata-alarms`: `No data` badge shows `✓ · for 10m`.

Cortex rule where `labels.slo_burn_rate_multiplier === "20"` matches
`SLO_BurnRate_PageQuick_*`.

**Cleanup**: delete SLO.

---

### S11 — `exclusion_windows.spec.js`

**Given** the wizard is open.

**When** I:
1. Click `slos-wizard-exclusion-windows-toggle`. Assert
   `slos-wizard-exclusion-windows-empty` is present initially.
2. `slos-wizard-exclusion-add` → cron `0 2 * * 0`, duration `2h`, tz
   `UTC`, reason `weekly maintenance`.
3. Second row: one-off `2026-05-01T00:00:00Z` →
   `2026-05-01T02:00:00Z`.
4. Submit.

**Then**:
1. `slos-detail-metadata-exclusion-windows` has 2 rows.
2. Each row has `slos-detail-metadata-exclusion-deferred`.
3. Hard reload (`cy.reload(true)`). Both rows still present.
4. `cy.request('/api/saved_objects/_find?type=slo-definition&search=<name>')`
   confirms 2 entries in `spec.exclusionWindows` — proves SO
   persistence.

**Cleanup**: delete SLO.

---

### S12 — `validators.spec.js`

Three `it` blocks, one per sub-case.

**S12.1 — UUID label**:
- Fill wizard basics, then labels textarea:
  `env=550e8400-e29b-41d4-a716-446655440000`.
- Set up a spy intercept on `POST **/api/observability/v1/slos`.
- Click submit.
- Assert no matching request was made (`cy.wait(...)` with a short
  timeout should timeout; use `cy.get('@create.all').should('have.length', 0)`).
- Assert `slos-wizard-labels-row` has `aria-invalid="true"` and error
  text contains `env:` and `UUIDs`.

**S12.2 — >4 KiB annotation** (uses the native DOM setter workaround
documented in Finding `#S12b`):
```
cy.get('[data-test-subj="slos-wizard-annotations"] textarea').then(($el) => {
  const el = $el[0];
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  ).set;
  setter.call(el, 'runbook=' + 'x'.repeat(5120));
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
cy.get('[data-test-subj="slos-wizard-submit"]').click();
cy.get('[data-test-subj="slos-wizard-annotations-row"]')
  .should('have.attr', 'aria-invalid', 'true')
  .and('contain.text', '4096-byte');
```

**S12.3 — >5-nine target**:
- Target field = `99.999999`. Click submit.
- Assert the Target (%) `EuiFormRow` error contains
  `Target must be between 0.5 and 0.99999`. No POST fired.
- Fix target to `99.999`; submit succeeds; verify persisted `target ===
  0.99999` via `cy.request` to `/api/observability/v1/slos/<id>`.

**Cleanup**: none for 12.1/12.2; delete the SLO created in 12.3.

---

## Test harness + CI notes

### Fast vs. slow split

- `@fast` (PR gate): S1, S2, S6, S7, S8, S9, S10, S11, S12. These all
  run in < 2 min each.
- `@slow` (nightly): S3, S4, S5. Each needs 15–25 min of live traffic
  because of 5m/1h PromQL rate windows.

### Workspace assumption

All specs visit the plugin under the `Observability Stack` workspace
(`/w/CHkxVF/...`). Hard-code that into a constant; the workspace id is
stable per plugin CLAUDE.md.

### Data retention between runs

- `beforeEach`: `cleanupSlos('cy-s<n>-')` to handle leftover state from
  a crashed previous run.
- `afterEach`: primary cleanup. If `afterEach` fails, the next run's
  `beforeEach` is the safety net.
- A `support/commands.js` dangling-rule sweeper (`cleanupCortexGroups`)
  that scans `/api/v1/rules` for `slo:cy_` prefixed groups and deletes
  them should run from `before` in a root `spec.js` as a catch-all.

### Real-Cortex read-only assertions are free; writes are not

Reading from `/prometheus/api/v1/query*` is idempotent and fine to hit
in every test. Never write to Cortex from a spec **except** S15's
backfill helper — and even that writes to a dedicated
`scenario_s15_synth_*` metric namespace that no other series uses.

### What to do when a live signal is inherently flaky

Two acceptable responses; pick one per assertion, not both:

1. Widen the poll window (up to 5 min) and assert a **monotone**
   condition (decrease, crossed threshold), not a specific numeric
   value.
2. Skip the live assertion on PR gate; assert only the UI contract
   (ruler-provisioning count, DOM state). Add the live check under
   `@slow` so nightly catches regressions.

What's *not* acceptable: stubbing the backend to return a deterministic
response to make the test pass. If you reach for that, file it under
"Cypress gaps" and revisit — it means the feature needs a new
test-mode affordance, not a mocked test.

---

## Out of scope (for now)

- **S13 — delete cleans up Cortex**: v2 status **FAIL** (see
  `#S13-datasource-not-registered` in `SLO_BUG_BASH_RESULTS.md` — the
  DELETE handler spuriously rejects with "Datasource ds-4 is not
  registered" even though the datasource is present). No spec until
  the bug is fixed; writing one today would encode broken behavior.
  When fixed, follow the v2 § S13 plan — create via API, click
  `slos-detail-delete`, poll the ruler namespace until empty within
  10 s, and assert the SO returns 404.
- **S14 — orphan recovery**: v2 status **PASS**, but the pass is a
  *regression guard* that confirms DELETE/PUT both reject with HTTP
  400 naming the stale `ds-N` after the datasource churns. That's the
  currently-known broken flow — the fix for `#SLO-orphan-recovery`
  has not landed. Don't write a Cypress test for the broken flow;
  once the fix (e.g. `PUT` accepting a new `datasourceId` in the
  body) ships, write a spec that drives the happy-path relink.
- **S15 — historical backfill**: v2 status **FAIL** (see
  `#S15-backfill-blocked`). Cortex's default 10-minute
  `creation_grace_period` and `out_of_order_time_window` reject the
  28-day-old remote-write samples the scenario depends on. The
  backfill helper at `.cypress/fixtures/backfill/cortex_backfill.py`
  is correct; the blocker is stack-side config in
  `observability-stack/docker-compose/cortex/cortex.yaml` (needs
  `limits.creation_grace_period: 30d` +
  `limits.out_of_order_time_window: 30d`, then restart the
  `prometheus` container). Do this spec only after that config lands
  and a live S15 run passes.

When those land, append new sections to this plan and add the spec
filename to the table above.
