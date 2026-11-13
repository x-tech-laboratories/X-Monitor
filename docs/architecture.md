# Architecture

X-Monitor is built around **pure plugins and a Coordination Engine that owns all IO and persistence**. A plugin is
constructed with only its `(name, config)`; it declares *what* to collect and *how to interpret* the results as pure
functions, and the engine performs every side effect: SSH and agent commands, HTTP, DNS and ICMP, and every write to the
store. This keeps plugins small, free of side effects, and testable without mocks.

A plugin's contract is:

- **Declare**: `requests()` returns a list of connector requests (`command`, `http_request`, `dns_query`,
  `ping_request`); a plugin that only runs commands overrides the `commands()` shorthand instead. Both are pure.
- **Interpret**: `parse_results()` (or `parse()` for the command shorthand) turns the connector results into one
  `CollectResult` describing everything to keep: metrics, events, log lines, a status and an optional snapshot.
- **Subscribe** (optional): `subscriptions()` declares event streams an agent watches on the target, and
  `parse_event()` turns each pushed event into a `CollectResult`. Both are pure, and ignored for targets reached over SSH.
- **Act** (optional): `plan_action()` and `interpret_action()` describe control actions (restart a service, force a
  backup) the same declarative way.
- **Present** (optional): a declarative `UI_SPEC` describes the monitor's page as data; the few monitors the spec
  cannot draw alone return `custom_view()`, the data their own page view is built from.

The engine runs the declared IO, stores the returned `CollectResult`, and drives one independent polling loop per
monitor.

## Data flow

1. **Start**: `src/server/main.ts` (the `x-monitor` command) builds one `XMonitorEngine`
   (`src/core/coordination/engine.ts`), which reads `config.yaml` and builds the monitor tree (`setup_modules()`).
   Monitor types resolve through the `PluginLoader`, from X-Monitor's own types in `src/monitors/index.ts` or from
   folder plugins under `plugin_paths`.
2. **Wiring**: for each monitor the engine builds its `ExecContext` (an agent connection or a pooled SSH connection,
   chosen by config) and hands it a read-only `PluginDataView` as `plugin.data`.
3. **Polling**: each monitor runs its own loop at its own `interval`. Each cycle the engine runs the monitor's requests
   through the **Connector Engine**, which routes each command to that target's agent or SSH connection, then calls the
   monitor's pure `parse_results()`.
4. **Events**: monitors on an agent-backed target may also declare `subscriptions()`. The agent watches those sources
   and pushes an event the moment one changes; the engine hands it to the monitor's pure `parse_event()` and stores the
   result at once, outside the polling schedule. An agent with `run_monitors` set runs its host's monitors itself and
   syncs their records back.
5. **Storage**: the engine writes each `CollectResult` with `db.apply_result(...)` into the in-memory `StateStore`;
   SQLite (through `node:sqlite` and X-Libs `sql`) is a sink behind it, written in batches and read once at startup.
6. **Pages**: every write publishes a change on the change bus. The Fastify server tells pages through
   `/api/changes` (server-sent events), and the page reloads the views it shows. Each view is JSON the server's page-view
   builders (`src/server/views/`) make from the monitors' specs and stored state; the React page (`src/web/`) only draws
   it, with X-Libs widgets and the Halon theme.
7. **Export**: metrics are exposed to Prometheus (`/metrics`), and optionally pushed to InfluxDB or published over MQTT
   with Home Assistant discovery. Notifications watch the same change bus.

## Project structure

```
src/
├── core/                   # Runs on the server and on an agent that runs monitors
│   ├── coordination/       # XMonitorEngine, PluginDataView, jobs, schedules, triggers, reload, plugin loader, agent plans
│   ├── connectors/         # All IO: agent, SSH (ssh2), local, HTTP, DNS, ICMP; request and result types
│   ├── database/           # DatabaseManager over the store, the SQLite sink, an agent's outbox database
│   ├── state/              # StateStore, records, the change bus
│   ├── settings/           # config.yaml loader, schema, runtime log levels
│   └── sync/               # The records an agent syncs to the server
├── monitors/               # One module per monitor type, plus base/ (Plugin, SignalPlugin, shared helpers)
├── server/                 # Fastify: routes, sign-in, tokens, methods, the agent socket
│   ├── views/              # Page-view builders: a monitor's page, the overview, sidebar, logs, schedules
│   ├── notifications/      # Notification Engine and channels
│   └── exporters/          # Prometheus, InfluxDB, MQTT
├── shared/                 # Types and pure rules the server and page share: page_view, ui_spec, status, agent_protocol
├── web/                    # The React page, built by Vite
└── agent/                  # x-monitor-agent: the X-Libs agent client, watchers, desktop notifications, local engine
```

[develop.md](develop.md) holds the reasoning: the pure-plugin contract, the collection lifecycle, the store and its
SQLite sink, the page views and the declarative UI spec.

## Technical stack

| Concern       | Technology                                                                        |
|---------------|-----------------------------------------------------------------------------------|
| Language      | TypeScript, run directly by Node 24                                               |
| Server        | Fastify 5                                                                         |
| Page          | React 19, built by Vite, with X-Libs widgets and the Halon theme                  |
| Connectivity  | X-Libs agent protocol over WebSocket (agent), ssh2 (SSH), Node's `fetch` and `dns`, the system `ping` |
| Configuration | YAML or JSON                                                                      |
| Storage       | In-memory state store, SQLite through `node:sqlite` and X-Libs `sql`               |
| Accounts      | X-Libs accounts: users, sessions, second factor, tokens, single sign-on           |
| Tests         | vitest                                                                            |

## Design principles

1. **Simplicity first**: configuration should be intuitive.
2. **Agent optional**: all logic stays on the X-Monitor server; a host needs only SSH, and the agent is there for hosts
   where live events, or monitoring through an outage, are worth installing it.
3. **Pure plugins**: each plugin owns its domain logic (what to collect, how to interpret it, what actions it offers)
   as pure functions; the engine owns all IO and persistence.
4. **Hierarchical organization**: nested groups and links organize monitors by location, service or environment.
5. **Fail-safe control**: control actions are logged and confirmable.
6. **Standard-aware**: data naming and export aim at OpenTelemetry compatibility.
