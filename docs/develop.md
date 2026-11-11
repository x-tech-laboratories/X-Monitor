# Development Notes

Architectural decisions and their reasons, by topic. Code comments stay at one sentence; anything that needs more
explanation lives here. This describes the code as it is; read it before changing the engine, the plugin contract or
how the page refreshes.

## Setup

- `nix develop` gives the pinned toolchain; `npm ci` installs the dependencies.
- `npm run dev:server` runs the server on `config.example.json` with `password.hash` as the accounts file, restarting
  on every change, and `npm run dev:web` runs Vite for the page.
- `npm run build` type-checks and builds the page into `dist/`; `npm start` serves it in production mode.
- `nix run` runs the packaged `x-monitor`.
- `dev/demo/run.sh` starts the dashboard on a self-contained demo fleet and `dev/demo/shoot.sh` screenshots it; see
  `dev/demo/README.md`.

## One process, one event loop

X-Monitor runs as one Node process. `serve()` in `src/server/main.ts` builds one `XMonitorEngine` (the Coordination
Engine, `src/core/coordination/engine.ts`), loads the monitor tree with `setup_modules()`, builds the Fastify app
(`src/server/app.ts`), starts listening and then calls `engine.run()`. The polling loops and the server share one event
loop and the same live `Plugin` instances; there is no IPC between collecting and serving. A page view reads through
the monitor's `data` (its read-only `PluginDataView`), which reads the same in-memory state the polling loop just wrote.

**State lives in memory.** Collectors write into a `StateStore` (`src/core/state/store.ts`) and every read is served
from it; SQLite is a persistence sink behind it, written in batches and read once at startup to restore the store. The
one exception is a finished job's full log, read from disk when someone opens it.

## Engine model

`src/core/` is organized as named engines the Coordination Engine owns and wires together:

- **Settings Engine** (`src/core/settings/`): `ConfigFileManager` loads and types `config.yaml` (`config_schema.ts`)
  at startup and on each [config reload](#config-reload); `LogLevels` holds the runtime log levels.
- **State Engine** (`src/core/state/`): `StateStore` holds the live system of record: current state (statuses,
  snapshots, settings, jobs) whole, and history (metrics, events, log lines, job output) in bounded per-stream buffers
  sized by `memory:` in the config. Record types are in `records.ts`, the change bus in `changes.ts`.
- **Database Engine** (`src/core/database/`): `DatabaseManager` fronts the store: every read is served from memory,
  and every write updates the store and is then mirrored to SQLite through a `Persistence` sink
  (`sqlite_persistence.ts`).
- **Connector Engine** (`src/core/connectors/`): all external IO. One `ConnectorEngine` routes a monitor's request list
  to the right connector: SSH, an agent, the local host, HTTP, DNS or ICMP.

The server adds the Notification Engine (`src/server/notifications/`) and the Exporter Engine
(`src/server/exporters/`), injected into the engine so a reload can rebuild them, and the page-view builders
(`src/server/views/`), which read only through `plugin.data` or the Database Engine.

`EngineLike` (`src/core/contracts.ts`) is the narrow slice of `XMonitorEngine` monitors call, and `ServerEngine`
(`src/server/engine_api.ts`) the slice the server calls, so those modules and their test doubles depend on a small
contract rather than the class.

`src/core/` and `src/monitors/` run on the server and on an agent that runs its own monitors, so they never import from
`src/server/`, `src/web/`, React or Fastify (`tests/agent/imports.test.ts`).

## Pure plugins

A `Plugin` (`src/monitors/base/plugin_base.ts`) exposes **only pure functions and data**: no IO and no persistence
handles. "Pure" constrains effects, not memory: a plugin may keep derived state between cycles (`oom`'s kill-count
baseline, `syncthing`'s discovered folder ids), but it never holds a connection, a database handle, or a side effect
inside `requests()` or `parse_results()`. It is constructed with just `(name, config)`. The engine wires its IO (an
`ExecContext` for its target) and hands it a read-only `PluginDataView` as `plugin.data`. A plugin never learns whether
its `ExecContext` wraps an agent or an SSH connection.

Collection is:

- `requests(): Request[]` then `parse_results(results): CollectResult`, the declarative path most plugins take. Both are
  pure; the engine runs the requests through the Connector Engine and hands back results in the same order.
- `commands()` and `parse()`, the command-only shorthand `requests()` and `parse_results()` default to.
- `io_call()`, the escape hatch for sequential or conditional IO a request list cannot express (`ddns_updater`: fetch
  the public IP, resolve the record, compare, maybe update; `containers`: ask image registries through
  `engine.http_fetch`). It returns a function the engine runs and awaits, and its value goes to `parse_results()`.
- `subscriptions(): StreamSpec[]` then `parse_event(stream_id, payload, timestamp)`, the push path for targets an
  agent reaches. Both pure; see [Agent transport](#agent-transport).
- `RUNS_ON_AGENT` (default `true`) says a monitor of this type can run on its host's own agent when that agent has
  `run_monitors` set, because it only runs commands on that host. A plugin that makes HTTP, DNS or ICMP requests from
  the server, reads the engine, or works across hosts sets it `false`. See [agent.md](agent.md#running-monitors-on-the-agent).

A plugin never stores anything itself. `parse_results()` returns one `CollectResult` describing everything to write
(metrics, events, log lines, status, a snapshot, settings); the engine writes it. Writes outside a cycle (a push
heartbeat from the API, a parent's open child cards) go through the engine (`engine.apply`, `engine.set_setting`),
and job updates through `plugin.jobs`, the `JobsGateway` the engine wires onto each plugin.

**Side effects a plugin asks for.** A plugin can never cause IO from `parse_results()`, so a reaction to what it just
measured (`uptime` waking a host that went down) is requested instead: after storing each polled cycle the engine calls
the plugin's pure `on_status(status, now)`, and when it returns `[action_id, args]` the engine dispatches that action
as if a button had been pressed, so its outcome is logged the same way.

**Running an action elsewhere.** An `ActionPlan` with `via: <monitor id>` runs on that monitor's `ExecContext`, which is
how `uptime` sends a wake packet from a host inside another subnet; `agent: <id>` runs it on a named agent. The plugin
names a monitor or agent, never a connection, so it stays transport-blind.

## The write path: `db.apply_result`

There is no per-plugin writer. The engine persists a `CollectResult` with one call:

```ts
this.db.apply_result(plugin.target, plugin.id, plugin.name, result);
```

`DatabaseManager.apply_result` is the only place that turns the plugin-facing `CollectResult` into store writes: it
fans the result out to metrics, events (prefixed `[plugin_name]` for the events feed), log lines, the status, the
snapshot and settings, each at the result's own `timestamp` when it carries one.

`PluginDataView` (`src/core/coordination/data_view.ts`) is the read half: it scopes the plugin-id-keyed reads
(`latest_metric`, `latest_snapshot`, `get_setting`) plus the few other reads page views need. Every method on it is a
read; there is deliberately no `apply`, which keeps plugins and pages away from the write path.

## Interface contracts

A contract that crosses modules is named once as a TypeScript type rather than agreed on by convention. Types document
and check the code; they do not validate data at runtime, so config and `UI_SPEC` values still fail at first use, not
at load.

`src/core/contracts.ts` holds the cross-subsystem contracts:

- `MetricsSource`: the read-only slice of `DatabaseManager` (`latest_metrics`, `latest_statuses`) exporters read.
- `PushablePlugin` and `is_pushable()`: the `token` and `record_push()` surface `src/monitors/push.ts` adds, so the push
  route needs no import of the class.
- `EngineLike`: the narrow engine surface monitors call.
- `TransportConnection`: the two-member surface (`host`, `execute()`) the SSH, agent and local transports share;
  `ExecContext.conn` is typed as this, so the invariant the transport swap rests on is checked.

Other typed boundaries: `src/shared/ui_spec.ts` (`UISpec` and its card, table, dialog and job-panel shapes, and
`ActionButtonSpec` for header buttons), `src/shared/page_view.ts` (the JSON a page is drawn from),
`src/core/settings/config_schema.ts` (the config's shape, not exhaustive per plugin type),
`src/core/connectors/types.ts` (requests, results, `CollectResult` and the action plans, each told apart by `kind`), and
`src/shared/agent_protocol.ts` (X-Monitor's messages on the agent socket).

**Config is checked at the top level only.** `ConfigFileManager` warns once per structural mistake (an unknown
top-level section, with the nearest known name as a hint; a section of the wrong kind; a plugin with no `type` or an
agent with no `id`), so a typo is named at startup instead of silently doing nothing. It never rejects a file. The
file is read as YAML 1.1, as PyYAML read it, and JSON is valid YAML, so `config.json` loads the same way.

## Polling loop

Each monitor runs on its own `interval`, treated as a period: the loop sleeps to the next due time rather than for the
whole interval after each cycle, so a slow cycle does not stretch the schedule, and a cycle overrunning the whole
period re-anchors instead of bursting. Monitors start with a random stagger (`STARTUP_JITTER_SECONDS`, 3) so they do
not all fire at once. After a restart, a monitor whose saved result is younger than its interval waits until that
result is one interval old, so a redeploy never repeats a daily scan. An error in one cycle is caught there, so one
crashing monitor never stops its own later polls or anyone else's.

Each background task is a promise with an `AbortController`; aborting a monitor's loop stops it at its next await.

**Any monitor can hold children.** `children` belongs to every `Plugin`, not only `group`: the engine builds it for any
config entry, `Plugin.run_cycle()` (Poll Now) polls the children before the monitor itself, and `child_statuses()`
reads their latest statuses, so an aggregating plugin folds them in a pure `parse_results()`. The scheduled loop calls
`run_cycle_now()` directly and never cascades, so a parent may read child statuses up to one child interval old. A
monitor whose status only repeats its children's sets `restates_children`; `monitor_graph.ts`'s `restates_children()`
is what notifications, the overview, the fleet tiles and `/api/summary` check to leave it out. Only a `worst` group
does.

`run_cycle_now()` is single-flight per monitor, shared by the scheduler and Poll Now, so a slow cycle never overlaps
itself.

**Cycle timing.** Every cycle that did IO is timed into `CycleStats` (`src/core/coordination/cycle_stats.ts`), a
20-cycle window per monitor that `engine.cycle_timing(id)` reads back as last, average and longest seconds plus SSH
channel wait. It is memory only and always on; `logging.cycle_timings` governs only the `cycle_collect_seconds` and
`cycle_parse_seconds` metric rows, which cost disk. `x_monitor_self` turns it into its slowest-first table. The channel
wait is measured without threading anything through the connector API: the cycle runs inside
`measure_channel_wait()`, an `AsyncLocalStorage` scope, and the SSH connection reports how long each command queued on
the host's semaphore to the tally in that scope, which keeps the longest single wait.

Two monitors with the same effective `id` (which falls back to the name) would overwrite each other's state, since
everything is keyed by id. Startup logs it, and a reload refuses it.

## Config reload

The config is re-read and applied in place, without a restart and without dropping the connections unchanged monitors
use. `engine.reload_config(source)` is the one entry point; four things call it: the file watcher, SIGHUP,
`POST /api/config/reload`, and **Reload config** in the dashboard's System menu. Reloads run one at a time, each
returns a `ReloadResult` (`src/core/coordination/reload.ts`), and each records its summary as an event: how many
monitors were added, removed and changed, and which settings need a restart.

**Validate everything, then apply.** `plan_reload()` reads the file strictly (where the startup read would fall back to
an empty config, it throws), resolves every monitor's type through a fresh `PluginLoader`, and constructs every new or
changed monitor. Any failure (an unknown type, a constructor that throws, two monitors with one id) refuses the whole
reload: the running tree is untouched, and the error goes to the log and the events feed.

**Monitors are diffed by id.** A monitor is unchanged when its class and its effective config (after `ssh_defaults` are
merged and a group's `agent` inherited, not counting `children`) equal the running one's (`same_monitor`). An unchanged
monitor keeps its instance, its loop, its in-memory state and its connection, even when it moved to another group. A
changed monitor is stopped and a new instance started; its stored history carries over because it is keyed by id.

**Applying** (`apply_reload()`), in order:

1. Removed and changed monitors are retired: their loops aborted, their exec contexts and event streams dropped. A cycle
   already in flight for a retired monitor finishes without writing.
2. The new config, plugin loader and global settings go in: retention windows, cycle-timing metrics, log levels, and
   agents when `agents:` changed.
3. New instances are wired and the tree is swapped in one assignment. SSH connections no exec context uses any more are
   closed (the pool key is host, port, user and key, so a changed monitor on the same host keeps its connection),
   agents get their new stream sets, and new loops start.
4. Notifications are rebuilt when the tree or `notifications:` changed, exporters when `exporters:` changed, and agents
   that run monitors get fresh plans.
5. Settings read only at startup (`database.path` unless `--db` overrides it, `database.write_batch_seconds`, `memory`,
   `auth`, `theme`) are compared and reported as restart required.

**Pages follow through the change bus.** A reload that changed the tree increments `engine.monitors_version` and
publishes a `monitors` change, and every page reloads its views.

**The file watcher** polls every `CONFIG_POLL_SECONDS` (3) rather than using inotify, which does not follow the ways a
config gets replaced. It stats the resolved path, so an editor that renames a new file over the old one and a NixOS
switch that re-points the symlink into the store both change the fingerprint; it waits one more poll with the same
fingerprint so a file mid-write is not read, and reloads only when the content hash differs, so a `touch` does nothing.

## Runtime log levels

Each module logs through `create_logger_for("x_monitor.<module path>")` (`src/core/logging.ts`), so a logger's name is
its module path and one module's verbosity changes without touching the rest. `LogLevels`
(`src/core/settings/log_levels.ts`) is the one place levels change: it applies `logging.level` and `logging.levels` at
startup and on a reload, and undoes a per-logger level only when the config that set it drops it. The engine exposes it
as `log_levels()`, `known_loggers()` and `set_log_level()`, which the API, the System menu and the signal handlers call.

Every change is logged at WARNING on `x_monitor.log_levels`, a logger with its own WARNING level, so the record of who
made logging quieter survives the change it describes. SIGUSR1 and SIGUSR2 step only the root level, one notch at a
time, because a signal carries no argument. They and SIGHUP are installed only when `main` asks (`handle_signals`), so
an engine built in a test never takes over the process's signals.

## Agent transport

`src/core/connectors/agent_connector.ts` is the server half of the agent link and `src/agent/` the daemon. Both sides
speak X-Libs' agent protocol (`@x-tech-laboratories/x-libs/agent/*`): the key login, running commands, long runs and
heartbeats. Everything X-Monitor adds rides as an app message on the same socket, described in
`src/shared/agent_protocol.ts`: the event streams the agent watches, desktop notifications, sleep holds, and the plan and
records of an agent that runs its own monitors. The app is `x-monitor` at protocol version 3; an agent speaking another
version is turned away, so agents are upgraded with the server.

The design rests on one decision: `AgentConnection.execute()` has the same signature and the same
`[exit_code, stdout, stderr]` failure mapping as `SSHConnection.execute()`. That is why moving a host onto an agent is a
config key and not a plugin rewrite.

**Direction.** The agent dials the server, never the reverse, at `/api/agent/ws` on the dashboard's own port. The
monitored host opens no port and needs no certificate, and a host behind NAT works untouched. A monitor on an agent that
has not dialled in fails with an explicit message, the same shape as a refused SSH dial.

**Login.** The upgrade names the agent's id in the `x-monitor-agent-host` header, the server sends a fresh nonce, and
the agent signs `x-monitor-agent-v1|<id>|<nonce>` with its ed25519 key; the server checks it against the public key
`agents:` lists for that id and holds no agent secrets. The X-Libs client refuses a `ws://` URL except to this machine,
so commands and output travel encrypted.

**Concurrency.** Commands are frames multiplexed on one socket, so there is no `MaxSessions` and no semaphore. Each
command runs in its own process group (`src/agent/executor.ts`) and a timeout kills everything it started, which the SSH
path cannot do.

**Events.** A plugin's `subscriptions()` returns `StreamSpec`s keyed by its id; the server sends an agent its full set,
never a delta, so a reconnecting agent converges without the server tracking what it knows. The agent runs one
supervised loop per stream from `src/agent/watchers.ts` and pushes an event the moment something happens. A sample
stream carries `max_quiet` (five intervals), so unchanged results are suppressed but one always lands per window and a
quiet monitor never reads as stale, and `JournalMux` shares one `journalctl --follow` process across every
unit-filtered journal stream (plus one kernel follower), so N service monitors cost two processes. The engine's
`on_agent_event()` routes each event by stream id to the plugin's pure `parse_event()` and stores the result through the
same `apply_result` the polling cycle uses.

When an agent finishes its login the engine collects every monitor bound to it at once (`on_agent_connected()`).
Monitors start their schedule when X-Monitor does, but an agent takes a moment to dial in, so a first cycle would record
a failure; for an hourly check that meant an hour of failed after every restart. A monitor still waiting out a current
saved result is left out.

Two conventions matter:

1. **The poll keeps owning status.** The plugins that stream (`oom`, `systemd_service`) return log lines from
   `parse_event()` and leave status to `parse_results()`, so one noisy journal line never flips a healthy monitor.
2. **A throwing plugin never takes down the socket.** `on_agent_event()` catches, logs and goes on.

## Agents that run monitors

An agent with `run_monitors: true` runs its host's monitors itself and keeps running them while cut off from the
server. The server compiles each such agent a plan (`src/core/coordination/agent_plans.ts`): the effective config of
every monitor on that agent whose plugin has `RUNS_ON_AGENT` set. Checks that need the server's view of the network,
groups, links and work across hosts stay on the server.

The agent runs the server's own engine over that plan (`LocalEngine`, `src/core/coordination/local_engine.ts`), with a
local command transport and an `AgentDatabase` (`src/core/database/agent_database.ts`): the server's database on a
local SQLite file, plus an outbox of every result, job step and setting as a numbered record
(`src/core/sync/records.ts`). Records stream to the server while connected and wait while offline; the server applies
each at its own time and acknowledges it, and the agent trims what was acknowledged. The agent acknowledges the plan
version it runs, and from then on the server no longer polls, schedules or triggers those monitors, sends their buttons
down as actions, and marks them unavailable when the agent goes quiet. Which monitors an agent has taken survives a
server restart in the settings store.

Statuses that arrive late fill in the history without alerting (`LATE_STATUS_MILLISECONDS`); once live records resume,
the Notification Engine sends one summary per agent. While offline, the agent raises desktop notifications itself
through the local socket a desktop agent on the same host listens on.

## SSH transport

`src/core/connectors/ssh_connector.ts` uses ssh2, the maintained pure-JavaScript SSH implementation, rather than the
system `ssh` client: one connection per physical target, each command a channel on it. `ConnectorEngine` pools one
`SSHConnection` per host, port, user and key; a plugin's per-target handle is a small `ExecContext`.

Three behaviours matter:

1. **Killing a remote command.** A timed-out command is sent TERM, then KILL after a grace period, and its channel
   closed; a command's own deadline (`deadline_prefix`) sits inside any `sudo`, so a root command can be killed by its
   own `timeout`.
2. **Host-key trust.** Trust on first use: the first key a host shows is stored in `known_hosts` under
   `$XMONITOR_SSH_CONTROL_DIR` (default `x-monitor-ssh` under the system temp folder), and a later mismatch is refused.
3. **Per-host channel limits.** X-Monitor bounds its own channels per host (`MAX_CONCURRENT_PER_HOST`, 8, a semaphore)
   below sshd's default `MaxSessions` of 10. A host with many monitors raises `MaxSessions` or moves to the agent.

## Job control

A long-running job (a borg backup, a flake evaluation) is not a channel held open for hours. It is launched detached on
the target with one ordinary command (`setsid sh -c '…' &`), writing its output to `<workdir>/out` and its exit code to
`<workdir>/exit`, and is then advanced by ordinary polling commands on the owning monitor's cycle. A plugin that sets
`job_poll_interval` is polled that often while one of its jobs runs (`Plugin.next_cycle_in()`), without moving its
regular schedule. The command builders and parsers in `src/core/connectors/job_commands.ts` are pure: one poll returns
the output size, the exit code (empty while running), whether the process lives, and any output past the offset the last
poll consumed.

Because the job lives on the target it **survives an X-Monitor restart**: `reconcile_orphaned_jobs` fails only jobs with
no pid (lost before launch), and a job with a pid is re-adopted by its monitor's next poll.

A plugin's main job is the one `jobs.running()` returns; side jobs run beside it and never grey out its actions. A kind
in `Plugin.SIDE_JOB_KINDS` is a side job the plugin polls itself. An action whose plan sets `detached` (a custom action
with `detached: true`, a container prune, a borg diff or restore check) is a side job of kind `action:<action id>` the
plugin never polls: the engine launches it, and `ActionJobs` (`src/core/coordination/action_jobs.ts`) polls every
running one every five seconds, every two while someone has its log open. When one ends, its whole output goes to the
action's interpreter as a `CmdResult`, as if the command had run inline. The action's arguments live only in memory, so
after a restart a run is interpreted without them.

A job's command prints its output as it runs, never into files read at the end, because its log is read while it runs.

Jobs live in the store like everything else, so **job ids are assigned by the store**: `jobs.create` returns an id at
once, and the row is written under that id with the next batch. A `JobRecord` is the one record that changes in place;
readers take a copy through `job_as_dict()`. If X-Monitor dies between launching a job and the next batch, the job is
lost from memory and disk, and the process on the target has nothing to re-adopt it.

## SQLite: persistence, hydration, retention

SQLite is written much and read once, at startup; every runtime read is served from the store. It runs on `node:sqlite`
through X-Libs `sql`, in WAL mode with `synchronous = NORMAL`.

**Writes are batched.** Every write is queued and whatever arrives within `database.write_batch_seconds` (default 1)
commits as one transaction. Because the store, not the database, is what pages read, a slow disk never makes a read
wait. The trade-off is a crash losing the unflushed batch. `flush()` writes the queue, and `engine.shutdown()` calls it
after closing every transport, so a clean exit keeps the tail.

**The tables are the Python app's.** Tables, columns, indexes and the local text timestamps match the peewee models, so
an existing X-Monitor database opens in place: the legacy column renames and every additive migration run on open,
under X-Libs `migrate` with the owner `x-monitor`. Row ids stay SQLite integers, since these tables are logs that never
sync between hosts.

**Hydration** (`DatabaseManager.hydrate()`) restores the store at startup: the latest status per monitor, the recent
tail of each metric series, recent events and log lines, all snapshots and settings, and recent or unfinished jobs.
Each history stream loads only as deep as its buffer, so startup cost is bounded by `memory:` rather than by how large
the database has grown. A failure here is logged, not fatal; the store starts empty and collectors refill it.

Hydration runs in `engine.run()` after the server is already listening. Until it finishes `engine.ready` is false:
`register_starting_page` (`src/server/startup.ts`) answers every request with 503 (a starting page for a browser,
`{status: "starting"}` for the API), agent events are dropped, and agents that connected early are collected once it is
ready.

**Indexing.** `metric` carries one series index on `(plugin_id, metric_name, timestamp, value, target)`, holding every
column hydration loads for a series' tail, so the tail reads from the index alone. `ensure_series_index()` builds it at
the start of hydration, behind the starting page.

**Retention.** Metrics and a status row are written on every poll, so both tables grow without pruning. The prune loop
runs `prune_metrics` and `prune_status` (the metric retention window) beside `prune_logs` and `prune_jobs` (the log
retention window) once an hour; `prune_status` always keeps the newest row per monitor. `logging.metric_downsample_days`
(off by default) thins metrics older than the window to one row per series per hour, one day per pass, remembering how
far it got. `0` turns a window off.

**Snapshots.** A snapshot exists because a metric carries one named number, which is wrong for a process list or a
unit list. A plugin with row-level data returns a `snapshot` in its `CollectResult` and reads it back with
`latest_snapshot`; the store holds the object as it is and serialises it only on the way to disk.

**Log-line dedup** is enforced by the store, which keeps a hash set per target beside the buffer, since collectors
re-fetch the same trailing lines every cycle. The set ages out with the buffer.

**Retention and buffers** are separate knobs: `logging.retention_days` and `logging.metric_retention_days` prune the
database file; `memory:` bounds the buffers. **Memory is bounded by config, not by uptime**: every stream has a ceiling
(defaults in `default_buffer_sizes`), and jobs get two more bounds, `jobs_per_plugin` (oldest finished jobs evicted) and
`finished_job_output` (a finished job's output trimmed to a short tail, its whole log kept on disk).

**State backups.** The state database's backups are X-Libs `sqlite_backups`: `VACUUM INTO` copies in a `backups` folder
beside the database, taken daily and 14 kept by default, listed and restored under Settings or `/api/state-backups`. A
restore is staged beside the database and taken in on the next start, before the engine opens it; X-Monitor exits with
code 75 so its service manager starts it again.

## Page refresh: push, not polling

Pages do not poll the server for changes. Every semantic write on the Database Engine publishes one change on the bus
in `src/core/state/changes.ts`, tagged with its kind (`status`, `metric`, `event`, `log`, `job`, `snapshot`, `setting`,
or `monitors` after a reload) and the monitor it belongs to. An idle system publishes nothing.

The server follows the bus once (`follow_changes` in `src/server/app.ts`) and tells every open page through
`/api/changes`, an X-Libs `EventStream` of server-sent events. The first change goes out at once and the rest arriving
within `CHANGE_COOLDOWN_SECONDS` (0.5) collapse into one, which keeps latency at zero for an isolated change while
bounding the rate on a busy system, where one cycle publishes a change per metric, log line and status. Each message
names the kinds and monitors that changed.

The page follows the stream with X-Libs `follow_changes`, which bumps a watch on each message and after a reconnect.
Each view loads through X-Libs `use_resource` with `live` (`src/web/api.ts`): it reloads quietly when the watch bumps,
and every 60 seconds as a backstop for values that age on their own, such as a running job's duration. Every call the
page makes carries its stream client id, so a change the page made itself is not audited as a script's.

Reads are lookups over live objects, so there is no cache and no TTL: a read sees what the last collector wrote.

## The server and its API

`src/server/app.ts` builds the Fastify app. Every call is written once in `src/server/methods.ts` over the engine, and
four doors open onto the same methods:

- the REST routes scripts have always used (`/api/health`, `/api/monitors`, `/api/events`, poll, actions, push, log
  levels, config reload);
- the page's own routes (`/api/sidebar`, `/api/overview`, `/api/monitors/:id/page`, `/run`, `/toggle`, jobs);
- calls by name at `POST /api/call/:method`, described once in `src/server/api_spec.ts` as an X-Libs `ApiSpec`;
- the same calls as MCP tools at `/api/mcp` and as an OpenAPI 3.1 document at `/api/openapi.json`.

A call named `list_`, `get_` or `search_` only reads and is marked read-only, which is what lets a viewer or a read
token make it. A refusal is an `ApiError` carrying its status and `{error}` body, answered the same way by every door.

## Page views

The page never sees a `UI_SPEC`. The server's page-view builders (`src/server/views/`) walk a monitor's spec, its
`custom_view()`, its stored readings and its attributes, and return plain JSON in the shapes `src/shared/page_view.ts`
declares: rows of cells, each holding widget views (value cards, repeated items, gauges, share bars, strips, history
charts, tables with row actions and toggle cells, button rows, dialogs, the job panel). The page draws them, runs the
actions they name, and fills each `{row[field]}` from the row a click came from. `page_view.ts` also holds the few pure
rules both sides apply, such as how a value takes its status colour. So a rule function in a spec (a formatter, a
colour rule, a `visible_if` predicate) runs on the server and only its result crosses to the browser.

`src/server/views/spec.ts` is the declarative page, as `generic_render()` was: a card dispatches on its first matching
key (`repeat`, then `kind`, then `metrics`, then `metric`, then the static and attribute forms), and `host_card` and
`status_card` are reserved names. `custom.ts` builds the pages the spec cannot draw alone (`systemd_service`, borg's
archive browser, the journal's log search), and `group.ts` the composite grid and child cards. A spec's `value_attr`,
`color_attr`, `rows_attr` and `options_attr` name plain attributes of the plugin (`plugin_attr`), without Python's
leading underscore.

## The page

`src/web/` is a React page built by Vite. `main.tsx` holds the X-Libs `Shell` (top bar, sidebar with the views and the
monitor tree, theme button, toasts and dialogs), the sign-in form and the hash router: `#/`, `#/monitor/<id>`,
`#/events`, `#/schedules`, `#/logs`, `#/settings`, `#/account` and, for an admin, `#/users`. `api.ts` names every route
the page calls, with the shapes the view builders return. Widgets come from X-Libs (`DataTable`, `Tree`, `LineChart`,
`Donut`, `Meters`, `Strip`, dialogs, badges, controls); `src/web/widgets/` holds the three it lacks: the gauge, the share
bar and the treemap.

Folder plugins for the page itself are listed under `/plugins` from a `plugins` folder beside the config, loaded by
X-Libs `load_plugin_modules` and switched on or off in Settings.

## Accounts and tokens

Sign-in is X-Libs accounts (`src/server/auth.ts` over `server/account_sign_in` and `server/account_store`): users,
sessions and page-made tokens live in the state database under `account_*` tables, with the roles `viewer`,
`operator` and `admin`. `needed()` says what each route takes: reads anyone signed in, other writes an operator,
writes to state backups an admin. The admins are declared: the accounts file named by `X_MONITOR_PASSWORD_HASH_FILE`
(`name:hash` lines from `npm run hash-password`) plus config's `auth.username` and password, its name lower-cased.
`X_MONITOR_OIDC_*` adds single sign-on. With nobody to sign in as, no accounts are mounted and the dashboard and API stay
open, as they did before any auth was configured; push tokens still work, since the push route checks them itself.

`auth.tokens` stays as declared tokens (`src/server/tokens.ts` over X-Libs `declared_tokens`): `read` signs in as a
viewer, `control` as an operator, and `push` reaches only the push route. Only a SHA-256 digest of each token is kept;
the tokens are 256-bit random values, so a fast unsalted hash is enough, and a presented token is compared in constant
time. A token never opens a browser session. Tokens can also be made per user on Your account.

**The audit trail.** `acting_client()` names who made a request (the account, `token '<name>'`, or `<user>'s token`).
The control routes write it into the monitor's events, push heartbeats carry it through `record_push(source)`, and every
write made with a token is logged (reads only at debug, since a scraper calls every few seconds).

**Agents are not accounts.** Each `agents:` entry has its own ed25519 public key, which the agent socket checks.

## Theme

The page wears Halon (`@x-tech-laboratories/halon`): `halon-tokens.css` is the only place a literal colour exists, in a
light and a dark block, and `halon.css` the component rules, where every value is a `var(--token)`. The page imports
both first, then X-Monitor's own `app.css` and `widgets.css`, which use only tokens. Charts are DOM and SVG painted with
the same variables, so they follow the scheme with no repaint, and `src/shared/charts.ts` names Halon tokens rather than
colours. The light, dark or system choice is the X-Libs theme button, kept in the browser.

Text case follows what the text is: headings (table, job panel, events and dialog titles) are sentence case; labels
(card and chart titles) are capitals; buttons are title case (`Poll Now`, `Shut Down`).

## Exporter Engine

`ExporterEngine` (`src/server/exporters/index.ts`) owns the push exporters; the Prometheus render (`prometheus.ts`) needs
no runtime object. The engine starts it once running and stops it on shutdown, and hands it a function returning the
live monitors, so an exporter that describes them (MQTT) always sees the current set.

**InfluxDB** pushes the latest snapshot on a fixed interval.

**MQTT** (`mqtt.ts`, on the `mqtt` package) is change-driven. It follows the change bus for `status` and `metric`
changes; a changed monitor joins a dirty set, and a drain waits `COALESCE_SECONDS` (1) before publishing, so a cycle that
writes ten metrics and a status goes out as one pass. Everything is marked for publishing on every (re)connect, on Home
Assistant's birth message, and on the optional `interval`. The connection carries a retained last will of `offline` on
`<base>/status`, and `online` is published retained on connect. Discovery gives one Home Assistant device per target
and, per monitor, a status `enum` sensor and a `problem` binary sensor, plus a sensor per metric whose unit and device
class come from the metric name (X-Libs `mqtt_discovery`). Any error ends the session, which reconnects with backoff
from one second to a minute; nothing is queued while disconnected, since the reconnect republishes the current state.

## The overview's fleet sections

Above its charts the overview draws the fleet: a tile per root of the monitor tree, its dot showing the worst state
among its monitors; reachability strips for every uptime, http, mosquitto, dns_record and push monitor, grouped by host;
a meter per borg repository of the time since its newest archive; a tile per NixOS deployment; and a bar per
vulnerability scan. A section appears only when the fleet has monitors of its kind. `src/server/views/fleet.ts` builds
each section with a pure function over monitors and readings, read from the latest metrics and the in-memory history,
so the strips cover the last 60 readings rather than a fixed time span.

## The logs view: searched live, not stored

The Logs page and each `journal` monitor's page search the hosts' journals when asked, rather than reading copies
X-Monitor kept. A journal holds every line every service writes, and journald already keeps, rotates and indexes it.
The search is the plugin's `query_logs` action, so it stays pure: `plan_action` builds the `journalctl -o json` command,
`interpret_action` parses the reply into the action's metadata, and the engine runs it over SSH or the agent like any
other action. `src/server/views/logs.ts` dispatches it on every chosen monitor at once and merges the entries; nothing is
written, so a search logs no event. The poll only counts warnings and errors after the cursor it last saw.

## Overview charts: a donut for status, a treemap for type

Status has five fixed slices, so part-to-whole reads at a glance in a donut. Type does not: a modest config declares
around 25 monitor types, most of them once, which a pie handles worst. The type card is a treemap instead: tile area is
the monitor count, the label inside carries identity, and each tile takes the worst status among its monitors from the
five status tokens. So the chart needs no categorical palette, and one failed unit inside a healthy type shows without
opening it. Clicking a tile or a slice filters the monitor table.

## Declarative UI spec

Most monitors reduce to the same shape: a few metric cards with a formatter, a layout grid, a chart, an events table. A
plugin declares that shape as its `UI_SPEC` (`src/shared/ui_spec.ts`) rather than describing widgets. Only `group` and
`systemd_service` need a page of their own, through `custom_view()`; `borg` and `journal` add a part to their spec's
page the same way.

Formatter, colour and predicate rules are named from registries in `src/shared/ui_registry.ts` (`FORMATTERS`,
`COLOR_RULES`, `ITEM_FORMATTERS`, `ITEM_COLOR_RULES`, `ENABLED_PREDICATES`), the shared vocabulary every plugin can use,
or given as the function itself for a one-off rule. A plugin registers a name of its own only to publish a rule others
may reuse; a card's own limits go in the spec as `color: { warning: this.warning, threshold: this.threshold }`.

`src/server/views/layout.ts` lets the config override a monitor's arrangement two ways: replacing the rows, or
per-widget overrides (visibility, height, flex, min width, title) merged onto the default rows. Every cell is made up
front in declared order, so a page follows its layout rather than the order the builder fills it.

**A layout is injectable, which is what lets a group mix children.** A group with a `layout` addresses its
descendants' widgets as `<child_id>.<widget>`; the builder renders each child's spec into the group's cells and builds
only the widgets a cell claims. Only a monitor with a `UI_SPEC` can be taken apart this way; one with a page of its own
is referenced by its bare id and drawn whole. Without a layout, a monitor with children shows one collapsible card per
child, whose open state is kept per parent as a setting.

## Chart widgets

A spec can ask for a chart in place of a card: a gauge for one percentage, a share bar for parts of a whole, an uptime
strip for a run of up/down checks, meters or status tiles for repeated items, and a history chart holding several
series. `src/shared/charts.ts` holds the geometry both sides share (how full a bar is, which strip cells are up, how
histories line up on one axis), and the page draws each as DOM or SVG painted with Halon's variables.

Cards and tiles stay plain whatever their state: status shows only in the marks inside them (the coloured value, badge,
dot, arc, meter or strip cell), so a page of trouble reads as marks to scan rather than a wall of tinted panels. Every
widget prints its value beside its shape, so the shape reinforces the number rather than carrying it alone.

## Monitor types and helpers

A monitor's `type` names a class: X-Monitor's own types are in `src/monitors/index.ts`, each imported only when a
monitor uses it. A plugin that outgrows one file becomes a folder (`src/monitors/borg/`, `src/monitors/containers/`).

**Out-of-tree types.** `PluginLoader` (`src/core/coordination/plugin_loader.ts`) owns the type-to-class step. A type
X-Monitor does not ship is looked up in the `plugin_paths` folders, in order. Each folder holds X-Libs folder plugins
(`plugin_folder`): a subfolder whose `package.json` names its server entry under `"x-plugin": {"server": ...}`, loaded
through an X-Libs plugin host. Its `start(context)` provides `monitor_type` entries keyed by type name with
`context.provide`, and reaches X-Monitor's `Plugin`, `CollectResult` and `command` through the host's services. A
built-in name wins by default, because silently swapping a shipped plugin is the surprising outcome; an entry with
`override: true` reverses that, and both cases log a warning. The type name must be an identifier. Each loader imports
the folders once, and a reload builds a new loader, so an edited plugin is read again on the next reload.

A plugin whose subject is not the host it collects on (`vuln_scan` runs nmap on one agent against another host) sets
`display_target`, and the engine labels the monitor with it instead of the transport's target.

`src/monitors/base/plugin_helpers.ts` holds the shared pure helpers: `limit_from`, `level_for`, `floor_level_for`,
`limits_text`, `StatusAccumulator`, `format_bytes`, and `parse_duration` and `format_duration` from X-Libs `durations`
(`'1w'`, `'7d'`, `'2h30m'`, `'1d12h'`). `format_bytes` reads its value in GB by default and takes a unit for the rest.
`text_parsing.ts` reads text as Python's builtins did (`split_lines`, `split_words`, `parse_int`, `parse_float`), and
formats fixed decimals with ties to even (`format_fixed`), so messages read as they did.

`src/monitors/base/disk_usage.ts` holds the `df` and `du` handling the three filesystem monitors share, so they cannot
read the same output differently. `filesystems`, `disk_space` and `folders` stay separate monitors (a fleet-wide sweep,
one path against one threshold, and folder sizes are different questions), but each builds its command with
`df_command()` or `du_command()` and reads it back with `parse_df()` or `parse_du()`. `parse_df` reads every column but
a leading `target` from the right, so a mount point with spaces survives. `metric_family.ts` finds the metrics a monitor
records one per item (`folder_<name>_gb`, `fs_<name>_used_pct`) for both the monitor and the page.

`src/monitors/base/dns_lookup.ts` is the one record lookup `dns_record` and `ddns_updater` share, so the two can never
disagree about what a record resolves to.

`src/monitors/base/signal_plugin.ts` holds what the single-signal monitors (`cpu`, `memory`, `load`, `temperature`,
`interrupts`, `gpu`, `oom`, `throughput`, `connections`, `wifi`, `smart`, `zfs`, `btrfs`, `md`, `disk_io`,
`reboot_required`, `package_updates`, `interfaces`, `sessions`, `journal`, `power`) share: `worst_status` and a
`SignalPlugin` base that turns the `cards()`, `tables()`, `charts()` and `rows()` a monitor declares into the usual host
card, tables, charts and events page.

**One signal per monitor, grouped in config.** A host's page is assembled by a `group` (per host, then per domain), not
by one plugin collecting seven things. That costs one round trip per monitor instead of one per host, which over a
persistent socket is cheap, and buys per-signal status, interval and history, and cells a group layout can address one
at a time (`ragnarok-cpu.cpu_chart`). Signals with different costs therefore get different intervals: `smart` runs
hourly and `cpu` every minute because they are separate monitors on separate loops.

The same holds for things a user names and acts on one at a time. `systemd_service`, `service_list`, `containers`, `vms`
and `processes` look alike but stay separate: each named unit wants its own status and restart button, and systemd,
podman, libvirt and `/proc` share no code a merged plugin could reuse. Each application plugin (`pihole`, `borg`,
`frigate`, …) is its own monitor; a "backup" or "media" grouping is a `group` in config. A plugin that combines other
monitors, such as a quorum, holds them as `children` and reads what they stored rather than collecting their signals
again.

## Testing

Tests run under vitest (`npm test`, or `npx vitest run <file>` for one file), keep files in temporary folders and use
no network. Monitor tests (`tests/monitors/`) drive the pure `commands()`/`parse()` or `requests()`/`parse_results()`
through `tests/harness.ts`: `make_plugin` constructs a monitor and wires its data view, jobs gateway and a `FakeEngine`,
and `run_cycle`, `run_requests` and `run_io_cycle` run one cycle through fabricated results and write what it returns,
so a test reads the store as a page would. The other folders follow the source: `tests/core/`, `tests/server/`,
`tests/views/` for the page-view builders, `tests/web/`, `tests/agent/` and `tests/integration/`.
`npx tsc -p tsconfig.server.json --noEmit` and `tsconfig.web.json` type-check each side, and `npx oxlint` lints.
