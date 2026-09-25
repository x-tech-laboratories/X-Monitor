# Integrations

Beyond the dashboard, Vigil exposes its state to external tools. All of the following are served on the same port as the web UI.

## Events feed

An **Events** view in the sidebar shows a unified, filterable feed of every event Vigil has recorded across all monitors — status changes, threshold crossings, and collection errors — filterable by level, target host, and message text.

## REST API

JSON endpoints for consuming Vigil's state programmatically:

| Endpoint | Returns |
|----------|---------|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/monitors` | All monitors with id, name, type, target, and current status |
| `GET /api/monitors/{id}` | A single monitor plus its latest metrics and the ids of its actions |
| `GET /api/metrics` | Latest value of every collected metric |
| `GET /api/events` | Recent events — supports `?level=`, `?target=`, `?search=`, `?limit=` |

And a few that act, the same things the dashboard's buttons do:

| Endpoint | Does |
|----------|------|
| `POST /api/monitors/{id}/poll` | Runs one collection cycle now (the **Poll Now** button) |
| `POST /api/monitors/{id}/actions/{action_id}` | Runs one of the monitor's header actions, e.g. `restart` |
| `POST /api/notifications/{channel_id}/test` | Sends a test notification through one channel |

Each action taken through the API is written to the monitor's events, naming the account or [API token](../README.md#api-tokens) that asked for it.

```bash
curl http://localhost:8080/api/monitors
curl "http://localhost:8080/api/events?level=ERROR&limit=50"
curl -X POST -H "Authorization: Bearer $VIGIL_TOKEN" http://localhost:8080/api/monitors/web/poll
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
