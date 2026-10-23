# Offline agents plan

The plan for agents that keep monitoring their host while cut off from the X-Monitor server, and
sync everything back when they reconnect. How the agent works today is in [agent.md](agent.md).

## What changes

Today the agent is a remote shell: the server decides what to run, sends each command, and parses
the output itself. When the connection drops, the agent stops every stream and kills every running
command, and nothing on that host is watched until it comes back.

After this work the agent is a small X-Monitor engine of its own:

- The server sends each agent the monitors that belong to its host, with their schedules,
  triggers and actions.
- The agent always runs them itself, connected or not: polls, scheduled actions, triggers and
  detached jobs. There is one code path, and no handover when the link drops.
- Everything it records goes into a local SQLite outbox with its original time. While connected,
  records stream to the server at once. While offline, they wait, and the server takes them all
  when the agent reconnects: every metric, status, log line, event and job line.
- The server keeps the dashboard, history, alerting and the control plane. Buttons, config changes
  and commands go down to the agent, which runs them and reports back.

## Decisions

| Question | Decision |
|---|---|
| Which monitors move | Host-local ones: every monitor whose commands run on that agent's own host. Checks that need the server's view of the network (HTTP, DNS, ping, push), groups and links, and cross-host work (`switch_agent`, `build_agent`, `scan_host`, `via`, `Command.agent`) stay on the server. |
| Who runs them while connected | The agent, always. |
| Plugin code | Shipped to the agent. The agent package is the full X-Monitor package without the dashboard. |
| Offline storage | A local SQLite database: plugin state plus an outbox of numbered records, trimmed once the server acknowledges them. |
| Alerts after an offline stretch | Every record syncs back with its original time. The server sends one summary notification per agent covering what changed while it was away, then alerts on the current state as usual. |
| Alerts while offline | The agent raises desktop notifications itself for status changes while it cannot reach the server. |

## Design

### Packaging

The agent installs the `x_monitor` package minus the UI: the plugins, `core.coordination`
(schedules, triggers, the cycle runner), `core.connectors` (local execution only) and
`core.state`. The rule "`x_monitor_agent` never imports `x_monitor`" is replaced by
"the agent never imports `x_monitor.core.ui` or NiceGUI", enforced by a test that imports the agent
entry point with `nicegui` made unimportable.

The Nix agent package builds from the same source as the server, without the UI dependencies. The
server and its agents run the same code: the hello frame carries `code_version()`, a hash of both
packages' sources, and the server refuses to hand monitors to an agent whose hash differs (it still accepts its records and runs its
legacy commands). TechNet deploys both from one flake input, so they move together.

Plugins loaded from `plugin_paths` must be installed on the agent too; a monitor whose type the
agent cannot import stays on the server, which logs why.

### Assignment

On connect, and on every config reload, the server compiles each agent's plan:

- every monitor whose effective `agent` is that agent and which is host-local, as its effective
  config (group inheritance and `ssh_defaults` already applied);
- with its `schedule`, `triggers` and custom `actions`;
- a plan version, a hash of the above.

The agent builds plugin instances from the plan exactly as the engine does, keeps the plan on disk
so a restart while offline carries on, and acknowledges the version. Reload on the agent reuses
`reload.same_monitor`, so an unchanged monitor keeps its instance and state.

Secrets are resolved where the monitor runs: a `password_command` or secret file named by an
agent-run monitor is read on the agent's host.

### The agent's local engine

The agent runs the same loops the server does, for its monitors only: the poll loop (interval,
`offset`, job polling), the schedule loop and trigger evaluation. Commands run through the local
executor instead of a WebSocket. `SAMPLED` monitors keep their sample watchers.

Disconnecting no longer stops streams or kills running commands. Inhibits a running job holds stay
held.

Plugin state lives in the agent's database: `PluginDataView` (latest metric, snapshot, settings,
statuses) and `JobsGateway` get a local implementation with the same interface, so plugins do not
change. Schedule and trigger markers are agent-owned settings.

Job ids are assigned by the agent as `<agent>:<n>`; the server stores agent jobs under those ids.

### Records and sync

Every write a cycle, action or job makes becomes a record with a sequence number, the agent's id,
the monitor id and the time it happened: status, metric, event, log line, snapshot, setting, job
and job output.

Protocol v3 adds:

| Frame | Direction | Meaning |
|---|---|---|
| `plan` | server → agent | The agent's monitors and their schedules, triggers and actions, with a version |
| `plan_ack` | agent → server | The version the agent now runs |
| `records` | agent → server | A batch of records in sequence order |
| `records_ack` | server → agent | The highest sequence number the server has stored |
| `action` | server → agent | Run an action on an agent-run monitor: request id, monitor, action, arguments |
| `action_result` | agent → server | The action's outcome for that request id |
| `poll_now` | server → agent | Run a cycle now |

The server stores each batch, then acknowledges it. A record the server has already stored (same
agent and sequence number) is skipped, so resending after a dropped acknowledgement is harmless.
The agent trims acknowledged records and keeps unacknowledged ones up to a size bound, dropping
the oldest metric records first if a host stays offline for very long.

An `action` carries a request id, and the agent remembers recent ids, so a button press resent
after a reconnect runs once.

### Applying records with their own time

`CollectResult` and `apply_result` take a timestamp, and every write carries it through to SQLite.
The in-memory state store inserts by time rather than appending, and the latest value of a
series is the newest by time, so a backfilled record never becomes "latest" over a newer one.
Downsampling and pruning cut by record time; a late record in an hour that was already thinned is
thinned on the next pass.

### Alerts

Records that arrive in real time alert as today. A sync after an offline stretch does not replay
each status change. The server sends one summary notification per agent listing what changed while
it was away (for example "On Disk failed 02:10, recovered 02:40"), then alerts on each monitor's
current state as usual. While offline, the agent sends desktop notifications itself for its
monitors' status changes, through the desktop session the agent already notifies on Odin.

### What the server keeps doing for an agent-run monitor

The server keeps the monitor's place in the tree, its page and its history. Its status is the
agent's latest record, and `unavailable` once the agent has been silent past a grace period. The
buttons send `action` frames, and Poll Now sends `poll_now`.

## Phases

Each phase lands on its own and leaves X-Monitor working.

1. **Timestamps through the write path.** `CollectResult.timestamp`, `apply_result` and the
   database write it, the state store inserts by time, and notifications ignore a status older
   than the current one. Nothing else changes yet.
2. **Agent packaging.** Agent package from the full source without the UI, the import test, and
   the version in the hello frame.
3. **Local plugin state.** Store-backed `PluginDataView` and `JobsGateway` the agent can run on its
   own SQLite database, with agent-assigned job ids.
4. **The agent's local engine.** Poll, schedule and trigger loops on the agent over the local
   executor, driven by a plan file; disconnecting stops nothing.
5. **Protocol v3 and sync.** `plan`, `records` and their acknowledgements, `action` and `poll_now`;
   the server compiles plans and applies records.
6. **Alerts.** The reconnect summary on the server and desktop notifications from the agent while
   offline.
7. **Rollout in TechNet.** Odin first, then Thor and Ragnarok, then Heimdall's own agent.
   With Odin's backups running on Odin, Vorta's profiles move to X-Monitor and Vorta goes.
