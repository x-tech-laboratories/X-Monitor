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

## MQTT and Home Assistant

An optional **push** exporter publishes every monitor's status and metrics to an MQTT broker the moment they change, and announces each one to Home Assistant through [MQTT discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery), so no agent or custom integration is needed on the Home Assistant side. It needs the `mqtt` extra (`pip install 'vigil[mqtt]'`, which brings `aiomqtt`); the Nix package and dev shell already include it.

```yaml
exporters:
  mqtt:
    host: "mqtt.lan"
    port: 1883                   # 8883 by default when tls is set
    username: "vigil"
    password_file: "/run/secrets/mqtt_password"   # or password:
    tls: true                    # or {ca_certs, certfile, keyfile, insecure}
    client_id: "vigil-myhost"    # default: vigil-<hostname>
    base_topic: "vigil"
    discovery_prefix: "homeassistant"
    discovery: true
    retain: true
    interval: 5m                 # optional periodic republish of everything; off by default
```

Topics, with monitor ids and metric names lowercased and reduced to `a-z 0-9 _ -`:

| Topic | Payload |
|---|---|
| `<base>/status` | `online` / `offline` — Vigil's availability, also the connection's last will |
| `<base>/<monitor>/status` | `online`, `warning`, `failed` or `unavailable` |
| `<base>/<monitor>/<metric>` | the metric's latest value |

In Home Assistant each monitored host becomes one device (named after the target), and each monitor on it gets a status sensor (an `enum` with the four statuses), a `problem` binary sensor that is on whenever the status is not `online`, and one sensor per metric. A metric's unit and device class follow its name: `_pct` is `%`, `_seconds`/`_ms` a duration, `_bytes`/`_mb`/`_gb` a data size, `temp_c` a temperature in °C, `_dbm` a signal strength. Unique ids are `<base>_<monitor>_<metric>`, so entities survive restarts, and two Vigil instances on one broker stay apart by using different `base_topic`s.

Everything is republished when the exporter (re)connects and when Home Assistant sends its birth message (`online` on `<discovery_prefix>/status`). While the broker is unreachable the exporter retries with backoff (up to a minute) and monitoring carries on unaffected.
