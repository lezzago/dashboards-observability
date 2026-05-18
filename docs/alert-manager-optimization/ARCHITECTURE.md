# Alert Manager — UI data-fetching architecture

This document describes how the Alert Manager UI in
`plugins/dashboards-observability` fetches data from its two backends
(OpenSearch Alerting and Prometheus-via-DirectQuery), and how that
architecture changed across a five-commit optimization series. It is
intended for an engineer who did not follow the optimization work and
needs a working mental model of the system as it stands today.

References use `path:line` format and are verified against:

- **OLD** = `origin/main` (commit `0f223f54`).
- **NEW** = `alert-manager-phase-5` (commit `110bd5e0`), which is what
  ships when this doc lands.

The five optimization commits are:

| Commit | Branch | Theme |
|---|---|---|
| `75aca55a` | phase-1 | Stop the bleeding — kill per-flyout O(N) scans + the unbounded Prom matrix query |
| `c64fca4c` | phase-2 | Move the timeline chart onto a server-aggregated endpoint |
| `dbee2c57` | phase-3 | Trim the Prom rule-detail path + lazy-load notification routing |
| `3aab5bdf` | phase-4 | Server-paged listings + Prom listing cache + filter pushdown |
| `110bd5e0` | phase-5 | Server-side facets + controlled-table pagination + search push-down |

## Table of contents

1. [Overview](#1-overview)
2. [Public API surface](#2-public-api-surface)
3. [Alerts page](#3-alerts-page)
4. [Rules page](#4-rules-page)
5. [Routing page](#5-routing-page)
6. [Detail flyouts](#6-detail-flyouts)
7. [Cross-cutting infrastructure](#7-cross-cutting-infrastructure)
8. [Scaling story](#8-scaling-story)
9. [Glossary](#9-glossary)
10. [Key file index](#10-key-file-index)

## 1. Overview

The Alert Manager UI lives at `app/observability-alerting` and surfaces
alerts and rules from two unrelated alerting systems behind one set of
pages:

- **OpenSearch Alerting plugin** (`/_plugins/_alerting/...`). Native
  cluster monitors stored in OpenSearch indices, with alert history in
  the `.opendistro-alerting-alert-history-*` daily indices.
- **Prometheus rulers** reached via the DirectQuery proxy
  (`/_plugins/_directquery/_resources/{dsId}/api/v1/...`). This includes
  Cortex / Amazon Managed Prometheus rulers; alert state lives in the
  ruler, alert *history* lives in the underlying TSDB as the
  `ALERTS{...}` synthetic metric.

The UI does not talk to either backend directly. It calls plugin server
routes registered in `server/routes/alerting/index.ts`; each route's
handler delegates to `MultiBackendAlertService` in
`server/services/alerting/alert_service.ts`, which fans out to the
appropriate backend (`HttpOpenSearchBackend` or
`DirectQueryPrometheusBackend`) and merges results.

Three pages share that data plane:

1. **Alerts** — table of fired/firing alerts, with a stacked-bar
   timeline chart, severity / state / backend / label facets, and a
   detail flyout. (`alerts_dashboard.tsx`.)
2. **Rules** — table of monitors / Prom alerting rules, facet panel,
   detail flyout. (`monitors_table/`.)
3. **Routing** — Alertmanager YAML config viewer (route tree, receivers,
   inhibit rules). Prometheus-only and read-only.
   (`notification_routing_panel.tsx`.)

Both backends produce a unified shape that the UI consumes:

- `UnifiedAlertSummary` — one row per alert (table + chart input).
- `UnifiedRuleSummary` — one row per monitor/rule (rules table input).
- `UnifiedAlert` / `UnifiedRule` — flyout payload, adds `raw` +
  `alertHistory` + `conditionPreviewData` etc.

The unification lets the same hooks, table, facets, and flyouts cover
both backends. The cost: the server has to map between different APIs,
different filter models, and different cardinality risks (see §8).

### What changed at a high level

The OLD architecture was correct but client-shaped: routes returned
"give me everything," the UI did filtering, faceting, pagination, and
chart bucketing in JavaScript over the result array. That works at
hundreds of alerts; it falls over at tens or hundreds of thousands.

The NEW architecture moves work to the server:

- **Listings** are now server-paged with filter pushdown
  (Phase 4 / 5).
- **Facet counts** come from a dedicated `_facets` endpoint
  (Phase 5).
- **The timeline chart** has its own aggregated endpoint that returns
  pre-bucketed per-severity counts (Phase 2).
- **Detail flyouts** scope their backend reads instead of full-scanning
  (Phase 1 / 3).
- **Notification routing** is a separate lazy fetch instead of part of
  the rule detail (Phase 3).

The reverse-lookup pattern — "fetch the entire list, then `.find()` the
one item" — was removed everywhere it appeared (alert detail flyout,
rule detail flyout, Prom rule detail, OS rule detail history). See §6.

## 2. Public API surface

This section enumerates every route the UI calls. Each route is owned
by `server/routes/alerting/index.ts` and dispatched via a handler in
`server/routes/alerting/handlers.ts`. The route name is the canonical
identifier; the table notes which page consumes it and what upstream
work it does.

### 2.1 Routes that existed on `origin/main`

| Route | Method | Used by | Upstream work |
|---|---|---|---|
| `/api/alerting/unified/alerts` | GET | Alerts page | Fan-out to OS `monitors/alerts` + Prom `getHistoricalAlerts` (matrix). Returns `ProgressiveResponse<UnifiedAlertSummary>` |
| `/api/alerting/unified/rules` | GET | Rules page | Fan-out to OS `monitors/_search` + Prom `/api/v1/rules`. Returns `ProgressiveResponse<UnifiedRuleSummary>` |
| `/api/alerting/alerts/{dsId}/{alertId}` | GET | Alert flyout | Reverse-lookup: list-everything + `.find()`. (See §6.1.) |
| `/api/alerting/rules/{dsId}/{ruleId}` | GET | Rule flyout | Reverse-lookup for Prom; full `getMonitor` + `getAlerts` + `getDestinations` for OS |
| `/api/alerting/opensearch/{dsId}/monitors` | GET | (admin) | Pass-through to OS monitor list |
| `/api/alerting/opensearch/{dsId}/monitors/{monitorId}` | GET | (admin) | Pass-through |
| `/api/alerting/opensearch/{dsId}/alerts` | GET | (admin) | Pass-through |
| `/api/alerting/prometheus/{dsId}/rules` | GET | (admin) | Pass-through |
| `/api/alerting/prometheus/{dsId}/alerts` | GET | (admin) | Pass-through (current-active only) |
| `/api/alerting/alertmanager/config` | GET | Routing page | Direct call to `promBackend.getAlertmanagerConfig` |
| `/api/alerting/prometheus/{dsId}/metadata/...` (×4) | GET | Create/edit forms | Prom metric / label metadata |
| `/api/alerting/monitors/...` (mutation routes) | POST/PUT/DELETE | Forms | Create/update/delete/acknowledge |

### 2.2 Routes added by the optimization series

| Route | Method | Phase | Used by | Purpose |
|---|---|---|---|---|
| `/api/alerting/unified/alerts/timeline` | GET | 2 | Alerts page chart | Pre-bucketed per-severity counts. Replaces the unbounded Prom matrix query |
| `/api/alerting/rules/{dsId}/{ruleId}/routing` | GET | 3 | Rule flyout | Lazy notification-routing fetch, decoupled from rule detail |
| `/api/alerting/unified/alerts/_facets` | GET | 5 | Alerts facet panel | Server-computed severity / state / backend / label counts |
| `/api/alerting/unified/rules/_facets` | GET | 5 | Rules facet panel | Same shape, plus `monitorType` / `healthStatus` / `createdBy` |

### 2.3 New parameters added to existing routes

`/api/alerting/unified/alerts` and `/api/alerting/unified/rules` (Phase
4 / 5) now accept the following optional query params; all of them are
parsed by `buildFetchOptionsFromQuery` in
`server/routes/alerting/handlers.ts:243-269`:

```
page, pageSize, sort           — Phase 4: server-paged shape switch
severity, state, backend       — Phase 4: filter pushdown
labels (JSON)                  — Phase 4: label-equality filter pushdown
search                         — Phase 4 (rules) / Phase 5 (alerts) — text search
monitorType, healthStatus, createdBy — rules-only listing filters
noCache                        — Phase 4: bypass the 30s Prom listing cache
```

When `page` is absent, the route preserves the legacy
`ProgressiveResponse<T>` shape; when `page` is present, it returns
`PaginatedResponse<T>` (with `total` / `hasMore` / `warnings`). This
backward-compat split is implemented at
`server/routes/alerting/handlers.ts:271-310`.

`/api/alerting/alerts/{dsId}/{alertId}` gained an optional `monitorId`
query param (Phase 1). When present, the handler scopes the backend
read to one monitor's alerts instead of doing a cluster-wide scan
(`server/routes/alerting/index.ts:657-676`,
`server/services/alerting/alert_detail.ts:254-276`).

### 2.4 Response shapes

```ts
ProgressiveResponse<T> {
  results: T[];
  datasourceStatus: DatasourceFetchResult<T>[];   // per-DS success/error/timeout/fallback
  totalDatasources: number;
  completedDatasources: number;
  fetchedAt: string;
}

PaginatedResponse<T> {
  results: T[];                  // up to pageSize entries for THIS page
  total: number;                 // sum across all selected datasources after filter
  page: number;
  pageSize: number;
  hasMore: boolean;
  warnings?: DatasourceWarning[];
  fetchedAt: string;
}

AlertsTimelineResponse {
  buckets: { ts: number; severity: { critical, high, medium, low, info } }[];
  bucketCount: number;
  bucketDurationMs: number;
  datasourceStatus: DatasourceFetchResult<AlertsTimelineBucket>[];
  fetchedAt: string;
}

AlertFacetCounts {
  severity, state, backend: Record<string, number>;
  labels:                  Record<string, Record<string, number>>;
  total: number;
  truncated?: boolean;
  warnings?: DatasourceWarning[];
  fetchedAt: string;
}
```

`DatasourceFetchResult<T>` is the per-datasource envelope shared across
all unified routes. Its `fallback` field is one of four sentinel
values introduced by the optimization series; each is explained the
first time it appears in this doc:

- **`prometheus-alerts-current-only`** (existed on main, semantics
  changed in Phase 1) — the alerts list from a Prometheus datasource
  reflects "what's firing now," not the picked range. The Phase 1 code
  attaches this on every Prom response when a range is supplied,
  because the historical-reconstruction path was removed.
- **`prometheus-no-severity-labels`** (Phase 2) — `sum by(severity)
  (ALERTS{alertstate="firing"})` returned series but none carried a
  `severity` label; the timeline fell back to `count(...)` and bucketed
  everything as `medium` so the chart still renders.
- **`prometheus-search-truncated`** (Phase 5) — the user supplied a
  `search` term, the timeline matcher includes
  `alertname=~".*<input>.*"`, and the query was wrapped in
  `topk(200, …)` to bound series cardinality. The chart may miss
  high-cardinality series above the cap.
- **`opensearch-history-index-missing`** (Phase 2) — the timeline
  endpoint for an OS datasource hit `index_not_found_exception` against
  `.opendistro-alerting-alert-history-*`, so it fell back to bucketing
  `osBackend.getAlerts(...)` server-side. Operational signal; the chart
  still renders.

## 3. Alerts page

`AlertsDashboard` (`public/components/alerting/alerts_dashboard.tsx`)
hosts the timeline chart, the severity / state stat cards, the facet
panel, and the alerts table. Its parent `alarms_page.tsx` owns the
hooks that drive it and the picker / refresh / datasource state.

### 3.1 OLD (`origin/main`)

**Cold load** — On mount, `alarms_page.tsx` instantiates `useAlerts({
dsIds, startTime, endTime, refreshToken })`
(`hooks/use_alerts.ts:39-110` on main) which fires one call:

```
GET /api/alerting/unified/alerts?dsIds=...&startTime=...&endTime=...
```

The server fans out per datasource
(`server/services/alerting/alert_service.ts:250-308` on main):

- **OpenSearch** — `osBackend.getAlerts(client, { startMs, endMs })`
  paginates `/_plugins/_alerting/monitors/alerts?size=100&startIndex=…`
  until the response is shorter than the page size, with a defensive
  `SCAN_CAP=10000` hard ceiling and a `FILTER_CAP=1000` post-filter
  cap (`opensearch_backend.ts:210-312` on main).
- **Prometheus** — `promBackend.getHistoricalAlerts(...)` runs a range
  matrix query
  `ALERTS{alertstate="firing"}` (`directquery_prometheus_backend.ts:682-707`
  on main). Series count is *the number of distinct alert label sets in
  the window* — unbounded. Episodes are reconstructed from the matrix
  in JS (`directquery_prometheus_backend.ts:745-788` on main).

The UI receives every alert, then `AlertsDashboard` does ALL of the
following client-side over that array:

- **Filtering** — `filteredAlerts = filterAlerts(alerts, ...)` for the
  table (`alerts_dashboard.tsx:291-322` on main).
- **Faceting** — `facetCounts` builds a `severity × state × backend ×
  label-key × label-value` matrix on every keystroke in search
  (`alerts_dashboard.tsx:253-282` on main).
- **Timeline buckets** — `AlertTimeline` iterates the alerts array,
  picks 12-24 buckets, stacks five severities per bucket
  (`alerts_charts.tsx:103-202` on main).
- **Pagination** — `EuiInMemoryTable` paginates the array client-side
  (`alerts_dashboard.tsx:164-173` on main).

**Refire triggers (OLD):**

| Action | Refires |
|---|---|
| Datasource selection change | `useAlerts` deps change → full refetch |
| Picker (start/end) change | Full refetch |
| Refresh button click | `refreshToken++` → full refetch |
| Filter click / search keystroke | Pure client-side recompute |
| Page nav / page size change | Pure client-side |

**Scaling cost (OLD).** Let N = total alerts in the picked window:

- Cold load: O(N) wire bytes, O(N) JS work for filter/facet/bucket on
  every interaction.
- Prom-side: also O(label-set cardinality × time-bucket count) Cortex
  samples — Cortex enforces `-querier.max-samples` (default 50M);
  this query reliably trips it once N grows past tens of thousands.
- OS-side: at 100k alerts the pagination loop can do ~1000 round-trips
  before `SCAN_CAP` cuts it off — minutes of cold-load latency.

### 3.2 NEW (`alert-manager-phase-5`)

The Alerts page now drives three independent hooks plus a controlled
`EuiBasicTable`. The hooks, page/sort/search state, and filter
derivation live at the page shell so all three hooks see the same
state (`public/components/alerting/alarms_page.tsx:281-354`).

**Cold load** fires three concurrent calls:

```
GET /api/alerting/unified/alerts/_facets?dsIds=...&startTime=...&endTime=...
GET /api/alerting/unified/alerts?dsIds=...&page=1&pageSize=20&sort=startTime:desc&...
GET /api/alerting/unified/alerts/timeline?dsIds=...&startTime=...&endTime=...&buckets=24
```

Per-hook responsibility:

- **`useAlerts`** (`hooks/use_alerts.ts:56-160`) — drives the table.
  Sends `page`, `pageSize`, `sort`, plus filter params from
  `mapAlertFilters(...)`. Response is `PaginatedResponse` with `total`
  / `hasMore`. Page change fires one network call per click.
- **`useAlertsTimeline`** (`hooks/use_alerts_timeline.ts:53-140`) —
  drives the chart. Sends start/end + buckets + same filter params.
  Receives pre-bucketed payload (`buckets[]` of fixed length, each with
  `severity: { critical, high, medium, low, info }`). The chart no
  longer iterates raw alerts — see `alerts_charts.tsx:83-155`.
- **`useAlertsFacets`** (`hooks/use_alerts_facets.ts:42-131`) — drives
  the stat cards + facet panel. Internally debounces 200ms so rapid
  filter clicks coalesce into one call.

The data feed is a *page* of alerts. Sorting and full-set counts are
the server's job:

- `severityCounts` and `activeCount` for the stat cards come from
  `facetData` (the full filtered set) with a fallback to the page-local
  `alerts` array while the facet hook is loading
  (`alerts_dashboard.tsx:454-464`).
- The "X alerts" text is `alertsTotal` from `PaginatedResponse.total`
  (`alarms_page.tsx:380-384`).

**Server-side paginated path** (Phase 4 / 5):
`MultiBackendAlertService.getPaginatedAlerts`
(`alert_service.ts:690-761`) fans out per datasource, lets the OS
backend page-and-filter at the upstream where possible, applies the
post-filter via `applyAlertFilters` for correctness, then sorts and
slices.

**OS pushdown** (`opensearch_backend.ts:500-595`): `getAlertsPage` maps
to native upstream params (`size`, `startIndex`, `sortString`,
`sortOrder`, `severityLevel`, `alertState`, `searchString`). Multi-value
severity / state fall back to JS post-filter (the upstream accepts only
one value), and `labels` always post-filters.

**Prom pushdown** for alerts: the `/api/v1/alerts` endpoint accepts no
filters, so this case is purely (a) cache the response per-`dsId` for
30s via `TtlCache`, (b) JS-post-filter, sort, and slice
(`alert_service.ts:1021-1051`). Refresh-button bumps add `noCache=1` to
bypass the cache (`hooks/use_alerts.ts:79-87`).

**Refire triggers (NEW):**

| Action | What fires |
|---|---|
| Datasource selection change | All three hooks refetch |
| Picker change | All three hooks refetch (timeline & facets re-bucket on the new range) |
| Refresh button | All three hooks refetch with `noCache=1` |
| Filter click | All three hooks refetch (debounced 200ms on facets) |
| Page navigation | Listing only |
| Sort change | Listing only |
| Page-size change | Listing only |
| Search keystroke | Debounced 250ms then all three hooks refetch (`alarms_page.tsx:294-299`) |

**Scaling cost (NEW).** Per page render:

- Listing: O(pageSize) wire bytes (≤ 200 alerts), O(matched × log
  matched) for sort, O(page) for slice. The OS upstream does the
  pushdown filtering for the cheap dimensions; Prom does the cache
  lookup for free, post-filter is bounded by upstream cardinality
  (which is current-firing only, not historical).
- Timeline: 1 PromQL with ≤ 5 series ×
  `bucketCount` (12–48) samples, OR one OS `_search` aggregation
  bounded by `bucketCount × 5` cells. Both query complexity classes
  are O(bucketCount × severity), no longer O(label-set cardinality).
- Facets: bounded by `MAX_FACET_SCAN=10_000`
  (`alert_facets.ts:43`); when exceeded, `truncated: true` tells the
  user to refine.

### 3.3 Reverse-lookup elimination (alerts page)

The OLD page had no reverse-lookup at the page level (the table was
already "list everything") — but the alert detail flyout did. See §6.1.

## 4. Rules page

`MonitorsTable` (`public/components/alerting/monitors_table/index.tsx`)
hosts the rules table and facet panel, with `MonitorsMainPanel` as the
right-hand pane and `MonitorsFiltersPanel` on the left.

### 4.1 OLD (`origin/main`)

**Cold load** — `alarms_page.tsx:463-505` (on main) calls inline
`fetchRules(dsIds, page, pageSize)`:

```
GET /api/alerting/unified/rules?dsIds=...
```

The server unifies per datasource:

- **OpenSearch** — `osBackend.getMonitors(client)` always
  full-scans via `search_after` page size 100
  (`opensearch_backend.ts:41-75` on main). At 100k monitors that's
  ~1000 sequential round-trips per refresh.
- **Prometheus** — `promBackend.getRuleGroups(client, ds)` GETs
  `/api/v1/rules` and returns every group with its embedded `alerts[]`
  array (a per-rule list of currently-firing alerts the UI never reads
  but pays to transport).

The UI then does the same client-side trifecta as the alerts page:

- `filtered` set computed via `matchesSearch + matchesFilters`
  (`monitors_table/index.tsx:150-153` on main).
- `facetCounts` over status / severity / monitorType / healthStatus /
  backend / createdBy + per-key label values, recomputed on every
  search keystroke (`monitors_table/index.tsx:301-331` on main).
- `EuiInMemoryTable` paginates client-side
  (`monitors_eui_table.tsx:26-37` on main).

**Refire triggers (OLD):**

| Action | Refires |
|---|---|
| Datasource selection change | Full refetch |
| Refresh button | Full refetch |
| `rulesPage` / `rulesPageSize` change | **Spurious full refetch** — the deps are listed in the effect but the request shape doesn't include them, so the whole rules dataset is re-fetched for nothing (`alarms_page.tsx:496-505` on main) |
| Filter / search | Pure client-side |

**Scaling cost (OLD).** Let M = total rules:

- OS pagination loop: O(M / 100) sequential round-trips per refresh.
- Prom payload: O(M × per-rule-alerts). On a busy ruler, "alerts" can
  be the dominant bytes per rule.
- Client-side facets: O(M × labelKeys) on every keystroke.

### 4.2 NEW (`alert-manager-phase-5`)

The Rules page is now structurally identical to the Alerts page:
`useRulesFacets` for facets, server-paged listing via inline
`fetchRules`, controlled `EuiBasicTable` for pagination/sort.

**Cold load** fires two calls:

```
GET /api/alerting/unified/rules/_facets?dsIds=...&...
GET /api/alerting/unified/rules?dsIds=...&page=1&pageSize=20&sort=name:asc&...
```

(There's no rules timeline — no chart on this page.)

**Server-side paginated path** (`alert_service.ts:624-688`):

- **OS** — `getMonitorsPage` (`opensearch_backend.ts:152-227`) issues
  one `_search` against `/_plugins/_alerting/monitors/_search` with
  `from`/`size`/`sort`/filter clauses pushed down where possible:
  `monitor.enabled` for status, `monitor.monitor_type` for monitor
  type, `multi_match` over `monitor.name` + `monitor.description` for
  search. Severity (nested under triggers, fragile across types),
  `healthStatus` (derived from alert history), and `createdBy`
  (security-plugin-dependent) fall through to JS post-filter.
- **Prom** — `getRuleGroups` is now cached for 30s via
  `ruleGroupsCache` (`directquery_prometheus_backend.ts:188-222`). When
  the per-`dsId` filter probe says pushdown works, severity / labels /
  state filters also flow as `?rule_group=&rule_name=&type=alert`
  params (`alert_service.ts:1093-1136`). The cache only stores the
  *unfiltered* listing — filtered queries always hit the upstream so
  one filter result doesn't poison another.

The Phase 3 payload-trim (`directquery_prometheus_backend.ts:618-651`)
strips the embedded `alerts[]` array from listing responses by default;
detail-flyout callers opt back in via `{ includeAlerts: true }`.

**Refire triggers (NEW):**

| Action | What fires |
|---|---|
| Datasource change | Listing + facets refetch |
| Refresh button | Both refetch with `noCache=1` |
| Filter click | Both refetch |
| Page nav / size / sort | Listing only |
| Search keystroke | Debounced 250ms then both refetch (`alarms_page.tsx:454-461`) |

**Scaling cost (NEW).** Per render:

- OS listing: one `_search` round-trip, page bounded by `pageSize ≤
  200`. `track_total_hits: true` gives the server-side total for the
  page count (`opensearch_backend.ts:201`).
- Prom listing: 30s cache hit ⇒ zero upstream calls. Cache miss ⇒ one
  `/api/v1/rules` call. Filtering is post-applied or pushed down per
  probe.
- Facets: same `MAX_FACET_SCAN=10_000` bound as alerts.

### 4.3 Reverse-lookup elimination (rules page)

The OLD rules page had two reverse-lookup paths in detail flyouts; both
are gone. See §6.2 and §6.3.

## 5. Routing page

`NotificationRoutingPanel`
(`public/components/alerting/notification_routing_panel.tsx`) renders
the Alertmanager configuration for a chosen Prometheus datasource: the
route tree, the receivers table, the inhibit rules table, and a YAML
view of the parsed config.

### 5.1 OLD and NEW

The Routing page was not modified by the optimization series. Its data
flow is the same on both sides:

**Cold load** — `useEffect` runs `adminService.getConfig(selectedDsId)`
on mount and on datasource change
(`notification_routing_panel.tsx:184-200` on both).

```
GET /api/alerting/alertmanager/config?dsId=<promDsId>
```

The server resolves a Prometheus datasource saved object
(`server/routes/alerting/index.ts:682-737`) and calls
`promBackend.getAlertmanagerConfig(client, ds)`, which goes to the
ruler's Alertmanager config endpoint via DirectQuery. Response is the
parsed YAML config.

**Refire triggers:**

| Action | Refires |
|---|---|
| Datasource selection change | Full refetch |
| Refresh button | Full refetch |
| (No filtering / paging in the UI — config is small) | — |

**Scaling cost:** O(1) calls per render. The config is one YAML file
on the order of kilobytes; cardinality is not a concern.

There is no reverse-lookup on this page. Per-rule notification routing
*was* surfaced from the rule flyout's "Notification Routing" accordion
on `origin/main` (an O(monitor) read per flyout open); that's the
Phase 3 lazy-routing change covered in §6.3.

## 6. Detail flyouts

The two flyouts are where the OLD code's reverse-lookup pattern
clustered. Each opened a flyout (a UI action that ought to cost one
network call) and triggered a list-everything-then-`.find()`-one
backend read.

### 6.1 Alert detail flyout

#### OLD (`origin/main`)

`AlertDetailFlyout`'s mount-time effect
(`alert_detail_flyout.tsx:66-79` on main) unconditionally fires:

```
GET /api/alerting/alerts/{dsId}/{alertId}
```

The server's `getAlertDetail`
(`server/services/alerting/alert_detail.ts:230-258` on main) handles
the call as follows:

```ts
if (ds.type === 'opensearch' && osBackend) {
  const { alerts } = await osBackend.getAlerts(client);   // EVERY alert
  const alert = alerts.find((a) => a.id === alertId);
  ...
} else if (ds.type === 'prometheus' && promBackend) {
  const promAlerts = await promBackend.getAlerts(client, ds);  // every Prom alert
  const alert = promAlerts.find(...);
  ...
}
```

That is the textbook reverse-lookup. Opening one alert flyout costs
one `getAlerts` of the entire datasource, capped at
`SCAN_CAP=10_000` by the OS backend. At a busy cluster, every
flyout open is seconds of work.

#### NEW (`alert-manager-phase-5`)

Two changes, in two phases:

**Phase 1 — pass `monitorId` through (`alert_detail.ts:254-276`).** The
`UnifiedAlertSummary` already carries the monitor id; the flyout passes
it through the route as a query param, the handler forwards it
(`server/routes/alerting/index.ts:657-676`), and
`osBackend.getAlerts({ monitorId })` appends `&monitorId=…` to the
upstream URL (`opensearch_backend.ts:406-408`). The OS upstream then
returns only that one monitor's alerts, typically a handful.

For Prometheus, the flyout's detail call is dropped entirely
(`alert_detail.ts:272-274` returns `null`). The summary already carries
the labels/annotations; there's no upstream "scan-all-alerts-by-id"
shape that's worth chasing.

**Phase 1 — lazy-load the Raw Data accordion
(`alert_detail_flyout.tsx:64-83`).** The flyout no longer fires the
detail call on mount. The "Raw Alert Data" accordion's `onToggle`
calls `fetchDetailIfNeeded()`, which fires the request on first
expand. For the common path (user opens the flyout, reads the visible
fields, closes it) the detail call is never made.

```tsx
<EuiAccordion
  id={`alertRaw-${alert.id}`}
  buttonContent={<strong>Raw Alert Data</strong>}
  initialIsOpen={false}
  onToggle={(isOpen) => { if (isOpen) fetchDetailIfNeeded(); }}
>
  ...
</EuiAccordion>
```

**Cost comparison.** Opening one alert flyout at a 100k-alert datasource:

| | OLD plugin call | OLD upstream cost | NEW plugin call (no expand) | NEW plugin call (Raw Data expanded) |
|---|---|---|---|---|
| OS flyout | 1 detail call | up to ~100 OS pagination reads (capped at `SCAN_CAP=10_000`) | 0 | 1 detail call → 1 monitor's alerts only |
| Prom flyout | 1 detail call | 1 `/api/v1/alerts` (every firing alert) | 0 | 0 — handler returns `null`, accordion renders summary's labels/annotations |

### 6.2 Rule detail flyout — OS path

#### OLD

`getOSRuleDetail` (`alert_detail.ts:69-169` on main) does *three* O(N)
reads on every flyout open:

1. `osBackend.getAlerts(client)` for "build alert history,"
   then JS-filters down to the requested monitor:

   ```ts
   const { alerts } = await osBackend.getAlerts(client);   // every alert
   const monitorAlerts = alerts.filter((a) => a.monitor_id === monitorId).slice(0, 20);
   ```

   This is the same reverse-lookup pattern the alert detail flyout had,
   recurring here for the rule history list (`alert_detail.ts:80-93` on
   main).

2. `osBackend.getDestinations(client)` to build a `destMap` so the
   rule's trigger actions can be resolved against destinations
   (`alert_detail.ts:97-114` on main). This is a `GET
   /_plugins/_alerting/destinations?size=200` *every flyout open*.

3. If the cheap "extract preview from monitor" path returns no points,
   `osBackend.runMonitor(_, dryRun=true)` actually executes the user's
   monitor against live data (`alert_detail.ts:145-153` on main). At
   scale this is per-browse-session live re-execution of customer
   monitors.

#### NEW

All three reads are gone or scoped:

1. **Phase 1** — pass `{ monitorId }` to `osBackend.getAlerts` so the
   upstream returns only that one monitor's history
   (`alert_detail.ts:80-83`). The post-filter `.filter(a =>
   a.monitor_id === monitorId)` is removed (now redundant); the
   `.slice(0, 20)` history cap remains.

2. **Phase 3** — destinations are no longer fetched on flyout open. A
   new lazy endpoint, `GET /api/alerting/rules/{dsId}/{ruleId}/routing`
   (`server/routes/alerting/index.ts:638-655`,
   `server/services/alerting/alert_service.ts:822-863`), owns the
   destinations lookup. The flyout's "Notification Routing" accordion's
   `onToggle` calls `osService.getRuleRouting(...)`
   (`monitor_detail_flyout.tsx:242-253`). If the user never expands
   the accordion, `getDestinations` never runs.

3. **Phase 1** — the dry-run fallback was deleted entirely
   (`alert_detail.ts:115-122`). `conditionPreviewData` may now be empty
   for some monitors, and the flyout's `ConditionPreviewGraph` already
   handles that case.

### 6.3 Rule detail flyout — Prom path

#### OLD

`getPromRuleDetail` (`alert_detail.ts:171-225` on main) iterated *every
group × every rule* to find the one rule:

```ts
const groups = await promBackend.getRuleGroups(client, ds);  // every group
for (const group of groups) {
  for (const rule of group.rules) {
    if (rule.type !== 'alerting') continue;
    const id = `${ds.id}-${group.name}-${alertingRule.name}`;
    if (id !== ruleId) continue;
    ...
  }
}
```

Per-flyout-open cost: one full `/api/v1/rules` listing — including the
per-rule embedded `alerts[]` array — to find one rule by id.

#### NEW

Phase 3 replaces the full scan with a scoped fetch when the upstream
supports filter pushdown. `getPromRuleDetail` (`alert_detail.ts:163-238`):

```ts
const parsed = parsePromRuleId(ruleId, ds.id);   // {dsId}-{group}-{rule}
const probeResult = await promFilterProbe.probe(client, ds);
if (probeResult.status === 'pushdown-works') {
  groups = await promBackend.getRuleGroups(
    client, ds,
    { ruleGroup: parsed.groupName, ruleName: parsed.ruleName, type: 'alert' },
    { includeAlerts: true }
  );
} else {
  groups = await promBackend.getRuleGroups(client, ds, undefined, { includeAlerts: true });
}
```

The probe (`server/services/alerting/prom_filter_probe.ts`) is a
process-lifetime cache keyed by `dsId`. On first flyout open per
datasource, it issues one extra round-trip to test the upstream;
subsequent opens use the cached probe result.

**Server-side post-filter remains regardless of probe result** — even
when pushdown works, the code re-walks the response to find the single
matching rule (`alert_detail.ts:189-237`). That guarantees correctness
even on Cortex versions that "partially" honor filters (e.g. accept
`rule_group` but not `rule_name`).

When the probe returns `pushdown-ignored` or `unknown` (for example
the Cortex in the local dev stack), the code falls back to a full
listing — which is itself cached for 30s by `ruleGroupsCache` (when
called without a filter), so the cost amortizes across flyout opens
within a session.

The Phase 3 listing-side payload trim (`directquery_prometheus_backend.ts:618-651`)
strips `alerts[]` from listings by default, but the rule-detail call
opts back in with `includeAlerts: true` so its alert history list still
populates.

## 7. Cross-cutting infrastructure

Five new pieces of plumbing showed up across the optimization series.
Each is the answer to a structural question that couldn't be solved
inside one route or one component.

### 7.1 `filter_mapping.ts` — single source of truth

**File:** `public/components/alerting/filter_mapping.ts`.

**Problem.** The Alerts page has three independent hooks
(`useAlerts`, `useAlertsTimeline`, `useAlertsFacets`). All three have
to send the same filter set or the chart, the table, and the facet
counts will disagree visibly (chart shows bars for filtered-out
alerts, etc.). Phases 2-5 each added another consumer of the same
filter state.

**Shape.** Two pure functions:

- `mapAlertFilters(snapshot)` — takes an `AlertsDashboardFilterSnapshot`
  (panel filters + the two stat-card single-selects) and returns
  normalized `{ severity?, state?, labels? }`. Encapsulates the
  precedence rule: panel filters win over stat-card single-selects;
  `severityCard === 'medium'` expands to `['medium', 'low', 'info']`
  (the existing wide-medium semantics).
- `mapRuleFilters(filters)` — same shape for the rules table.
- `resolveBackendDsIds(...)` — separately, a `backend[]` UI filter
  (e.g. "show only Prometheus alerts") is resolved client-side to a
  narrowed `dsIds` set so all three hooks send the same datasource
  list.

**How it's used.** `alarms_page.tsx:283-354` derives `alertsFilterParams`
once and passes it into all three hooks. That single derivation is the
chart-vs-table consistency contract.

### 7.2 `TtlCache` — Prom upstream coalescing

**File:** `server/services/alerting/ttl_cache.ts` (49 lines, generic
`<K, V>`).

**Problem.** Prom's `/api/v1/alerts` and `/api/v1/rules` accept no
filter parameters. When the user clicks through filter combinations,
each click would otherwise issue another full listing call — even when
the underlying data hasn't changed and just the post-filter has.

**Shape.**

```ts
class TtlCache<K, V> {
  constructor(private readonly ttlMs: number = 30_000);
  async get(key: K, fetcher: () => Promise<V>): Promise<V>;
  invalidate(key: K): void;
  clear(): void;
}
```

The two important behaviors are:

- **TTL** (default 30s) — repeated `get(key, ...)` calls within the
  window reuse the cached value.
- **In-flight coalescing** — concurrent `get(key, ...)` calls during a
  cache miss share one in-flight promise, so two pages opening at the
  same time don't race two upstream calls.

**Where it's wired.** Two instances on the Prom backend
(`directquery_prometheus_backend.ts:75-84`):

- `alertsCache: TtlCache<string, PromAlert[]>` — keyed on `dsId`.
- `ruleGroupsCache: TtlCache<string, PromRuleGroup[]>` — keyed on
  `dsId`. Caches *only the unfiltered listing*; filtered queries
  bypass per `isCacheableRuleFilter`
  (`directquery_prometheus_backend.ts:216-222`).

**Bypass.** A `noCache` query param on the route (driven by the
refresh button or the hooks' `refreshToken` watcher in
`hooks/use_alerts.ts:79-87`) forwards through the service layer
(`alert_service.ts:1041-1043`, `1075-1077`) and flips
`get(...)` to `invalidate(key); fetcher()` semantics
(`directquery_prometheus_backend.ts:275-278`).

### 7.3 `prom_filter_probe.ts` — pushdown vs fallback

**File:** `server/services/alerting/prom_filter_probe.ts` (110 lines).

**Problem.** Cortex / Prometheus added `?rule_group=&rule_name=&type=alert`
to `/api/v1/rules` in Prom 2.40 / Cortex 1.13. Older upstreams
**silently** ignore the params and return the full listing. We can't
know which by version-sniffing alone (forks exist), so we have to
test the upstream.

**Shape.** Process-lifetime cache keyed on `dsId`. On first call per
datasource, the probe:

1. Lists rules unfiltered, picks the first alerting rule's
   `(group, name)` pair.
2. Issues a scoped request for exactly that pair.
3. If the response is exactly that one rule → `'pushdown-works'`.
   Anything else → `'pushdown-ignored'`. Listing failures →
   `'unknown'` (silently fall through to the unfiltered path).

Concurrent probes for the same `dsId` share one in-flight promise.

**Lazy probing.** Probing fires on the first flyout/listing call that
needs it, not at server startup
(`alert_service.ts:780, 1104-1107`). Each datasource pays one extra
round-trip on its first cold open and zero on every subsequent flyout.

**Correctness contract.** Even when the probe says
`'pushdown-works'`, every caller still post-filters the response in JS
(`alert_detail.ts:189-237` for detail, `alert_service.ts:746-760` for
listings). A Cortex bug that "partially" honors filters can't sneak
the wrong rule through.

### 7.4 Server-side facets

**Files:** `server/services/alerting/alert_facets.ts` (353 lines),
hooks `use_alerts_facets.ts`, `use_rules_facets.ts`.

**Problem (OLD).** `alerts_dashboard.tsx:253-282` and
`monitors_table/index.tsx:301-331` both rebuilt a
`severity × state × backend × label-key × label-value` matrix on every
keystroke in search. At 10k alerts × 20 label keys, that's 200k cells
recomputed per keystroke.

**Shape.** Standard "OR-within-dimension, AND-across-dimensions" facet
semantics: each top-level dimension's count is computed with its own
filter excluded ("what would I see if I added this filter?").
Implementation steps (`alert_facets.ts:262-307`):

1. Fetch the dimensional superset — same `fetchAlertsRaw` /
   `fetchRulesRaw` the listing path uses, but with severity / state /
   labels filters stripped (`stripDimensionalFilters` at
   `alert_facets.ts:141-151`). Cache hits are the win.
2. For each dimension, run `applyAlertFilters(set, { ...options,
   <thisDim>: undefined })` to get the count surface that would show
   if the user toggled this dimension.
3. Count values per dimension. Internal label keys (`monitor_id`,
   `datasource_id`, `_workspace`, `monitor_type`, `monitor_kind`,
   `trigger_id`, `trigger_name`) are filtered out
   (`alert_facets.ts:49-57`).
4. Cap label keys at `MAX_LABEL_KEYS=20` and values per key at
   `MAX_VALUES_PER_KEY=50`. Surface `truncated: true` if any cap hits.

**Cache reuse.** Both `fetchAlertsRaw` (Prom path) and
`fetchRulesRaw` (Prom path) hit the same `TtlCache` the listing uses
(see §7.2). A facet call within 30s of a listing call is a cache hit.
That's the savings: facet recomputation is the bigger upstream cost in
the cache-miss case, but cache-hit it costs zero upstream traffic.

**Client-side fallback.** `useAlertsFacets` debounces 200ms internally
(`use_alerts_facets.ts:40, 81-109`). While in-flight or errored, the
dashboard falls back to a client-side memo over the page-local `alerts`
array (`alerts_dashboard.tsx:397-440`) so the panel never flashes empty.

### 7.5 Server-side timeline aggregation

**File:** `server/services/alerting/alert_timeline.ts` (744 lines).
**Hook:** `use_alerts_timeline.ts`.

**Problem (OLD).** The chart on `origin/main` fed off the same
`alerts[]` array the table uses. For a Prometheus datasource, that
array was reconstructed from a range matrix query
`ALERTS{alertstate="firing"}`
(`directquery_prometheus_backend.ts:700-707` on main) — series count
unbounded by alert label-set cardinality. Cortex's `max-samples`
default is 50M; this query trips it well before 100k alerts.

**Shape.** Returns pre-bucketed counts:

```ts
{
  buckets: [
    { ts: 1707000000000, severity: { critical: 0, high: 2, medium: 1, low: 0, info: 0 } },
    ...
  ],
  bucketCount: 24,
  bucketDurationMs: 3600000,
  datasourceStatus: [...],
  fetchedAt: "..."
}
```

**Per-backend implementation:**

- **Prometheus**
  (`alert_timeline.ts:405-504`): range-query
  `sum by(severity) (ALERTS{alertstate="firing"})` with
  `step = max(1, floor((endMs - startMs) / 1000 / buckets))`. Returns
  one series per distinct severity value — bounded cardinality (≤ 5).
  Severity / labels filters become matchers on the selector
  (`alert_timeline.ts:340-368`). State filters override the
  `alertstate` matcher (`alert_timeline.ts:379-391`).

  Two fallbacks worth knowing:

  - **`prometheus-no-severity-labels`** — `sum by(severity)` returned
    series but none had a `severity` label. Falls back to
    `count(ALERTS{alertstate="firing"})` and buckets all under
    `medium` (`alert_timeline.ts:454-489`).
  - **`prometheus-search-truncated`** — when the user supplies a
    `search` term, the matcher includes `alertname=~".*<input>.*"` and
    the query is wrapped in `topk(200, …)` so a broad regex doesn't
    blow up cardinality (`alert_timeline.ts:431-441`). The cap is
    surfaced regardless of whether it actually clipped.

- **OpenSearch**
  (`alert_timeline.ts:525-655`): one `_search` against
  `.opendistro-alerting-alert-history-*` with a `date_histogram` on
  `start_time` and a nested `terms` agg on `severity`. Severity / state
  filters become `terms` clauses; search becomes a `wildcard` over
  `monitor_name.keyword` + `trigger_name.keyword`
  (`alert_timeline.ts:566-586`).

  When the index doesn't exist (alerting plugin creates it lazily on
  first alert fire), the timeline falls back to bucketing
  `osBackend.getAlerts(...)` server-side
  (`alert_timeline.ts:622-637`,
  `fetchOSTimelineFromGetAlerts` at `alert_timeline.ts:664-695`).
  Surface code: **`opensearch-history-index-missing`**.

**Bucket count.** `pickBucketCount(startMs, endMs)` in
`common/services/alerting/timeline_buckets.ts` is the shared helper —
defaults to a 5-min target bucket clamped to `[12, 24]` on the client.
Server clamps further to `[12, 48]` via `clampServerBucketCount`
(defense-in-depth).

**Multi-datasource merge.** Each datasource produces
`buckets[i].severity[k]`; the server merges by summing across
datasources (`alert_timeline.ts:172-199`). Failed datasources contribute
zero to all buckets but appear in `datasourceStatus`.

## 8. Scaling story

This section walks through the costs at increasing scale on the alerts
page, the rules page, and the two flyouts. N = total alerts in the
window, M = total rules / monitors. The picker / filters add their own
multipliers; the rough orders of magnitude below assume cold load with
default filters.

### 8.1 Alerts page

| Scale | OLD wire bytes | OLD upstream load | NEW wire bytes | NEW upstream load |
|---|---|---|---|---|
| 100 alerts | ~50 KB | 1 OS call, 1 Prom matrix | ~30 KB across 3 calls | 1 OS list + 1 OS agg + 1 Prom (cached) |
| 10k alerts | ~5 MB | 100 OS pages, 1 Prom matrix (~10k series) | ~30 KB | same as above |
| 100k alerts | ~50 MB / `SCAN_CAP=10k` | 100 OS pages then truncate; Prom matrix **trips Cortex `max-samples`** | ~30 KB | same as above |
| 1M alerts | won't load | won't load (Prom side) | ~30 KB; facets surface `truncated: true` past `MAX_FACET_SCAN=10_000` | same as above |

Where the OLD code falls over at scale:

- **Cortex `max-samples`** (default 50M). The OLD Prom matrix query
  `ALERTS{alertstate="firing"}` returns one series per distinct alert
  label-set in the window. At ≥ ~50k alerts and a 7-day range with a
  reasonable step, Cortex rejects with `query processing would load
  too many samples into memory`. The NEW timeline endpoint sums
  by severity at the matcher level — at most 5 series, regardless of
  N. **Fix:** §7.5.
- **`SCAN_CAP=10_000`** in the OS backend (still present on both old
  and new at `opensearch_backend.ts:402`). On main the cap fires for
  the page-level table fetch; on the new branch the listing endpoint
  uses `getAlertsPage` (page bounded by 200), so the legacy SCAN_CAP
  only matters for the legacy "no range, no filter" path.
- **Client-side facets and bucketing** — at 10k alerts × 20 label
  keys, the OLD client-side facet matrix is ~200k cells per
  keystroke. Phase 5's debounced server-side facets fix that.

### 8.2 Rules page

| Scale | OLD wire bytes | OLD upstream | NEW wire bytes | NEW upstream |
|---|---|---|---|---|
| 1k rules | ~500 KB (incl. embedded `alerts[]`) | 10 OS `_search` pages, 1 Prom listing | ~100 KB | 1 OS `_search`, 1 cached Prom listing |
| 10k rules | ~5 MB | 100 OS pages | ~100 KB | same |
| 100k rules | ~50 MB; long load | 1000 OS pages | ~100 KB | same |

Where the OLD code falls over:

- **`getMonitors` always full-scans** via `search_after`
  (`opensearch_backend.ts:41-75` on main). At 100k monitors, ~1000
  sequential round-trips per refresh. The NEW backend takes a single
  paginated `_search` for the page (`opensearch_backend.ts:152-227`).
- **`alerts[]` embedded in every rule** in the OLD Prom listing. Stripped
  on the NEW path by `mapRule` with `includeAlerts: false`
  (`directquery_prometheus_backend.ts:618-651`).
- **Spurious refetch on page change** — the OLD `useEffect` listed
  `rulesPage` / `rulesPageSize` in deps but didn't actually use them
  in the request (`alarms_page.tsx:496-505` on main). On the NEW path,
  page change is meaningful (server-paged) and fires exactly the
  expected one call (`alarms_page.tsx:702-722`).

### 8.3 Detail flyouts

| Action | OLD upstream calls | NEW upstream calls (no expand) | NEW (full expand) |
|---|---|---|---|
| Open OS alert flyout (100k alerts) | up to ~100 OS pages | 0 | 1 scoped (≤ 1 monitor's alerts) |
| Open Prom alert flyout (10k firing) | 1 `/api/v1/alerts` | 0 | 0 |
| Open OS rule flyout | 1 full `getAlerts` + 1 `getDestinations` (+ optional dry-run!) | 1 scoped `getAlerts` | + 1 `/routing` if user expands |
| Open Prom rule flyout (1k rules × 50 alerts) | 1 full `/api/v1/rules` (~5 MB) | 1 scoped `/api/v1/rules?rule_group=&rule_name=` | same; cache hit if listing was loaded recently |

The Prom rule flyout is bounded by the probe state: when the upstream
ignores filters, the request expands to the full listing — but the
30s `ruleGroupsCache` makes that cost amortize across opens.

The **dry-run live re-execution** (`runMonitor(_, dryRun=true)` on
`alert_detail.ts:147` in main) was per-flyout-open re-execution of
customer monitors against live data. Phase 1 deleted it
unconditionally. The cost was less about wire bytes and more about
*the cluster running real queries every time anyone clicks a flyout.*

## 9. Glossary

- **Reverse lookup** — fetching a list of "everything" and using
  `.find()` / `.filter()` to pick one item by id, instead of
  asking the upstream for that one item. Identifiable in the OLD
  alert detail flyout, OS rule detail history, and Prom rule detail
  paths.
- **Pushdown** — sending a filter to the upstream so it returns the
  narrowed set, instead of returning everything and filtering in JS.
- **Probe** — for the Prom rule listing only: a one-shot test that
  asks the upstream "does `?rule_group=&rule_name=` actually narrow
  results?" and caches the answer per-`dsId`.
- **Progressive vs paginated response** — `ProgressiveResponse<T>`
  is the legacy "full set + per-DS status" shape; `PaginatedResponse<T>`
  is the Phase 4 "one page + total + warnings" shape.
  `/api/alerting/unified/{alerts,rules}` returns the former when `page`
  is absent and the latter when `page` is present.
- **Facet** — a count next to a filter checkbox. Server-computed on
  Phase 5; client-computed before.
- **DirectQuery** — the OpenSearch plugin that exposes upstream
  Prometheus / data-connection HTTP APIs as
  `/_plugins/_directquery/_resources/{ds}/...` paths through the OS
  cluster. The dashboards-observability plugin always reaches Prom
  through DirectQuery, never directly.
- **`SCAN_CAP=10_000`** — the OS backend's hard ceiling on rows it
  will paginate through in the legacy `getAlerts(client, range)`
  path. Defensive against a 100k+ datasource where almost no alerts
  fall into the picked window. (`opensearch_backend.ts:402`.)
- **`MAX_FACET_SCAN=10_000`** — the facet path's cap on alerts/rules
  considered. Past it, `truncated: true` surfaces and the user sees
  the truncation callout. (`alert_facets.ts:43`.)
- **`MAX_LABEL_KEYS=20`** / **`MAX_VALUES_PER_KEY=50`** — caps on
  the label-facet payload. (`alert_facets.ts:44-45`.)
- **`PROM_TIMELINE_SEARCH_TOPK=200`** — `topk(...)` cap on Prom
  timeline series when search is in play. (`alert_timeline.ts:63`.)
- **Fallback codes** — `prometheus-alerts-current-only`,
  `prometheus-no-severity-labels`, `prometheus-search-truncated`,
  `opensearch-history-index-missing`. See §2.4.

## 10. Key file index

A reader navigating from this doc into the codebase will hit these
files most often:

### Server side

| Path | What |
|---|---|
| `server/routes/alerting/index.ts` | Route registrations, schemas, request-services builder |
| `server/routes/alerting/handlers.ts` | Thin handler functions; query-string parsing helpers |
| `server/routes/alerting/alertmanager_handlers.ts` | Routing page handler (read-only Alertmanager config) |
| `server/services/alerting/alert_service.ts` | `MultiBackendAlertService` orchestrator |
| `server/services/alerting/alert_detail.ts` | Flyout resolvers (`getAlertDetail`, `getOSRuleDetail`, `getPromRuleDetail`) |
| `server/services/alerting/alert_timeline.ts` | Timeline endpoint per-backend implementation |
| `server/services/alerting/alert_facets.ts` | Facet endpoint compute path |
| `server/services/alerting/opensearch_backend.ts` | OS HTTP backend (paginated `_search`, alert history aggregation) |
| `server/services/alerting/directquery_prometheus_backend.ts` | Prom backend (`getRuleGroups`, `getAlerts`, `queryRangeMatrix`, `filterProbe`, `alertsCache`, `ruleGroupsCache`) |
| `server/services/alerting/prom_filter_probe.ts` | Lazy per-`dsId` pushdown probe |
| `server/services/alerting/ttl_cache.ts` | Generic TTL + in-flight-coalescing cache |

### Client side

| Path | What |
|---|---|
| `public/components/alerting/alarms_page.tsx` | Page shell; owns hooks, page/filter/sort state, picker |
| `public/components/alerting/alerts_dashboard.tsx` | Alerts page UI: stat cards, facets, chart, table |
| `public/components/alerting/alerts_charts.tsx` | `AlertTimeline` (consumes pre-bucketed payload) |
| `public/components/alerting/alert_detail_flyout.tsx` | Alert flyout; raw-data accordion lazy-loads |
| `public/components/alerting/monitor_detail_flyout.tsx` | Rule flyout; routing accordion lazy-loads |
| `public/components/alerting/notification_routing_panel.tsx` | Routing page (Alertmanager config view) |
| `public/components/alerting/monitors_table/index.tsx` | Rules page UI: facet panel, search, container |
| `public/components/alerting/monitors_table/monitors_main_panel.tsx` | Rules table right pane |
| `public/components/alerting/monitors_table/monitors_eui_table.tsx` | Controlled `EuiBasicTable` wrapper |
| `public/components/alerting/filter_mapping.ts` | UI filter snapshot → server params (Phase 4) |
| `public/components/alerting/hooks/use_alerts.ts` | Listing hook (paginated when `page` present) |
| `public/components/alerting/hooks/use_alerts_timeline.ts` | Timeline-chart hook (Phase 2) |
| `public/components/alerting/hooks/use_alerts_facets.ts` | Alerts facets hook (Phase 5) |
| `public/components/alerting/hooks/use_rules_facets.ts` | Rules facets hook (Phase 5) |
| `public/components/alerting/hooks/use_alertmanager_config.ts` | Routing page hook |
| `public/components/alerting/query_services/alerting_opensearch_service.ts` | Frontend HTTP transport |

### Shared

| Path | What |
|---|---|
| `common/services/alerting/timeline_buckets.ts` | `pickBucketCount`, `clampServerBucketCount` |
| `common/types/alerting/timeline.ts` | `AlertsTimelineResponse`, `AlertsTimelineBucket` |
| `common/types/alerting/unified_types.ts` | `UnifiedFetchOptions`, `PaginatedResponse`, `ProgressiveResponse`, `DatasourceFetchResult` |
