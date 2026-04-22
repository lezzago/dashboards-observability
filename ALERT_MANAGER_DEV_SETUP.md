# Alert Manager Dev Setup

End-to-end walkthrough for running the `dashboards-observability` plugin's Alert
Manager UI against a local `observability-stack` (OpenTelemetry demo + Prometheus
+ Alertmanager + OpenSearch) while OSD itself runs from source so you can
hot-reload plugin changes.

At a high level you will:

1. Clone and boot `observability-stack` with the OTel demo turned on.
2. Stop the dashboards container inside the stack so it doesn't conflict with
   the local dev server.
3. Clone the OSD monorepo and this plugin into `plugins/`.
4. Point OSD's config at the stack's OpenSearch container.
5. Run `yarn osd bootstrap` + `yarn start`, then log in.

The whole setup takes ~20 minutes the first time (most of it is `yarn osd
bootstrap`).

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | **22.22.0** (pinned by `.nvmrc`/`.node-version`) |
| Yarn | 1.x (classic) |
| Docker + Docker Compose | any recent |
| Git | any recent |

Using `nvm` is recommended:

```bash
nvm install 22.22.0
nvm use 22.22.0
```

---

## 1. Clone and start `observability-stack`

```bash
mkdir -p ~/workspace && cd ~/workspace
git clone -b update-alerting git@github.com:lezzago/observability-stack.git
cd observability-stack
```

Inspect `.env` — this is the source of truth for the OpenSearch admin
password. Keep the value handy; you'll need it in step 4.

```bash
cat .env        # OPENSEARCH_INITIAL_ADMIN_PASSWORD=...
```

Bring the stack up:

```bash
docker compose up -d
```

This starts OpenSearch, Prometheus, Alertmanager, and the OTel demo
services together.

Verify OpenSearch is reachable (replace `<PASSWORD>` with the value from
`.env`):

```bash
curl -sk -u "admin:<PASSWORD>" https://localhost:9200 | jq .version.number
```

You should see the cluster responding.

---

## 2. Stop the in-stack OpenSearch Dashboards container

The stack ships its own OSD container. It will fight with the local dev
server for the `.kibana*` saved-objects index (migration lock) and for
browser auth context. Stop it:

```bash
# From the observability-stack directory:
docker compose stop opensearch-dashboards
```

Confirm nothing is listening on `:5601`:

```bash
lsof -iTCP:5601 -sTCP:LISTEN -n -P   # should be empty
```

If an empty `.kibana_2` index got created before you stopped the
container, clean it so the dev server can migrate fresh:

```bash
curl -sk -u "admin:<PASSWORD>" -XDELETE "https://localhost:9200/.kibana_2"
```

---

## 3. Clone the OSD monorepo and this plugin

OSD **3.7.0** matches this plugin's `opensearchDashboardsVersion`. Clone
anywhere you like; the example uses `~/workspace/osd`:

```bash
mkdir -p ~/workspace/osd && cd ~/workspace/osd
git clone -b 3.7 git@github.com:opensearch-project/OpenSearch-Dashboards.git
cd OpenSearch-Dashboards
nvm use               # picks up 22.22.0 from .nvmrc
```

Clone this plugin into `plugins/` alongside the other in-tree plugins (the
plugin's `CLAUDE.md` documents this layout):

```bash
cd plugins
git clone git@github.com:lezzago/dashboards-observability.git
cd dashboards-observability
git checkout alertManager
cd ../..   # back to OpenSearch-Dashboards repo root
```

---

## 4. Point OSD at the stack's OpenSearch

OSD's dev server doesn't include the `opensearch_security` plugin, so there
is no login flow to hold the session for the browser. We work around it by
having OSD inject a static admin Authorization header on every proxied
request (dev-only; **never** ship a config like this).

Generate the base64-encoded basic-auth header. Substitute the real password
from `observability-stack/.env`:

```bash
printf '%s' 'admin:<PASSWORD>' | base64
# copy the output for the next step
```

Edit `config/opensearch_dashboards.yml` in the OSD repo root. Append (or
replace the corresponding lines with) the block below. Use the base64 value
you just generated:

```yaml
opensearch.hosts: ["https://localhost:9200"]
opensearch.username: "admin"
opensearch.password: "<PASSWORD>"
opensearch.ssl.verificationMode: none
opensearch.requestHeadersAllowlist: []
opensearch.customHeaders:
  authorization: "Basic <BASE64_FROM_ABOVE>"
```

The empty `requestHeadersAllowlist` stops OSD from forwarding the browser's
(empty) auth header and clobbering `customHeaders`.

---

## 5. Bootstrap + run OSD

From the OSD repo root:

```bash
yarn osd bootstrap       # installs deps + builds workspace packages (~10 min)
yarn start               # dev server with optimizer
```

The first compile takes a few minutes. Watch the log for:

```
[info][status][plugin:observabilityDashboards] Status changed from uninitialized to green
[info][listening] basepath proxy server running at http://localhost:5601/<BASEPATH>
```

The `<BASEPATH>` (e.g. `/igq`) changes on every restart.

---

## 6. Open the plugin in a browser

Navigate to:

```
http://localhost:5601/<BASEPATH>/app/observability-alerting
```

Because of the header injection in step 4, there's no login dialog — OSD
proxies every request as the admin principal.

Click the **Suppression** tab (fourth tab). You should see silences from
the Prometheus datasource, rendered in a read-only table with the new
detail flyout.

---

## Troubleshooting

**"Another OpenSearch Dashboards instance appears to be migrating the
index"** — the stack's OSD container came back up, or an old empty
`.kibana_2` got left behind. Stop the container and delete the index per
step 2.

**Browser prompts for HTTP basic auth** — step 4's `customHeaders` isn't
taking effect. Common causes: `opensearch.requestHeadersAllowlist` wasn't
emptied, the base64 string was mis-copied, or `config/opensearch_dashboards.yml`
was edited after `yarn start` (config changes require a restart).

**The dev server shows stale behavior after editing plugin code** — the
optimizer typically takes 30-45 seconds to rebuild after a file change.
Hard-reload (`Cmd+Shift+R`) only after the optimizer logs report success.
Open flyouts do not hot-reload; close and reopen them.

**The Prometheus datasource doesn't appear in the Suppression tab** — the
plugin discovers Prometheus via the OpenSearch SQL plugin's
`/_plugins/_query/_datasources` endpoint. Confirm the stack registered a
Prometheus connector:

```bash
curl -sk -u "admin:<PASSWORD>" \
  "https://localhost:9200/_plugins/_query/_datasources" | jq
```

**Port 9200 is in use** — another OpenSearch instance is running. Either
stop it, or change the stack's port mapping in `docker-compose.yml` and
update `opensearch.hosts` in OSD's config accordingly.

---

## Shutting down

```bash
# Stop OSD: Ctrl-C in the yarn start terminal

# Stop the stack:
cd ~/workspace/observability-stack
docker compose down
```

To fully reset state, add `-v` to also drop the named volumes (wipes
OpenSearch indices + Prometheus TSDB):

```bash
docker compose down -v
```
