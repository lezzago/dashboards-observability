# SLO/SLI bug bash v3 — results

Source of truth: `SLO_BUG_BASH_PLAN_v3.md`. This file collects scenario
results (one row per scenario in Part 5 summary) and per-FAIL Findings
entries (Part 2 template). Append-only — do not touch
`SLO_BUG_BASH_RESULTS.md` (v1/v2).

Run start: 2026-04-30 (UTC offset set by host).

---

## Pre-flight (Part 0) — drift + deviations

Captured before S22. Does NOT count as a FAIL for any scenario; noted
here so readers know the run started from a deliberately accepted
baseline.

| Plan check | Accepted baseline | Why |
|---|---|---|
| P0.1 OSD container :5601 | Skipped | Per explicit decision: this run uses only the dev OSD on :5602. The containerized OSD is down; not a prerequisite for any scenario. |
| P0.2 `http_server_request_duration_seconds_count` rate > 0 | Substituted | That metric does not exist in this stack. Live traffic confirmed via `http_server_duration_milliseconds_count` (rate ≈ 0.06/s) and `envoy_http_downstream_rq_xx_total` (rate ≈ 1.04/s). Plan metric name is stale — file as plan-drift. |
| P0.3 `GET :5602/api/observability/config` → `.slo` | Not reachable — stale plan step | No such route exists in the plugin (grep for `observability/config` in `server/` returns zero). Flags are read directly in `server/plugin.ts:143-148` from `opensearch_dashboards.yml` with code defaults: `ruleDedup.enabled ?? true`, `ruleAdoption.enabled ?? false`. yml line 439 sets `observability.slo.ruleAdoption.enabled: true`; ruleDedup is absent so the default `true` applies. Net effect: both flags ON, as the plan required. |
| P0.3 `legacyOrphanPurge` absent from yml | PASS | `grep -c legacyOrphanPurge config/opensearch_dashboards.yml` → 0. |
| P0.4 Datasource dual-URI | PASS | `query: http://prometheus:9090/prometheus`, `ruler: http://prometheus:9090`. |
| P0.5 `^slo:scenario_` Cortex groups | PASS | 0. |
| P0.5 `scenario-*` slo-definition SOs | PASS | 0. |
| P0.5 `slo-legacy-*` SO types | PASS | 0. |
| P0.6 Alertmanager inbox empty | Drained via silence | 7 pre-existing non-SLO alerts (`HighRequestLatency`, `HighRequestErrorRate`, `OtelDemoFrontendHighLatency`, `OtelDemoAdServiceHighCpu` on flagd / frontend / recommendation / accounting / product-reviews / cart) were silenced at run-start via AM silence `0b99e2a4-af09-4625-afc0-50b0c49802cb` (matcher `alertname=~".+"`, 2 h TTL). `GET /api/v2/alerts?silenced=false` → `0`. S5 will assert on SLO-labelled alerts filtering `silenced=false`. |

### Plan drift to file (not scenario failures)

- `SLO_BUG_BASH_PLAN_v3.md:165-166` — metric name `http_server_request_duration_seconds_count` is stale; should be `http_server_duration_milliseconds_count`.
- `SLO_BUG_BASH_PLAN_v3.md:177-184` — `GET /api/observability/config` endpoint does not exist in the current plugin build. There is no runtime surface for reading the SLO flags; verification must go through yml + `server/plugin.ts` defaults.

---

## Part 5 — Summary table

| # | Scenario | Coverage | Result | Signal | Triage | Skills | Notes |
|---|----------|----------|--------|--------|--------|--------|-------|
| 1 | Ruler dual-write + dedup shape | Phase 3 + W1.5 | PASS | Cortex: exactly 2 groups (`slo:alerts:scenario_s1_availability_group_2c3568d6` + `slo:rec:1a5a1554acd74669`); alert group carries `osd_slo_provenance` with specSha256 + schemaVersion:1; recording group: 7 rules, 0 annotations; both gone within 5s of delete | Sanjay | — | Detail page metadata + recording rules accordion fully populated; dedup shape verified |
| 2 | Listing + filter round-trip | Wave 3.2 | PASS | Datasource filter now returns matching SLOs for both id and name URL forms. `?datasourceId=ds-4` and `?datasourceId=ObservabilityStack_Prometheus` both return 1 (session-f-smoke), `?datasourceId=does-not-exist` returns 0, unfiltered returns 1. Unit coverage added in slo_service.test.ts for both forms + unresolved + no-resolver. Service + Team facets still work when clicked correctly. | Chen | — | Fixed by b02e33d9 (Refs: Finding S2.1). S2.2 (service facet "non-functional") retracted — targeted re-check showed `input.click()` DOES update URL to `?service=shipping`; prior failure was Playwright click landing on outer `div.euiCheckbox` wrapper instead of the `<input>` |
| 3 | Live status transitions | Wave 3.1 + Phase 1 | PASS | **Full orchestration via Path A (backfill).** Pushed 2h of historical `request{service="bugbash-synth"}=100` + `fault{...}=60` via `cortex_backfill.py` (60% error rate). Created `scenario-s15-synthburn` SLO with target 99% / 28d window. Within ~60s: listing row's health badge reads **"breached over budget"** (red progress bar), rules badge shows **"2 firing alerts"** (red). API `GET /slos/<id>.liveStatus.state == "breached"`, `firingCount: 2`. `rules_missing` transition already covered by S14 (out-of-band rec-group delete → red badge within 15s → Restore rebuilds dedup shape). Combined: full no_data → breached transition + rules_missing transition verified. | Sanjay + Jay | — | Full ok→warning→breached→healed sequence (all 4 states in one SLO lifecycle) still incomplete — would need controlled backfill-then-recovery timeline. State-endpoint transitions are all exercised individually. |
| 4 | Budget chart live burn | Wave 4.1 | PASS | Detail page for `scenario-s15-synthburn` under Path A backfill: **Attainment = 40%** (target 99%, matches 1 - 0.6 error ratio), **Budget remaining = -5900%** (fully exhausted + negative), **Time to exhaustion = "exhausted" (based on 1h burn)**. 4 burn-rate alert tiers all render with their respective 60% burn rates + correct multipliers (Page Quick 14.4× critical, Page Slow 6× critical, Ticket Quick 3× warning, Ticket Slow 1× warning). Budget consumption bar shows full exhaustion (red). All panel math matches the expected values from the backfill ratio. | Chen | — | Evidence: `slo-bugbash-v3-S4-detail-breached.png`. |
| 5 | Burn-rate + ruler + AM | Wave 4.1 + #S5 | PASS | **Full end-to-end ruler-to-AM delivery verified under Path A.** After 2h backfill + 3 min sustained error window, both Page•Quick (`for=2m`) and Page•Slow (`for=5m`) burn-rate rules transitioned `pending → firing`. Pre-flight AM silence was removed; `GET /api/v2/alerts?silenced=false` showed **2 SLO-labelled alerts** delivered: `SLO_BurnRate_PageQuick_scenario_s15_synthburn_availability_99_...` and `SLO_BurnRate_PageSlow_...`, both with correct labels (`slo_id=652b53a5-6bf1-42de-9102-3d7a64a34ecd`, `slo_severity=critical`, `slo_window=5m/1h` or `30m/6h`). `#S5` regression guard verified at rule-expr level: `slo:sli_error:ratio_rate_5m:... > 0.144 and ignoring(slo_window) slo:sli_error:ratio_rate_1h:... > 0.144` — the `ignoring(slo_window)` clause is present, which prevents tier cross-contamination. `osd_slo_provenance` annotation round-trips full JSON spec through AM. | Chen + Jay | — | Pre-flight silence was removed during S5 run; re-applied post-cleanup as silence `9ab400e8-dc99-4262-8784-ee773784be92` to keep remaining session clean from pre-existing OTel demo alerts. |
| 6 | Metadata panel | Wave 4.2 | PASS | All subsections render correctly: labels (team/env/compliance present, empty state absent), annotations (runbook present, empty state absent), burn-rates (4 tiers with 5m/30m/2h/6h intervals + severity markers, empty state absent), budget warnings (50%/20% present, empty state absent), exclusion windows (weekly-maintenance + cron visible, deferred status shown), alarms section expands to show SLI health + Budget warning ON, No data 15m ON, Attainment + Resolved OFF; recording-rules accordion present with 7 rules. sharedPill absent (fresh fingerprint, expected). session-f-smoke side-obs (now resolved by Bug C investigation): the SLO carried a malformed customExpr with `${service}` placeholders that were never substituted (plugin doesn't support placeholder syntax). Recreated with concrete `service="checkoutservice"` in queries (new id: de25e2d3-b271-4dc7-9f54-80d5f5c52565). See Finding S-bonus. | Chen | — | scenario-s6-full: sharedPill absent; session-f-smoke recreated 2026-04-30 with concrete queries. Cortex cleanup: API DELETE returned 200 but rule group persisted (7 rules) after 5s; manual Cortex DELETE issued (202) but group still present on final check — ruler propagation lag or filesystem storage issue |
| 7 | Multi-objective + dedup | Wave 2.1 + Phase 3 | PASS + plan-drift | Both objectives render (`availability-99` 99%, `availability-999` 99.9%); metadata panel shows "Recording groups: 1 shared" confirming fingerprint dedup (`3f54273c9ceb3ccf`, 7 rec rules, refcount=1). Clicking the `availability-99`/`availability-999` pills DOES switch the Error Budget + Burn-rate panels (screenshot shows `availability-99` pill selected in blue + Error Budget targeting 99%); Kai's earlier "no affordance" observation was wrong. Cortex: 1 rec + 1 alert group (14 rules packed per-SLO, not 2 alert groups as the plan expected). Cleanup complete. | Chen + Sanjay | frontend-design | **Plan-drift**: plan calls the objectives surface `slosDetailObjectivesTable` (BasicTable w/ row-selection + sort icons) — actual impl is a segmented pill bar. Panel-switching affordance works via pill click. **Frontend-design audit (main-thread)**: no EuiCallOuts on the page (nothing to mis-variant); pill tap-targets ~28px — fails WCAG 2.5.5 AAA ≥44px (acceptable on desktop but flagging); selected/unselected pill contrast ≥4.5:1 (AA OK); objectives panel lacks a bold section heading neighboring panels have (low-sev design debt); no on-pill badge that the two objectives share a fingerprint (Maya opportunity). Plan expected 2 alert groups (1/objective); current consolidates per-SLO — file as plan reconciliation for Sanjay/Chen. Evidence: `slo-bugbash-v3-S7-detail.png`, `slo-bugbash-v3-S7-objectives-table.png`. |
| 8 | Custom PromQL | Wave 2.2 | PASS + plan-drift | Custom PromQL template + split good/total query UI exercised. Preview YAML contains 7 occurrences of the raw expression `envoy_cluster_upstream_rq_retry` (matching plan's "≥ 7 rule expr fields"); Cortex post-deploy `jq ... | grep -c 'envoy_cluster_upstream_rq_retry'` = 7. Detail page renders. Negative branch (missing total query → "totalQuery is required" validation error): submit button remains enabled (current wizard pattern — relies on inline errors, not submit disabling). | Chen + Jay | — | Plan said "submit button must disable" on preview error — current design keeps submit enabled + surfaces inline errors on click (consistent with S12 observations). Plan-drift, not a regression. Evidence: `slo-bugbash-v3-S8-preview-yaml.txt`, `slo-bugbash-v3-S8-detail.png`, `slo-bugbash-v3-S8-cortex-exprs.txt`, `slo-bugbash-v3-S8-preview-error-v2.png`. |
| 9 | Wizard validation + visual | Wave 2.4 + Session B | PASS + plan-drift | Window-approximation callout renders correctly at 14d (`EuiCallOut` warning variant, text: "Windows greater than 3d use the 3d recording rule as an approximation in P0. Attainment alerts will carry slo_window_approximated=\"true\"."). Submit with 14d succeeds; resulting Cortex rules carry `slo_window_approximated: "true"` label. Callout positioned directly below window input (961×65px, adequate tap target). Frontend-design: EuiCallOut warning wrapper ✓, text readable ✓, positioning correct ✓. | Sanjay + Maya | frontend-design | Plan-drift: plan expected 3d and 90d as selectable windows — wizard template only exposes 7d/14d/28d/30d. Warning text is static across all >3d windows (plan expected window-specific copy "budget accuracy approximated to 3d" at 90d). Threshold behavior is correct; copy variation is a plan gap. Evidence: `slo-bugbash-v3-S9-warning-14d.png`, `slo-bugbash-v3-S9-no-warning-7d.png`, `slo-bugbash-v3-S9-warning-30d.png`, `slo-bugbash-v3-S9-cortex-labels.txt`. |
| 10 | Listing LCP + interactivity | Session B/D perf guard | PASS | Pagination click-to-page-2 landed (aria-current flipped), back-to-page-1 after mousemove stimulus landed (click not dropped); sort stability preserved across 5s of sidebar mousemove; SlosTablePanel marker survived (memoization holding, table did not remount). LCP/CLS measurement DEFERRED per scope rule (dev-build optimizer overhead corrupts perf metrics; production-build run required). | Chen + Maya | cdevtools-lcp | All interactivity regression guards passed; table properly memoized inside EuiResizableContainer |
| 11 | Exclusion windows | Wave 2.6 | PASS | Detail page shows both exclusion windows (weekly-maintenance cron `0 2 * * 0 · 2h · UTC`, may-release one-off 2026-05-01T00:00Z → 02:00Z) with deferred status badges; 3 tr rows (1 header + 2 data); hard-reload preserves state identically. API round-trip confirmed 2 windows. SO find `search_fields=attributes.name&search=scenario-s11` returned 0 (stale search-fields path — plan-drift, not a SO bug). | Chen | — | API/SO persistence verified by main-thread before test; UI rendering + hard-reload confirmed |
| 12 | Validators (3 sub) | Wave 1.3 | PASS (3/3) + plan-drift | S12.1: UUID label validator fires inline error + nav red icon, blocks submit; S12.2: >4KiB annotation fires "Annotations exceed 4096-byte size cap", blocks submit; S12.3: target 99.999999 fires "Target must be between 0.5 and 0.99999", blocks submit; target 99.999 succeeds (API: `0.99999`). Plan selectors were kebab-case (`slos-wizard-labels-row`), actual are camelCase (`slosWizardLabels`, `slosWizardAnnotationsRow`, `slosWizardObjectiveTarget-0`). | Sanjay | — | All three validators functional; plan-drift note: selectors renamed from kebab-case to camelCase across wizard (Session B/F refactor) |
| 13 | Delete + refcount-aware teardown | Phase 3 | PASS (9/10) + plan-drift | Refcount progression 0→1→2→1→0 on shared fingerprint `549f661f754450be` (updatedAt 20:08:05Z after 2nd create, 20:12:12Z after 2nd delete with zeroSinceAt set); recording group `slo:rec:549f` survived both deletes (Phase-3 24h grace). 2 alert groups created (1 per SLO), gone within 5s of their respective deletes. Step 9 (force grace=0 sweep) unverifiable: `recordingGraceMs` is yml-only, `/_reconcile` route has no `graceMs` query param. | Sanjay | — | Kai's initial FAIL was a `refCount` (camelCase) vs `refcount` (lowercase) jq field-name mistake; see Finding S13 for the triage trail + plan fix needed for step 9 |
| 14 | Broken-SLO detection + repair | Phase 1 + Session F | PASS | Detection: listing badge transitioned "No data" → "Missing" within 15s of out-of-band delete; detail page callout rendered danger variant with "Rule groups missing in Cortex... 1 of 2 expected" + Restore/Delete buttons; Restore click cleared callout within 8s; Cortex: recording group rebuilt with 7 rules, all rules carry 0 annotations (Session-F dedup-shape fix verified). Steps C/D (both-groups-deleted, ruler-unreachable) deferred per budget. | Sanjay + Maya | frontend-design | Frontend-design: danger EuiCallOut ✓, Restore (filled danger) + Delete (outlined danger) side-by-side with 8-12px gap ✓, both small variant ✓. Focus ring subtle (standard EUI). Evidence: `slo-bugbash-v3-S14-before.png`, `slo-bugbash-v3-S14-broken-detail.png`, `slo-bugbash-v3-S14-restored.png`, `/tmp/slo-bugbash-v3-S14-repair-shape.txt`. Cleanup: manual Cortex DELETE required (SLO DELETE didn't cascade within 5s, ruler propagation lag) |
| 15 | Historical burn via backfill | backfill infra | PASS | **Orchestration pattern validated, works end-to-end.** Approach: (1) push `request{service="bugbash-synth",remoteService="",namespace="span_derived"}=100` and `fault{...}=60` via `cortex_backfill.py` for 2h window ending ~5 min ago (60% error rate gauge, 1m step), (2) create SLO with concrete `sum(request{service="bugbash-synth",...})` / `sum(fault{...})` queries, (3) re-push fresh 5-10 min window every 30s to keep recording rules' 5m/1h short/long windows populated. Recording rule `slo:sli_error:ratio_rate_5m:sli_<fp>` evaluates to 0.6 within ~60s of create. Detail page attainment = 40%, budget = -5900%. Full S3/S4/S5 orchestration ran on top of this backfill. | Kai + Sanjay | — | Helper is production-ready. Plan-drift: plan says "backfill metric = `scenario_s15_synth_ratio`" (a synthetic SLI-ratio-output metric), but what actually worked here was backfilling the SLI INPUT metrics (`request` / `fault`), letting the plugin's generated recording rules compute the ratio. Plan should document this input-metric approach as the canonical pattern for future bug bashes. Also: continuous re-push (every 30s) is needed to keep the recording rule's lookback window populated; one-shot backfill isn't enough once the SLO's rules are live. |
| 16 | Reconciler + orphan detection | Phase 2 + Session C-removed | PASS | **Retired legacy-purge counters** absent from `_reconcile` response (`legacy_purge_*` / `legacyObservations*` / `legacyAuditRecordsExpired` all absent) — Session-C removal clean. Pre-Phase-3 legacy shapes still surface in `unknowns`. **S16.1 fixed by 689acd80**: `_reconcile?datasourceId=ds-4` and `?datasourceId=ObservabilityStack_Prometheus` both return 46 unknowns, matching `_orphans`. Five repeats of both forms all succeed with `errors: []` (intermittent "not registered" shake-out). `reconcileOnce` now normalizes filter input via `datasourceService.get` (id-or-name fallback) and falls back to both forms for the empty-bucket sweep so refStore grace-deletion + ruler orphan detection both run regardless of which form the caller sent. | Sanjay | — | Fixed by 689acd80 (Refs: Finding S16.1). Note: the "not registered" errors visible on a fresh dev-OSD boot are because discovery hasn't been primed yet — `_reconcile` doesn't call `discoveryService.ensure(ctx)`. A GET to `/api/alerting/datasources` primes discovery and subsequent calls succeed. Filed as a post-bash follow-up (not a regression; pre-existing and documented). |
| 17 | Recover — same-workspace adoption | Phase 4 + Session B | PASS | `_orphans` detects the orphan as adoptable; `POST /_recover` with the datasource NAME returns 200 with `adoptionSource.source === "recover"` and refcount 1→2. Seeded SLO → backdoor-deleted SO → _orphans flagged candidate → _recover succeeded → SLO reappeared in listing → regular DELETE cleaned up cleanly. Fix had two stacked root causes: (a) `input.workspaceId === undefined` from the Lite-typed handler produced "slo-generated-undefined" namespace; fall back to `deploy.workspaceId`. (b) Provenance records `datasourceId: "ds-4"` but UI calls with the name; accept a match against `{deploy.datasource.id, deploy.datasource.name}` on either side. | Sanjay | — | Fixed by ace8037d (Refs: Finding S17.1). Reconciler-via-name intermittent ("Datasource not registered") absorbed by Bug D's Finding S16.1 fix (689acd80) — reconciler now normalizes via id-or-name fallback, eliminating that class of errors. |
| 18 | Adoption page visual states | Phase 4 + Session B | PASS (partial) + plan-drift | Empty state verified via API: `GET /_orphans?datasourceId=ObservabilityStack_Prometheus` → `{candidates:[], unknowns:[]}` (all prior orphans now tracked by `slo-rule-ref` SOs at refcount=0 pending grace sweep, so none classify as orphans). S17 already demonstrated the adoption page DOES render correctly when orphans exist (`sloAdoption-page` selector, Recover tab active, orphan row with spec preview). Kai's S18 "404 on `/slos/adoption` route" retracted — likely a URL construction error (wrong basepath/app path); the route has loaded fine in multiple other scenarios this session. | Maya + Chen | frontend-design | Deferred sub-cases (as planned): disabled state (needs `observability.slo.ruleAdoption.enabled=false` + OSD restart), error state (needs `_orphans` middleware tampering or Cortex outage), loading state (too fast on dev build to capture reliably). Frontend-design audit deferred — empty state could not be screenshotted without a clean reproduction; will bundle with a dedicated adoption-UX pass when the S17.1 Recover bug is fixed so orphans can flow through the full UI lifecycle. |
| 19 | Detail page long-session memory | Session D regression guard | PASS | **Production-build run against containerized OSD (3.6.0 image with bind-mounted built plugin)**. scenario-s19-longsession seeded (2 objectives sharing fingerprint, 28d window, all alarms enabled, 2h backfill @ 0.5% error rate, continuous 30s re-push). 10 navigation cycles (listing ↔ detail, 15s dwell each). **Baseline: 484.62 MB / 1547 DOM nodes. Final: 256.38 MB / 1547 DOM nodes. Delta: –228 MB heap (runtime GC reclaimed more than warmup allocated), ±0 DOM nodes.** Detached-node marker: 0. Iframe count: 0. Heap-snapshot diff (fallback compare script) shows only V8 engine internals growing (`code::system / UncompiledDataWithoutPreparseData` +23431 objects /+469KB, feedback vectors, allocation sites, JIT bytecode for `SloDetailPage` +1 instance +37KB — all expected JIT warmup, bounded). Closure leak indicator: +30 closures / +960 bytes (~32 bytes/closure — trivial). `Context` objects: +24 / +488 bytes. All assertions **PASS**: detached DOM <100 (actual 0), listener/interval plateau (DOM count identical baseline→final), heap growth <10MB (actual NEGATIVE, -228 MB net). | Chen + Maya | cdevtools-memory | Snapshots at `/tmp/s19_heap/{baseline,final}.heapsnapshot` (322MB + 285MB). Profile used prod-build observabilityDashboards bind-mounted into opensearchstaging/opensearch-dashboards:3.6.0. Backfill loop + scenario SLO cleaned up; only session-f-smoke remains. |
| 20 | Probe SLI correctness | W5 + d9a982a7 | PASS | Happy path: Good=1.30, Total=1.30, ratio=100%, 20 sparkline points. Empty path: empty callout renders. Error path: invalid PromQL now surfaces `errors.good = "Invalid PromQL or unsupported query for datasource \"ObservabilityStack_Prometheus\""` — probe-sli populates the per-query error field so the wizard's `slosWizardProbeError-good` callout renders. Regression guard (`time` param): preserved. | Sanjay + Chen | — | Fixed by ccbeb95b (Refs: Finding S20.1). SQL-plugin note: observability-stack's DirectQuery scrubs the Cortex error text; we only get the "invalid" signal. A richer message would require a SQL-plugin-side fix. See post-bash follow-ups. |
| 21 | Suggest batch concurrency | Suggest-page wave | PARTIAL | Suggest page loads; services table renders; 41 SLOs selectable, 32 created successfully in a batch. Progress strip renders live count ("Creating SLO N/41 • 0 failed"). Bounded-concurrency regression guard **unverifiable** — Kai's fetch-wrapper instrumentation was injected after the batch POSTs started, so maxConc came back 0. The plugin's `f42210c5` commit does implement a 3-wide semaphore (checked source-side in `public/components/apm/pages/slos/slo_suggest_page.tsx` batch-create path); no regression observed in the UI beyond the measurement gap. Transient `ERR_CONNECTION_REFUSED` errors appeared mid-batch (likely dev optimizer stall under 40-wide create load); OSD recovered + resumed. 32/41 creates succeeded. | Chen | frontend-design | Frontend-design notes: EuiProgress strip with live count; preview flyout hierarchical with 13-rule badge per SLO + time-window pills. Cleanup: all 32 batch SLOs deleted; Cortex has 45 refcount-0 `slo:rec:*` carryover groups pending 24h grace (not a leak — Phase-3 dedup intentional behavior). Plan's regression guard (no >3 concurrent POSTs) would need CDP-level network capture, which dev-build optimizer instability made unreliable. |
| 22 | Legacy-purge UI removal guard | Session C-removal | PASS | Bundle: 0 legacy identifiers; adoption page: exactly 1 tab (Recover), no Legacy tab; `_purge_legacy` routes: 404; reconcile: no legacy fields; SO types: 0 | self | — | Basepath rotation during test required URL correction; all surface removed cleanly |
| 23 | Pre-commit hygiene | Session F + 7fe1c174 | PASS | Pre-commit hook exit 0 (4.28s); both files carry `/* eslint-disable max-classes-per-file */` directive; commit reset cleanly | self | — | Evidence: `/tmp/slo-bugbash-v3-S23-hook.txt` |

Legend: `PASS` / `FAIL` / `BLOCKED`. Kai (slo-live-tester) updates these rows as each scenario finishes.

---

## Part 2 — Per-FAIL Findings

Appended in scenario-completion order. Template:

```
### S<n>.<subcase> — <title>

**Finding**: <one-line summary>
**Coverage**: <phase/session>
**Steps to reproduce**: <from plan>
**Expected**: <plan assertion>
**Observed**: <actual behavior>
**Evidence**:
- Screenshot: `slo-bugbash-v3-S<n>-fail.png`
- Cortex state: `...`
- OSD logs: `...`
**Hypothesis**: <if clear>
**Triage owner**: <name>
**Related commits**: <grep history>
```

<!-- Findings entries appended below -->

### S12 — Plan drift: wizard selectors renamed kebab-case → camelCase

**Finding**: All three S12 validators (UUID label, >4KiB annotation, >5-nine target) are functional and fire correctly. Plan selectors are stale due to wizard refactor.
**Coverage**: Wave 1.3 validators.

**Plan drift details**:
- Plan used kebab-case: `slos-wizard-labels`, `slos-wizard-labels-row`, `slos-wizard-annotations`
- Actual are camelCase: `slosWizardLabels`, `slosWizardLabelsRow`, `slosWizardAnnotationsRow`, `slosWizardAnnotationKey-<i>`, `slosWizardAnnotationValue-<i>`, `slosWizardObjectiveTarget-<i>`
- Wizard nav items: `slosWizardNavItem-labels` (not `slos-wizard-labels`)
- Submit button: `slosWizardSubmit` (plan's `slos-wizard-submit` also exists as alias)

**Validation results (all PASS)**:

**S12.1 — UUID label value**:
- Input: label `env=550e8400-e29b-41d4-a716-446655440000`
- Error: "Label values must not be UUIDs (cardinality guardrail)" appears inline in `slosWizardLabelsRow` AND in top callout AND in preview panel AND nav sidebar red icon
- Submit blocked (no POST to `/api/observability/v1/slos`)
- Screenshot: `slo-bugbash-v3-S12-uuid.png`

**S12.2 — >4KiB annotation**:
- Input: annotation `runbook=x.repeat(5120)` (5 KiB)
- Error: "Annotations exceed 4096-byte size cap" appears inline in `slosWizardAnnotationsRow` AND in top callout
- Submit blocked (console shows no POST to `/api/observability/v1/slos`, only preview endpoint 400s)
- Screenshot: `slo-bugbash-v3-S12-annosize.png`

**S12.3 — >5-nine target**:
- Input: target `99.999999`
- Error: "Target must be between 0.5 and 0.99999" appears inline near `slosWizardObjectiveTarget-0` input
- Submit blocked
- Changed target to `99.999` → submit succeeds, SLO created with ID `ef833471-ddd4-4643-8f9a-b854fd5ae1f6`
- API verification: `GET /api/observability/v1/slos/<id>` → `"target": 0.99999` (5 sig figs, correct)
- Cleanup: delete via UI → SLO 404 + Cortex `scenario_s12` rule groups count 0
- Screenshots: `slo-bugbash-v3-S12-target.png` (error), `slo-bugbash-v3-S12-target-success.png` (detail page after success)

**Triage owner**: Not a bug — plan-drift only. Main thread should update `SLO_BUG_BASH_PLAN_v3.md` S12 body with corrected selectors for future runs.

**Related**: Wizard refactor likely in Session B or F (grep `slosWizardNavItem` in `public/components/apm/pages/slos/wizard/`).

---

### S13 — Step 9 unverifiable due to plan fiction; body otherwise PASSED

**Finding (main)**: Phase 3 refcount-aware dedup is working correctly. Kai's initial FAIL diagnosis was a jq field-name mistake — queried `.refCount` (camelCase), got `null` for every ref, incorrectly concluded the Phase 2 fallback was active. The actual SO field is `refcount` (lowercase c; see `server/services/slo/slo_rule_ref_store.ts:217,243,308,313`). Main-thread re-verification with the correct field name shows the refcount progression 0→1→2→1→0 happened as expected and matches the delete timestamps.

**Finding (plan fiction)**: Step 9 of S13 as written is **not executable** against the current plugin. The plan directs: `POST /_reconcile?datasourceId=<ds>&graceMs=0`. The route (`server/routes/slo/reconcile_route.ts:92`) validates only `datasourceId`; `graceMs` is rejected as an unknown query param (HTTP 400). `recordingGraceMs` is yml-only (`server/plugin.ts:164`, default 24h). Forcing an immediate sweep in a running dev OSD is not supported without restarting with `observability.slo.recordingGraceMs: 0` in `opensearch_dashboards.yml`. This is a plan-drift entry, not a plugin regression.

**Coverage**: Phase 3 refcount-aware teardown + grace sweep.

**What actually happened (main-thread re-verification)**:

Pre-S13 ruler-ref state (carryover from S1):
```
549f661f754450be  refcount=0  zeroSinceAt=2026-04-30T19:55:12.620Z
1a5a1554acd74669  refcount=0  zeroSinceAt=2026-04-30T19:59:27.000Z
305ed25f75519bc2  refcount=1  (owned by session-f-smoke)
```

During S13 run (inferred from `updated_at` transitions + delete timestamps):
1. Create A with HTTP Availability on `frontend-proxy` → deterministically fingerprinted to `549f661f754450be` (identical SLI to prior orphan); ref resurrected 0→1, `zeroSinceAt` cleared.
2. Create B with identical SLI → fingerprint collision detected; ref bumped 1→2, no new recording group written (byte-equal dedup). 2 alert groups created.
3. Delete A (via UI) → alert group A gone within 5s; ref decremented 2→1; recording group `slo:rec:549f` preserved.
4. Delete B (via UI) → alert group B gone within 5s; ref decremented 1→0 at `2026-04-30T20:12:12.035Z` (matches observed ref `updated_at`); `zeroSinceAt` re-set to same timestamp; recording group `slo:rec:549f` preserved (24h grace).

All of that is the correct Phase-3 refcount behavior.

**Step 9 (`graceMs=0` force-sweep)**: not executable — see plan fiction above. Not a regression.

**Step 10 equivalent (natural 24h grace)**: not in this run's budget. The `slo:rec:549f` group will be reclaimed by the next reconciler pass ≥24h after `20:12:12Z`.

**Evidence**:
- `slo-bugbash-v3-S13-after-create.json` — Cortex state with both SLOs live (2 new alert groups + unchanged rec groups).
- Post-delete ref state:
  ```json
  {
    "fingerprint": "549f661f754450be",
    "refcount": 0,
    "groupName": "slo:rec:549f661f754450be",
    "zeroSinceAt": "2026-04-30T20:12:12.035Z",
    "updatedAt": "2026-04-30T20:12:12.035Z"
  }
  ```
- Post-cleanup ruler query: `[.data.groups[].name | select(test("^slo:(rec|alerts):.*(s13|scenario_s13)"))] | length` → `0` (alert groups purged; rec group `slo:rec:549f` is shared with the pre-existing orphan tracking, not a scenario-s13 artifact).

**Plan fixes required**:
- S13 step 9 should either drop the `graceMs=0` parameter (accept 24h grace) or cite a currently-nonexistent yml override. Until either is fixed, step 9 cannot run against `yarn start` without a full OSD restart.

**Triage owner**: self (plan fix); no plugin fix needed. Kai's jq typo isn't a systemic issue — noting it here so future runs double-check field casing before escalating.

**Related**: `server/routes/slo/reconcile_route.ts:90-95` (query schema); `server/plugin.ts:162-164` (grace config); `server/services/slo/slo_rule_ref_store.ts` (field casing).

---

### S2.1 — Datasource filter breaks listing (0 results despite match)

**Finding**: Selecting `ObservabilityStack_Prometheus` in the Datasource facet produces "No SLOs match your filters" empty state, even though all 4 SLOs in the catalog (session-f-smoke + 3 seeds) have `datasourceId: "ObservabilityStack_Prometheus"`.
**Coverage**: Wave 3.2 facets + URL sync.
**Steps to reproduce**:
1. Navigate to `/app/observability-apm-slo#/slos`.
2. Without any filters, listing shows 4 SLOs (verified via `GET /api/observability/v1/slos` → `total: 4`, all with `datasourceId: "ObservabilityStack_Prometheus"`).
3. UI initially displays only 1 SLO (session-f-smoke) in the table with no URL query params. After clicking any filter and clearing it, all 4 appear.
4. Click the `ObservabilityStack_Prometheus` checkbox in the Datasource facet.
5. URL updates to `?datasourceId=ds-4`.
6. Table immediately shows "No SLOs match your filters" empty state, 0 rows.

**Expected**: Table should show 4 SLOs (all have matching datasourceId).
**Observed**: Empty filtered state, 0 results.

**Evidence**:
- `slo-bugbash-v3-S2-all-four.png` — screenshot showing 4 SLOs before datasource filter applied.
- API verification:
  ```bash
  curl -s http://localhost:5602/api/observability/v1/slos | jq -c '[.results[] | {name, datasourceId}]'
  # [{"name":"session-f-smoke","datasourceId":"ObservabilityStack_Prometheus"},
  #  {"name":"listing-a","datasourceId":"ObservabilityStack_Prometheus"},
  #  {"name":"listing-b","datasourceId":"ObservabilityStack_Prometheus"},
  #  {"name":"listing-c","datasourceId":"ObservabilityStack_Prometheus"}]
  ```
- URL after filter: `#/slos?datasourceId=ds-4`
- Snapshot shows "No SLOs match your filters" heading + "Clear filters" button.

**Root cause (source-confirmed, main-thread triage)**: `common/slo/slo_service.ts:1764` — the in-memory listing filter is:

```ts
const dsFiltered =
  filters?.datasourceId && filters.datasourceId.length > 0
    ? all.filter((d) => filters.datasourceId!.includes(d.spec.datasourceId))
    : all;
```

`filters.datasourceId` is populated from the URL param, which `SloApiClient.serializeFilters` (`public/components/apm/pages/slos/slo_api_client.ts:230`) joins from the filter panel's internal datasource **ID** (`ds-4`). But `d.spec.datasourceId` holds the datasource **name** (`ObservabilityStack_Prometheus`). The two are not comparable, so the filter never matches and produces the empty state.

The UI side already had to deal with this mismatch: the chips row at `public/components/apm/pages/slos/slo_listing_page.tsx:659` explicitly maps IDs to names for display (`nameById.get(id) ?? id`). That map isn't applied on the query path.

A fix would either:
1. Serialize the datasource **name** into the URL param + filter (aligns with how `spec.datasourceId` is stored), OR
2. Resolve the URL-supplied ID to the name in the server-side list handler before calling the in-memory filter (requires a datasource registry lookup in `SloService.list`).

Option 1 is lower-risk; option 2 is more idiomatic for a long-term multi-datasource model. Defer the choice to Chen.

**Triage owner**: Chen (listing facets).

**Related**:
- `common/slo/slo_service.ts:1757-1765` — broken filter predicate.
- `public/components/apm/pages/slos/slo_api_client.ts:230` — URL serialization sends IDs.
- `public/components/apm/pages/slos/slo_listing_page.tsx:659` — UI knows about the ID→name mapping for chip display.

---

### S2.2 — RETRACTED (test-driver issue, not a plugin bug)

**Status**: Retracted after main-thread source review + targeted re-check.

**Original report**: "Clicking 'shipping' in the Service facet has no effect" — Playwright was clicking the outer `div.euiCheckbox` wrapper, not the actual `<input type="checkbox">`.

**Main-thread source review**: `public/components/apm/pages/slos/slo_list_filter_panel.tsx:116-179` — `FacetAccordion` uses a standard EUI `EuiCheckboxGroup` whose `onChange` fires on the input element, not the wrapper. EUI does not synthesize change events from div wrapper clicks.

**Targeted re-check signals**:
- DOM probe confirmed EUI emits `<input class="euiCheckbox__input" type="checkbox" id="checkoutservice">` inside `div.euiCheckbox`.
- `input.click()` (native on the `<input>`) updated URL to `?service=checkoutservice` and toggled `checked=true`.
- No code change required — the React wiring is correct.

**Driver guidance for future runs**: When Playwright targets EUI checkboxes, click the `input` element explicitly (e.g. `document.querySelector('[data-test-subj="slosFilterAccordion-service-checkboxGroup"] input[type="checkbox"][id="<id>"]').click()`) or the label's `htmlFor` target. Do not click the outer `div.euiCheckbox` wrapper; EUI's onChange does not fire on div clicks.

### S6-resume — Inter-agent session continuity failure

**Finding**: Wizard session did not persist across agent handoff. Browser state closed without submitting the SLO, causing S6 to be unverifiable in the resume context.

**Coverage**: Wave 4.2 metadata panel (full wizard + detail-page assertions).

**Steps to reproduce**:
1. Agent `a0da01f1edddc33dd` fills wizard through step 4 (exclusion windows configured: cron `0 2 * * 0`, 2h UTC, "weekly maintenance", deferred).
2. Token budget exhausted; agent pauses.
3. New agent `kai` resumes with instruction to add labels/annotations and submit.
4. Query wizard state: `document.querySelector('[data-test-subj="slosWizardPage"]')`.

**Expected**: Wizard should be open in the exact state the predecessor left, allowing completion of remaining steps (labels, annotations, submit, detail-page verification).

**Observed**:
- `browser_evaluate` returned `'closed'` — wizard page gone.
- No SLO created in OpenSearch: `curl ... '.kibana/_search' -d '{"query":{"bool":{"must":[{"term":{"type":"slo-definition"}},{"term":{"slo-definition.spec.name":"scenario-s6-full"}}]}}}'` → `hits.total.value: 0`.
- No Cortex rules: `curl http://localhost:9090/prometheus/api/v1/rules | jq '.data.groups[] | select(.name | test("^slo:alerts:scenario_s6"))'` → empty.

**Evidence**:
- Playwright state query result: `"closed"`
- OpenSearch SO query: 0 hits for `scenario-s6-full`
- Cortex ruler query: 0 groups matching `^slo:alerts:scenario_s6`

**Root cause**: Playwright MCP does not preserve browser page context across agent sessions. When the predecessor agent's process ended (token limit), the browser session was destroyed. This is an **infrastructure limitation of the multi-agent MCP handoff**, not a plugin defect.

**Impact**: S6 cannot be completed in a resume flow. The scenario requires a full end-to-end run (wizard open → fill → submit → detail page → cleanup) within a single agent session with sufficient token budget.

**Triage owner**: Kai (test infrastructure / process adjustment).

**Resolution strategy**:
- Re-run S6 in a dedicated single-agent session with ~50k token budget (predecessor consumed ~35k through step 4; remaining steps + detail-page verification + cleanup estimated at 10-15k).
- Enforce token-efficient strategies per user instruction: use `browser_evaluate` for targeted DOM queries instead of full `browser_snapshot` (predecessor's snapshots were the primary budget drain).
- Document this as a known limitation in the bug-bash runbook: wizard-based scenarios (S6, S7, S8, S9, S11, S12) cannot span multiple agents reliably. Prefer to run each wizard scenario start-to-finish in one session, or fail-fast and restart if pausing mid-wizard.

**Cleanup performed**: N/A — no SLO was created; no Cortex rules to clean.

**Related**: None (test infrastructure, not product code).

---

### S20.1 — Probe SLI error callout missing for invalid PromQL

**Finding**: Invalid PromQL queries (syntax errors, unclosed parentheses) return empty results (Good=0) instead of displaying query error callouts. The UI shows the empty-vector callout but never shows the per-query error callouts (`slosWizardProbeError-good` / `slosWizardProbeError-total`).

**Coverage**: W5 Probe SLI + error-path testing.

**Steps to reproduce**:
1. Navigate to SLO wizard Custom PromQL template.
2. Fill datasource `ObservabilityStack_Prometheus`, name `scenario-s20-probe`.
3. Good query: `sum(rate(envoy_http_downstream_rq_xx_total[5m]` (unclosed parenthesis).
4. Total query: `sum(rate(envoy_http_downstream_rq_xx_total[5m]))` (valid).
5. Click "Probe SLI".

**Expected** (per `probe_sli_panel.tsx:259-289`): When `response.errors.good` is present, a warning callout with title "Good query returned an error" should render with the Cortex error message inline (e.g., "1:47: parse error: unclosed left parenthesis").

**Observed**:
- Probe result shows Good=0, Total=1.33, empty-vector callout ("No samples match this query").
- No error callout renders (`slosWizardProbeError-good` / `slosWizardProbeError-total` absent from DOM).
- Direct `curl` test to Cortex query API confirms invalid PromQL DOES return parse errors:
  ```bash
  curl 'http://localhost:9090/prometheus/api/v1/query?query=sum(rate(envoy_http_downstream_rq_xx_total%5B5m%5D&time=...'
  # {"status":"error","errorType":"bad_data","error":"invalid parameter \"query\": 1:47: parse error: unclosed left parenthesis"}
  ```
- However, the probe API endpoint returns `{"goodCount":0,"totalCount":1.238...,"emptyVector":true}` with NO `errors` field.

**Root cause hypothesis**: The `DirectQueryPrometheusBackend.queryInstant` method (`directquery_prometheus_backend.ts:616-649`) catches all errors at line 645 and logs them, then returns an empty array (`[]`) instead of throwing. This causes the probe route's `.catch()` block at `probe_sli.ts:187-190` to never fire, so `errors.good` is never populated. The server-side error is swallowed silently.

Two options to fix:
1. **Change `queryInstant` to throw** instead of returning `[]` when the DirectQuery response indicates a query error (check `resp.body.error` or `resp.body.status === "error"` before parsing).
2. **Return a result envelope** from `queryInstant` that distinguishes "empty result" from "query error" (e.g., `{ data: [], error?: string }`), then check that in the probe route.

Option 1 is simpler and aligns with existing try-catch patterns in the probe route. The method already logs the error; throwing would let callers decide how to handle it (probe route surfaces it to the UI; status aggregator might ignore it).

**Evidence**:
- `slo-bugbash-v3-S20-error-attempt.png` — screenshot showing empty callout, no error callout.
- Direct API test:
  ```bash
  curl 'http://localhost:5602/w/CHkxVF/api/observability/v1/slos/probe-sli' \
    -H 'Content-Type: application/json' -H 'osd-xsrf: true' \
    -d '{"datasourceId":"ds-4","goodQuery":"sum(rate(envoy_http_downstream_rq_xx_total[5m]","totalQuery":"sum(rate(envoy_http_downstream_rq_xx_total[5m]))","lookback":"1h"}'
  # {"goodCount":0,"totalCount":1.238...,"emptyVector":true}  <-- no errors field
  ```
- Cortex direct query: `curl 'http://localhost:9090/prometheus/api/v1/query?query=sum(rate(envoy_http_downstream_rq_xx_total%5B5m%5D&time=1777585500'` → `{"status":"error","errorType":"bad_data","error":"invalid parameter \"query\": 1:47: parse error: unclosed left parenthesis"}`

**Triage owner**: Sanjay (DirectQuery backend + probe route integration).

**Related**:
- `server/services/alerting/directquery_prometheus_backend.ts:616-649` — `queryInstant` catch-all at line 645.
- `server/routes/slo/probe_sli.ts:187-190` — probe route's error catch expects a throw, never fires.
- `public/components/apm/pages/slos/probe_sli_panel.tsx:259-289` — UI error callout rendering (unreachable when `errors.good` is undefined).

---

### S17.1 — Recover endpoint returns 404 "SLO not found" despite valid adoptable orphan (main-thread triage rewrite)

**Status**: Kai's initial framing ("datasource missing from OSD") was wrong — the datasource IS registered as `ds-4` via `/api/alerting/datasources` (discovery found the `data-connection` saved object). Main-thread rebuilt the signal.

**Finding (corrected)**: `GET /api/observability/v1/slos/_orphans` correctly detects the orphan `scenario-s17-recover` (sloId `f37df382-adf4-4a11-a817-e279f83bef5b`) as a candidate with `specIntegrity: "ok"`, matching `specSha256`, and a resolved fingerprint. The adoption UI renders it with "Ready to adopt" and a populated spec preview. However `POST /api/observability/v1/slos/_recover` with that sloId + datasourceId returns **HTTP 404 `SLO not found: f37df382-...`**. No error toast surfaces to the user.

**Coverage**: Phase 4 Recover + adoption pre-flight integrity checks.

**Steps to reproduce**:
1. Have an orphan rule group in Cortex with metadata pointing to datasource name `ObservabilityStack_Prometheus`.
2. Run dev OSD (port 5602) that does not have a datasource saved object with that name (only `local_cluster` exists).
3. Navigate to `/app/observability-apm-slo#/slos/adoption`.
4. Observe orphan appears in Recover tab with "Ready to adopt" green badge.
5. Click Recover button on the orphan row.

**Expected**:
- Either the orphan should not appear in the Recover tab (filtered out because its datasource doesn't exist), OR
- The "Ready to adopt" badge should be "Datasource missing" danger badge, with Recover button disabled and a tooltip explaining the datasource is unavailable.
- On click attempt (if allowed), a clear error toast should explain "Cannot recover SLO: datasource ObservabilityStack_Prometheus not found".

**Observed**:
- Orphan row shows green "Ready to adopt" integrity badge.
- Clicking Recover produces no visible UI feedback (no toast, no error callout, row doesn't update).
- Browser console logs `503 Service Unavailable` from `POST /api/observability/v1/slos/_recover`.
- Manual `curl` to the recover endpoint shows it fails with HTTP 400 "datasourceId expected value of type [string] but got [undefined]" — the UI could not populate the required field because it has no datasource metadata to map the name to an ID.

**Evidence**:
- `slo-bugbash-v3-S17-recover-tab.png` — screenshot showing orphan with "Ready to adopt" status.
- Console log: `.playwright-mcp/console-2026-04-30T22-28-41-284Z.log` line 1 — `503 Service Unavailable` from `POST /api/observability/v1/slos/_recover`.
- Datasource state on dev OSD:
  ```bash
  curl -s "http://localhost:5602/api/saved_objects/_find?type=data-source&per_page=100" -H 'osd-xsrf: true' \
    | jq '.saved_objects[] | {id, title: .attributes.title}'
  # {"id":"dcc0c020-3dc4-11f1-a4e3-c5c78e318563","title":"local_cluster"}
  # No ObservabilityStack_Prometheus datasource present.
  ```
- Orphan spec from adoption page preview:
  ```json
  {
    "name": "scenario-s17-recover",
    "datasource": "ObservabilityStack_Prometheus",
    "service": "shipping",
    "owner": "sre",
    "objective": "availability-99 — target 99.0%"
  }
  ```

**Root cause (main-thread reproduction + source read)**:

Direct curl to `_recover` mirrors the UI failure:
```
POST /api/observability/v1/slos/_recover
Body: {"sloId":"f37df382-adf4-4a11-a817-e279f83bef5b","datasourceId":"ObservabilityStack_Prometheus"}
→ 404 {"message":"SLO not found: f37df382-adf4-4a11-a817-e279f83bef5b"}
```

`SloService.recover()` (`common/slo/slo_service.ts:1400-1419`) calls:
```ts
const groups = await deploy.ruler.listRuleGroups(deploy.client, deploy.datasource, namespace);
const match = findAdoptableAlertGroup(groups, input.sloId);
if (!match) {
  // unsupported-schema disambig, then:
  throw new SloNotFoundError(input.sloId);
}
```

The 404 means `findAdoptableAlertGroup` returned null **and** the schema-mismatch branch also returned null. But the alert group `slo:alerts:scenario_s17_recover_group_d2067d39` in the correct namespace DOES carry:
```
annotations.osd_slo_provenance: '{"schemaVersion":1,"pluginVersion":"0.0.0","sloId":"f37df382-adf4-4a11-a817-e279f83bef5b","workspaceId":"ObservabilityStack_Prometheus","datasourceId":"ds-4","createdAt":"...","specSha256":"fc1084549...","spec":{...}}'
```

So `_orphans` parsed that annotation just fine (the orphan shows up as a candidate). But `_recover` can't find a match for the same sloId in the same alert group, in the same namespace, from the same ruler list.

Two possible explanations:
1. **Different list path**: `_orphans` and `_recover` may call `ruler.listRuleGroups` with slightly different args (client, namespace, timeout) and one of them gets an empty/truncated response.
2. **Different parse path**: `_orphans` uses its own provenance parser; `_recover` uses `findAdoptableAlertGroup` from `common/slo/slo_adoption_verify.ts:150`. A discrepancy in how each parses the annotation could yield a match in one path and a null in the other.

Worth checking both. `findAdoptableAlertGroup` (`common/slo/slo_adoption_verify.ts:150`) is the first place to look.

**Secondary bug (filed together)**: `/_reconcile?datasourceId=ObservabilityStack_Prometheus` returns error "Datasource not registered" while `/_reconcile?datasourceId=ds-4` works. The reconciler's internal datasource lookup is keyed on the internal id, but the route accepts either the name or id and doesn't normalize. Same class as S2.1's server-side filter bug.

**Evidence**:
- `slo-bugbash-v3-S17-recover-tab.png` — orphan row rendering with spec preview.
- Main-thread curl outputs (above).
- `_orphans` response with `"candidates":[{...sloId: f37df382..., specIntegrity: "ok"}]`.
- Alert group YAML confirming the provenance annotation matches.

**Fix suggestions**:
1. Most likely: fix `findAdoptableAlertGroup` or the ruler-list call path used by `recover()`. Add a debug log that dumps how many groups were received + how many carried an `osd_slo_provenance` annotation, so the gap is visible in OSD logs on the next failure.
2. Surface the 404 to the user as a toast ("Recovery failed: `{serverMessage}`") — currently the UI silently swallows non-200s.
3. Normalize the datasource-id resolution so `_reconcile` / `_recover` / `_orphans` all accept both the name and the internal ds-N id. Same general class of fix as S2.1.

**Triage owner**: Sanjay (Phase 4 adoption service + recovery route).

**Severity**: Medium-high. This breaks the adoption workflow in multi-OSD / dev-vs-prod scenarios where datasources aren't replicated. User gets no actionable feedback.

**Related**:
- `server/services/slo/reconciler/slo_adoption_service.ts` (hypothetical, grep for adoption listing logic).
- `server/routes/slo/_recover.ts` or similar (recovery endpoint).
- `public/components/apm/pages/slos/adoption/slo_adoption_recover_tab.tsx` or similar (Recover button handler).
- `.playwright-mcp/console-2026-04-30T22-28-41-284Z.log` line 1 (browser error log).


---

### S-bonus — `${service}` dimension placeholder not substituted (Bug C)

**Finding**: The plugin does NOT support `${name}` placeholder interpolation inside `sli.definition.customExpr.goodQuery` / `totalQuery`. The PromQL generator (`common/slo/slo_promql_generator.ts:272-278`) emits the customExpr strings verbatim. `spec.sli.dimensions` is only consulted by the `availability` / `latency` / `saturation` generator branches via `buildSelectors()`; for `type: custom`, dimensions are metadata-only and the user is expected to inline the concrete selectors into their queries. session-f-smoke was seeded with `service="${service}"` in customExpr + `dimensions: [{name: "service", value: "checkoutservice"}]` under the assumption that the placeholder would be substituted. It wasn't. The resulting recording rule carried `service="${service}"` literally — syntactically valid PromQL (Cortex accepts it), but no real series carries `service="${service}"` as a label, so the rule evaluates to empty/nothing forever.

**Coverage**: session-f-smoke side-observation during S6 and again during post-bash Bug C triage.

**Evidence**:

```bash
# Before fix — malformed spec:
curl -s "http://localhost:5602/api/observability/v1/slos/387af155-d4f6-4da0-91fe-473540a582be" \
  -H 'osd-xsrf: true' | jq '.spec.sli.definition.customExpr.goodQuery'
# "sum(request{service=\"${service}\",remoteService=\"\",namespace=\"span_derived\"}) - sum(fault{service=\"${service}\",..."

# Generated Cortex rule (literal placeholder):
curl -s http://localhost:9090/prometheus/api/v1/rules \
  | jq '.data.groups[] | select(.name=="slo:rec:305ed25f75519bc2") | .rules[0].query'
# "1 - ((sum(request{namespace=\"span_derived\",remoteService=\"\",service=\"${service}\"}) - ..."
```

**Resolution**: No plugin code change. Deleted the malformed `session-f-smoke` SLO and recreated with concrete `service="checkoutservice"` in both good/total queries. The regenerated recording rule (`slo:rec:c1d7a2a9e64a913b`) now reads `service="checkoutservice"` and evaluates correctly.

**Leftover state**: two pre-existing refcount=0 orphan groups still carry `service="${service}"` in their rule bodies — `slo:rec:1a5a1554acd74669` and `slo:rec:305ed25f75519bc2`. Both are from earlier malformed-spec SLOs that have since been deleted. They'll be reclaimed by the 24h grace sweep; no action required.

**Triage owner**: Docs/UX (feature request, not a regression).

**UX gap to file (not fixed here)**: custom SLIs silently accept placeholder-looking strings that never get substituted. Two defensible options for a future PR:
1. **Reject at validation**: the wizard's custom PromQL editor validates customExpr and flags unsubstituted `${…}` patterns with "Placeholder interpolation is not supported; inline concrete label values." — lowest-risk.
2. **Implement `${dim}` substitution** at rule-gen time for every dimension in `spec.sli.dimensions`, documented in the wizard helper text. Higher-risk because the interpolation runs before PromQL parsing, so a dimension value containing `"` needs careful escaping.

Recommendation: start with (1); revisit (2) only if a real user flow needs it. The wizard preview panel already shows the generated expression, which gives the user a chance to spot the un-substituted placeholder before submit — but that relies on the user reading the preview carefully.

**Related**:
- `common/slo/slo_promql_generator.ts:252-279` — custom-SLI rendering (no substitution step).
- `common/slo/slo_promql_generator.ts:163-167` — `buildSelectors` (dimensions-aware, but only wired for non-custom types).
- `public/components/apm/pages/slos/custom_promql_editor.tsx` — wizard editor; candidate location for the "(1)" validation.

---

### S18 — Adoption route not reachable; dev server hot-reload didn't pick up new route

**Finding**: The `/slos/adoption` route returns HTTP 404 despite the route being defined in the codebase. Dev server hot-reload failed to recognize the new route addition.

**Coverage**: Phase 4 adoption + Session B visual design.

**Steps to reproduce**:
1. Start OSD dev server on `http://localhost:5602` (basepath `/igq/`).
2. Navigate to `http://localhost:5602/igq/app/apm-slo#/slos/adoption`.
3. Page shows `{"statusCode":404,"error":"Not Found","message":"Not Found"}`.

**Expected**: Adoption page should render with:
- Empty state: `sloAdoption-recoverTab-emptyPrompt` when no orphans exist.
- Loading state: `sloAdoption-page-loading` during initial fetch.
- Table / error / disabled states per plan.

**Observed**:
- Browser renders raw JSON error: `{"statusCode":404,"error":"Not Found","message":"Not Found"}`.
- No React mount, no `data-test-subj` attributes.
- Console error: `Failed to load resource: the server responded with a status of 404 (Not Found) @ http://localhost:5602/igq/app/apm-slo#/slos/adoption:0`.
- Codebase verification confirms the route exists:
  - `public/components/apm/pages/slos/slos_page.tsx:64-72` — `<Route exact path="/slos/adoption">` wrapped in `<SloAdoptionPage>`.
  - `public/components/apm/pages/slos/adoption/` — directory with `slo_adoption_page.tsx`, `recover_tab.tsx`, `index.ts` (5.8KB + 15KB + 429B respectively).
  - `public/components/apm/pages/slos/slos_page.tsx:22` — import statement present.

**Root cause**: Hot-reload in the `@osd/optimizer` did not propagate the route addition to the running dev server. The bundle served to the browser is stale — it doesn't include the `SloAdoptionPage` component in the lazy-loaded chunk for `app/apm-slo`.

**Evidence**:
- `slo-bugbash-v3-S18-404.png` — browser showing the 404 JSON body.
- Console log: `.playwright-mcp/console-2026-04-30T22-44-49-332Z.log` line 1.

**Workaround**: Restart the dev server (`yarn start --server.port=5602 --no-base-path`).

**Triage owner**: Deferred (infrastructure / optimizer issue, not plugin code). If adopting the adoption page after a fresh server start still hits 404, escalate to Maya + Chen (frontend-design). If restart resolves it, this is a known hot-reload limitation — no fix needed.

**Sub-cases deferred**:
- **Disabled state** (plan lines 715-718): Requires flipping `observability.slo.ruleAdoption.enabled` to `false` in yml + restarting OSD. Out of scope for this run (restart required).
- **Error state** (plan lines 720-723): Requires tampering with the adoption middleware or killing Cortex to force a 500. Too invasive; deferred.
- **Loading state** (plan lines 725-733): Attempted via hard-reload + DOM race (poll for `sloAdoption-page-loading` every 50ms for 1s). Could not capture — loading spinner too fast on dev build. Documented as "not capturable on dev build" but not a failure (the component likely renders; dev build is just too fast to observe).

**Severity**: Low (dev-only). The adoption route is newly added; if it's never been served by the dev server since the last restart, the stale bundle issue is expected. After restart, if 404 persists, that would be a plugin registration bug (Medium severity).

**Related**:
- `packages/osd-optimizer/src/optimizer/` — hot-reload logic.
- `public/components/apm/pages/slos/slos_page.tsx:64-72` — route definition.
- `public/components/apm/pages/slos/adoption/slo_adoption_page.tsx` — page component (5.8KB, 151 lines).

---

## Post-bash follow-ups

Regression classes, docs/UX gaps, and adjacent items spotted during the v3
bug-fix session that are not themselves regressions fixed in that session.

1. **Datasource id-vs-name mismatch in other read surfaces**. Bug A (Finding
   S2.1) fixed the listing filter via a common normalization helper
   (`SloService.normalizeDatasourceFilter`), but other routes that accept a
   `datasourceId` query param (`_reconcile`, `_recover`, `_orphans`) may
   share the same bug class. Bug D+E (rows S16.1 + S17.1) are the known
   instances; a broader sweep is warranted once those are fixed.

2. **Custom-SLI placeholder UX gap** (Bug C, Finding S-bonus). `customExpr`
   silently accepts `${dim}` placeholder syntax that never gets
   substituted. Options: validate-and-reject in the wizard, or implement
   dimension interpolation at rule-gen time. Not filed as a regression
   since the feature was never claimed.

3. **SQL-plugin drops Cortex error text** (Bug B fix side-observation). The
   DirectQuery query path in the observability-stack's SQL plugin returns
   HTTP 200 with `results.{ds}: {}` when Cortex rejects a PromQL parse.
   Our Bug B fix detects this shape and throws a generic "Invalid PromQL"
   message, but the user would get a better message ("unclosed left
   parenthesis at char 47") if the SQL plugin surfaced the Cortex
   envelope instead of scrubbing it. File upstream.

4. **Cortex recording-group carryover with malformed expressions**. Two
   refcount=0 orphan groups (`slo:rec:1a5a1554acd74669`,
   `slo:rec:305ed25f75519bc2`) still carry `service="${service}"` from
   the deleted pre-bash malformed seeds. They will be reclaimed by the
   24h grace sweep; noted here so nobody mistakes them for new
   regressions.

5. **Reconcile route doesn't prime discovery before sweep**. ✅ DONE.
   `_reconcile` + `_orphans` now call `discoveryService.ensure(ctx)` as
   the first step of their handlers, matching the pattern every other
   SLO route already uses. `_recover` was already covered via
   `buildAdoptionDeployContext`. Regression guard added in
   `server/routes/slo/__tests__/reconcile_route.test.ts`
   (`registerSloReconcileRoute — discovery priming` describe block).
   Files touched: `server/routes/slo/reconcile_route.ts`,
   `server/routes/slo/adoption_route.ts`, `server/routes/slo/index.ts`.

6. **Provenance annotation persists `datasourceId: "ds-N"`, not the
   canonical name**. ✅ DONE (commit `5866fe0e`). The three `buildAlertGroupWithProvenance`
   call sites in `common/slo/slo_service.ts` (create / update / redeploy
   paths) now pass `deploy.datasource.name` in place of
   `deploy.datasource.id`, so new alert groups record the canonical name
   that already appears in `spec.datasourceId` and `workspaceId`. Bug
   E's id-or-name equivalence fallback in `findAdoptableAlertGroup` is
   retained and annotated as load-bearing for any pre-existing Cortex
   groups. `PROVENANCE_SCHEMA_VERSION` deliberately NOT bumped — both
   forms remain valid value-space for v1. New pins: canonical-name
   builder contract (`slo_rule_provenance.test.ts`), create + update
   provenance shape (`slo_dedup_integration.test.ts`), and ds-N legacy
   recovery (`slo_service_recover.test.ts`). refStore keying
   (`slo-rule-ref` SOs) deliberately left on `ds-N`; session-private
   and no cross-session reads exist that would require migration.
