# SLO/SLI live-data test plan — observability-stack

This plan validates every SLO/SLI feature in this plugin against the running
`observability-stack` using only real Cortex data. It is organized so every
step has a concrete pass/fail signal, and it documents the stack
configuration gaps that must be closed first — otherwise flipping a flagd
flag doesn't move any metric the plugin can chart.

The local dev OSD is running at `http://localhost:5601` (yarn start on
port 5601). Prometheus/Cortex lives at
`http://localhost:9090/prometheus`. Flagd UI at `http://localhost:4000`.

---

## How to run this plan in a clean Claude session

Paste this prompt at the start of a fresh session, with the working
directory set to this plugin's root:

> You are running a bug bash of the SLO/SLI plugin against the live
> observability-stack. Your single source of truth is
> `SLO_LIVE_TEST_PLAN.md` — read it end-to-end before you start, then
> execute scenarios in the order specified in "Part 2 — Run order".
>
> Drive every scenario through the `slo-live-tester` subagent (it is
> pre-configured at `~/.claude/agents/slo-live-tester.md`). That agent
> owns: browser automation via Playwright MCP, direct Cortex `curl`
> verification, and appending results rows to
> `SLO_BUG_BASH_RESULTS.md`. The subagent does NOT fix bugs — on any
> FAIL it files a Findings entry and reports back.
>
> When the subagent reports a FAIL, triage the failure on the main
> thread using the "Triage owner" from the scenario header. Spawn a
> focused fix agent only after you've read the Findings entry and
> confirmed the reproducer. Don't batch fixes across scenarios; small
> PRs per bug are the right shape.
>
> Prerequisites to verify before scenario 1:
>   1. `yarn start` is running on port 5601 (ask the user if unsure).
>   2. observability-stack is up: `docker compose -f
>      /Users/ashisagr/Documents/workspace/observability-stack/docker-compose.yml
>      ps` shows prometheus, data-prepper, otel-collector, flagd,
>      load-generator, frontend-proxy all healthy.
>   3. Cortex has live traffic: `curl -s
>      'http://localhost:9090/prometheus/api/v1/query?query=up' | jq
>      '.data.result | length'` returns > 0, OR
>      `envoy_http_downstream_rq_xx_total` has non-zero recent rate.
>   4. Datasource `ObservabilityStack_Prometheus` exists with both
>      `prometheus.uri` and `prometheus.ruler.uri` set: `curl -sk -u
>      admin:'My_password_123!@#'
>      'https://localhost:9200/_plugins/_query/_datasources' | jq`.
>
> If any prereq fails, STOP and tell the user — don't attempt to fix
> the stack yourself. Stack fixes are the user's call.
>
> When all 12 scenarios are done, summarize the results table from
> `SLO_BUG_BASH_RESULTS.md` in under 300 words: counts + the title of
> every FAIL + a recommendation on which triage owners to engage
> first.

---

## Part 0 — Stack configuration gaps (APPLIED)

> **Status: DONE.** Fixes G2 / G3 / G4 / G5 have all been applied to
> `observability-stack` and verified against live Cortex. G1 was dropped
> after probing: no otel-demo service exposes a `/metrics` endpoint, so
> scraping would be a no-op; data-prepper's span-derived RED metrics
> cover the same surface. See the "Applied fixes" subsection below for
> the diff.

Baseline state (before fixes) was:

```
service_name label values in Cortex: ["flagd"]   # only flagd was named
job label values seen with HTTP counters: opentelemetry-demo/shipping,
  opentelemetry-demo/flagd, weather-agent, events-agent, travel-planner
gRPC/RPC counters in Cortex:   none (zero rpc_server_duration* series)
frontend (Node.js): emits only nodejs_* runtime metrics, no http_server_*
data-prepper RED metrics:      all rejected by Cortex (series-limit 400s)
```

After the fixes land:

```
service_name label values in Cortex: 17 services (ad, cart, checkout,
  currency, envoy-frontend-proxy, events-agent, flagd, fraud-detection,
  frontend, kafka, load-generator, payment, product-reviews,
  recommendation, shipping, travel-planner, weather-agent)
envoy metrics: envoy_http_downstream_rq_xx_total (by response_code_class
  1..5 and http_conn_manager_prefix=ingress_http/admin),
  envoy_cluster_upstream_rq_xx_total (per upstream service)
data-prepper RED metrics: latency_seconds_{count,sum,bucket} labeled by
  {service, operation, remoteService, remoteOperation, environment,
  namespace="span_derived"} for 17 services
```

The flagd flags ship failure on **gRPC** paths (payment, cart, ad,
product-catalog, recommendation) and on the **frontend** Node.js process.
None of those services export HTTP or gRPC duration counters to Cortex
today, so flipping a flag produces no error signal the plugin can chart.

### Gaps → fixes (in order of impact)

**G1. gRPC server counters missing.** The OTel collector pipeline accepts
OTLP and writes to Cortex, but no otel-demo service in Cortex has
`rpc_server_duration*` or equivalent. Root cause options:

- The services are emitting traces + maybe metrics, but the collector's
  `metrics` pipeline is dropping gRPC due to no translation for
  `rpc.server.*` attributes, OR
- The language instrumentations aren't exporting RPC metrics (they
  export traces only).

**Fix**: add the OTel Demo's Prometheus receiver-based collector scrape OR
patch each service's OTel SDK to enable the `rpc-metrics` instrumentation.
The cleanest change is to add a `prometheus` receiver to the collector
that scrapes the demo's embedded `/metrics` endpoints and forwards them
into the same `metrics` pipeline.

**File**: `docker-compose/otel-collector/config.yaml` — add:

```yaml
receivers:
  prometheus/otel-demo:
    config:
      scrape_configs:
        - job_name: otel-demo-scrape
          scrape_interval: 15s
          static_configs:
            - targets:
                - checkout:5050
                - payment:50051
                - ad:9555
                - cart:7070
                - product-catalog:3550
                - recommendation:9001
                - email:6060
                - currency:7001
                - shipping:50050
                - quote:8080
                - frontend:8080
# …
service:
  pipelines:
    metrics:
      receivers: [otlp, prometheus/otel-demo]   # <-- add the new receiver
```

If those services don't expose `/metrics` (many in the otel-demo only
expose OTLP), the alternative is to deploy the demo's **`ngrinder`-style
loadgen + gRPC sidecar** that the upstream [opentelemetry-demo
Helm chart](https://github.com/open-telemetry/opentelemetry-demo) uses.

**G2. frontend emits no HTTP server counters.** The Node.js frontend's
OTel SDK ships traces for HTTP but not metrics. Fix: in
`docker-compose/opentelemetry-demo/src/frontend/Dockerfile` environment,
set `OTEL_METRICS_EXPORTER=otlp` AND add
`@opentelemetry/instrumentation-http` with `metricsEnabled: true`. This
produces `http_server_duration_*` on the frontend job. **(If you don't
own the frontend image, skip G2 and rely on envoy proxy metrics from the
frontend-proxy container — see G3.)**

**G3. frontend-proxy (Envoy) metrics not exposed to Cortex.** Envoy's
`/stats/prometheus` endpoint is reachable but no scrape target points at
it. Fix: add Envoy to the `prometheus/otel-demo` scrape job above, path
`/stats/prometheus`. Envoy emits `envoy_http_downstream_rq_xx` counters
keyed by status class — this is the **single most-useful live HTTP
counter for SLOs** because it covers the whole demo's customer-facing
traffic and reacts to any flag flip that changes HTTP status codes (e.g.
cart/payment failure surfaces as a `5xx` on the frontend-proxy).

**G4. Service naming inconsistency.** `service_name` is only populated
for flagd; everyone else uses `job="opentelemetry-demo/<svc>"`. The
SLO wizard's "Service" field is free-form, so this works, but operators
who filter the listing by service will expect `service_name`. The OTel
collector's `resource/service_name_to_service_name` processor promotes
`service.name` → `service_name`. Fix: confirm the collector's
`resourcedetection` processor is applied to the metrics pipeline (it is
— grep `resourcedetection` in `config.yaml:105`). If `service_name` is
still missing, it's because `prometheusremotewrite` collapses the
resource attribute under `job`. Add `target_info` enrichment or enable
`resource_to_telemetry_conversion: true` on the exporter:

```yaml
exporters:
  prometheusremotewrite/cortex:
    endpoint: "http://prometheus:9090/api/v1/push"
    resource_to_telemetry_conversion:
      enabled: true    # <-- promotes service.name -> service_name, service.version -> service_version, etc.
```

After this change the wizard's pre-filled `service` dimension works
uniformly across the demo.

### Applied fixes (diff summary)

All of these are now on disk under `observability-stack/` and will
reload on `docker compose up -d`.

**`.env`** — new globals so OTel SDKs actually export metrics:
```diff
+ OTEL_METRICS_EXPORTER=otlp
+ OTEL_LOGS_EXPORTER=otlp
```

**`docker-compose.otel-demo.yml`** — all 17 services that set
`OTEL_EXPORTER_OTLP_ENDPOINT` also pass through the new exporters:
```diff
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT
+     - OTEL_METRICS_EXPORTER
+     - OTEL_LOGS_EXPORTER
      - OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
```

**`docker-compose/otel-collector/config.yaml`** — adds an envoy scrape
(G3) and promotes resource attrs (G4):
```diff
  receivers:
    otlp: { … }
+   prometheus/envoy:
+     config:
+       scrape_configs:
+         - job_name: envoy-frontend-proxy
+           metrics_path: /stats/prometheus
+           static_configs: [{ targets: ["frontend-proxy:10000"] }]
+           relabel_configs:
+             - target_label: service.name
+               replacement: frontend-proxy
  exporters:
    prometheusremotewrite/cortex:
      endpoint: "http://prometheus:9090/api/v1/push"
      tls: { insecure: true }
+     resource_to_telemetry_conversion:
+       enabled: true
  service:
    pipelines:
      metrics:
-       receivers: [otlp]
+       receivers: [otlp, prometheus/envoy]
```

**`docker-compose/data-prepper/pipelines.template.yaml`** — splits the
service-map pipeline so we can strip `randomKey` + `telemetry_sdk_language`
from the prometheus branch only (G5):
```diff
  service-map-pipeline:
    sink:
      - opensearch: { … service map … }
-     - prometheus:
-         url: "http://prometheus:9090/api/v1/push"
-         routes: [service_processed_metrics]
+     - pipeline:
+         name: "service-metrics-cortex-pipeline"
+         routes: [service_processed_metrics]
+
+ service-metrics-cortex-pipeline:
+   source: { pipeline: { name: "service-map-pipeline" } }
+   processor:
+     - delete_entries:
+         with_keys:
+           - "/attributes/randomKey"
+           - "/attributes/telemetry_sdk_language"
+           - "randomKey"
+           - "telemetry_sdk_language"
+   sink:
+     - prometheus:
+         url: "http://prometheus:9090/api/v1/push"
```

**`docker-compose/cortex/cortex.yaml`** — enables `shard_by_all_labels`
(required for per-user/global limits to apply) and raises ceilings:
```diff
  distributor:
+   shard_by_all_labels: true
    ring: { … }

+ limits:
+   max_global_series_per_metric: 500000
+   max_global_series_per_user: 5000000
+   ingestion_rate: 100000
+   ingestion_burst_size: 200000
```

**Verified live**: flipping `paymentFailure=75%` via flagd UI now drives
`envoy_cluster_upstream_rq_xx_total{envoy_cluster_name="frontend",
envoy_response_code_class="5"}` from 0 to ~0.04 req/s within 3 minutes.
This is the metric the test plan's S3 / S4 / S5 scenarios depend on.

### Known residual issue (not blocking)

Data-prepper's prometheus sink occasionally emits duplicate samples for
the same `(metric, labels, timestamp)` tuple when its flush window
overlaps the OTel service-map aggregator's; Cortex rejects those with
`duplicate sample for timestamp`. Harmless for SLO charting (we still
get enough points to compute ratios) but surfaces in data-prepper logs.
Fix would require either upstream data-prepper change or adding an
aggregation processor. Left alone for now.

---

## Part 1 — Test-plan scenarios (assumes Part 0 fixes applied)

Each scenario is self-contained: creates its SLO(s) via the UI, exercises
the live feature, asserts a measurable Cortex signal, then cleans up.

Do **not** mock anything. If a step requires a workaround, call it out
explicitly in the "Notes" field.

### Scenario matrix — one row per W1/W2/W3/W4 capability

| # | Capability (wave ref)              | Flagd flip            | Expected observable signal                                 |
|---|------------------------------------|-----------------------|------------------------------------------------------------|
| 1 | SLO create → ruler dual-write (W1.5)| —                     | 13 recording/alerting rules appear in Cortex ruler         |
| 2 | SLO list + filters (W3.2)           | —                     | Listing filters by state/service/team via URL round-trip   |
| 3 | SLO live status (W3.1)              | `paymentFailure=50%`  | Listing row transitions `ok → warning → breached`          |
| 4 | Error-budget chart (W4.1)           | `paymentFailure=75%`  | Budget-remaining chart trends down + warning line crossed  |
| 5 | Burn-rate chart (W4.1)              | `paymentFailure=75%`  | Page·Quick tier line crosses `14x` threshold               |
| 6 | Metadata panel (W4.2)               | —                     | Labels, burn-rate tiers, exclusion windows render          |
| 7 | Multi-objective (W2.1)              | `imageSlowLoad=5sec`  | Two objective rule sets deployed; wizard preview matches   |
| 8 | Custom PromQL (W2.2)                | `kafkaQueueProblems`  | Raw-mode error-ratio against kafka consumer lag metric     |
| 9 | Approximation warning (W2.4)        | —                     | `window=14d` surfaces the 3d-approximation warning         |
| 10| Advanced editors (W2.5)             | —                     | MWMBR / budget-warning / alarm toggles round-trip          |
| 11| Exclusion windows (W2.6)            | —                     | Cron-scheduled exclusion window persists + shows deferred  |
| 12| Validator guardrails (W1.3)         | —                     | UUID label-value + >4KiB annotation rejections             |

---

### S1 — Ruler dual-write + rule provisioning (W1.5)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Sanjay (ruler client, server routes)

**Goal**: confirm a new SLO writes 13 rules to Cortex and they show up
in `GET /api/v1/rules`.

1. Open `http://localhost:5601/app/observability-apm-slo#/slos/create`.
2. Template = HTTP Availability. Datasource = `ObservabilityStack_Prometheus`.
   Metric = `envoy_http_downstream_rq_xx_total` (Part 0 G3). Name =
   `scenario-s1-availability`. Target = 99%. Window = 28d.
3. Click Create.
4. Assert: page redirects to `#/slos/<uuid>`, a green toast appears
   ("SLO created — … is now provisioned"), and the detail page shows
   "13 Rules provisioned".
5. **Live verification**:
   ```bash
   curl -s http://localhost:9090/api/v1/rules | \
     jq '.data.groups[] | select(.name|contains("scenario_s1")) | .rules | length'
   ```
   → must return `13`.
6. **Cleanup**: Delete SLO, confirm the rule-group disappears from the
   same `curl`.

**Pass when**: UI toast + `curl /api/v1/rules` agree on 13 rules, delete
tears them down.

**Notes**: If Cortex rejects the rule group with a 404 on
`/api/v1/rules/<ns>`, check datasource has `prometheus.ruler.uri` set
(plugin CLAUDE.md, "SLO ruler dual-write against Cortex" section).

---

### S2 — Listing + filter round-trip (W3.2)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (frontend listing + URL sync)

**Goal**: confirm listing page filters work against live multi-SLO state.

1. Create three SLOs via the wizard:
   - `listing-a` service=`shipping`, team=`sre`, tier=`tier-1`
   - `listing-b` service=`shipping`, team=`platform`, tier=`tier-2`
   - `listing-c` service=`weather-agent`, team=`sre`, shadow mode
2. Open listing.
3. Click the **Service** filter button → select `shipping` → assert the
   URL gains `?service=shipping` and rows collapse to 2.
4. Add **Team** = `platform` → URL adds `&team=platform` → rows collapse
   to 1 (`listing-b`).
5. Click **Clear filters** chip → URL query params gone, rows return to 3.
6. Reload with a pasted URL: `…#/slos?state=ok&mode=shadow` → only
   `listing-c` visible.
7. **Live verification**: the row for `listing-c` shows a `shadow` badge
   (set via wizard's Shadow-mode checkbox, which is already live data).

**Pass when**: every facet filter updates both table and URL; URL
hydration reproduces the view on reload.

---

### S3 — Live status state transitions (W3.1)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Sanjay (status aggregator) + Jay (state semantics)

**Goal**: prove `SloLiveStatus.state` is computed from live Cortex data,
not cached.

Prerequisite: Part 0 G3 (envoy metrics) is in place — verified.

1. Create `scenario-s3-payment-availability` — custom PromQL mode:
   ```promql
   # Good events: 2xx responses on the ingress HTTP listener
   sum(rate(envoy_http_downstream_rq_xx_total{envoy_http_conn_manager_prefix="ingress_http", envoy_response_code_class="2"}[5m]))
   # Total events: sum of all response classes on the same listener
   sum(rate(envoy_http_downstream_rq_xx_total{envoy_http_conn_manager_prefix="ingress_http"}[5m]))
   ```
   (The upstream-cluster variant `envoy_cluster_upstream_rq_xx_total`
   reacts faster to `paymentFailure` flips since envoy sees the 5xx on
   the upstream connection before the frontend node app translates it
   for the downstream response. Use it if the ingress version is too
   slow to transition in the live demo's short feedback window.)

   Target 99.9%, 28d window, default tiers.
2. Load generator is already hitting frontend-proxy (default behavior of
   the stack's `load-generator` container). Wait ~3 minutes for the
   5m-rate recording rule to populate.
3. Listing row state → **ok** (green).
4. **Flip `paymentFailure=50%` in flagd UI** (http://localhost:4000).
5. Wait 3–5 minutes. Envoy emits 500s when payment gRPC fails ("internal
   server error" from checkout upstream).
6. Listing row transitions to **warning**, then **breached** as more
   budget is consumed.
7. Flip `paymentFailure=off` → wait 5m → state returns to **ok** (once
   the rolling window heals).

**Pass when**: state transitions are observable in the listing without
reloading the page (the listing polls at 30s intervals).

**Live verification** (direct Cortex):
```bash
curl -s -G http://localhost:9090/prometheus/api/v1/query \
  --data-urlencode 'query=sum(rate(envoy_cluster_upstream_rq_xx_total{envoy_cluster_name="frontend", envoy_response_code_class="5"}[1m]))'
```
After `paymentFailure=75%`, expect ≥0.04 req/s. Before, expect 0.
Values should match what the plugin displays (tolerance: 1 scrape
interval).

**Notes**: do NOT use the "Suggest SLOs" path here — W3.1 is about the
aggregator. If flagd hot-reload doesn't pick up your flip after ~30s,
`docker compose restart flagd` (per plugin CLAUDE.md).

---

### S4 — Error-budget-remaining chart live burn (W4.1)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (chart component); review by Jay (SRE-workbook conventions)

Continues from S3. The goal is to **see the chart move**, not just the
state pill.

1. With `paymentFailure=75%` active, open `scenario-s3-*` detail page.
2. Observe the "Error budget remaining" chart. Within 5m of the flag
   flip, the green area should visibly slope downward on the right edge.
3. The warning threshold line (`warning @ 50%`) should be crossed after
   ~10–20 minutes of 75% payment failure at steady loadgen RPS.
4. Flip to `paymentFailure=100%`. Budget remaining should hit 0 within
   minutes; chart fill flips to **danger red** and an **"Budget
   exhausted"** banner appears below the chart (W4.1 danger-state path).

**Pass when**: (a) line slopes down with the flag on, (b) warning line
is crossed on screen, (c) at 100% failure, the chart fill is red and the
exhausted banner renders. **Assert with `curl` in parallel**:

```bash
curl -s -G http://localhost:9090/prometheus/api/v1/query_range \
  --data-urlencode 'query=clamp_min((0.001 - (1 - (sum(rate(envoy_http_downstream_rq_xx{envoy_response_code_class!="5"}[28d])) / sum(rate(envoy_http_downstream_rq_completed[28d]))))) / 0.001, -0.5)' \
  --data-urlencode "start=$(date -v-30M +%s)" --data-urlencode "end=$(date +%s)" \
  --data-urlencode 'step=60s' | jq '.data.result[0].values[-5:]'
```

Values at the tail should be `<1.0` and decreasing, then `<=0` once the
budget is exhausted.

**Cleanup**: flip `paymentFailure=off` before the next scenario so
other SLOs don't inherit the burn.

---

### S5 — Burn-rate-per-tier chart with live alerting-grade burn (W4.1)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (chart component); review by Jay (burn-rate math)

Runs alongside S4.

1. With `paymentFailure=75%`, the short-window (5m) error ratio is
   `~0.75`. Divided by the error budget (`0.001`) → burn rate `~750x`.
   Every tier's threshold (14x / 6x / 3x / 1x) is blown through.
2. On the detail page's "Burn rate by tier" chart, all four tier lines
   should climb well past their dashed threshold lines within 5m.
3. The burn-rate alerts panel above the chart should show all tiers as
   **firing** (red `EuiHealth`).
4. Alertmanager should show the alerts as firing at
   `http://localhost:9093/#/alerts`.

**Pass when**: all 4 lines above threshold; 4 `firing` pills in the
matrix; Alertmanager shows them.

**Assertion**:
```bash
curl -s -G http://localhost:9090/prometheus/api/v1/query \
  --data-urlencode 'query=sum(rate(envoy_http_downstream_rq_xx{envoy_response_code_class="5"}[5m])) / sum(rate(envoy_http_downstream_rq_completed[5m])) / 0.001'
```
Should return a value >> 14 while the flag is active.

---

### S6 — Metadata panel rendering (W4.2)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (metadata panel component)

**Goal**: every field in `SloSpec` renders on the detail page.

1. Create `scenario-s6-full` with:
   - Labels: `team=sre`, `env=dev`, `compliance=pci`
   - Annotations: `runbook=https://example.com/runbook`
   - Budget-warning thresholds: warning @ 50%, critical @ 20%
   - MWMBR tiers: default 4-tier set
   - Alarms: enable `sliHealth`, `budgetWarning`, `noData` (forDuration=15m)
   - Exclusion window: cron `0 2 * * 0` / duration `2h` / tz UTC /
     reason "weekly maintenance"
2. Open detail page.
3. Verify each section:
   - Labels table has 3 rows with `slo_label_<key>` badges on each
   - Annotations table has 1 row (runbook)
   - Burn-rate tiers table has 4 rows with severity dots
   - Budget-warning thresholds table has 2 rows
   - Advanced accordion starts **collapsed** (aria-expanded=false)
   - Expand → supplemental-alarm badges: `Budget warning ✓`,
     `SLI health ✓`, `No data ✓ · for 15m`, `Attainment breach ✗`,
     `Resolved ✗`
   - Exclusion windows table has 1 row, `deferred` badge
   - Provisioning block: rule group + namespace + 13 rule names

**Pass when**: every asserted cell matches the input from step 1 byte-for-byte.

---

### S7 — Multi-objective SLO (W2.1)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (wizard ObjectivesSection) + Sanjay (rule generator doubling)

1. Create `scenario-s7-multi-obj` with objectives:
   - `availability-99` target 99%
   - `availability-999` target 99.9%
2. Preview shows 13 + 13 = 26 rules.
3. After Create, Cortex ruler returns 26 rules:
   ```bash
   curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[] | select(.name|contains("scenario_s7")) | .rules | length'
   ```
4. On the detail page, the "Objective" selector surfaces (only shown
   when >1 objective); switching changes the budget/burn-rate panels.

**Pass when**: 26 rules in Cortex; objective selector toggles the
charts' computed `target` / `errorBudget`.

---

### S8 — Custom PromQL (W2.2)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (CustomPromqlEditor); review by Jay (PromQL semantics)

1. Create `scenario-s8-custom` — Custom PromQL template, raw mode:
   ```promql
   # errorRatioQuery:
   sum(rate(kafka_consumer_records_lag_sum[5m])) / sum(rate(kafka_consumer_records_consumed_total[5m]))
   ```
2. Flip `kafkaQueueProblems=on`. Kafka consumer lag spikes; ratio moves.
3. Open detail page → budget-remaining chart charts the user's custom
   expression, not a generated one.

**Pass when**: the rule preview YAML contains the custom expression
verbatim; the detail chart reacts to the flag flip.

**Notes**: if the kafka metric path doesn't exist in Cortex, substitute
another live metric (e.g. `envoy_cluster_upstream_rq_retry`). The point
is the Custom PromQL flows end-to-end, not the specific kafka metric.

---

### S9 — Window approximation warning (W2.4)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Sanjay (validator warning emission)

1. In the wizard, pick `window = 14 days`.
2. Assert the yellow "Window approximation" callout appears above the
   window field (this is the validator's `warnings` output).
3. Complete the SLO; confirm rules carry
   `slo_window_approximated="true"` label:
   ```bash
   curl -s http://localhost:9090/api/v1/rules | \
     jq '.data.groups[].rules[].labels.slo_window_approximated' | sort -u
   ```
4. Delete.

**Pass when**: UI callout shows + the rule labels carry the flag.

---

### S10 — Advanced editors round-trip (W2.5)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (advanced editor components); consult Maya on layout regressions

1. Open wizard → Expand **Advanced** accordion.
2. Edit one tier: `Page·Quick` → change multiplier from 14 → 20.
3. Edit budget-warning thresholds: add a 3rd entry `severity=info
   threshold=0.75`.
4. Toggle `sliHealth.enabled` ON.
5. Save.
6. Re-open the SLO detail page.
7. Metadata panel shows:
   - Burn-rate tiers table: `Page·Quick` row shows `20.0x` multiplier
   - Budget-warning table has 3 rows
   - Advanced → alarms: `SLI health` badge is green `✓`
8. Confirm Cortex rule for the 20x tier:
   ```bash
   curl -s http://localhost:9090/api/v1/rules | \
     jq '.data.groups[].rules[] | select(.alert|test("burn_rate_page_quick")) | .expr' | head
   ```
   Should contain `> 20 *` not `> 14 *`.

**Pass when**: every advanced field survives Create → detail round-trip
AND rule generation honors the edits.

---

### S11 — Exclusion windows persistence (W2.6)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Chen (exclusion-window editor + saved-object round-trip)

1. Create SLO with two exclusion windows:
   - Cron: `0 2 * * 0`, duration `2h`, timezone `UTC`, reason
     "maintenance"
   - One-off: start `2026-05-01T00:00:00Z`, end `2026-05-01T02:00:00Z`
2. Detail page → Advanced → Exclusion windows table shows both rows,
   each with `deferred` badge.
3. Restart OSD (`docker restart opensearch-dashboards` if using
   containerized OSD; for local `yarn start` just refresh the page).
4. Re-open the SLO — both exclusion windows are still there. Confirms
   SavedObjects persistence.

**Pass when**: both windows persist across refresh/restart.

---

### S12 — Validator guardrails (W1.3)

**Tester agent**: `slo-live-tester`
**Triage owner if FAIL**: Sanjay (validators)

1. Wizard: add a label `env=550e8400-e29b-41d4-a716-446655440000` (UUID).
   Click Create → assert an **error** callout: "label values must not be
   UUID-shaped".
2. Wizard: add an annotation with value = 5 KiB of text. Assert error:
   "annotations exceed 4 KiB cap".
3. Wizard: target = 99.999999%. The form **rejects** the value with an
   inline validator error `"Target must be between 0.5 and 0.99999"`
   rendered on the Target (%) `EuiFormRow`. Create is blocked; no SLO
   is persisted. (5-nine hard cap is the intended guardrail against
   6-nine misconfigurations — see Finding #S12c.)

**Pass when**: UI rejections happen before the network call; the
Target (%) inline error surfaces for the >5-nine case.

---

## Part 2 — Run order + cleanup

Run scenarios **in the order S12 → S1 → S2 → S6 → S7 → S10 → S11 → S9
→ S3 → S4 → S5 → S8**. This front-loads the scenarios that DON'T burn
the budget (so create/list/metadata start from a clean state), then
runs the burn scenarios (S3/S4/S5) as one live sequence against a single
flag flip, then winds down with S8 (Custom PromQL).

**Between scenarios**:
- Flip any flagd flag back to `off` via http://localhost:4000.
- Delete any SLO created in the scenario (UI Delete button).
- Verify cleanup with:
  ```bash
  curl -s http://localhost:9090/api/v1/rules | \
    jq '.data.groups[].name' | grep scenario_
  ```
  Should return nothing.

**Overall cleanup**:
- All scenario SLOs deleted.
- All flagd flags reset to `off`.
- Alertmanager has no active alerts:
  `curl -s http://localhost:9093/api/v2/alerts | jq length` → `0`.

---

## Part 3 — Pass/fail summary template

Fill one row per scenario:

| # | Scenario         | Result | Live signal observed                   | Notes                 |
|---|------------------|--------|----------------------------------------|-----------------------|
| 1 | Ruler dual-write | PASS/FAIL | rule_count=13                       |                       |
| 2 | Listing filters  | PASS/FAIL | 3 URL round-trips                   |                       |
| 3 | Status transition| PASS/FAIL | ok→warning→breached in 15m          |                       |
| 4 | Budget chart     | PASS/FAIL | warning line crossed at T+15m       |                       |
| 5 | Burn-rate chart  | PASS/FAIL | all 4 tiers firing                  |                       |
| 6 | Metadata panel   | PASS/FAIL | 8 sections render                   |                       |
| 7 | Multi-objective  | PASS/FAIL | 26 rules; selector toggles charts   |                       |
| 8 | Custom PromQL    | PASS/FAIL | Raw expr in rule YAML               |                       |
| 9 | Approx warning   | PASS/FAIL | callout + rule label both present   |                       |
| 10| Advanced editors | PASS/FAIL | 20x rule expression in Cortex       |                       |
| 11| Exclusions       | PASS/FAIL | 2 windows persist                   |                       |
| 12| Validators       | PASS/FAIL | 3 rejections (incl. >5-nine target) |                       |

Anything marked FAIL must name the hack/workaround that would make it
pass — and that hack is a bug to file, not the test's fallback.
