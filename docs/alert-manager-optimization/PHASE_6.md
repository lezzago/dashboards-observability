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

### P6.4 — Reuse the rules-listing cache for rule-detail flyouts

The rule flyout's detail call asks for `{ includeAlerts: true }`,
which today bypasses `ruleGroupsCache` entirely. Result: every flyout
open on the `pushdown-ignored` path costs a fresh upstream
`/api/v1/rules` round-trip even when the rules table loaded the
listing 10 seconds ago. Fix by separating "list rules" from "list
each rule's alerts" so the listing portion can hit the cache.

#### Why

`getRuleGroups` (`directquery_prometheus_backend.ts:208-221`) gates
caching on three conditions:

```ts
const cacheable = !options?.noCache && !includeAlerts && this.isCacheableRuleFilter(filter);
if (!cacheable) return fetcher();
return this.ruleGroupsCache.get(ds.id, fetcher);
```

`!includeAlerts` means: if the caller wants the embedded `alerts[]`
on each rule, skip the cache. Why? Because the cache value type is
`PromRuleGroup[]` and the cache key is `dsId` only. A cached entry
with stripped `alerts[]` (the listing path's shape) can't satisfy a
caller that needs `alerts[]` populated. Storing two value variants on
the same `dsId` key would force casts everywhere or split the cache.

The unintended consequence: **rule-detail flyouts that fall back to
the unfiltered listing path** (the `pushdown-ignored` case, which
includes the local Cortex used for development and many older
production deployments) **pay a full upstream round-trip every flyout
open**, even though the rules-page listing just fetched essentially
the same data.

Sequence on a Cortex-without-pushdown deployment:

1. User loads the rules page. Listing call →
   `getRuleGroups(ds, undefined, { lightweight, no includeAlerts })`
   → cache miss → upstream `/api/v1/rules` → cache populated.
2. User clicks a rule. Detail call →
   `getRuleGroups(ds, undefined, { includeAlerts: true })` →
   `cacheable = false` → upstream `/api/v1/rules` AGAIN. Even though
   the table just got 99% of the same data.
3. User clicks another rule. Detail call → upstream `/api/v1/rules`
   AGAIN. And so on.

Three flyout opens within the cache TTL ⇒ four upstream calls. The
right answer is one.

The Prom alerting-rule alert history (`AlertHistoryEntry[]` in the
flyout) is built from `rule.alerts[]` at `alert_detail.ts:203-208`.
The rest of the flyout's data comes from the rule's own fields
(`name`, `query`, `labels`, `annotations`, `state`, `health`,
`lastEvaluation`, `evaluationTime`) — all of which the listing
already has. So `alerts[]` is the *only* field that justifies the
cache bypass.

#### What's lost (and how to backfill)

Nothing on the user-visible side. The flyout still gets the same
data; the only change is *where* it comes from.

#### Concrete shape

Two seams to choose from. Both have the same on-the-wire effect; the
implementation cost differs.

**Option A — Two-layer fetch, single cache.** Rebuild the detail-path
to call `getRuleGroups(ds, filter, { lightweight: true })` (cached)
to get the rule's metadata, then issue a separate, scoped call for
the alerts of *that one rule*. The "alerts of one rule" call is
either:

- A separate Prom API call: there isn't a clean `/api/v1/alerts?rule=`
  endpoint. The closest is `/api/v1/alerts` filtered by alertname JS-side,
  but `/api/v1/alerts` is current-firing only — it'd lose the rule's
  full alert history (which the flyout shows in the "Alert History"
  table, including resolved alerts).
- Re-fetch the rule with `?rule_group=&rule_name=&includeAlerts`
  via the pushdown path. But this only works when the probe says
  pushdown works — exactly the case where caching matters less
  because the pushdown call is already O(1).

The fundamental problem with Option A: **Prom doesn't expose
"alerts for one rule" as a separate API**. The `alerts[]` array is
embedded in `/api/v1/rules` responses; there's no GET-by-rule
shortcut. So Option A degenerates into "either pushdown or full
listing" — same shape we have today.

**Option B — Two caches, separated by `includeAlerts` shape.** Add
a second cache:

```ts
readonly ruleGroupsCache: TtlCache<string, PromRuleGroup[]>;            // existing — alerts[] stripped
readonly ruleGroupsWithAlertsCache: TtlCache<string, PromRuleGroup[]>;  // NEW — alerts[] populated
```

`getRuleGroups` chooses which cache to hit based on `includeAlerts`:

```ts
const cache = options?.includeAlerts ? this.ruleGroupsWithAlertsCache : this.ruleGroupsCache;
const cacheable = !options?.noCache && this.isCacheableRuleFilter(filter);
if (!cacheable) return fetcher();
return cache.get(ds.id, fetcher);
```

Both caches share the same 30s TTL. Detail flyouts opened in close
succession reuse the second cache; the rules-page listing reuses the
first.

**Tradeoffs:**

- The second cache duplicates wire bytes vs the first (full payload
  including `alerts[]`). For the same `dsId`, two cache entries
  briefly coexist within the 30s window — once each per flyout-shape
  vs listing-shape. Memory cost: bounded by `dsId` count × 2 caches
  × payload size. Acceptable; the full payload is what `/api/v1/rules`
  returned anyway.
- **First flyout open after rules-page load is still a cache miss.**
  The two caches don't share entries (different value shapes). What
  improves is the *second* and subsequent flyout opens — those reuse
  the new cache. So the win is "successive flyout browsing" not
  "first flyout after listing."
- **Refresh-button invalidation needs to invalidate both caches.**
  Today `noCache=1` invalidates `ruleGroupsCache` for the listing
  path; the detail path doesn't go through the same flag because it
  always bypassed cache. Add invalidation symmetry: refresh button
  invalidates both `ruleGroupsCache` and `ruleGroupsWithAlertsCache`
  for the affected `dsId`.

Go with **Option B.** Pure additive. The duplication is real but
small (≤ 2 cache entries per `dsId`).

**Option C — Keep one cache, store both shapes per entry.** Cache
value becomes `{ stripped: PromRuleGroup[]; full: PromRuleGroup[] }`,
populated lazily — first call populates one shape, second call
(opposite shape) populates the other. The first shape's data isn't
re-fetched when the second is requested *if* we accept that the full
shape can be derived from the stripped shape + a separate fetch. But
again, "separate fetch" doesn't exist for `alerts[]` — so this
option doesn't actually save an upstream call vs Option B.

Option B wins on simplicity.

#### File-by-file change list

- `server/services/alerting/directquery_prometheus_backend.ts`:
  - Add `ruleGroupsWithAlertsCache` instance alongside the existing
    `ruleGroupsCache` (~3 lines).
  - `getRuleGroups` selects cache based on `includeAlerts` (~5 lines).
  - On `noCache`, invalidate both caches for the `dsId` (~2 lines).
- `server/services/alerting/__tests__/directquery_prometheus_backend.test.ts`:
  - Cache-hit tests for both shapes; cross-cache isolation; noCache
    invalidates both. ~30 lines.

No service / route / frontend changes.

#### Acceptance criteria

1. **Rules table → flyout → flyout (Cortex without pushdown)**
   Open the rules page. Open one rule flyout. Close it. Open another
   rule flyout. Network panel: the second flyout open issues a
   plugin-route call but **no upstream `/api/v1/rules`** call (cache
   hit on `ruleGroupsWithAlertsCache`). Today: every open is an
   upstream call.
2. **Rules table → flyout (cold)** — first flyout open after a
   listing load still pays one upstream call (the two caches are
   independent — same as today, no regression).
3. **Refresh button** — refresh from the rules page invalidates both
   caches; subsequent flyout open re-fetches.
4. **Pushdown path unaffected** — when the probe says
   `pushdown-works`, flyouts go through the scoped
   `?rule_group=&rule_name=` path. That path is uncached because
   it carries a non-cacheable filter shape (per `isCacheableRuleFilter`).
   No change.
5. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **Memory growth from the second cache.** Each `dsId` can hold up
  to 2 cache entries × full payload. For a deployment with 10
  Prom datasources × 10k rules × 200 bytes/rule (full shape including
  `alerts[]`), that's ~40 MB across both caches. Acceptable for a
  Node process; if it ever isn't, add an LRU bound to `TtlCache`.
- **Stale `alerts[]` after a rule fires.** A flyout opened 25s after
  a listing load may show alert state that's 25s out of date — same
  staleness window as today's listing cache. The Refresh button
  invalidates. Document.
- **Probe interaction.** The filter probe baseline call passes
  `?type=alert` only (no `includeAlerts`), so it hits the existing
  cache. The probe scoped call passes `?rule_group=&rule_name=&type=alert`
  which is uncached either way. No change.

#### Out of scope

- A unified single cache with shape-aware reuse. Conceptually nicer
  but the upstream API doesn't expose a shape-conversion path
  (`alerts[]` can't be derived from a stripped response).
- `noCache` per-flyout. The detail handler currently doesn't expose a
  refresh path; adding one is a UX change, not a perf change. Defer.

---

### P6.5 — Replace the rule flyout's "Alert History" with a sparkline + AM current-active list

The Prom rule flyout's "Alert History" panel today is mislabeled —
it's currently-active alert instances from `rule.alerts[]`, not
history. Replace it with a count-over-time sparkline (genuine
history, bounded cardinality) plus a current-active list sourced
from Alertmanager (richer than today's payload — adds silence,
inhibition, receivers).

#### Why

The flyout's "Alert History" panel is built from `rule.alerts[]`
embedded on the `/api/v1/rules` response (`alert_detail.ts:203-208`).
That array is **not** historical:

- It contains currently-active alert instances per rule (`firing` +
  `pending` states).
- When an alert resolves and Prom's resolved-alert-retention window
  closes (typically 15min), the entry disappears.
- One row per active label-set: a rule alerting per-pod across 5000
  pods returns up to 5000 entries.

Two consequences:

1. **The label is wrong.** Users opening "Alert History" expecting
   "what fired this week" see an empty panel for any rule that's
   currently quiet, even if it fired heavily yesterday.
2. **The cost is bounded by current-active cardinality, not
   historical volume — but that bound can still be large.** A rule
   with thousands of currently-active label-sets returns thousands
   of entries every flyout open. Bounded ≠ cheap.

A genuine "alert history" view needs two different things, and
neither maps cleanly to today's panel:

- **A sense of how often this rule fired over time.** A scalar count
  per time bucket, not per-instance.
- **What's firing right now, with full context.** Including silences
  / inhibitions / receivers — not just labels and the timestamp the
  rule first turned on.

This item replaces the single panel with two purpose-built pieces.

#### What's lost (and how to backfill)

The old per-active-instance list — labels, `activeAt`, `value`,
`message` — is replaced by:

| Old field | New source | Notes |
|---|---|---|
| Per-instance row | AM current-active list (Option C) | Same per-label-set granularity for currently-firing alerts. AM retains alerts ~5min past resolution; older instances are not in AM either. |
| `value` (numeric trigger value) | AM doesn't carry this | Backfill from `rule.alerts[]` via the rules-detail call we already make (the call already runs with `includeAlerts: true` for the existing flyout, so the data is already in hand). Join by label fingerprint. |
| `activeAt` | AM `startsAt` | Approximation — AM `startsAt` is set when AM first received the alert, close to `activeAt`. Acceptable. |
| Resolved-alert visibility (was 0–15min for Prom, 0–5min for AM) | Sparkline shows the resolved alerts implicitly via the count drop | Per-instance drilldown for resolved alerts is gone unless the user clicks "Show episode history" (opt-in, Option B from the discussion above — out of scope for P6.5; deferred to a future item). |

Net: users gain a real over-time sense of the rule's activity AND the
operationally-critical silence/inhibition info; they lose
per-resolved-instance drilldown for the past 15min. Acceptable
tradeoff — the panel was already empty for any alert resolved past
that window.

#### Concrete shape

Two new flyout sub-panels replacing the existing "Alert History"
accordion:

##### 1. Sparkline (Option D from the discussion)

Bar chart, severity-stacked, over the picker's range. Source:

```
POST /api/v1/query_range
{
  "query": "count(ALERTS{alertname=\"<rule.name>\", alertstate=\"firing\"})",
  "start": <pickerStart>,
  "end": <pickerEnd>,
  "step": <derived>
}
```

Cardinality: 1 series. Sample count: `range / step`, target ~200
samples per the existing convention. Cost is constant in
historical volume.

When the rule has a per-severity differentiation (rules whose
`alertname` repeats across severity levels), use:

```
sum by(severity) (ALERTS{alertname="<rule.name>", alertstate="firing"})
```

≤ 5 series. Same shape as the alerts-page timeline endpoint
(`alert_timeline.ts:438-441`). **Reuse the existing
`fetchPromTimelineBuckets` helper** with the rule's `alertname` as a
matcher — no new server-side aggregation logic needed.

Renders as a stacked bar chart, 12-24 buckets, same visual style as
`AlertTimeline` on the alerts page (`alerts_charts.tsx:83-155`). The
sparkline is read-only (no click-to-drill); future work could wire
bar-clicks to the alerts table filtered by alertname.

##### 2. Current-active list (Option C from the discussion)

Below the sparkline, a table of alerts currently firing for this
rule. Source — when AM is available (P6.1's probe says yes):

```
GET /alertmanager/api/v2/alerts?filter=alertname="<rule.name>"&active=true&silenced=true&inhibited=true
```

Filter pushdown is native to AM v2 (it accepts label matchers,
including `alertname`). The response contains:

- Currently firing or recently-resolved-within-AM-retention alerts
  matching the rule.
- Silence info on each alert (`status.silencedBy[]`, with full silence
  records joinable via `getAlertmanagerSilences`).
- Inhibition info (`status.inhibitedBy[]` listing parent fingerprints).
- Receiver list (`receivers[].name`).
- `endsAt` (resolution horizon).

Rendered as a table with columns: labels, severity, started at,
duration, silenced (badge), inhibited (badge), receivers. Click on
silenced badge → mini-popup with silence details. Click on receivers →
the existing routing accordion.

**When AM is unavailable** (P6.1's probe says no): fall back to the
existing `rule.alerts[]` from the rules-detail call. Render the same
table without the silence / inhibition / receivers columns. Surface
the existing `prometheus-alertmanager-unavailable` callout (added by
P6.1) above the panel so users know they're seeing the legacy view.

##### Per-rule AM matcher generation

The matcher needs to identify the right alertname; the rule's other
labels (e.g. `severity`) are NOT used as matchers because the
flyout-as-a-whole is about the rule, not a specific alert instance.
So:

```ts
function buildRuleAlertmanagerFilter(rule: PromAlertingRule): string[] {
  return [`alertname="${escapeAmMatcherValue(rule.name)}"`];
}
```

If the rule's `alertname` collides with another rule (rare but
possible — same alertname in different groups), the AM response will
include both. Acceptable for the per-rule view; users see what AM
considers this alertname's instances. Document as a known limitation.

##### File-by-file change list

**Backend / service:**

- `server/services/alerting/directquery_prometheus_backend.ts` —
  no changes; reuses existing `getAlertmanagerAlerts` (extended by
  P6.1) and existing `queryRangeMatrix`. ~0 lines.
- `server/services/alerting/alert_service.ts` — extend
  `getRuleDetail` to include sparkline buckets + AM current-active
  alerts in the response. Or — recommended — leave `getRuleDetail`
  unchanged and add **two new lazy endpoints** the flyout calls
  separately on mount:
  - `GET /api/alerting/rules/{dsId}/{ruleId}/sparkline?startTime=&endTime=`
  - `GET /api/alerting/rules/{dsId}/{ruleId}/active-alerts`

  Lazy keeps the detail call cheap and lets each piece error
  independently — same pattern as Phase 3's `/routing` endpoint.
  ~80 lines diff for the two handlers + service methods.
- `server/routes/alerting/index.ts` — register the two new routes,
  reuse the existing `validateDateMath` validators. ~30 lines.
- `server/routes/alerting/handlers.ts` — `handleGetRuleSparkline`
  and `handleGetRuleActiveAlerts` thin wrappers. ~40 lines.

**Frontend:**

- `public/components/alerting/query_services/alerting_opensearch_service.ts`
  — `getRuleSparkline` / `getRuleActiveAlerts` methods. ~30 lines.
- `public/components/alerting/hooks/use_rule_sparkline.ts` (new) —
  fetches sparkline buckets, mirrors `use_alerts_timeline.ts`'s
  abort + monotonic-request-id guard. ~80 lines.
- `public/components/alerting/hooks/use_rule_active_alerts.ts` (new)
  — fetches AM current-active list. ~80 lines.
- `public/components/alerting/monitor_detail_flyout.tsx` —
  replace the existing "Alert History" accordion content with the
  sparkline (always rendered) + current-active table. ~100 lines.
- `public/components/alerting/alerts_charts.tsx` — extract a
  reusable sparkline variant of `AlertTimeline` if shape differs;
  ideally just pass a single-color spec. ~20 lines.

**Tests:**

- `alert_service.routing.test.ts` — sparkline / active-alerts
  service paths. AM-available, AM-unavailable, alertname matcher
  escaping.
- New hooks `__tests__/`.
- `monitor_detail_flyout.test.tsx` — assert the new accordion
  content + the AM-unavailable fallback rendering.

#### Acceptance criteria

1. **Sparkline renders for a rule** — open a Prom rule flyout for a
   rule that fired several times over the picker window. The
   sparkline shows bars at the firing times, with severity stacking
   when applicable. Cold load: one upstream `query_range` call, ≤ 200
   samples.
2. **Current-active list (AM available)** — the rule has 3 alerts
   currently firing, 1 silenced. The table shows 4 rows; the silenced
   one has a badge. Network panel: one
   `/alertmanager/api/v2/alerts?filter=alertname=...` call.
3. **Current-active list (AM unavailable)** — point at a Prom-only
   deployment without AM. Probe resolves to `unavailable`. The
   current-active table renders from `rule.alerts[]` (already in the
   detail response), with no silence / inhibition / receiver columns
   and the new fallback callout above.
4. **Sparkline cost is bounded** — open a flyout for a rule that
   fired 100k times over 7 days (test fixture). Sparkline call is
   1 series × ~200 samples regardless of historical volume.
5. **Current-active is bounded by current cardinality, not history**
   — same rule's current-active table shows however many label-sets
   are firing right now (typically dozens, not 100k).
6. **Picker change updates the sparkline** — change the time range;
   sparkline re-fetches with the new window. Current-active list
   does NOT re-fetch (it's "right now" by definition).
7. **Refresh button** — invalidates both calls; sparkline + table
   re-fetch with `noCache=1` flowing through to the AM call.
8. **Phase 1-5 acceptance criteria still hold.**
9. **Phase 6 P6.1 + P6.4 must land first** — P6.5 depends on P6.1
   for the AM probe + filter shape, and benefits from P6.4's
   includeAlerts cache for the legacy fallback.

#### Risk register

- **Alertname collision.** Two rules with the same `alertname` in
  different groups (rare but happens) means the per-rule AM filter
  returns both rules' alerts mixed together. Mitigation: AM v2's
  filter param accepts multiple matchers; we could add the rule's
  `severity` label to disambiguate when set, but most rules don't
  have a unique-by-severity label-set. Document as a limitation in
  the flyout copy when collision is detected.
- **Sparkline cost on huge ranges.** A user picking "now-90d → now"
  on a rule that fires every minute is 90 × 1440 = ~130k samples
  before step downsampling. `step` derived from `pickBucketCount`
  keeps the sample count at ~200 regardless. Verify the sparkline
  hook uses the same step-derivation as the alerts-page timeline.
- **AM `resolve_timeout` confuses users.** The current-active list
  shows alerts up to ~5min after resolution (AM retention). A user
  may see a row labeled "resolved 4min ago" and wonder why other
  resolved alerts aren't there. Add a footer note: "Showing
  currently active and recently resolved (last 5min). For older
  events, see the sparkline above."
- **The two new endpoints are flyout-only.** The rules table doesn't
  use them. Don't add them to the unified listing surface — they're
  per-rule by design.
- **Documentation drift.** `ARCHITECTURE.md` §6.3 (rule flyout)
  describes the current `alerts[]`-driven panel. After P6.5 lands,
  update §6.3 + §10 (key file index) to mention the two new
  endpoints + hooks.

#### Out of scope for P6.5

- **"Show episode history" button (Option B from the discussion).**
  The opt-in `last_over_time` per-episode walk for genuine
  per-instance history. Defer to a future item; P6.5's sparkline +
  current-active covers the dominant operator use cases. The episode
  walk is for forensic deep-dives on specific incidents.
- **Click-to-drill on sparkline bars.** Wiring sparkline bar-clicks
  to filter the alerts page table by `alertname=<rule.name>` +
  bucket time range. Useful but a separate UX change; the sparkline
  is read-only in P6.5.
- **OS rule flyout.** The OS path's "Alert History" panel sources
  from a scoped `getAlerts` call (Phase 1) which is genuine alert
  history per monitor. The OS history is fine as-is; P6.5 is
  Prom-only.

---

### P6.6 — Restore per-datasource `withTimeout` on the paginated and facet paths

The Phase 4 paginated alerts/rules paths and the Phase 5 facet paths
fan out without the `withTimeout` wrapper that the legacy progressive
paths still use. One slow datasource hangs the whole call.

#### Why

`MultiBackendAlertService` has a `withTimeout` helper
(`alert_service.ts:1256-1281`) used by `fetchAlertsFromDatasource`
(`alert_service.ts:976-977`) and `fetchRulesFromDatasource`
(`alert_service.ts:1018-1019`) — both helpers wrap the per-datasource
fetcher in a timeout that resolves to a `'timeout'` status on the
per-datasource result envelope, so a slow datasource doesn't block
the whole listing.

Phase 4 added `getPaginatedAlerts` (`alert_service.ts:713`) and
`getPaginatedRules` (line 654) — both fan out via
`Promise.allSettled` over `fetchAlertsRaw` / `fetchRulesRaw`
**without** wrapping in `withTimeout`:

```ts
const dsResults = await Promise.allSettled(
  datasources.map(async (ds) => {
    const client = isResolver ? await clientOrResolver(ds.id) : clientOrResolver;
    return this.fetchAlertsRaw(client, ds, resolvedRange, options);
  })
);
```

Phase 5's facet path has the same gap
(`alert_facets.ts:175-180, 227-232`). Both `fetchFilteredAlerts` and
`fetchFilteredRules` call `fetchAlertsRaw` / `fetchRulesRaw` directly.

The HTTP server has its own request-timeout backstop, but it kills
the whole route — at that point the user sees a generic 504, not a
per-datasource `'timeout'` status. The status panel in the UI loses
its ability to say "DS-1 succeeded, DS-2 timed out" because the
whole response failed.

In practice on multi-datasource setups: one Cortex behaving badly
(slow query, long-running backfill, transient network) will fail the
entire alerts page. Phase 4 + Phase 5 quietly regressed the
isolation Phase 0's progressive path provided.

#### What's lost (and how to backfill)

Nothing. The fix is purely additive: wrap the per-datasource fetcher
in `withTimeout`, and on timeout map the result into a
`DatasourceWarning` (paginated path) or `DatasourceFetchResult`
shape (facet path) the same way today's slow / failed datasources
are handled.

#### Concrete shape

Three call sites need the wrapper:

**1. `getPaginatedAlerts`** (`alert_service.ts:713`):

```ts
const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
const dsResults = await Promise.allSettled(
  datasources.map(async (ds) => {
    const client = isResolver ? await clientOrResolver(ds.id) : clientOrResolver;
    return this.withTimeout(
      this.fetchAlertsRaw(client, ds, resolvedRange, options),
      timeoutMs,
      `Datasource ${ds.name} timed out after ${timeoutMs}ms`,
    );
  })
);
```

The catch block in the `for` loop below already catches `TimeoutError`
implicitly through `settled.reason` and emits a warning entry.
Verify; tweak the warning shape to flag `kind: 'timeout'` so the UI
can distinguish (optional).

**2. `getPaginatedRules`** (`alert_service.ts:654`): same shape.

**3. `fetchFilteredAlerts` / `fetchFilteredRules`**
(`alert_facets.ts:175-180, 227-232`): wrap each per-datasource fetch.
The facet path already has a per-datasource warning shape; timeouts
just become another flavor.

The existing `DEFAULT_TIMEOUT_MS = 10_000` constant
(`alert_service.ts:70`) is the right default. Both routes already
parse a `timeout` query param and forward as `timeoutMs` (it just
isn't being applied on the new paths).

#### File-by-file change list

- `server/services/alerting/alert_service.ts` — wrap two call sites
  in `getPaginatedAlerts` / `getPaginatedRules`. ~15 lines.
- `server/services/alerting/alert_facets.ts` — pass `alertSvc` (or
  the timeout helper) into `fetchFilteredAlerts` /
  `fetchFilteredRules` so they can wrap. **Or** inline a local
  `withTimeout` mirror — the facet module already imports from
  `alert_service`. ~15 lines.
- `server/services/alerting/__tests__/alert_service.routing.test.ts`
  — add timeout cases to the paginated path.
- `server/services/alerting/__tests__/alert_facets.test.ts` — add
  timeout cases.

#### Acceptance criteria

1. **Paginated path timeout** — point one Prom datasource at a slow
   upstream (e.g. mock a 30s delay; default `timeoutMs = 10_000`).
   Open the alerts page with that DS + a healthy DS selected. The
   listing returns within ~10s with the healthy DS's results. The
   slow DS appears in `warnings[]` with a timeout-shaped error.
2. **Facet path timeout** — same, against the
   `/_facets` endpoint.
3. **Custom `timeout` param honored** — pass `?timeout=2000` on the
   listing call; the timeout fires after 2s.
4. **Healthy fan-out unchanged** — when no datasource times out, the
   call shape and response are identical to today.
5. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **Caching interaction.** A timeout abandons the in-flight upstream
  request, but `TtlCache.get` doesn't know — it'll still hold the
  in-flight promise. Subsequent calls within the TTL window get the
  same in-flight promise (which is already abandoned by the
  timed-out caller). Mitigation: when a `withTimeout` fires, also
  call `cache.invalidate(dsId)` to clear the in-flight slot. Verify
  in tests.
- **`withTimeout` coverage on the auxiliary historical query.**
  `getHistoricalAlerts` is called inside `fetchAlertsRaw`'s Prom
  branch (post-Phase-5 work). The outer `withTimeout` covers it
  transitively, but if the historical query is the slow piece and
  the current-firing call is fast, today the merge waits on both.
  Acceptable — the outer timeout still bounds the wait.

#### Out of scope

- Adaptive timeout based on datasource history. Static
  `DEFAULT_TIMEOUT_MS` is fine for Phase 6.
- Surfacing per-datasource latency to the UI as a metric. That's a
  Telemetry item, not a perf item.

---

### P6.7 — Cache the bounded historical-alerts query

`getHistoricalAlerts` (`directquery_prometheus_backend.ts:367-452`)
goes to Cortex on every call — it has no `TtlCache` participation,
unlike `getAlerts` and `getRuleGroups`. Repeated picker/filter/refresh
clicks re-issue an expensive `topk(N, last_over_time(...))` every
time.

#### Why

`last_over_time(ALERTS{...}[range_seconds])` is structurally
expensive on Cortex: the queryer has to scan every sample of
`ALERTS{...}` over the range at evaluation time. A 7-day range with
a moderate-cardinality matcher is seconds of upstream work. The
plugin pays this cost on every single flyout open, every filter
click, every picker fidget — even when the data hasn't changed
upstream.

The two existing TTL caches (`alertsCache`, `ruleGroupsCache`) keyed
on `dsId` work because the corresponding upstream APIs accept no
filters — one cache slot per `dsId` covers all callers. The
historical-alerts query DOES accept filters (severity / labels /
search become matchers on the selector), so its cache key needs to
include those.

#### What's lost (and how to backfill)

Nothing functional. The cost is a slightly more complex cache key.

#### Concrete shape

A new cache instance:

```ts
readonly historicalAlertsCache: TtlCache<string, { candidates: PromHistoricalAlertCandidate[]; truncated: boolean }>;
```

Keyed on a stringified composite:

```
<dsId>:<startBucket>:<endBucket>:<severitySorted>:<labelsSorted>:<search>
```

Range bucketing matters: a user clicking through pickers or letting a
"now" range tick forward shouldn't bust the cache for every second
of drift. Bucket `start` and `end` to **30s granularity** before
hashing into the key:

```ts
const bucketed = (ms: number) => Math.floor(ms / 30_000) * 30_000;
```

A 7-day range that's "now-7d → now" stays cache-hot for 30s windows;
a `now-7d → now` query made 5 seconds later sees the same cache
entry. After the bucket boundary advances, a new entry is created.

TTL: same 30s as the other caches (matches the bucketing — one new
upstream call per ~minute of "now"-tracking, which is acceptable).

`noCache: true` (refresh button) invalidates by full-key match. Or —
simpler — invalidate the whole cache on refresh; it's small and the
refresh button is rare. Recommend the simpler shape.

#### File-by-file change list

- `server/services/alerting/directquery_prometheus_backend.ts` —
  add `historicalAlertsCache` instance; route `getHistoricalAlerts`
  through it. Build the composite key. ~30 lines.
- `server/services/alerting/__tests__/directquery_prometheus_backend.test.ts`
  — cache hit/miss cases, range-bucketing cases, `noCache` bypass,
  composite-key collision tests. ~50 lines.

No service / route / frontend changes.

#### Acceptance criteria

1. **Repeat-call hit** — issue two listing calls 5 seconds apart with
   identical filter shape. Network panel: one upstream
   `query_range`-style call (the topk historical query). Today: two.
2. **Range drift within bucket** — advance the "now" anchor by 10s
   between calls. Same upstream call count as #1 (range-bucketing
   absorbs the drift).
3. **Range drift past bucket** — advance the "now" anchor by 35s.
   Two upstream calls (cache key changed at the 30s bucket boundary).
4. **Filter change busts the cache** — apply a severity filter; new
   key, new upstream call. Reverting the filter within 30s reuses
   the prior cache entry (key matches).
5. **Refresh button** — `noCache=1` invalidates; refetches.
6. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **Cache memory.** Each entry holds up to `PROM_HISTORICAL_ALERTS_TOPK
  = 1000` candidates (~200 bytes each = 200 KB per entry). With
  many distinct filter combinations, the cache could grow. Mitigate:
  add a soft cap on the cache (e.g. 50 entries per `TtlCache`); LRU
  eviction. Or accept the bound: 30s TTL means stale entries
  self-expire fast.
- **Consistency between current and historical.** When the merge
  happens (`alert_service.ts:1118-1142`), `getAlerts` (current,
  cached) and `getHistoricalAlerts` (cached separately) may produce
  slight mismatches if their cache entries were populated at
  different moments. Acceptable — both have 30s TTLs and the merge
  is a union; the worst case is one alert showing as "current" for
  ~30s after it resolved on the upstream.

#### Out of scope

- Pre-warming the historical cache on plugin startup. Lazy
  population is fine.
- Cross-`dsId` cache sharing. Each `dsId` is a distinct upstream;
  no sharing semantics.

---

### P6.8 — Skip the historical query for short `endIsNow=true` ranges

For "now-X to now" pickers where X is small (≤ 5 minutes), the
current-firing call from `/api/v1/alerts` already covers the window.
Firing the bounded historical query in addition is wasted Cortex
work.

#### Why

Today's merge logic (`alert_service.ts:1115-1147`) for ranged
listings:

1. If `endIsNow=true`, fetch `/api/v1/alerts` (cached).
2. Always fetch `getHistoricalAlerts` (uncached, expensive).
3. Merge by fingerprint.

For a "now-5m to now" picker, step 1 already returns every alert
firing in the last 5 minutes (`/api/v1/alerts` is current-state with
no time filter, but anything resolved more than ~5 minutes ago has
already aged out of Cortex's resolved-alert retention anyway). Step 2
would mostly return the same fingerprints with a much higher upstream
cost.

The threshold isn't exact — "what's in `/api/v1/alerts`" depends on
Cortex's `-rules.alertmanager-resolve-timeout` (typically 5min) and
`-rules.alert-timeout` (typically 1m). But for any range ≤ 5min that
ends at "now", the historical query is essentially redundant.

For ranges > 5min or ranges that don't end at "now", the historical
query is the only source of alerts that resolved before the picker
end. It must run.

#### What's lost (and how to backfill)

For ranges in the gray zone (5min < range ≤ ~10min) the change is
optimistic — there could be a brief window where an alert resolved 6
minutes ago (gone from `/api/v1/alerts`, present in historical
samples) gets dropped. Mitigation: pick the threshold conservatively
(e.g. 2 minutes, well under any plausible resolve-timeout) so we
optimize the dominant common case (real-time monitoring with a
"now-1h" or "now-5m" picker) without losing fidelity at the edge.

Test fixtures should cover the boundary explicitly.

#### Concrete shape

In `fetchAlertsRaw` Prom branch (`alert_service.ts:1090-1147`),
gate the historical call on range duration:

```ts
const SHORT_RANGE_MS = 2 * 60 * 1000;  // 2min — well under typical resolve-timeout
const isShortNowRange = range.endIsNow && (range.endMs - range.startMs) <= SHORT_RANGE_MS;

// (a) Current-firing
if (range.endIsNow) {
  const currentAlerts = await this.promBackend.getAlerts(client, ds, ...);
  for (const a of currentAlerts) {
    merged.set(promAlertFingerprint(...), promAlertToUnified(a, ds.id));
  }
}

// (b) Historical — skipped for short now-anchored ranges where (a) covers it.
if (!isShortNowRange) {
  const historical = await this.promBackend.getHistoricalAlerts(client, ds, {...});
  for (const c of historical.candidates) {...}
}
```

The threshold (`SHORT_RANGE_MS = 2 * 60 * 1000`) is conservative.
Worth surfacing as a uiSetting with the default 2min for power users
on deployments with non-default resolve-timeouts:

```
observability:promListingShortRangeSkipMs   default 120_000
```

Lazy: skip the uiSetting for Phase 6, hard-code the constant. Add the
setting later if anyone asks.

#### File-by-file change list

- `server/services/alerting/alert_service.ts` — gate the historical
  call. ~10 lines diff.
- `server/services/alerting/__tests__/alert_service.routing.test.ts`
  — boundary cases: 1min range (skipped), 5min range (skipped),
  10min range (fired), past-only range (fired).

#### Acceptance criteria

1. **`now-1m → now` picker** — listing fires only `/api/v1/alerts`,
   no historical query. Upstream call count drops from 2 to 1
   per render.
2. **`now-5m → now` picker** — same: only `/api/v1/alerts` fires
   (within the 2min threshold? no — 5min is > 2min, so the
   historical call DOES fire). Verify the boundary explicitly in
   tests.
3. **`now-1h → now` picker** — both calls fire. No regression.
4. **Past-only `now-2h..now-1h`** — only the historical call fires
   (current-firing is skipped because `endIsNow=false`). No change
   from today.
5. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **Threshold tuning.** If a deployment has Cortex configured with a
  long `resolve_timeout` (10min instead of 5), the threshold might
  miss alerts. Mitigation: keep the threshold conservative (2min)
  so even the longest sane resolve-timeout windows pass through
  unaffected.
- **Edge race.** A "now-2m → now" picker at the boundary instant
  where `range.endMs - range.startMs == 120_000`. The `<=`
  comparison includes it (skipped); a subsequent `<` would exclude
  it. Pick `<=` for consistency with "if the range fits within the
  threshold, skip"; document.

#### Out of scope

- Auto-detecting Cortex's `resolve_timeout` via `/status`. Possible
  but invasive; defer.
- Skipping the current-firing call for past-only ranges. Already
  done at `alert_service.ts:1118-1126` (the `if (range.endIsNow)`
  gate).

---

### P6.9 — Cap the rule flyout's condition-preview query

`fetchPromPreviewData` (`alert_preview.ts`) executes the rule's full
PromQL expression to populate the condition-preview chart on every
flyout open. The expression is **user-defined** — there's no
cardinality cap. A pathological rule + a wide picker can produce a
genuinely expensive Cortex query.

#### Why

The flyout's condition preview is a `query_range` against the rule's
own expression (e.g. `rate(http_requests_total[5m]) > 0.1`). For
this expression on a 100k-pod cluster with `now-7d → now`:

- 100k label-sets × `7d / step` samples per series.
- `step` from `computeStep` targets ~200 samples; with 100k series
  that's 20M samples scanned.
- Cortex's `-querier.max-samples` (50M default) doesn't trip — but
  we're paying a substantial fraction of the budget on every flyout
  open.

This pattern recurs across the codebase:

- Alerts table historical query: P6.7 added caching + P5 had
  `topk(N, ...)` cap.
- Timeline endpoint: bounded by `sum by(severity) (...)` (≤ 5
  series) + `topk(200, ...)` on search.

The condition preview has neither bound. It's the only "execute
user PromQL" path with no series-cardinality protection.

#### What's lost (and how to backfill)

A user with a high-cardinality rule expression who opens the flyout
loses the per-instance breakdown. The chart shows "top N series" or
"sum across series" instead of the full breakdown. For most rules
(low-cardinality, scalar-y) this is invisible. For pathological
rules it's a tradeoff: bounded chart vs. potential timeouts.

#### Concrete shape

Two layers of protection, layered:

**1. Wrap the user's expression in `topk(N, ...)`.** N tied to
chart-rendering needs — say 20 (ECharts can render dozens of series
without choking; more is unreadable anyway):

```ts
const cappedQuery = `topk(${PROM_PREVIEW_TOPK}, ${rule.query})`;
```

This is the dominant safety net. Even if the rule's raw expression
returns 100k series, the upstream caps at 20.

**2. `withTimeout` on the call itself** (separately from P6.6, which
covers listing/facet paths). A 5-second per-flyout cap:

```ts
const PROM_PREVIEW_TIMEOUT_MS = 5_000;
const samples = await withTimeout(
  promBackend.queryRange(client, ds, cappedQuery, ...),
  PROM_PREVIEW_TIMEOUT_MS,
  'Preview query timed out',
);
```

On timeout, the flyout shows an empty preview chart with a "preview
unavailable" message (don't surface as an error — the rest of the
flyout is still useful). The flyout already handles `[]` from the
preview gracefully (`monitor_detail_flyout.tsx`).

**3. Surface a callout when topk truncated.** Detect by comparing the
returned series count to N; if equal, show a "showing top 20 of
many series" callout. Same pattern as the alerts-page truncation
hints.

#### File-by-file change list

- `server/services/alerting/alert_preview.ts` — wrap the expression
  in `topk(N, ...)`; add timeout. ~20 lines.
- `server/services/alerting/__tests__/alert_preview.test.ts` —
  cap-engaged case, timeout case.
- `public/components/alerting/monitor_detail_flyout.tsx` — render
  the truncation callout when the preview signals it. ~10 lines.

No route changes.

#### Acceptance criteria

1. **High-cardinality rule** — open a flyout for a rule whose
   expression returns 1000 series. The preview chart shows ≤ 20
   series. The truncation callout fires.
2. **Low-cardinality rule** — open a flyout for a rule with a
   scalar expression. Chart renders ≤ 20 series (typically just 1);
   no callout.
3. **Slow query** — mock a `queryRange` that takes 10s. The flyout
   shows the empty-preview state after 5s; the rest of the flyout
   renders normally.
4. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **`topk` semantics.** `topk(N, expr)` returns the top N series by
  *value*. For an alerting rule whose `expr` is a comparison
  (`>` / `<` / `==`), the value is 0 or 1 — `topk` returns an
  arbitrary subset. Workaround: detect comparison expressions and
  apply `topk` to the LHS instead, or just `count` the result.
  Conservative: skip the `topk` wrap for comparison expressions and
  rely on the timeout instead. Document the limitation; defer
  smarter handling.
- **Expression parsing.** Detecting "is this a comparison
  expression?" requires PromQL parsing. Don't do it in Phase 6;
  apply `topk` to all expressions and accept the comparison edge
  case as "best-effort cap, may show arbitrary subset for boolean
  rules."

#### Out of scope

- A full PromQL parser to apply `topk` semantically. Out of scope
  for an optimization pass.
- Pre-fetching the preview before the flyout opens. Today's behavior
  (fetch on open) is fine; the cap makes it bounded.

---

### P6.10 — `?file=` pushdown for workspace-scoped Prom datasources

`fetchRuleGroupsRaw` (`directquery_prometheus_backend.ts:255-261`)
post-filters by workspace using `g.file.includes(ds.workspaceId!)`
or label-match on `_workspace`. Push the filter to the upstream via
`?file=<workspaceId>` when the upstream supports it.

#### Why

For workspace-scoped Prom datasources (the AMP multi-workspace
shape), every `/api/v1/rules` call returns ALL workspaces' rules,
then we drop the non-matching ones in JS. That's:

- N× wire bytes (where N is the number of workspaces).
- Cortex's serialization work for groups we throw away.
- Cache pollution: the cache value is the union of all workspaces,
  so a workspace-scoped query returns more than it needs.

`/api/v1/rules?file=<pattern>` was added in Prom 2.40 / Cortex 1.13,
same release as `?rule_group=&rule_name=`. The existing
`prom_filter_probe` already tests pushdown for those params; extend
it (or add a sibling probe) for `?file=`.

#### What's lost (and how to backfill)

Nothing. JS post-filter remains for correctness (same Phase 3
contract).

#### Concrete shape

Two implementation choices:

**Option A — Extend the existing probe.** Add a `file` test alongside
the `rule_group=&rule_name=` test:

```ts
type ProbeResult =
  | { status: 'pushdown-works'; capabilities: { ruleScope: boolean; fileScope: boolean } }
  | { status: 'pushdown-ignored' }
  | { status: 'unknown'; reason: string };
```

The probe issues a third call with `?file=<knownFile>` and checks
the response is narrowed. Adds one round-trip per `dsId`'s first
flyout. Cleaner API.

**Option B — Best-effort with no probe.** Always pass `?file=`; the
JS post-filter handles upstreams that ignore it. Simpler;
imperceptible cost on supporting upstreams; same cost as today on
non-supporting upstreams (we send the param, upstream ignores, we
get the full payload, we post-filter).

Option B is the better Phase 6 choice. The ground truth is that
Cortex / AMP / recent Prom support `?file=`; older deployments are
the rare case. Always-passing it costs nothing and saves payload
when supported. The probe-based approach has additive cost for the
probe itself.

```ts
// directquery_prometheus_backend.ts buildRulesPath
private buildRulesPath(ds: Datasource, filter?: PromRuleGroupsFilter): string {
  const params: string[] = [];
  if (filter?.ruleGroup) params.push(`rule_group=...`);
  if (filter?.ruleName) params.push(`rule_name=...`);
  if (filter?.file) params.push(`file=${encodeURIComponent(filter.file)}`);
  // Workspace-scoped datasource → always push file matcher; backstop
  // with the existing JS post-filter at fetchRuleGroupsRaw:255-261.
  else if (ds.workspaceId && ds.workspaceId !== 'default') {
    params.push(`file=${encodeURIComponent(ds.workspaceId)}`);
  }
  // type=alert from P6.2
  const type = filter?.type ?? 'alert';
  params.push(`type=${encodeURIComponent(type)}`);
  return `/api/v1/rules?${params.join('&')}`;
}
```

Note `buildRulesPath` doesn't take `ds` today — signature change
needed. Or thread `workspaceId` via the filter shape.

#### File-by-file change list

- `server/services/alerting/directquery_prometheus_backend.ts` —
  signature change in `buildRulesPath`; pass `ds` (or
  `ds.workspaceId`) through. ~15 lines.
- `server/services/alerting/__tests__/directquery_prometheus_backend.test.ts`
  — workspace-scoped URL construction. ~20 lines.

No service / route / frontend changes.

#### Acceptance criteria

1. **Workspace-scoped DS (Cortex with `?file=` support)** — open
   the rules page. Network panel: one
   `/api/v1/rules?type=alert&file=<workspaceId>` call. Response
   contains only this workspace's rules; no JS filtering needed
   (post-filter is a no-op).
2. **Workspace-scoped DS (older upstream that ignores `?file=`)** —
   response contains all workspaces. Existing post-filter at
   `fetchRuleGroupsRaw:255-261` drops the non-matching ones. Page
   renders correctly.
3. **Default workspace** — no `?file=` param sent. Same as today.
4. **Cache key invariance** — workspace-scoped DSs have distinct
   `dsId`s, so the cache key is unaffected. Unrelated workspaces
   don't pollute each other's cache.
5. **Phase 1-5 acceptance criteria still hold.**

#### Risk register

- **Wildcard semantics.** `?file=<workspaceId>` is an exact match in
  most upstreams. If a deployment encodes the workspace into a
  *substring* of the file path (e.g.
  `rules/<workspaceId>/<rulefile>.yml`), exact match doesn't work.
  Verify the current AMP / Cortex semantics before shipping; if
  substring is needed, fall back to JS post-filter (which already
  uses `g.file.includes(ds.workspaceId!)`).
- **Probe vs no-probe.** Option B doesn't probe, so we don't know
  whether the param worked. The post-filter catches the failure mode.
  Acceptable — same as P6.2's `?type=alert`.

#### Out of scope

- Probe-based capability detection. Option A's design is documented
  for reference but not pursued in Phase 6.
- Multi-workspace rules access. Today each datasource maps to one
  workspace; cross-workspace queries aren't a feature.

---

### P6.11 — TBD (placeholder)

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
