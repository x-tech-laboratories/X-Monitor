# Architecture

X-Monitor is built around **pure plugins and a Coordination Engine that owns all IO and persistence**. A plugin is constructed with only its `(name, config)`; it declares *what* to collect and *how to interpret* the results as pure functions, and the engine performs every side effect — SSH, HTTP/DNS/ICMP, database writes, thread offloading. This keeps plugins small, side-effect-free, and testable without mocks.

A plugin's contract is:

- **Declare** — `requests()` returns a list of connector requests (`Command` / `HttpRequest` / `DnsQuery` / `PingRequest`); an SSH-only plugin overrides the `commands()` shorthand instead. Both are pure.
- **Interpret** — `parse_results()` (or `parse()` for the SSH shorthand) turns the connector results into a single `CollectResult` describing everything to persist (metrics, logs, status, an optional snapshot). Pure — no IO.
- **Subscribe** (optional) — `subscriptions()` declares event streams an agent should watch on the target, and `parse_event()` turns each pushed frame into a `CollectResult`. Both pure; ignored for targets reached over SSH.
- **Act** (optional) — `plan_action()` / `interpret_action()` describe control actions (restart a service, force a backup) the same declarative way.
- **Present** (optional) — a declarative `UI_SPEC` dict renders the plugin's dashboard page; only genuinely bespoke plugins hand-write `render_ui()`.

The engine executes the declared IO, persists the returned `CollectResult`, and drives one independent polling loop per monitor.

## Data Flow

1. **Initialization**: `x_monitor/__main__.py` builds one `XMonitorEngine` (`core/coordination/engine.py`), which loads `config.yaml` and instantiates plugins (`setup_modules`). Group plugins act as containers for nested monitors.
2. **Wiring**: for each plugin the engine builds its engine-owned `ExecContext` — an agent connection or a pooled SSH connection, chosen by config — and injects a read-only `PluginDataView` as `plugin.data`.
3. **Polling**: each monitor runs its own async loop at its own `interval`. Per cycle the engine runs the plugin's declared requests through the **Connector Engine** — which routes each `Command` to that target's agent or its SSH connection — then calls the plugin's pure `parse_results()`.
3b. **Events**: monitors on an agent-backed target also declare `subscriptions()`. The agent watches those sources locally and pushes a frame the instant one changes; the engine hands it to the plugin's pure `parse_event()` and persists the result immediately, outside the polling schedule.
4. **Persistence**: the engine writes the resulting `CollectResult` via `db.apply_result(...)` into SQLite (Peewee ORM). A background writer thread batches commits off the event loop.
5. **Visualization**: every write publishes a change, and the NiceGUI dashboard refreshes off that — one subscription per connected client — rendering the sidebar tree plus each plugin's detail page. It reads only through `plugin.data` / the database — never through a plugin's IO.
6. **Export**: metrics are exposed to Prometheus (pull, `/metrics`) and optionally pushed to InfluxDB, or published over MQTT with Home Assistant discovery.

## Project Structure

```
x_monitor/
├── __main__.py              # Entry point: build engine, load plugins, start GUI
├── core/
│   ├── coordination/        # XMonitorEngine (Coordination Engine) + PluginDataView
│   ├── connectors/          # All IO: agent + SSH + HTTP/DNS/ICMP sub-connectors, request types
│   ├── database/            # DatabaseManager (SQLite/Peewee), models, read-result types
│   ├── settings/            # config.yaml loader + typed schema
│   ├── exporters/           # Prometheus pull + InfluxDB and MQTT push
│   └── ui/                  # NiceGUI dashboard, declarative UI_SPEC renderer
└── plugins/
    ├── base/                # Plugin ABC + shared config/helper mixins
    └── *.py                 # One module per monitor type (uptime, systemd_service, …)

x_monitor_agent/                 # The daemon that runs on a monitored host
├── protocol.py              # Wire format, shared with the server
├── client.py                # Outbound WebSocket, reconnect, frame dispatch
├── executor.py              # Local command execution
└── watchers.py              # Event sources (journal / path / sample)
```

See [docs/develop.md](develop.md) for the architectural rationale — the pure-plugin contract, the collection lifecycle, the SQLite writer/reader model, and the declarative UI spec.

## Technical Stack

| Concern        | Technology                          |
|----------------|--------------------------------------|
| Language       | Python 3.9+                          |
| Connectivity   | WebSocket (agent), AsyncSSH (SSH), `httpx` (HTTP), dnspython (DNS) |
| Configuration  | YAML                                 |
| Concurrency    | `asyncio`                            |
| Storage        | SQLite via Peewee ORM                |
| Frontend       | NiceGUI + ECharts                    |

## Design Principles

1. **Simplicity First**: Configuration should be intuitive.
2. **Agent Optional**: All logic stays on the X-Monitor server; a host needs only SSH, and the agent is there for hosts where live events are worth installing it.
3. **Pure Plugins**: Each plugin owns its domain logic (what to collect, how to interpret it, what actions it offers) as pure functions; the engine owns all IO and persistence.
4. **Hierarchical Organization**: Supports nested groups for organizing monitors by location, service, or environment.
5. **Fail-Safe Control**: Control actions must be logged and confirmable.
6. **Standard-Aware**: Aims for OpenTelemetry compatibility in data naming and export capability.
