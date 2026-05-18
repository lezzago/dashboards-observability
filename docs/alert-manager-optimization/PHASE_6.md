# Phase 6 — Alertmanager-primary alerts (and other follow-ups)

Phase 5 closed out the original optimization plan. This doc tracks
follow-ups identified after Phase 5 landed. Each item is independent
and can ship on its own; the file is structured so new items can be
appended over time without forcing a rewrite of the lead item.

## Status

- Branch base: `alert-manager-phase-5` (commit `110bd5e0`).
- Branch this work on as `alert-manager-phase-6`.
- Items will land as separate commits; nothing here is bundled.

## Phase 5 carryovers worth knowing

These are facts about the system as Phase 6 begins. Keep them in mind
when making changes to avoid stepping on existing invariants.

- **`MultiBackendAlertService`** is per-request. Stateful caches live on
  the backend instances (`alertsCache`, `ruleGroupsCache`,
  `filterProbe`), which are constructed once at server startup and
  shared across requests.
- **Post-Phase-5 work — bounded historical Prom alerts.** Independent
  of the five committed phases (`75aca55a..110bd5e0`), a separate
  working session on the same `alert-manager-phase-5` branch reintroduced
  historical alerts for Prometheus. Phase 1 had stripped the original
  unbounded matrix reconstruction; the post-Phase-5 work brought
  history back via a *bounded* `topk(N, last_over_time(ALERTS{...}[range]))`
  instant query (`directquery_prometheus_backend.ts:367-452`,
  `alert_service.ts:1090-1147`, with
  `PROM_HISTORICAL_ALERTS_TOPK = 1000`). The current shape:
  - **Range with `endIsNow=true`** (e.g. `now-7d → now`) ⇒ merge
    current-firing (from `/api/v1/alerts`, cached) with historical
    fingerprints (from the topk query); current-firing wins on
    fingerprint collision.
  - **Past-only range** (e.g. `now-2h..now-1h`) ⇒ historical only;
    `/api/v1/alerts` is skipped because it ignores time entirely.
  - **No range** ⇒ current-firing only (legacy path).

  The same session also added a per-flyout bounded episode walk for
  Prom alerts (`alert_detail.ts:281-285, 298-onward`,
  `fetchPromAlertEpisodes`) — one `queryRangeMatrix` over
  `ALERTS{<exact label-set>}` with a target ~200 samples, replacing
  the Phase 1 "return null" behavior when the flyout has labels +
  range available.

  This is **not part of Phase 5** and is not described in any of the
  five plan docs. It's covered in `ARCHITECTURE.md` (header note +
  §3.2 + §6.1 + §8.1).
- **Cache reuse contract.** Anywhere a new code path reaches the Prom
  upstream, prefer to go through `getAlerts` / `getRuleGroups` so the
  30s `TtlCache` hit benefits both that path AND the listing/facet
  surfaces. New ad-hoc fetchers without cache participation are a
  regression.
- **Filter-probe caching is process-lifetime.** Restart the plugin
  process to invalidate. Tests use `probe.reset()`; production code
  should never call `reset()`.
- **Four fallback codes** are surfaced via `DatasourceFetchResult.fallback`:
  `prometheus-alerts-current-only`, `prometheus-no-severity-labels`,
  `prometheus-search-truncated`, `opensearch-history-index-missing`.
  New code paths must keep emitting them where today's behavior emits
  them, and any new fallback signal needs a new sentinel value (don't
  overload existing ones).

## Items

### P6.1 — Alertmanager-primary alerts (Prom path)

Replace `/api/v1/alerts` with `/alertmanager/api/v2/alerts` as the
primary source for the alerts table and flyout, with `/api/v1/alerts`
preserved as a fallback when Alertmanager is unreachable. Augment
with `/api/v1/rules` for the fields AM doesn't carry (`value`, pending
state).

#### Why

Two structural wins, plus three smaller UX wins:

**1. Filter pushdown.** `/api/v1/alerts` accepts no filter parameters,
which is why we wrap it in a 30s `TtlCache` (`alertsCache` at
`directquery_prometheus_backend.ts:75-85`) and JS-post-filter via
`applyAlertFilters` (`alert_service.ts:173-210`). Alertmanager's
`/api/v2/alerts` accepts native matchers:

```
filter[]=severity="critical"
filter[]=alertname=~".*pod.*"
filter[]=env="prod"
active=true
silenced=false
inhibited=false
unprocessed=false
receiver=<regex>
```

The filter-narrowed result comes back from the upstream. JS-post-filter
remains for correctness (per the Phase 3 contract — Cortex bugs that
"partially" honor filters can't sneak through), but its scan size is
the filtered set, not the full population.

**2. Silence + inhibition visibility.** Today's `UnifiedAlertSummary`
has no field for "this alert is silenced" or "this alert is inhibited
by …" because `/api/v1/alerts` doesn't carry those. AM's response does
(`status.silencedBy[]`, `status.inhibitedBy[]`), and the right place
to surface them is the table (badge column) and the flyout (with
links to the silence definition / parent alert).

**3. Receivers per alert.** Today the rule flyout's Notification
Routing accordion (Phase 3 lazy fetch) returns `[]` for Prom because
routing is owned by AM, not the rule. With AM as the source, the
flyout can show the actual *computed* receiver list per alert (the AM
routing tree result), not just the rule's static configuration.

**4. `endsAt` field.** AM carries the resolve-timeout horizon. Useful
context for the flyout: "expires at 14:32 unless rule re-fires."
Currently inferable only by mentally inverting the ruler's evaluation
interval.

**5. HA-ruler dedup.** Two-replica rulers + one AM today produce
duplicate rows because each ruler reports the same firing alert
independently. AM dedupes by fingerprint. Free.

#### What's lost (and how to backfill)

| Field | Available in AM? | Backfill |
|---|---|---|
| `value` (expression result at firing) | No | Join from `/api/v1/rules?type=alert`. Rule listing embeds `alerts[]` per rule with `value` per entry. The 30s `ruleGroupsCache` already serves the rules table — usually warm. |
| Pending alerts (`for:` not yet satisfied) | No | Same `/api/v1/rules` listing; pending entries appear in the embedded `alerts[]`. Or: drop pending from the table entirely. Most observability UIs do. Recommendation: drop, keep only `state: firing` rows visible, document the change. |
| `activeAt` (precise firing-time) | Approximated by `startsAt` | AM's `startsAt` is set when it first received the alert from the ruler; close enough. The flyout can still show the more precise rule-side `activeAt` if backfill is wanted. |

#### When AM isn't available

Some Prom installs don't run AM at all (small custom routers, Mimir
without an AM bundle). Detection mechanism already exists:
`getAlertmanagerStatus` (`directquery_prometheus_backend.ts:454-460`)
issues `GET /alertmanager/api/v2/status`, which the Routing page
already uses.

Probe shape, mirroring `prom_filter_probe.ts`:

```ts
type AmProbeResult =
  | { status: 'available' }
  | { status: 'unavailable'; reason: string };

createAlertmanagerProbe(promBackend, logger): AlertmanagerProbe;
```

Process-lifetime cache keyed on `dsId`, in-flight coalescing. Probe
fires on the first table fetch per `dsId` (lazy, not at startup —
same reasoning as the filter probe). Result cached for the plugin
process's lifetime.

Fallback when probe is `unavailable`:

- Use today's `/api/v1/alerts` + `getHistoricalAlerts` path unchanged.
- The UI surfaces a new fallback code so users know they're seeing the
  legacy behavior.

#### New fallback code

Add to the existing four:

- **`prometheus-alertmanager-unavailable`** — surfaced when the AM
  probe returns `unavailable` for a Prom datasource that's otherwise
  healthy. The table still works (legacy path); the user is told the
  silence / inhibition / receiver columns won't populate. UI treats it
  like the existing fallbacks: small callout above the table.

#### Concrete shape

##### Backend

`DirectQueryPrometheusBackend` already has `getAlertmanagerAlerts`
(`directquery_prometheus_backend.ts:362-372`) but it's currently
unused by the alerts table. Extend its signature with the AM filter
parameters:

```ts
async getAlertmanagerAlerts(
  client: AlertingOSClient,
  ds: Datasource,
  options?: {
    filter?: string[];           // raw matchers, e.g. ['severity="critical"', 'env=~"prod|stage"']
    active?: boolean;            // default true
    silenced?: boolean;          // default true (include silenced)
    inhibited?: boolean;         // default true
    unprocessed?: boolean;       // default false
    receiver?: string;           // regex match
    noCache?: boolean;
  }
): Promise<AlertmanagerAlert[]>;
```

The response is a richer shape than `PromAlert`. Add a new common
type `AlertmanagerAlert` (or extend the existing one) with:

- `labels: Record<string, string>`
- `annotations: Record<string, string>`
- `state: 'active' | 'suppressed' | 'unprocessed'`
- `startsAt: string`
- `endsAt: string`
- `fingerprint: string`
- `generatorURL: string`
- `receivers: Array<{ name: string }>`
- `status: { state: string; silencedBy: string[]; inhibitedBy: string[] }`

Map AM's `state` to `UnifiedAlertSummary.state`:

- `active` + no silence/inhibit → `active`
- `suppressed` with `silencedBy.length > 0` → new `silenced` value
  (already exists in the unified vocabulary;
  `unified_types.ts` has it for OS).
- `suppressed` with `inhibitedBy.length > 0` → new `inhibited` value
  (needs adding to the unified vocabulary — see "Type changes" below).
- `unprocessed` → drop (router hasn't seen it yet; transient).

Cache participation: AM responses go through a new
`alertmanagerAlertsCache: TtlCache<string, AlertmanagerAlert[]>` keyed
on `dsId`, separate from `alertsCache`. They're different shapes;
mixing them forces casts.

##### Service plumbing

In `alert_service.ts`'s `fetchAlertsRaw` (NEW lines 1082-1148, the
Prom branch), introduce a probe-then-dispatch:

```ts
if (ds.type === 'prometheus' && this.promBackend) {
  const amProbe = await alertmanagerProbe.probe(client, ds);

  if (amProbe.status === 'unavailable') {
    // Existing path unchanged. Surface fallback code for the new banner.
    const result = await fetchAlertsViaRulerOnly(...);
    return { ...result, fallback: 'prometheus-alertmanager-unavailable' };
  }

  // AM-primary path: AM call + (optional) rule listing for value backfill.
  const [amAlerts, ruleListingP] = await Promise.all([
    this.promBackend.getAlertmanagerAlerts(client, ds, amOptions),
    this.promBackend.getRuleGroups(client, ds, undefined, { includeAlerts: true })
       .catch((e) => { logger.debug(...); return [] as PromRuleGroup[]; }),
  ]);

  return {
    alerts: mergeAlertmanagerWithRuleValues(amAlerts, ruleListingP, ds.id),
    // No fallback under the happy path.
  };
}
```

The rule listing call benefits from `ruleGroupsCache` and is best-effort
(failure means we render rows without `value`, not an error). Keep
the existing range-merge semantics (current vs historical) — but note
that AM doesn't carry historical fingerprints, so historical alerts
still need the existing `getHistoricalAlerts` topk path. Worked
example:

| Range shape | Calls fired |
|---|---|
| No range | `getAlertmanagerAlerts` + `getRuleGroups` (cached) |
| `endIsNow=true` (e.g. now-7d → now) | `getAlertmanagerAlerts` (current) + `getHistoricalAlerts` (history) + `getRuleGroups` (cached). Merge by fingerprint, AM wins. |
| Past-only (e.g. now-2h..now-1h) | `getHistoricalAlerts` only. AM is current-state only. |

Filter pushdown applies *only to the AM call*. The historical-topk
query already takes filters via its `severity`/`labels`/`search` args
(`directquery_prometheus_backend.ts:367-396`), but it's a cardinality
cap, not a filter-pushdown contract.

##### UI surface changes

`UnifiedAlertSummary` (or a new optional sub-shape) gains:

```ts
interface AlertSuppression {
  silencedBy?: Array<{ id: string; comment: string; expiresAt: string; createdBy: string }>;
  inhibitedBy?: Array<{ fingerprint: string; alertname?: string }>;
}

interface UnifiedAlertSummary {
  ...existing...
  endsAt?: string;
  fingerprint?: string;
  receivers?: string[];     // AM receiver names
  suppression?: AlertSuppression;
}
```

All optional; OS path leaves them undefined. Phase 6 is additive on
the type; existing callers don't break.

**Table changes (`alerts_dashboard.tsx`):**

- New column: "Status" badges showing `silenced` / `inhibited` /
  `active` (replaces today's plain state column for Prom rows; OS
  rows continue to show only the existing state).
- Existing severity / state filters add a `silenced` / `inhibited`
  pseudo-state. Map to the AM `silenced=true&active=false` query
  param.
- The existing `state` filter mapping in `filter_mapping.ts:35-69` is
  the right place to encode the AM-vs-OS divergence; `silenced` and
  `inhibited` already exist as `UnifiedAlertState` values for OS, so
  the wire shape stays the same.

**Flyout changes (`alert_detail_flyout.tsx`):**

- New accordion: "Silences" — opens to the silence definition (pulled
  from `getAlertmanagerSilences`, already exists at
  `directquery_prometheus_backend.ts:411-417`). Lazy-load on accordion
  expand, same pattern as the Raw Data accordion (Phase 1).
- New accordion: "Inhibitions" — shows the parent alert's labels.
  Lazy-load.
- Existing "Notification Routing" accordion: for Prom alerts, populate
  from AM `receivers[]` instead of returning `[]`. Make this a tiny
  service change (`MultiBackendAlertService.getRuleRouting` Prom branch
  at `alert_service.ts:856-859`).

##### File-by-file change list (estimate)

Backend / service:
- `server/services/alerting/alertmanager_probe.ts` — new file,
  ~80 lines, mirrors `prom_filter_probe.ts`.
- `server/services/alerting/directquery_prometheus_backend.ts` —
  extend `getAlertmanagerAlerts` signature with filter options;
  introduce `alertmanagerAlertsCache`. ~50 lines diff.
- `server/services/alerting/alert_service.ts` — `fetchAlertsRaw` Prom
  branch swap; new `fetchAlertmanagerWithRuleValues` helper.
  `getRuleRouting` Prom branch surfaces AM receivers.
- `common/types/alerting/prometheus_types.ts` — `AlertmanagerAlert`
  shape (or refine the existing one).
- `common/types/alerting/unified_types.ts` — additive
  `endsAt` / `fingerprint` / `receivers` / `suppression` on
  `UnifiedAlertSummary`. Add `'inhibited'` to `UnifiedAlertState` if
  not already present (verify before adding).

Routes:
- No new routes. The wire surface doesn't change — `?` filters that
  already get parsed by `buildFetchOptionsFromQuery` flow into the AM
  matchers via `mapAlertFiltersToAm()` (a new pure helper sibling to
  `applyAlertFilters`).

Frontend:
- `public/components/alerting/alerts_dashboard.tsx` — Status column +
  silenced/inhibited badge rendering.
- `public/components/alerting/alert_detail_flyout.tsx` — two new
  lazy accordions.
- `public/components/alerting/filter_mapping.ts` — silenced/inhibited
  in the state mapping.

Tests:
- `alertmanager_probe.test.ts` — new.
- `alert_service.routing.test.ts` — new "AM-primary path" cases:
  AM available + rule join, AM unavailable fallback, range-shape
  behavior.
- `directquery_prometheus_backend.test.ts` — `getAlertmanagerAlerts`
  filter-forwarding cases, cache hit/miss, `noCache` bypass.
- `alert_detail_flyout.test.tsx` — silence/inhibition accordion
  expand fires correct calls.

#### Acceptance criteria

1. **Cold load with AM available** — open the alerts page with one
   Prom datasource. Network panel shows: one
   `/alertmanager/api/v2/alerts` call (filtered), one cached
   `/api/v1/rules` call (warm if rules table loaded recently). No
   `/api/v1/alerts`.
2. **Filter click — pushdown** — apply severity=critical. AM call
   fires with `filter[]=severity="critical"`. JS-post-filter still
   runs (correctness contract).
3. **Silenced badge** — silence one alert via the Silences UI; refresh.
   That alert renders with the silenced badge; the flyout's Silences
   accordion opens to the silence's definition.
4. **AM unavailable** — point at a Prom-only deployment without AM.
   Probe resolves to `unavailable`. Subsequent calls use
   `/api/v1/alerts` + `getHistoricalAlerts`. The UI shows the new
   `prometheus-alertmanager-unavailable` callout. No silence /
   inhibition / receiver columns.
5. **Historical range** — pick `now-7d → now`. AM provides current;
   `getHistoricalAlerts` provides historical fingerprints. Merge by
   fingerprint; AM wins for re-firing alerts.
6. **HA dedup** — point at an environment with two-replica rulers and
   one AM. Each alert appears once (AM dedupes by fingerprint). Old
   path showed duplicates.
7. **Phase 1-5 acceptance criteria still hold.** OS path unchanged,
   timeline / facets / pagination / refresh-button cache bypass all
   continue to work.

#### Risk register

- **AM filter-pushdown surprises.** AM's matcher language is similar
  to PromQL but not identical (no `__name__`, restricted regex
  semantics on some versions). Mitigation: post-filter via
  `applyAlertFilters`, same correctness contract as Phase 3's rule
  detail. Cost is a JS scan over the *filtered* result.
- **`receivers[]` semantics.** AM's response includes the *resolved*
  receiver list at request time. If the routing tree changes between
  the table fetch and the flyout open, the flyout could show a
  different set than the table did. Acceptable — it's the freshest
  truth from AM at flyout time. Document.
- **AM v2 schema variance.** Older AM versions expose v1 (`/api/v1/alerts`,
  not the same as Prom's `/api/v1/alerts`!). The probe at
  `/api/v2/status` differentiates: a 404 on v2 means downgrade to v1
  shape OR fall through to ruler-only. For Phase 6, treat v1-only AM
  as `unavailable` — Cortex/AMP/recent AM all expose v2. Document the
  limitation; revisit if a real-world v1-only deployment surfaces.
- **`inhibited` state addition.** Extending `UnifiedAlertState` to
  include `'inhibited'` is a wire-shape change. Verify that the OS
  path's state mapping doesn't break; add the new value as a
  Prom-only state (OS doesn't have inhibition).
- **Documentation drift.** `ARCHITECTURE.md` §3 / §6 / §7 / §8 will all
  need updates after this lands. Add a sub-task to the implementation
  ticket.

#### Out of scope for P6.1

- Migrating the *Routing* page to use AM v2 differently. Today it
  already uses AM v2 (`getAlertmanagerStatus`). No change.
- Showing per-alert *route trace* (which AM route node matched).
  AM doesn't expose this in the alert response; it requires a
  separate `/api/v2/status` config tree walk client-side. Defer.
- Acknowledge / silence-create flows for Prom alerts. Today the OS
  path has acknowledge; Prom has neither. Adding silence-create from
  the table flyout is a UX-meaningful follow-up; defer to a later
  item below.

---

### P6.2 — Always pass `?type=alert` on the Prom rules listing

Pass `?type=alert` unconditionally on the listing-path call to
`/api/v1/rules` so recording rules don't bloat the response.

#### Why

`fetchRulesRaw` (`alert_service.ts:1173-1182`) walks the response and
keeps only `r.type === 'alerting'`:

```ts
for (const r of g.rules) {
  if (r.type === 'alerting') results.push(promRuleToUnified(r, g.name, ds.id));
}
```

Recording rules are dropped at the JS layer. But the upstream
`/api/v1/rules` call we make today doesn't pass `?type=alert` on cold
load — `buildPromRuleFilter` (`alert_service.ts:1097-1108`) only
returns a filter when the user has a severity / state / labels filter
applied, and `?type=alert` rides along on that filter object.

In production deployments that use recording rules to pre-aggregate
metrics for dashboards (the common shape), recording rules outnumber
alerting rules by ~10×. The cold-load wire payload is therefore
~90% data we throw away.

Pushing `?type=alert` to the upstream:
- Reduces wire bytes proportionally.
- Reduces Cortex's serialization work (fewer rules to render).
- Reduces the `mapRule` cost on the plugin side (we map only what we'll
  keep).

#### What's lost (and how to backfill)

Nothing. The JS post-filter at line 1181 keeps the correctness
contract: even on a Cortex / Prom version that silently ignores
`?type=alert` (older than Prom 2.40 / Cortex 1.13), the same
`r.type === 'alerting'` filter runs and produces the same result. So
the win is purely a payload reduction on supporting upstreams; on
non-supporting upstreams the behavior is unchanged.

This is a strict subset of the Phase 3 filter-probe pattern: the probe
exists to gate `?rule_group=&rule_name=` pushdown (where wrong-result
risk exists if an upstream half-honors filters); `?type=alert` has no
wrong-result mode — it's accept-or-ignore. So no probe needed.

#### Concrete shape

`buildRulesPath` in `directquery_prometheus_backend.ts:592-616` is the
single point that constructs the URL. Today:

```ts
private buildRulesPath(filter?: PromRuleGroupsFilter): string {
  if (!filter) return '/api/v1/rules';
  const params: string[] = [];
  if (filter.ruleGroup) params.push(`rule_group=${encodeURIComponent(filter.ruleGroup)}`);
  if (filter.ruleName) params.push(`rule_name=${encodeURIComponent(filter.ruleName)}`);
  if (filter.file) params.push(`file=${encodeURIComponent(filter.file)}`);
  if (filter.type) params.push(`type=${encodeURIComponent(filter.type)}`);
  return params.length === 0 ? '/api/v1/rules' : `/api/v1/rules?${params.join('&')}`;
}
```

Change so the listing path always sends `type=alert`. Two options:

**Option A:** unconditionally add `type=alert` in `buildRulesPath` when
`filter?.type` is undefined. Keeps the call-site signatures clean.
Risk: rule-detail callers that pass `{ includeAlerts: true }` without
a `type` would also get `type=alert` — fine, since rule-detail only
cares about alerting rules anyway.

**Option B:** make `fetchRulesRaw` always construct a `{ type: 'alert' }`
filter even on cold load. More explicit at the call site; doesn't
change the backend default.

Go with **Option A.** It's a one-line change in `buildRulesPath`, and
it makes the cache key invariant correctly: the unfiltered listing
fetches a strictly smaller set than today's, but `getRuleGroups`'s
cache key is still `dsId` only (`isCacheableRuleFilter` accepts a
`type`-only filter at line 217-221). One cache slot, smaller payload.

```ts
private buildRulesPath(filter?: PromRuleGroupsFilter): string {
  const params: string[] = [];
  if (filter?.ruleGroup) params.push(`rule_group=${encodeURIComponent(filter.ruleGroup)}`);
  if (filter?.ruleName) params.push(`rule_name=${encodeURIComponent(filter.ruleName)}`);
  if (filter?.file) params.push(`file=${encodeURIComponent(filter.file)}`);
  // type=alert is the unified-listing contract: we never render recording
  // rules (the JS post-filter at fetchRulesRaw drops them anyway), so
  // pushing the filter to the upstream cuts ~90% of payload on
  // recording-rule-heavy deployments. Older upstreams that don't honor
  // the param silently return the full set; the post-filter still
  // produces the correct output.
  const type = filter?.type ?? 'alert';
  params.push(`type=${encodeURIComponent(type)}`);
  return `/api/v1/rules?${params.join('&')}`;
}
```

The `prom_filter_probe` baseline call at `prom_filter_probe.ts:51`
already passes `{ type: 'alert' }`, so the probe shape is unaffected.

#### File-by-file change list

- `server/services/alerting/directquery_prometheus_backend.ts` —
  `buildRulesPath` always emits `type=`. ~5 lines diff.
- `server/services/alerting/__tests__/directquery_prometheus_backend.test.ts`
  — update URL-construction tests. ~10 lines diff.

No service / route / frontend changes.

#### Acceptance criteria

1. **Cold load on a recording-rule-heavy deployment** — open the rules
   page with a Prom datasource that has 1k alerting rules and 10k
   recording rules. Network panel: one call to
   `/_plugins/_directquery/_resources/{ds}/api/v1/rules?type=alert`.
   Response is the alerting-only set; the page renders correctly.
2. **Behavior on older upstreams** — point at a Prom < 2.40 / Cortex <
   1.13 (or simulate via mock that ignores the param). Response
   includes recording rules; JS post-filter drops them. Page renders
   identically.
3. **Cache reuse** — listing call fires, then opening the rules page
   again within 30s reuses the cached response. Detail flyout opens
   on a rule visible in the listing — uses the same cached set when
   the probe says pushdown is unavailable, OR sends a scoped
   `?rule_group=&rule_name=&type=alert` when pushdown works (Phase 3
   path unchanged).
4. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **None significant.** This is a pure narrow-the-upstream-set change
  with a correctness-equivalent JS post-filter as backstop.

#### Out of scope

- Pushing `?type=` from elsewhere in the codebase. The probe and
  detail path already pass it; this item is about the listing path.
- `?file=` pushdown for workspace-scoped datasources — that's a
  separate item (would need its own probe, since older upstreams
  may not honor it).

---

### P6.3 — Strip `query` and trim `description` from the rules listing payload

Drop the heavy fields from `UnifiedRuleSummary` on the listing path.
The rules table doesn't render them; the rule flyout fetches them on
demand via `getRuleDetail`.

#### Why

`promRuleToUnified` (`alert_utils.ts`) populates every
`UnifiedRuleSummary` with:
- `query` — the rule's full PromQL expression. Often 100-300 chars.
- `description` — pulled from `annotations.description` /
  `annotations.summary`. Often 200-1000 chars including templated
  Go expressions.

Neither is rendered on the rules page. The table columns
(`monitors_table_columns.tsx`) show: name, severity, status, health,
monitor type, eval interval, last triggered. The query and full
description only surface in the **rule detail flyout**, which already
fetches the full `UnifiedRule` shape via
`/api/alerting/rules/{dsId}/{ruleId}` on flyout open
(`monitor_detail_flyout.tsx:215-234`).

So we're paying wire bytes for the listing on every cold load and
every refresh, when the bytes only matter when the user opens a
specific rule. For 10k rules at ~500 bytes of `query` +
`description` per row, that's **~5 MB of payload that nothing renders**.

The OS path has the same issue (the OS `_search` returns full triggers
including their condition scripts), but the win is smaller because OS
doesn't have annotations and the trigger script is the actionable
display. Scope this item to **the Prom path**, where the win is
clearest and the alternative payload (load on flyout open) already
exists.

#### What's lost (and how to backfill)

The mapped `UnifiedRuleSummary` for Prom on the listing path drops:
- `query: ''` — empty string instead of the PromQL expression.
- `description: ''` (or a truncated stub like the first 120 chars of
  `annotations.summary`).

Anywhere the listing-path consumer reads these fields and renders
them, we'd lose data. Auditing the consumers:

| Consumer | Reads `query`? | Reads `description`? |
|---|---|---|
| `monitors_table_columns.tsx` | No | No (only the `name` and a tooltip; the tooltip uses `description` if present — see below) |
| `alarms_page.tsx` `fetchRules` callback | No | No |
| `useRulesFacets` / `computeRuleFacets` | No | No |
| `monitor_detail_flyout.tsx` | Yes — but it consumes from `getRuleDetail`'s response, not from the listing summary it was opened from | Yes — same |
| `mapRuleFilters` / `applyRuleFilters` | No | No (`search` matches over `name` + label values, not `description` or `query`) |

The one ambiguous case is **the table tooltip**. Verify before shipping
whether the table renders a tooltip from `description` on the row;
if it does, either keep the first 120 chars of `description`
(reasonable tooltip length) or drop the tooltip and rely on the
flyout for full text. Recommendation: **truncate to 120 chars on the
listing**; full text comes from the flyout.

`query` has no tooltip / preview consumer on the listing — drop it
entirely.

#### Concrete shape

Two seams to choose from, mirroring Phase 3's analysis for `alerts[]`:

**Option A — Strip in `promRuleToUnified`** (the mapper). Add an
optional `lightweight` flag; when `true`, set `query: ''` and
truncate `description`. Cleanest.

**Option B — Strip in `mapRule`** (the upstream parser). Same
location Phase 3 used for `alerts[]` — but the mapping from
`PromAlertingRule` → `UnifiedRuleSummary` happens in `alert_utils.ts`,
not in `mapRule`. So this option doesn't quite apply; `mapRule`
produces the intermediate `PromAlertingRule` shape.

Go with **Option A.** Add `{ lightweight?: boolean }` to
`promRuleToUnified`'s signature, pass `true` from `fetchRulesRaw`,
leave the detail path's call (which goes through `getPromRuleDetail`
in `alert_detail.ts:163`) using the default (full).

```ts
// alert_utils.ts
export function promRuleToUnified(
  rule: PromAlertingRule,
  groupName: string,
  dsId: string,
  options?: { lightweight?: boolean },
): UnifiedRuleSummary {
  const desc =
    rule.annotations.description ||
    rule.annotations.summary ||
    '';
  const truncatedDesc = options?.lightweight
    ? (desc.length > 120 ? desc.slice(0, 117) + '…' : desc)
    : desc;
  return {
    ...existingFields,
    query: options?.lightweight ? '' : rule.query,
    description: truncatedDesc,
  };
}

// alert_service.ts fetchRulesRaw — line 1180
for (const r of g.rules) {
  if (r.type === 'alerting') {
    results.push(promRuleToUnified(r, g.name, ds.id, { lightweight: true }));
  }
}
```

The detail-path caller in `alert_detail.ts:200`
(`getPromRuleDetail` → `promRuleToUnified(alertingRule, group.name, ds.id)`)
keeps no options — full shape.

#### File-by-file change list

- `server/services/alerting/alert_utils.ts` — `promRuleToUnified`
  signature gains optional `{ lightweight }`. ~10 lines diff.
- `server/services/alerting/alert_service.ts` — `fetchRulesRaw` Prom
  branch passes `{ lightweight: true }`. ~3 lines diff.
- `server/services/alerting/__tests__/alert_utils.test.ts` —
  add cases for the lightweight shape.
- `server/services/alerting/__tests__/alert_service.routing.test.ts`
  — assert the listing path emits empty `query` and truncated
  `description`.
- `public/components/alerting/monitors_table/monitors_table_columns.tsx`
  — verify no consumer breaks. If a tooltip currently renders
  `description`, this still works (truncated text is fine for a
  tooltip).

No frontend logic changes; no route changes.

#### Acceptance criteria

1. **Listing payload size** — eyeball-compare `/api/alerting/unified/rules`
   response size before vs after on a Prom datasource with 1k+ rules.
   Expect significant reduction (target: 60-80% smaller for the
   alerting-rule slice, depending on how much annotation text the
   deployment uses).
2. **Table renders identically** — no visible changes on the rules
   table. Severity / status / health / type / eval interval / last
   triggered all populate as before.
3. **Detail flyout still has full text** — open a rule flyout. The
   PromQL expression and full description render correctly via
   `getRuleDetail`.
4. **Search push-down still works** — search filter targets `name`
   and label values, not `description` or `query` (verify in
   `applyRuleFilters` at `alert_service.ts:249-258`). Truncating
   description doesn't change search behavior.
5. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **Tooltip / inline description regression.** If a future code path
  starts rendering `description` on the listing (e.g. inline preview
  in the table), the truncation will be visible. Add a test that
  asserts the listing-path `description` is bounded to 120 chars; a
  future change that needs full text has to opt out of `lightweight`,
  which is intentional friction.
- **Search-mismatch surprise.** Today's `applyRuleFilters` search
  doesn't match `description` (verified above). If a user expects
  search to find rules by their description text, they'd need the
  flyout. This is the existing behavior — note it in the doc.

#### Out of scope

- Stripping the OS rules listing. Smaller win, harder to scope (OS
  triggers carry the actionable script — closer to "always-shown" than
  Prom annotations are).
- Server-side response compression. Would help wire bytes generally
  but doesn't address Cortex's serialization work.

---

### P6.4 — TBD (placeholder)

(To be filled in.)

---

## Future additions

This section is intentionally open. Append items as they're identified.
Each item should follow the P6.1 layout: **why**, **what's lost**,
**concrete shape**, **acceptance criteria**, **risk register**,
**out of scope**. That structure forces the writer to think through
fallbacks and tradeoffs before implementation, which is what kept the
five earlier phases on rails.

Suggested item template:

```markdown
### P6.X — <one-line summary>

#### Why
…

#### What's lost (if anything) and how to backfill
…

#### Concrete shape
##### Backend
…
##### Service plumbing
…
##### UI surface changes
…
##### File-by-file change list (estimate)
…

#### Acceptance criteria
1. …

#### Risk register
- …

#### Out of scope
- …
```

## Verification (any item)

```bash
# From plugin dir
nvm use
yarn test path/to/touched/file.test.ts
yarn lint:es
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

If pre-commit hits the `@osd/optimizer` LMDB error, kill any running
`yarn start`, clear `data/optimize-cache/`, and retry. Don't bypass
hooks without confirming.

## Handoff template (any item)

When an item lands, leave a one-paragraph status note covering:

- Item id and which sub-pieces shipped vs deferred.
- Deviations from this plan and why.
- Test status. Confirm prior phases' acceptance criteria still pass.
- Live UI validation results.
- Any docs updates required (especially `ARCHITECTURE.md` §3 / §6 / §7
  / §8 for P6.1).
- Commit hash(es), branch name (`alert-manager-phase-6`), base
  (`alert-manager-phase-5`).
- Confirmation that `yarn start` is killed.
