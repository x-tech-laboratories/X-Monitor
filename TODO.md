# TODO — Finish the move to X-Tech Laboratories

- [x] Design a hexagon logo in the X-Tech style (see the `.github` repo's `branding/README.md`) and use it as the app, agent and desktop-notification icon.
- [x] Add `AGENTS.md` (with `CLAUDE.md` importing it), a CI workflow running `ruff check` and `pytest`, the AI review workflow, and the readiness badge in the README.
- [x] Protect `main` with a ruleset that requires CI to pass.
- [x] Run the full test suite and fix anything the rename broke.
- [x] Add a "Moving from Vigil" section to the README: new option names, commands, `XMONITOR_*` variables, users, `/var/lib/x-monitor/x-monitor.db`, the `x_monitor_self` type and `x_monitor_*` metrics.
- [x] Add X-Monitor to the website's projects and home pages, and rescore readiness.
- [x] Update TechNet: flake input `github:x-tech-laboratories/X-Monitor`, `services.x-monitor*` options, hard-coded `vigil`/`vigil-agent` users and sudo rules, persisted `/var/lib/vigil`, and move the old database across.

# TODO — X-Monitor as the fleet's only backup tool

Decided 2026-10-21: retire Vorta and borgmatic and run every borg backup from X-Monitor. Ready-made
web UIs were ruled out: Borg UI is open-core, Borg Backup Server runs maintenance from its server and
has no repo on the client's own disk, and Backrest or Zerobyte would mean moving to restic.
The rules the work follows:

1. **Nix decides, X-Monitor acts.** Sources, excludes, targets, schedules, retention and check cadence
   are declared in the flake; X-Monitor's database holds only runtime state.
2. **The agent runs its own schedule**, catches up on missed runs and keeps going while the server is down.
3. **Jobs on one repo queue** instead of racing each other on `--lock-wait`.
4. **Small core, narrow privileges**: backup stays a plugin, and the agent may run only what it needs.
5. **Something outside X-Monitor watches X-Monitor.**
6. **Canary restores and stale-backup alerts stay.**

### Done

- [x] Cron schedules with catch-up of missed runs, and triggers ([schedule.py](x_monitor/core/coordination/schedule.py), [triggers.py](x_monitor/core/coordination/triggers.py)).
- [x] `run_backup` chains prune and compact, skips on a failed preflight, and takes local-path or `ssh://` repos.
- [x] Agents can run their monitors without the server (`run_monitors`, [local_engine.py](x_monitor/core/coordination/local_engine.py)).
- [x] Canary extracts, `max_age` and `check_kinds` on every backup monitor.
- [x] TechNet: borgmatic removed from Heimdall (2026-10-22) and Odin (2026-10-23); X-Monitor schedules all five of their backups.

### Gaps

- [ ] **Turn on `run_monitors` for the backup agents.** TechNet sets it nowhere, so every schedule
      fires from Heimdall: with the server down nothing backs up, and a slot that comes up while Odin is
      offline is used up rather than deferred. Prove it end to end before relying on it.
- [ ] **Start the schedule loop on reload.** `engine.py` spawns `_schedule_loop` only at start-up and
      only when some monitor already has a schedule; `_apply_reload` never starts it.
- [ ] **Retry skipped and failed runs** within a window, instead of waiting for the next slot or for
      `max_age` to trip the `failed` trigger a day later.
- [ ] **Agent-side plan source.** An agent runs only a plan the server has sent it, so a host whose
      agent has never connected backs up nothing, and a plan change made while the server is down never
      reaches it. Consider letting `agent-module.nix` write the host's plan from Nix.
- [ ] **A per-repo job queue** that also covers polls, canary, browse, diff and Verify Restore, which
      today rely on `--lock-wait`. The `flock` is one per host with no time limit and does nothing
      across hosts writing to the same server.
- [ ] **Backup plans as one unit**: one plan with several targets and per-target retention, instead of
      one monitor per target repeating the same sources.
- [ ] **Narrow the agent.** It runs any shell string it is sent; add a per-action allowlist. In TechNet,
      `borg *` with SETENV (`borg with-lock`, `BORG_RSH`) and `systemctl start|stop *` are effectively
      root, and `ProtectHome` is off.
- [ ] **Keep secrets out of `plan.yaml`.** The agent stores its whole plan at
      `/var/lib/x-monitor-agent/plan.yaml`, so an inline `passphrase` would land there; and
      `borgPassphraseFile` names a server path that breaks under `run_monitors`.
- [ ] **Dead-man check from outside.** Nothing alerts if X-Monitor itself goes silent; for example a
      timer on Ragnarok that probes the X-Monitor API and notifies on its own.
- [ ] **Retire Vorta (TechNet).** Turn Odin's three Vorta monitors into scheduled monitors with
      `archive_prefix`/`prune_match` set to keep pruning the `Odin-*` archives (the shared default is
      `backup`), and check their `source_paths` against Vorta's `settings.db` first. Then remove
      `vorta.nix` and its overlay patch, the `vorta_*` secrets, the three `borg-compact.vorta` units
      and the Vorta entries in `steam.nix`.
- [ ] **Ragnarok's checks (TechNet).** Its own `borg-check` units and Heimdall's scheduled checks both
      check the server repo. Keep one: run them through an X-Monitor agent on Ragnarok (local reads,
      no network), or watch the units with `check_units`.
- [ ] **Per-target retention (TechNet).** Vorta kept fewer archives on-disk and on Heimdall than on
      Ragnarok; the X-Monitor monitors use one policy for all targets.
- [ ] **Leftover names and comments (TechNet).** `borgmatic.yaml`, `borgmatic-repo-group-read`,
      "Borgmatic" repo paths, `backups-*-borgmatic` ids, `.vigil-canary`, and comments in
      `x-monitor.nix`, `vorta.nix` and `backups/borg.nix` that still describe Vorta and borgmatic.
- [ ] **Docs.** [plugins.md](docs/plugins.md) still says borg runs over SSH from the server; finish
      phase 7 of [offline-agents-plan.md](docs/offline-agents-plan.md) and add a page on running backups
      with X-Monitor.

# TODO — Chart follow-ups

- [ ] Count erroring feeds in FreshRSS. Its Fever API has no per-feed error field, so the freshness share shows fresh and stale only; find another endpoint that reports feed errors.
- [ ] Count Syncthing conflicts per folder. `/rest/db/status` does not report them, so folder tiles show pull-error counts; conflicts need another request per folder.
- [ ] Draw uptime strips over a fixed span (say 24 hours) rather than the last 60 readings, which needs a status-history query against the database.
- [ ] Add the mockup's 30-day backup calendar to the overview: one cell per day per borg repository, from archive history kept beyond the in-memory buffer.

# TODO — Feature gaps vs LNXlink and Valent

Gap analysis of X-Monitor's 45 plugins against two adjacent Linux projects, 2026-08-11.

- **[LNXlink](https://github.com/bkbilly/lnxlink)** — 60 modules. An MQTT agent that runs *on* the
  monitored host and publishes to Home Assistant. Overlaps X-Monitor's host monitoring substantially, so
  most real gaps come from here.
- **[Valent](https://github.com/andyholmes/valent)** — 26 plugins. A GTK implementation of the KDE
  Connect protocol (phone↔desktop pairing). Almost entirely device-sync; included for completeness,
  with the handful of transferable ideas separated from the non-goals.

Items already on the [roadmap](docs/roadmap.md) are cross-referenced rather than repeated.
Nothing here is committed work — this is the candidate list. §4 is not from either project:
it is the one architectural change X-Monitor has deliberately deferred.

---

## 1. LNXlink — actionable gaps

### 1a. New monitor types

- [x] **Battery** — LNXlink `battery` tracks level and charging state for every connected
      battery. Done: [power.py](x_monitor/plugins/power.py) reads charge, external power and wear
      from `/sys/class/power_supply/*`.
- [x] **Pending package updates** — LNXlink `sys_updates` counts available packages and flags
      security updates. X-Monitor can approximate this with a `command` plugin, but a first-class type
      would normalize across `apt`/`dnf`/`pacman` and give a real metric to threshold on. The Nix
      half is covered: [nixos_upgrade.py](x_monitor/plugins/nixos_upgrade.py) compares the running
      system closure to what its flake evaluates to, and carries the update and switch actions.
      Done: [package_updates.py](x_monitor/plugins/package_updates.py) counts pending and security
      updates from the apt, dnf or pacman cache without refreshing it.
- [x] **Reboot required** — LNXlink `required_restart`. [docs/plugins.md](docs/plugins.md#command)
      already shows this as a `command` example; promoting it to a dedicated plugin removes the
      per-distro shell snippet from every user's config. NixOS hosts already get this from
      `nixos_upgrade`'s `reboot_required` metric.
      Done: [reboot_required.py](x_monitor/plugins/reboot_required.py) runs every check that fits the
      host (Debian flag, `needs-restarting`, missing module dir, NixOS boot parts).
- [x] **Network interface inventory** — LNXlink `interfaces` lists active NICs and their assigned
      IPs. The `network` plugin's `throughput` module auto-detects *one* interface but never reports the
      set of interfaces or their addressing. Useful for catching a dropped link or a changed DHCP lease.
      Done: [interfaces.py](x_monitor/plugins/interfaces.py) lists every interface with its state and
      addresses, and flags an `expect_up` link that drops or changes address.
- [x] **Logged-in users / active sessions** — LNXlink `current_user` reports the active graphical
      user. The server-side reframing is `who`/`loginctl`/`last`: who is logged in, from where, since
      when. That is a legitimate security-adjacent monitor and X-Monitor has nothing in the space.
      Done: [sessions.py](x_monitor/plugins/sessions.py) lists sessions from `loginctl` or `who`, with
      recent logins, and flags users or sources outside the allowed lists.
- [x] **Per-plugin collection latency** — LNXlink `inference_time` measures how long each module's
      data collection takes. X-Monitor has [x_monitor_self.py](x_monitor/plugins/x_monitor_self.py) but does not
      expose per-monitor cycle duration. Would make SSH contention and slow targets visible, and
      pairs naturally with the `MaxSessions` queuing behaviour documented at
      [docs/plugins.md](docs/plugins.md#ssh-config).
      Done: `x_monitor_self` shows each monitor's cycle time and SSH channel wait, slowest first, and
      warns on monitors that use too much of their interval.

### 1b. Extensions to existing plugins

- [x] **GPU: AMD and Intel** — LNXlink `gpu` covers NVIDIA, AMD, and Intel.
      [gpu.py](x_monitor/plugins/gpu.py) is `nvidia-smi`-only and reports offline on anything else.
      Add `amdgpu_top`/`sysfs` and `intel_gpu_top` paths.
      Done: `gpu` reads AMD and Intel cards from sysfs (Intel load via `intel_gpu_top` when
      present), auto-detected per card with the same metric names.
- [x] **Containers: update-available detection and prune** — LNXlink `docker` checks whether a newer
      image exists and can prune. [containers.py](x_monitor/plugins/containers.py) counts running/stopped
      and offers restart only. An `image_update_available` metric plus a Prune action would be a
      genuine addition.
      Done: [containers/](x_monitor/plugins/containers/) asks the registry for each image's current
      digest on a slow interval, and has a confirmed Prune button.
- [x] *(Already on roadmap)* Per-core CPU breakdown — LNXlink's `cpu` exposes load 1m/5m/15m as
      attributes; X-Monitor already splits these into `load_pct_*` metrics, so only the per-core split
      is outstanding.
      Done: `cpu` shows a bar per core from the same sample, with per-core history opt-in via
      `per_core_metrics`.

### 1b2. Plugin granularity

Every host signal is its own monitor — `cpu`, `memory`, `load`, `temperature`, `interrupts`,
`gpu`, `oom`, `throughput`, `connections`, `wifi`, `smart`, `zfs`, `btrfs`, `md`, `disk_io` — each with
its own thresholds, interval, status and history, grouped per host and per domain in config.
They share only [signal_plugin.py](x_monitor/plugins/base/signal_plugin.py): the severity ordering
and the page assembly.

- [ ] **Shared delta sampling** — `cpu`, `interrupts`, `disk_io` and `throughput` each take their
      own 1s sample, so a host running several pays one sleep apiece. Collapsing them would need
      a shared snapshot the four monitors slice, which cuts against one-monitor-one-signal;
      open whether it is worth it.
- [x] **Filesystem monitors** — whether [filesystems.py](x_monitor/plugins/filesystems.py),
      `disk_space` and `folders` should stay three plugins is open. `disk_space` and `folders`
      exist so a named path gets its *own* status and alert, which is the same argument the
      per-signal split rests on. If they stay, the duplication belongs in a shared `df`/`du`
      parser, not a merged plugin.
      Decided: they stay three plugins and share [disk_usage.py](x_monitor/plugins/base/disk_usage.py)
      for `df`/`du`.
- [x] **DNS monitors** — [dns_record.py](x_monitor/plugins/dns_record.py) checks a record resolves and
      [ddns_updater.py](x_monitor/plugins/ddns_updater.py) keeps one current, and the updater already
      resolves the record it is about to update. Open whether they should share that lookup or
      merge. `unbound` and `pihole` stay out either way: they are resolver products with their own stats.
      Decided: they stay separate and share one lookup in
      [dns_lookup.py](x_monitor/plugins/base/dns_lookup.py).

### 1c. Control actions

X-Monitor positions itself on target control ([README.md:5](README.md#L5)), but has no host-level power
or hardware controls. All four map cleanly onto the existing
`plan_action()`/`interpret_action()` contract in
[plugin_base.py:104-119](x_monitor/plugins/base/plugin_base.py#L104-L119).

- [x] **Host power actions** — reboot / shutdown / suspend (LNXlink `restart`, `shutdown`,
      `suspend`). Needs a confirmation gate and an allowlist; design principle #5 ("Fail-Safe
      Control") already asks for confirmable, logged actions.
      Done: [host_control.py](x_monitor/plugins/host_control.py) offers reboot, shutdown and suspend,
      each off until listed under `allow:`, confirmed and logged.
- [x] **Wake-on-LAN** — LNXlink `wol` only toggles WoL support on the NIC. The more valuable X-Monitor
      feature is the inverse: *sending* a magic packet to wake a host that an `uptime` monitor
      reports down. X-Monitor is the only one of the three projects positioned to do this, since it sits
      on the network watching the offline host.
      Done: an `uptime` monitor with `mac:` has a Wake action, can send it through another host
      (`wake_via`), and can wake the host when it goes down (`wake_on_down`).
- [x] **Power profile** — LNXlink `power_profile` toggles performance/balanced/power-saver via
      `power-profiles-daemon`.
      Done: in `host_control`, through `powerprofilesctl`, `tuned-adm` or the platform profile.
- [x] **Next-boot selection** — LNXlink `boot_select` picks the OS for the next boot. Niche; pairs
      with the reboot action for dual-boot or kernel-testing hosts.
      Done: in `host_control`, through `bootctl`, `grub-reboot` or `efibootmgr`, optionally
      rebooting at once.

### 1d. Engine and platform capabilities

- [x] **Config hot-reload** — LNXlink `watch_changes` watches its config file and restarts on
      change. X-Monitor reads `config.yaml` once at startup
      ([engine.py:111-144](x_monitor/core/coordination/engine.py#L111-L144)); adding or retuning a
      monitor requires a full restart, dropping every persistent SSH connection. Reloading the
      plugin tree in place is the highest-leverage item in this section.
      Done: config.yaml reloads in place on file change, SIGHUP, the API or the dashboard; unchanged
      monitors keep running and bad config is refused whole.
- [x] **Out-of-tree plugin loading** — LNXlink auto-imports modules from a directory, including
      user-supplied ones. X-Monitor resolves a plugin type by importing `x_monitor.plugins.{type}`
      ([engine.py:120](x_monitor/core/coordination/engine.py#L120)), so a third-party plugin must be
      dropped inside the installed package. A configurable plugin path would let people extend X-Monitor
      without vendoring it.
      Done: `plugin_paths:` names directories searched for plugin types that are not built in.
- [x] **Runtime log-level control** — LNXlink `logging_level` changes verbosity without a restart.
      Small, and genuinely useful while debugging a flaky target.
      Done: levels change from the API, the dashboard or SIGUSR1/SIGUSR2, globally or per logger.
- [x] *(Already on roadmap)* MQTT export — LNXlink's entire integration story is MQTT autodiscovery.
      The roadmap's "Additional export backends" item ([docs/roadmap.md](docs/roadmap.md)) is the
      right shape: an HA-discovery MQTT exporter next to the Prometheus and InfluxDB ones would make
      every X-Monitor monitor a Home Assistant entity without an agent.
      Done: [mqtt.py](x_monitor/core/exporters/mqtt.py) publishes every monitor with Home Assistant
      discovery.

### 1e. Raspberry Pi / hardware — decide in or out

LNXlink supports these because it already runs on the box. X-Monitor would need a remote equivalent, and
all three are arguably outside "network and systems monitor".

- [ ] `gpio` — read/write Pi GPIO pins.
- [ ] `ir_remote` — IR send/receive.
- [ ] `fingerprint` — R503 scanner over UART.

### 1f. LNXlink modules that are explicit non-goals

Desktop/session features with no server-monitoring meaning. Recorded so they are not re-raised:
`active_window`, `audio_select`, `beacondb`, `bluetooth`, `brightness`, `camera_used`, `clipboard`,
`display_env`, `fullscreen`, `gamepad`, `idle`, `keep_alive`, `keyboard_hotkeys`, `media`, `mouse`,
`microphone_used`, `notify`, `screen_onoff`, `screenshot`, `send_keys`, `speaker_used`,
`speech_recognition`, `steam`, `webcam`, `xdg_open`.

Also excluded as agent-lifecycle concerns that do not apply to an agentless design: `update`
(self-update), `update_entities`, `statistics` (opt-in telemetry), `lwt` (MQTT last-will —
X-Monitor's DB *is* the availability record), `restful` (X-Monitor already has a REST API),
`bash` (covered by [command.py](x_monitor/plugins/command.py)), `systemd` (covered by
[systemd_service.py](x_monitor/plugins/systemd_service.py) and
[service_list.py](x_monitor/plugins/service_list.py)).

---

## 2. Valent — mostly non-goals, with three transferable ideas

Valent is a KDE Connect client. Nine of its 26 plugin directories are platform backends, not
features at all (`bluez`, `eds`, `fdo`, `gnome`, `gtk`, `lan`, `pipewire`, `pulseaudio`, `xdp`).
Of the remaining 17, almost everything is phone↔desktop sync.

### Worth stealing

- [x] **Per-device pairing and certificate auth** — Valent pairs each device with its own
      certificate identity rather than a shared password. X-Monitor currently offers a single HTTP Basic
      Auth credential for the whole dashboard and API
      ([README.md](README.md#authentication)), with HTTPS still open on the roadmap. A
      per-client token/identity model is the natural next step and would also give the REST API and
      the `push` endpoint a common auth story instead of `push`'s bespoke per-monitor token.
      Done: named API tokens in `auth.tokens`, scoped to read, control or push, minted with
      `x-monitor token new`.
- [x] **Battery monitoring** — Valent `battery` reports level and charging state, independently
      confirming §1a's battery item. Two of two surveyed projects have it; X-Monitor has none.
      Done: see §1a, as `power`.
- [x] **Identify-this-host action** — Valent `findmyphone` makes a device ring. The datacenter
      analogue is a locate action: `ledctl` to blink a drive/chassis LED, or a console beep, to
      physically identify a machine you are SSH'd into. Marginal, but it fits the control model.
      Done: `identify` in `host_control` blinks a drive LED with `ledctl` or beeps.

### Adjacent to existing roadmap items

- `notification` (sync notifications) and `connectivity_report` (link/carrier status) are weak
  analogues of the roadmap's alerting item and of X-Monitor's existing
  [network.py](x_monitor/plugins/network.py) / [uptime.py](x_monitor/plugins/uptime.py). No new work implied.
- `ping` is covered by [uptime.py](x_monitor/plugins/uptime.py); `runcommand` by
  [command.py](x_monitor/plugins/command.py) plus the action framework.

### Non-goals

Device-sync features with no server-monitoring analogue: `clipboard`, `contacts`, `findmyphone`
(except as above), `lock`, `mousepad`, `mpris`, `presenter`, `sftp`, `share`, `sms`,
`systemvolume`, `telephony`.

---

## 3. Summary

| Source | Total plugins | Already covered by X-Monitor | Actionable gaps | Non-goals |
|---|---|---|---|---|
| LNXlink | 60 | 14 | 17 (+3 undecided RPi) | 26 |
| Valent  | 26 (17 features, 9 backends) | 2 | 3 | 12 |

Highest leverage, in order:

1. ~~Config hot-reload (§1d)~~ — done.
2. ~~Battery monitor (§1a)~~ — done, as `power`.
3. ~~Host power actions + Wake-on-LAN (§1c)~~ — done, as `host_control` and the `uptime` Wake action.
4. ~~MQTT/HA export (§1d)~~ — done.

Still open: shared delta sampling (§1b2) and the Raspberry Pi hardware (§1e), both undecided.

---

## 4. Architecture — one deferred item

Not a gap against either project; a structural option X-Monitor has deliberately not taken. The
current design is documented in [docs/develop.md](docs/develop.md) under **Single process, one event loop**.

### Split the collector and the web UI into two processes

Collection and the dashboard share one process and one asyncio event loop, so CPU-bound UI
rendering, poll dispatch, exporters and job streaming all contend for it. A burst of client
re-renders can delay a poll, and there is no isolation between the two.

Two things that once made this pressing have already been removed: SSH is native async and no
longer occupies threads, and the UI reads the in-memory state store rather than querying SQLite.
What remains is loop contention, which only bites at a scale X-Monitor has not reached — one host and
33 monitors spend their time waiting on IO, not competing for the loop.

Worth doing when one of these becomes true:

- Rendering latency is visibly delaying collection, or the reverse, under real load.
- You want more than one collector process, which also means more than one SQLite writer (see
  **SQLite** in docs/develop.md — a single writer thread is currently an invariant).
- You want the UI to survive a collector restart, or to restart either half independently.

The shape it would take: a collector process owning the scheduler, the connectors and all writes,
a web process serving a read-only UI and the REST API, and the database plus a lightweight notify
channel between them. The database is already the source of truth, so the seam exists; the work is
that the state store is in-process memory today and would have to be fed to the web side over that
channel instead of shared directly.

# TODO — NixOS management moves to X-Nix

Decided 2026-10-31: the NixOS management functions move to X-Nix, a web app, as borg moved to
X-Backups. X-Monitor keeps only the job of watching X-Nix itself.
- [ ] Once X-Nix has ported them (its todo.md, task 1), remove `nixos_upgrade`, `nix_gc`, `attic_push`,
      the NixOS half of `reboot_required` and `host_control`, `base/nixos_boot.py`, the Fleet view's
      "NixOS deployments" tiles and the NixOS parts of `nix/agent-module.nix`, with their tests and docs.
- [ ] Add an X-Nix health check, as there is for X-Backups.
