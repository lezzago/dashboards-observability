# S13 post-fix evidence (2026-04-25)

## Live verification (warm-map dev server)

1. `1-create-response.json` — POST /api/observability/v1/slos with
   datasourceId=ds-4 (ObservabilityStack_Prometheus). HTTP 200; SLO id
   `ce8072f4-9e84-493e-bc25-6bff771fa223`; Cortex group
   `slo:scenario_s13_cleanup_live_group_5f1a0d7b` under namespace
   `slo-generated-ds-4`.
2. `2-ruler-pre-delete-prom.json` — Prometheus read API shows the 11-rule
   group (7 recording + 4 alert rules) before DELETE.
3. `3-delete-response.json` — DELETE /api/observability/v1/slos/<id> returns
   HTTP 200, `{ deleted: true, generatedRuleNames: [...11 names] }`. This
   is the payload that the broken path returned HTTP 400 "Datasource ds-4
   is not registered" for in the original S13 failure.
4. `4-ruler-poll.txt` — polling the ruler shows 0 matching groups after
   poll 1 (<1s), well inside the 10s budget.
5. `5-get-after-delete.json` — GET /api/observability/v1/slos/<id> returns
   HTTP 404 `{ statusCode: 404, error: "Not Found", message: "SLO not
   found" }`.

## Cold-start coverage

The original #S13 symptom only reproduces when the SLO route arrives before
`/api/alerting/datasources` on a freshly-started server — the alerting route
is what populates the in-memory datasource registry via
`discoverOsdDatasources`. The SLO routes never triggered that hydration, so
`datasourceService.get('ds-4')` returned null even though ds-4 exists in the
OSD saved-object store.

Cold-start behavior is covered by
`server/routes/slo/__tests__/delete_registry_lookup.test.ts`:

- `resolves a present datasource on the first SLO DELETE after process
  start` — asserts that DELETE on an SLO with a present datasource hydrates
  the registry from saved objects, the ruler teardown fires with the right
  namespace/group, and the SO is removed.
- `preserves the SLO and rule group when the datasource is genuinely
  missing` — asserts that DELETE on an SLO pointing at a truly-absent
  datasource returns HTTP 400 with the typed `spec.datasourceId: "…is not
  registered"` error, the SO survives, and the ruler is never touched. The
  delete-safety contract from 9d3e8a0a is preserved.

The live warm-path test above exercises the rest of the pipeline (ruler
write, ruler teardown, SO removal) end-to-end.
