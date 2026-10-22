# Integrations

Beyond the dashboard, X-Monitor exposes its state to external tools. All of the following are served on the same port as the web UI.

## Events feed

An **Events** view in the sidebar shows a unified, filterable feed of every event X-Monitor has recorded across all monitors — status changes, threshold crossings, and collection errors — filterable by level, target host, and message text.

## REST API

Read-only JSON endpoints for consuming X-Monitor's state programmatically:

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

## Prometheus

A Prometheus exposition endpoint is always available at `GET /metrics` (pull) — no configuration required. It exports `x_monitor_up` (per-monitor status: `1` online, `0.75` info, `0.5` warning, `0` failed, `-1` unavailable) and `x_monitor_metric` (every collected metric, labeled by monitor/target/metric). Point a Prometheus scrape config at it:

```yaml
scrape_configs:
  - job_name: x-monitor
    static_configs:
      - targets: ['x-monitor-host:8080']
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
    bucket: "x-monitor"
    token: "my-api-token"
    # InfluxDB 1.x: use `database:` instead of org/bucket/token
```
