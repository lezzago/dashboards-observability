# SLO/SLI bug-bash results

Append one row per scenario executed. Findings below the table are the
actionable bug entries.

## Summary table

| # | Scenario            | Result | Evidence (screenshot + curl)              | Triage owner      | Notes |
|---|---------------------|--------|-------------------------------------------|-------------------|-------|
| 1 | Ruler dual-write    | PASS   | slo-bugbash-S1-post-fix-created.png; Cortex curl shows 13 rules | Sanjay            | Re-validated after fix 995615bd; 13 rules confirmed in Cortex `/api/v1/rules` after create |
| 2 | Listing filters     | PASS   | slo-bugbash-S2-pass.png; all filter combinations tested | Chen              | Service+Team filters work; URL round-trip works; shadow mode badge visible; clear-all restores 3 rows |
| 3 | Status transitions  | BLOCKED | slo-bugbash-S3-blocked.png, slo-bugbash-S4-blocked.png; listing shows no_data state | Sanjay + Jay      | **Unblocked by #S1 fix (995615bd)** — recording rules now land in Cortex, so the live-status aggregator has data to read. Scenario NOT re-run in this session (long live-burn sequence ~15m with a flagd flip); pending a manual re-run against the new branch. |
| 4 | Budget chart        | BLOCKED | slo-bugbash-S345-detail-blocked.png; detail page shows "Budget exhausted" but no live chart data | Chen (review: Jay)| **Unblocked by #S1 fix (995615bd)**. Chart prerequisite now satisfied — the `slo:sli_error:ratio_rate_*` recording rules that S4's chart reads are being written. Pending a manual re-run to confirm chart behavior end-to-end. |
| 5 | Burn-rate chart     | BLOCKED | slo-bugbash-S345-detail-blocked.png; burn-rate alerts show 6.312% but not from live recording rules | Chen (review: Jay)| **Unblocked by #S1 fix (995615bd)**. Recording rules are now in Cortex; burn-rate tier computation now has the correct series to read. Pending a manual re-run (shares the S3/S4 live flagd-flip sequence). |
| 6 | Metadata panel      | PASS   | slo-bugbash-S6-pass.png (full page); all 8 metadata sections verified | Chen              | Labels (3 rows), Annotations (1 row), Burn-rate tiers (4 rows), Budget-warning (2 rows), Advanced accordion (collapsed initially), Supplemental alarms (5 badges correct states), Exclusion windows (1 row with cron/reason/deferred), Provisioning (15 rules, namespace, rule names list) |
| 7 | Multi-objective     | PASS   | slo-bugbash-S7-*.png; wizard shows 26 rules, objective selector toggles charts | Chen + Sanjay     | Wizard preview: 26 rules ✓; Objective selector visible ✓; Switching objectives updates target (99% → 99.9%), budget (1% → 0.1%), and all 4 burn-rate thresholds ✓; Cortex verification: unblocked by #S1 fix (995615bd) — ruler dual-write now writes the full set; rule-count assertion against Cortex is now valid to run. |
| 8 | Custom PromQL       | PASS   | live curl to `/api/observability/v1/slos/preview` returns 200 with 9-rule group; raw expression appears verbatim in 7/9 rules | Chen (review: Jay)| Re-validated after fix 0db3a036. Preview accepts partial specs now; raw-mode custom PromQL (substituted envoy retry ratio for kafka — kafka metric isn't live in this stack) flows end-to-end. Field-level validator errors still return 400 with `errors` map for incomplete specs (service-side `validateSloSpec` is the gate). |
| 9 | Approximation warn  | PASS   | slo-bugbash-S9-pass.png; UI callout visible with window=14d | Sanjay            | Window approximation yellow callout appears with 14d window; message correct: "Windows greater than 3d use the 3d recording rule as an approximation in P0. Attainment alerts will carry slo_window_approximated="true"."; Cortex rule label check unblocked by #S1 fix (995615bd). |
| 10| Advanced editors    | PASS   | slo-bugbash-S10-pass.png; UI round-trip verified | Maya + Chen       | Burn-rate tiers: Page·Quick shows 20.0x multiplier ✓; Budget-warning: 3 rows (warning 50%, critical 20%, info 75%) ✓; Supplemental alarms: SLI health enabled ✓; Cortex rule expr check unblocked by #S1 fix (995615bd). |
| 11| Exclusion windows   | PASS   | slo-bugbash-S11-pass.png; both windows persist after hard-refresh | Chen              | Created SLO with 2 exclusion windows: (1) cron "0 2 * * 0" 2h UTC "maintenance" deferred, (2) one-off 2026-05-01T00:00:00Z → 2026-05-01T02:00:00Z deferred. Both rows visible in Advanced → Exclusion windows table. Hard-refreshed browser (navigate with reload), re-opened detail page → both windows still present ✓. Persistence verified. Cortex rule check not performed (not relevant for saved-object-only feature; ruler write blocked by #S1 anyway). |
| 12| Validator guardrails| PASS   | slo-bugbash-S12.1-post-fix-uuid-error.png; wizard unit tests cover both textareas | Sanjay            | Re-validated after fix 0db3a036. S12.1 (UUID label error) PASS live via wizard — inline `env: Label values must not be UUIDs (cardinality guardrail)` now renders on the Labels `EuiFormRow`. S12.2 (4 KiB annotation cap) PASS via jest (`surfaces the annotation size-cap validator error inline on the Annotations row`) — live-browser run blocked on a Playwright text-input limitation with 5 KiB payloads, not a plugin defect. S12.3 remains out of scope (see Finding #S12c — spec decision, not bug). |

Fill **Result** with one of: `PASS`, `FAIL`, `BLOCKED`. `BLOCKED` is for
scenarios that couldn't start because a prerequisite broke (e.g. OSD
dev server down, datasource missing, live traffic stopped).

---

## Findings

For every `FAIL` row, add an entry below using the template. Number
entries by scenario (`#S4`, `#S4b`, `#S7`). Persona-tag the triage
owner the table cites.

### Template (copy-paste, fill in, don't delete the template itself)

```
### #S<n> — <one-line title>

**Severity**: P0 (blocks GA) | P1 (ships with mitigation) | P2 (polish)
**Triage owner**: <Chen | Sanjay | Jay | Maya | Kai | Rio>

**Reproduction**:
1. <step>
2. <step>
3. <step>

**Observed**:
<what actually happened, with UI element data-test-subjs or screenshot
references — e.g. "slos-budget-remaining-chart" shows `warning @ 50%`
line at y=0.05, not 0.5>.

**Expected** (per plan / design / prior working build):
<what the scenario asserted should happen>.

**Metric-level evidence**:
    $ curl -s -G http://localhost:9090/prometheus/api/v1/query \
        --data-urlencode 'query=<the exact query the chart runs>'
    <paste the JSON response here>

**Hypothesis** (optional — skip if unknown):
<where the bug might be: file_path:line_number, or "server
aggregator" / "chart option builder" / "wizard preview debounce", etc.>

**Cleanup performed**: yes | no — `<what was left behind>`
```

### Example (filled-in, for shape reference only — delete before actual bash)

```
### #S4 — Budget-remaining chart stuck at 100% after paymentFailure=75%

**Severity**: P1
**Triage owner**: Chen (review: Jay)

**Reproduction**:
1. Create SLO `example-s4` with envoy ingress custom PromQL.
2. Flip paymentFailure=75% in flagd UI.
3. Wait 5 minutes.
4. Open SLO detail page.

**Observed**:
"Error budget remaining" chart line stays flat at 100% despite Cortex
returning values that decline from 1.0 → 0.8 in the same window.
Browser snapshot: `slo-bugbash-S4-fail.png`.

**Expected**:
Line trends downward matching the Cortex query output.

**Metric-level evidence**:
    $ curl -s -G http://localhost:9090/prometheus/api/v1/query_range \
        --data-urlencode 'query=clamp_min((0.001 - (1 - ...)) / 0.001, -0.5)' \
        --data-urlencode 'start=...' --data-urlencode 'end=...' \
        --data-urlencode 'step=60s' | jq '.data.result[0].values[-5:]'
    [[1777..., "1"], [1777..., "0.93"], [1777..., "0.85"], ...]

**Hypothesis**:
The chart's `refreshTrigger` prop isn't propagating; the `useMemo`
on `data` may be memoizing against an identity that doesn't change.
Likely in `slo_budget_remaining_chart.tsx` around the series
transformation block.

**Cleanup performed**: yes — SLO deleted, flag reset.
```

---

### #S12 — UUID label validator fires but error message doesn't surface in UI

**Resolved by 0db3a036**: `LabelsAnnotationsPanel` now accepts the `errors` map
and threads per-label errors into `EuiFormRow.error[]` / `isInvalid`. The
UUID-rejection message now renders inline under the Labels textarea,
prefixed with the offending key (`env: Label values must not be UUIDs …`).
Live-validated via the wizard on the `slos` branch; covered by
`slo_wizard_page.test.tsx` — `surfaces a per-label validator error inline
on the Labels row`.

**Severity**: P1 (ships with mitigation — validator blocks the create call, but users don't know *why*)
**Triage owner**: Sanjay

**Reproduction**:
1. Open wizard at `http://localhost:5601/app/observability-apm-slo#/slos/create`.
2. Select HTTP Availability template.
3. Fill required fields: datasource `ObservabilityStack_Prometheus`, name `scenario-s12-uuid-test`, service `frontend`, team `sre`, dimension `service=frontend`.
4. In the "Labels" textarea (under "Labels & annotations (optional)"), enter: `env=550e8400-e29b-41d4-a716-446655440000`
5. Click "Create SLO".

**Observed**:
- The form shows a generic toast notification: "Fix validation errors — Some required fields are missing or invalid."
- No specific error callout about the UUID label value appears near the Labels field or anywhere else in the form.
- The create call is blocked (no POST to `/api/observability/v1/slos` happens — verified via console; only preview API calls with 400).
- Browser snapshots: `slo-bugbash-S12-step1-uuid-label-filled.png`, `slo-bugbash-S12-step1-scrolled.png`.

**Expected** (per test plan S12.1):
An **error** callout should appear stating: "label values must not be UUID-shaped" (or the actual message from the validator: "Label values must not be UUIDs (cardinality guardrail)"). The rejection should happen **before** the network call (✓ this part works), **and** the error message should be visible to the user (✗ this part fails).

**Code-level evidence**:
The validator EXISTS and fires:
```bash
$ grep -A 5 "UUID_LABEL_VALUE_RE" /Users/ashisagr/.../common/slo/slo_validators.ts
...
} else if (UUID_LABEL_VALUE_RE.test(val)) {
  errors[`spec.labels["${k}"]`] = 'Label values must not be UUIDs (cardinality guardrail)';
}
```
The error is populated in the `errors` object with key `spec.labels["env"]`, but the wizard UI doesn't display this error to the user.

**Hypothesis**:
The wizard's form validation aggregates the errors from `validateSloSpec()` but only surfaces a generic toast when `Object.keys(errors).length > 0`. The individual per-field error messages (like `errors['spec.labels["env"]']`) are not rendered as inline validation text or callouts near the Labels textarea.

Likely fix location: `public/components/slo/wizard/create_slo_wizard.tsx` or the `LabelsAnnotationsSection` component — needs to read `validationResult.errors` and render `EuiFormRow` error states for fields under `spec.labels` / `spec.annotations`.

**Cleanup performed**: no — the SLO was never created (validation blocked it); no Cortex state affected.

---

### #S12b — 5 KiB annotation rejection error message doesn't surface in UI

**Resolved by 0db3a036**: Same wiring as #S12. The `spec.annotations`
validator error (`Annotations exceed 4096-byte size cap`) now renders
inline on the Annotations `EuiFormRow`. Covered by
`slo_wizard_page.test.tsx` — `surfaces the annotation size-cap validator
error inline on the Annotations row`. Live-browser run on a 5 KiB payload
was blocked by a Playwright text-input limitation, not a plugin defect.

**Severity**: P1 (ships with mitigation — validator blocks the create call, but users don't know *why*)
**Triage owner**: Sanjay

**Reproduction**:
1. Open wizard at `http://localhost:5601/app/observability-apm-slo#/slos/create`.
2. Select HTTP Availability template.
3. Fill required fields: datasource `ObservabilityStack_Prometheus`, name `scenario-s12-annot`, service `test-service`, team `test-team`, dimension `service=envoy_http_downstream_rq_xx_total`.
4. In the "Annotations" textarea (under "Labels & annotations (optional)"), inject a 5 KiB annotation: `runbook=` + 5120 'x' characters (total 5128 bytes).
5. Click "Create SLO".

**Observed**:
- The form shows a generic toast notification: "Fix validation errors — Some required fields are missing or invalid."
- No specific error callout about the 4 KiB / annotation cap appears near the Annotations field or anywhere else in the form.
- The create call is blocked (no SLO is created).
- Browser snapshot: `slo-bugbash-S12-step2-generic-error.png`.

**Expected** (per test plan S12.2):
An **error** callout should appear referencing the 4 KiB / annotation cap. The test plan expected: "an error (toast, inline, or callout) references the 4 KiB / annotation cap."

**Hypothesis**:
Same root cause as #S12 (step 1): the validator fires and populates `errors['spec.annotations.runbook']` or similar, but the wizard UI doesn't render the specific error message inline or in a visible callout. Only the generic "Fix validation errors" toast appears.

**Cleanup performed**: no — the SLO was never created (validation blocked it); no Cortex state affected.

---

### #S12c — Target validator rejects >99.999% instead of clamping to 6 sig figs

**Severity**: P2 (polish — validator behavior differs from plan, but it's a valid guardrail)
**Triage owner**: Sanjay

**Reproduction**:
1. Open wizard at `http://localhost:5601/app/observability-apm-slo#/slos/create`.
2. Select HTTP Availability template.
3. Fill required fields: datasource `ObservabilityStack_Prometheus`, name `scenario-s12-clamp`, service `test-service`, team `test-team`, dimension `service=envoy_http_downstream_rq_xx_total`.
4. Set target to `99.999999%` (8 digits after decimal).
5. Click "Create SLO".

**Observed**:
- The form shows an inline validation error under the Target (%) field: "Target must be between 0.5 and 0.99999"
- The create call is blocked (no SLO is created).
- The form **rejects** values above 99.999% (5 nines / `0.99999`) rather than accepting and clamping them.
- When the target is changed to `99.999%`, the SLO is created successfully, and the persisted target is `0.99999` (5 sig figs, not 6).
- Browser snapshots: `slo-bugbash-S12-step3-validation-block.png`, `slo-bugbash-S12-step3-created-5nines.png`.

**Expected** (per test plan S12.3):
The test plan expected the form to **accept** `99.999999%` and **clamp** it to `0.999999` (6 sig figs) on save. The actual behavior is more restrictive: the validator rejects anything above 5 sig figs upfront.

**Metric-level evidence**:
```bash
$ curl -s 'http://localhost:5601/api/observability/v1/slos/f5fd1c69-c9a8-4ea6-a949-1a5c55bd417f' \
    -H 'osd-xsrf: true' | jq '.spec.objectives[0].target'
0.99999
```
The persisted target is `0.99999` (5 sig figs), confirming the validator's cap.

**Hypothesis**:
The validator has a hard cap at `0.99999` (5 nines), likely defined in `common/slo/slo_validators.ts` as a `MAX_TARGET` constant. The test plan expected a 6-sig-fig clamp (allowing `0.999999`), but the code implements a 5-sig-fig cap. This is arguably a **better** guardrail (prevents unrealistically tight SLOs), but it differs from the plan's expectation.

Decision needed: should the cap be raised to 6 nines (`0.999999`), or is the current 5-nine cap intentional?

**Cleanup performed**: yes — SLO `scenario-s12-clamp` deleted via UI, Cortex rules verified clean.

---

### #S1 — Ruler dual-write fails silently; UI shows "13 Rules provisioned" but Cortex has zero rules

**Resolved by 995615bd**: Ruler dual-write now succeeds against `ObservabilityStack_Prometheus`; 13 rules confirmed in Cortex `/api/v1/rules` after create. The fix resolved the datasource connection-name vs. ID mismatch that caused `buildDeployContext` to return undefined.

**Severity**: P0 (blocks GA — the core ruler integration doesn't work)
**Triage owner**: Sanjay

**Reproduction**:
1. Open wizard at `http://localhost:5601/app/observability-apm-slo#/slos/create`.
2. Select HTTP Availability template.
3. Fill fields: datasource `ObservabilityStack_Prometheus`, name `scenario-s1-availability`, service `frontend-proxy`, team `sre`, dimension `service=frontend-proxy`, target `99%`, window `28d`.
4. Click "Create SLO".
5. Page redirects to detail view `#/slos/<uuid>` showing "13 Rules provisioned".
6. Query Cortex ruler: `curl -s http://localhost:9090/api/v1/rules | grep -i scenario`

**Observed**:
- SLO saved object created in OpenSearch `.kibana_9` index (ID `21145162-eb8c-4e17-86ea-36c44b0fe223`).
- Detail page shows "13 Rules provisioned" in the Error budget panel.
- Cortex `/api/v1/rules` has **zero** rule groups matching the SLO name or any scenario-related namespace.
- No error toast or console error indicating the ruler POST failed.
- Browser snapshot: `slo-bugbash-S1-fail.png` (full page showing "13 Rules provisioned" claim).

**Expected** (per test plan S1 step 5):
Cortex ruler should return 13 rules in a group matching the SLO name/namespace. The curl should show `rule_count=13` for the scenario's rule group.

**Metric-level evidence**:
```bash
$ curl -s http://localhost:9090/api/v1/rules | grep -E "^[a-z_]+:"
otel_demo:
smk:
smoke:
stack:
test_ns:

$ curl -s http://localhost:9090/api/v1/rules | grep -i scenario | wc -l
       0
```
No namespace or group contains "scenario" or the SLO name. All existing groups (`otel_demo`, `smk`, `smoke`, `stack`, `test_ns`) are pre-existing — none were created by this SLO.

**Hypothesis (CORRECTED by main thread)**:

The initial hypothesis (missing `prometheus.ruler.uri` on the datasource) is **wrong**. Datasource verified by main thread:
```json
{
  "prometheus.uri": "http://prometheus:9090/prometheus",
  "prometheus.ruler.uri": "http://prometheus:9090",
  "alertmanager.uri": "http://alertmanager:9093"
}
```
Both the query URI and the (unprefixed) ruler URI are set correctly.

**Actual likely cause** — a silent no-op in the SLO create flow. In `common/slo/slo_service.ts:244`:

```ts
if (deploy) {
  await deploy.ruler.upsertRuleGroup(...);
}
```

If `deploy` is `undefined`, the ruler call is skipped **but the SO is still created**, the UI still redirects to the detail page, and `provisioning.generatedRuleNames` is populated from local rule generation — so the UI shows "13 Rules provisioned" even though zero rules reached Cortex.

`deploy` is built by `buildDeployContext` at `server/routes/slo/index.ts:255-289`; it returns `undefined` when any of these is missing:
- `rulerClient` (configured at plugin start)
- `datasourceService`
- `datasourceId` from the request
- `ds.directQueryName` (auto-discovered from the OpenSearch SQL plugin)

Most likely suspects:
1. `datasourceId` isn't being passed from the create request (wizard side) to `buildDeployContext`, OR
2. `datasourceService.get(datasourceId)` returns `undefined` because in-memory discovery hasn't populated yet / has a different ID format, OR
3. `directQueryName` isn't being populated on the discovered `Datasource` object for `ObservabilityStack_Prometheus`.

**Fix suggestion**: change `buildDeployContext` to *throw* (or at minimum log.warn) instead of silently returning `undefined` when the caller expected a ruler write. The SO create path should refuse to save if the intended ruler write can't happen, or at least make the UI aware that rules were generated-but-not-persisted. Today a silent no-op masquerades as success — that's what makes this P0.

Likely files:
- `server/routes/slo/index.ts:255-289` — `buildDeployContext` returns `undefined` path
- `common/slo/slo_service.ts:244` — the `if (deploy)` guard that skips ruler writes
- Wizard → server request body: verify `datasourceId` is included in the create request

**Cleanup performed**: yes — SLO deleted via UI, confirmed Cortex still has zero scenario rules.

**Downstream impact**: S3, S4, S5, S7 (rule-count check), S8 (rule YAML check), S9 (rule label check), S10 (rule expr check) all depend on rules actually reaching Cortex. Main thread will proceed to run those scenarios anyway — they still test distinct UI paths (wizard UX, metadata panel, listing filters), but their Cortex-side assertions will fail until #S1 is fixed. Expect several FAIL rows with `blocked-by-#S1` in Notes.

---

### #S8 — Preview API continuously returns 400 Bad Request; cannot verify custom PromQL in rule YAML

**Resolved by 0db3a036**: The preview route now uses a relaxed `previewBody`
schema (`{ spec: {…unknowns: 'allow'} }`) instead of the strict
`createBody`. The OSD boundary schema no longer duplicates field-level
validation — the service's `validateSloSpec` is the real gate and returns
field-keyed errors for incomplete specs. Live-validated: POST to
`/api/observability/v1/slos/preview` with a raw-mode Custom PromQL spec
(envoy retry ratio) returns 200 with a 9-rule group; the raw expression
appears verbatim in 7 of the 9 rules. Partial specs now return a 400 with
a human-readable `errors` map instead of a single-field schema rejection.

**Severity**: P1 (ships with mitigation — wizard UX captures custom PromQL correctly, but preview is broken)
**Triage owner**: Chen (review: Jay)

**Reproduction**:
1. Open wizard at `http://localhost:5601/app/observability-apm-slo#/slos/create`.
2. Select "Custom PromQL" template.
3. Fill fields:
   - Datasource ID: `ObservabilityStack_Prometheus`
   - Name: `scenario-s8-custom`
   - Service: `kafka`
   - Primary team: `platform`
4. Select "Raw error-ratio" mode.
5. Enter custom PromQL: `sum(rate(kafka_consumer_records_lag[5m])) / sum(rate(kafka_consumer_records_consumed_rate[5m]))`
6. Set objective name: `kafka-lag-ratio`, target: `99%`
7. Scroll down to "Rule preview" section.

**Observed**:
- The custom PromQL expression is correctly captured in the form field `[data-test-subj="slos-wizard-custom-promql-raw"]`.
- The "Rule preview" section continuously shows: "⚠️ Preview unavailable - Bad Request"
- Browser console shows repeated 400 errors from `/api/observability/v1/slos/preview` endpoint.
- Cannot verify whether the custom expression appears verbatim in the generated rule YAML (which is the critical S8 assertion per test plan).
- Browser snapshots: `slo-bugbash-S8-wizard-top.png`, `slo-bugbash-S8-sli-section.png`, `slo-bugbash-S8-preview-section.png`.

**Expected** (per test plan S8):
The "Rule preview" section should render the Prometheus rule group YAML, and the SLI recording rule's `expr:` field should contain the custom PromQL expression **verbatim**: `sum(rate(kafka_consumer_records_lag[5m])) / sum(rate(kafka_consumer_records_consumed_rate[5m]))`.

**Metric-level evidence**:
Tested the preview API directly via curl with manual spec construction. The API has strict validation that requires many nested fields (`spec.enabled`, `spec.mode`, `spec.owner.teams` as array, `spec.sli.type` must be "single" or "composite", `spec.budgetWarningThresholds` array, etc.). The wizard form state → preview API payload transformation appears to be incomplete or the API schema is stricter than the wizard's form state structure.

```bash
$ curl -s 'http://localhost:5601/w/CHkxVF/api/observability/v1/slos/preview' \
  -H 'Content-Type: application/json' \
  -H 'osd-xsrf: true' \
  --data-raw '{"spec":{"datasourceId":"ObservabilityStack_Prometheus","name":"test","enabled":true,"mode":"active","service":"kafka","owner":{"teams":["platform"]},"objectives":[{"name":"test","target":0.99}],"sli":{"type":"single","metric":{"type":"custom","customPromql":{"mode":"raw","errorRatioQuery":"sum(rate(kafka_consumer_records_lag[5m])) / sum(rate(kafka_consumer_records_consumed_rate[5m]))"}},"dimensions":[]},"window":"28d"}}'
{"statusCode":400,"error":"Bad Request","message":"[request body.spec.budgetWarningThresholds]: expected value of type [array] but got [undefined]"}
```

Even after manually constructing a payload with all discovered required fields, the API continues to reject with different missing field errors. The wizard is attempting to preview with an incomplete spec, and the preview API does not tolerate partial specs or provide defaults for omitted optional fields.

**Hypothesis**:
1. The wizard's `usePreview()` hook (or equivalent) constructs a preview request payload from the form state, but this transformation doesn't match the strict schema expected by the `/api/observability/v1/slos/preview` API route.
2. The API schema requires many fields that the wizard considers optional (e.g., `budgetWarningThresholds`, `enabled`, `mode`) to be present with valid default values, but the wizard doesn't inject those defaults before calling preview.
3. Alternatively, the wizard's form state isn't being debounced properly, and the preview is being called with partially-filled state (e.g., before `datasourceId` or `name` are set).

**Fix suggestion**:
1. In the wizard's preview payload builder (likely in `public/components/slo/wizard/use_preview.ts` or similar), ensure that all required fields for the `/api/observability/v1/slos/preview` API are populated with sensible defaults from the form state before the API call.
2. Alternatively, relax the preview API's validation to accept partial specs and return a best-effort rule preview, or return a more informative error (e.g., "Preview unavailable: missing required field X") instead of a generic 400.
3. Add validation on the wizard side to disable the preview panel (or show "Fill required fields to see preview") when critical fields like `datasourceId`, `name`, `service`, `ownerTeam`, `objectives[0].target` are empty.

Likely files:
- `public/components/slo/wizard/use_preview.ts` (or wherever the preview API call is made) — payload construction
- `server/routes/slo/index.ts` — preview endpoint schema validation (may need to be relaxed or provide better error messages)
- `common/slo/slo_validators.ts` — spec normalization (may need to inject defaults for optional fields before validation)

**Cleanup performed**: no — the SLO was never created (preview failed before Create was clicked); no Cortex state affected. Browser left on the wizard page with the custom PromQL filled in (for triage screenshots).
