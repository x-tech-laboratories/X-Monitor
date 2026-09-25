# Integrations

Beyond the dashboard, Vigil exposes its state to external tools. All of the following are served on the same port as the web UI.

## Events feed

An **Events** view in the sidebar shows a unified, filterable feed of every event Vigil has recorded across all monitors — status changes, threshold crossings, and collection errors — filterable by level, target host, and message text.

## REST API

Read-only JSON endpoints for consuming Vigil's state programmatically:

| Endpoint | Returns |
|----------|---------|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/monitors` | All monitors with id, name, type, target, and current status |
| `GET /api/monitors/{id}` | A single monitor plus its latest metrics |
| `GET /api/metrics` | Latest value of every collected metric |
| `GET /api/events` | Recent events — supports `?level=`, `?target=`, `?search=`, `?limit=` |

```bash
curl http://localhost:8080/api/monitors
curl "http://localhost:8080/api/events?level=ERROR&limit=50"
```

### Runtime control

These change Vigil itself rather than read its state. They sit behind the same sign-in as every other route.

| Endpoint | Does |
|----------|------|
| `POST /api/config/reload` | Re-reads `config.yaml` and applies it in place; answers with what was added, removed and changed and which settings need a restart, or `422` with the reason the file was refused |
| `GET /api/log-levels` | The root log level, every logger given its own level, and the names of Vigil's loggers |
| `POST /api/log-levels` | Sets one logger's level from a JSON body `{"logger": "...", "level": "DEBUG"}`; no `logger` means the root, and `"level": null` makes a named logger inherit again |

```bash
curl -X POST http://localhost:8080/api/log-levels \
  -H 'Content-Type: application/json' \
  -d '{"logger": "vigil.core.connectors.ssh_connector", "level": "DEBUG"}'
```

## Prometheus

A Prometheus exposition endpoint is always available at `GET /metrics` (pull) — no configuration required. It exports `vigil_up` (per-monitor status: `1` online, `0.5` warning, `0` failed, `-1` unavailable) and `vigil_metric` (every collected metric, labeled by monitor/target/metric). Point a Prometheus scrape config at it:

```yaml
scrape_configs:
  - job_name: vigil
    static_configs:
      - targets: ['vigil-host:8080']
```

## InfluxDB

An optional **push** exporter ships metrics to InfluxDB (1.x or 2.x) on an interval. Enable it under `exporters:` in `config.yaml`:

```yaml
exporters:
  influxdb:
    url: "http://localhost:8086"
    interval: 30
    # InfluxDB 2.x:
    org: "my-org"
    bucket: "vigil"
    token: "my-api-token"
    # InfluxDB 1.x: use `database:` instead of org/bucket/token
```
