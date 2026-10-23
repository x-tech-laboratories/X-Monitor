# X-Monitor Plugin Reference

Every monitor type X-Monitor ships, with its config keys, metrics, actions, and
config examples. For what X-Monitor is and how to run it, see the
[README](../README.md); for agent setup, see [Agent](agent.md).

## Contents

- [Summary](#summary) — the one-line table of every plugin type
- [Warning and failure limits](#warning-and-failure-limits) — turn either level of a limit pair off with `null`
- [Scheduled actions](#scheduled-actions) — run any monitor's action on a cron schedule
- [Custom actions](#custom-actions) — add your own command buttons to any monitor
- Plugin types:
  [`uptime`](#uptime) ·
  [`push`](#push) ·
  [`http`](#http) ·
  [`dns_record`](#dns_record) ·
  [`ddns_updater`](#ddns_updater) ·
  [`systemd_service`](#systemd_service) ·
  [`service_list`](#service_list) ·
  [`nixos_upgrade`](#nixos_upgrade) ·
  [`nix_gc`](#nix_gc) ·
  [`attic_push`](#attic_push) ·
  [`vuln_scan`](#vuln_scan) ·
  [`smart`](#smart) ·
  [`zfs`](#zfs) ·
  [`btrfs`](#btrfs) ·
  [`md`](#md) ·
  [`disk_io`](#disk_io) ·
  [`disk_space`](#disk_space) ·
  [`cpu`](#cpu) ·
  [`memory`](#memory) ·
  [`load`](#load) ·
  [`temperature`](#temperature) ·
  [`interrupts`](#interrupts) ·
  [`gpu`](#gpu) ·
  [`oom`](#oom) ·
  [`processes`](#processes) ·
  [`throughput`](#throughput) ·
  [`connections`](#connections) ·
  [`wifi`](#wifi) ·
  [`power`](#power) ·
  [`reboot_required`](#reboot_required) ·
  [`package_updates`](#package_updates) ·
  [`interfaces`](#interfaces) ·
  [`sessions`](#sessions) ·
  [`borg`](#borg) ·
  [`containers`](#containers) ·
  [`command`](#command) ·
  [`filesystems`](#filesystems) ·
  [`folders`](#folders) ·
  [`vms`](#vms) ·
  [`host_control`](#host_control) ·
  [`cloud`](#cloud) ·
  [`x_monitor_self`](#x_monitor_self) ·
  [`group`](#group)
- [Plugin Layout](#plugin-layout) — arranging a plugin's widgets on its page
- [SSH Config](#ssh-config) — the `ssh_config` block SSH-based plugins accept
- [Out-of-tree plugins](#out-of-tree-plugins) — adding your own plugin types without changing X-Monitor

---

## Plugin Types

### Summary

| Type | Monitors | Collection | Key metrics | Actions |
|------|----------|------------|-------------|---------|
| [`uptime`](#uptime)                     | Host reachability                     | ICMP ping                                        | `up`, `latency_ms`                              | Wake (Wake-on-LAN, with `mac`) |
| [`push`](#push)                         | External heartbeat (dead man's switch) | REST API (caller pushes in)                     | `last_push_epoch`, `reported_up`, `value`       | — |
| [`http`](#http)                         | HTTP(S)/WebSocket endpoint health     | HTTP from the X-Monitor host, or `websocat` over SSH | `probe_ok`, `probe_status`, `probe_latency_ms`  | — |
| [`dns_record`](#dns_record)             | DNS record resolution                 | DNS query (via dnspython, in-process)            | `resolved`, `ttl`, `matches_expected`            | — |
| [`ddns_updater`](#ddns_updater)         | Dynamic DNS record kept current       | Public IP lookup + DNS query (in-process)        | `in_sync`, `last_update_epoch`                   | Force Update |
| [`systemd_service`](#systemd_service)   | systemd unit state / last run         | SSH (`systemctl`)                                | `active` *or* `last_run_epoch`, `last_run_success` | Restart, Stop, Enable, Disable |
| [`service_list`](#service_list)         | Systemd unit browser and control      | SSH (`systemctl`)                                | `services_total`, `services_active`, `services_failed` | Start, Stop, Restart, Enable, Disable, View Status |
| [`nixos_upgrade`](#nixos_upgrade)       | NixOS system vs. the flake it deploys from | SSH (`nix eval`, `nix flake metadata`)      | `up_to_date`, `reboot_required`, `flake_reachable` | Update Flake, Rebuild & Switch, Reboot |
| [`nix_gc`](#nix_gc)                     | Nix store garbage collection           | SSH (`df`, `systemctl`, `journalctl`)             | `last_gc_epoch`, `last_gc_freed_gb`, `store_used_pct` | Collect Garbage |
| [`attic_push`](#attic_push)             | Fleet closures built and pushed to Attic | SSH (`nix eval`, `nix path-info`)                 | `targets_built`, `targets_pushed`, `missing_paths` | — |
| [`vuln_scan`](#vuln_scan)               | Network-facing vulnerabilities of a host | SSH (`nmap --script vuln`, run from the scanning host) | `vulnerable`, `suspected`, `open_ports`      | — |
| [`smart`](#smart)                       | SMART health of every physical disk    | SSH (`smartctl`)                                | `disks_total`, `disks_ok`, `disks_failed`       | — |
| [`zfs`](#zfs)                           | ZFS pool state and capacity            | SSH (`zpool list`)                              | `pools_total`, `pools_degraded`, `zfs_usage_max` | — |
| [`btrfs`](#btrfs)                       | Btrfs filesystem health and capacity   | SSH (`btrfs filesystem usage`, `btrfs device stats`) | `filesystems_total`, `filesystems_degraded`, `btrfs_usage_max` | — |
| [`md`](#md)                             | mdadm array health                     | SSH (`/proc/mdstat`)                            | `arrays_total`, `arrays_ok`, `arrays_degraded`  | — |
| [`disk_io`](#disk_io)                   | Disk read/write throughput             | SSH (`/proc/diskstats`)                         | `read_kbps`, `write_kbps`                       | — |
| [`disk_space`](#disk_space)             | Filesystem usage for a path           | SSH (`df`)                                       | `used_pct`, `size_gb`, `used_gb`, `avail_gb`    | — |
| [`cpu`](#cpu)                           | CPU utilization, overall and per core  | SSH (`/proc/stat`)                              | `cpu_pct`, `cpu_core_max_pct`                   | — |
| [`memory`](#memory)                     | Memory and swap use                    | SSH (`/proc/meminfo`)                           | `memory_pct`, `memory_used_gb`                  | — |
| [`load`](#load)                         | Load average, scaled by core count     | SSH (`/proc/loadavg`)                           | `load_pct_1m`, `load_pct_5m`, `load_pct_15m`    | — |
| [`temperature`](#temperature)           | Thermal zone temperatures              | SSH (`/sys/class/thermal`)                      | `temp_c`, `temp_zone_<zone>`                    | — |
| [`interrupts`](#interrupts)             | Interrupt and context-switch rates     | SSH (`/proc/stat`)                              | `irq_per_sec`, `ctxt_per_sec`                   | — |
| [`gpu`](#gpu)                           | NVIDIA, AMD and Intel GPU utilization, memory, temperature | SSH (`nvidia-smi`, `/sys/class/drm`) | `gpu_util`, `gpu_mem_pct`, `gpu_temp`           | — |
| [`oom`](#oom)                           | Kernel OOM kills                       | SSH (`/proc/vmstat`) + agent journal push       | `oom_kills_total`, `oom_kills_new`              | — |
| [`processes`](#processes)               | Running processes by CPU              | SSH (`ps`)                                       | `process_count`, `top_cpu_pct` *(ephemeral)*    | SIGTERM, SIGKILL |
| [`throughput`](#throughput)             | Network interface throughput           | SSH (`/proc/net/dev`)                           | `rx_kbps`, `tx_kbps`                            | — |
| [`connections`](#connections)           | TCP connection counts by state         | SSH (`/proc/net/tcp`)                           | `conn_total`, `conn_established`, `conn_listen` | — |
| [`wifi`](#wifi)                         | WiFi link quality and signal strength  | SSH (`/proc/net/wireless`)                      | `link_quality`, `signal_dbm`                    | — |
| [`power`](#power)                       | Battery charge, external power, wear   | SSH (`/sys/class/power_supply`)                 | `charge_pct`, `plugged_in`, `capacity_health_pct`, `battery_<name>_charge_pct` | — |
| [`reboot_required`](#reboot_required)   | Whether the host needs a reboot        | SSH (`/var/run/reboot-required`, `needs-restarting`, `/run/booted-system`, `/usr/lib/modules`) | `reboot_required` | — |
| [`package_updates`](#package_updates)   | Pending package and security updates   | SSH (`apt list`, `dnf --cacheonly check-update`, `checkupdates`/`pacman -Qu`) | `updates_pending`, `security_updates_pending` | — |
| [`interfaces`](#interfaces)             | Network interface inventory and addressing | SSH (`ip -j addr`, `/sys/class/net`)        | `interfaces_up`, `interfaces_total`, `interface_<name>_up` | — |
| [`sessions`](#sessions)                 | Logged-in users and recent logins      | SSH (`loginctl` or `who`, `last`)               | `sessions_total`, `sessions_remote`, `sessions_unexpected` | — |
| [`ports`](#ports)                       | TCP port / URL reachability           | SSH (`/dev/tcp`, `curl`)                         | `<check>_up`, `<check>_latency_ms`              | — |
| [`borg`](#borg)                         | Borg backups: freshness, browse, restore | SSH (`borg list`)                                | `archive_count`, `last_backup_epoch`            | — |
| [`containers`](#containers)             | Docker / Podman containers, image updates | SSH (`docker`/`podman ps`, `inspect`) + registry API | `containers_total`, `containers_running`, `containers_stopped`, `images_update_available` | Restart (per expected container), Prune |
| [`command`](#command)                   | Arbitrary command (generic check)     | SSH (any command)                                | `exit_code` (+ `value` in pattern mode)         | — |
| [`filesystems`](#filesystems)           | All mounted filesystems (auto-discovered) | SSH (`df`)                                    | `worst_used_pct`, `fs_<mount>_used_pct`         | — |
| [`folders`](#folders)                   | Sizes of arbitrary directories        | SSH (`du`)                                        | `worst_folder_gb`, `folder_<path>_gb`           | — |
| [`vms`](#vms)                           | libvirt/KVM virtual machines          | SSH (`virsh`)                                     | `vms_total`, `vms_running`, `vms_stopped`       | Running toggle (per expected VM) |
| [`host_control`](#host_control)         | Host power, boot and identify controls | SSH (`powerprofilesctl`, `bootctl`/GRUB/`efibootmgr`, `/sys/power`) | `power_profiles`, `boot_entries`, `suspend_supported` | Reboot, Shut Down, Suspend, Power Profile, Next Boot, Identify (each opt-in) |
| [`cloud`](#cloud)                       | Cloud instance metadata (AWS/GCP/Azure) | SSH (metadata endpoint)                         | `on_cloud`                                      | — |
| [`x_monitor_self`](#x_monitor_self)             | X-Monitor itself: memory, CPU, late and slow monitors | Local (`/proc/self`, engine state)     | `memory_mb`, `monitors_late`, `monitors_slow`, `slowest_cycle_seconds` | — |
| [`group`](#group)                       | Container for nested monitors         | — (aggregates children)                          | —                                               | — |

All plugin types share these common fields:

| Field    | Description                                                          |
|----------|----------------------------------------------------------------------|
| `name`   | Display name shown in the sidebar and dashboard                      |
| `id`     | Unique identifier used internally (defaults to `name` if omitted)    |
| `type`   | Plugin type — one of `uptime`, `push`, `http`, `dns_record`, `ddns_updater`, `systemd_service`, `service_list`, `nixos_upgrade`, `nix_gc`, `attic_push`, `vuln_scan`, `cpu`, `memory`, `load`, `temperature`, `interrupts`, `gpu`, `oom`, `throughput`, `connections`, `wifi`, `power`, `reboot_required`, `package_updates`, `interfaces`, `sessions`, `smart`, `zfs`, `btrfs`, `md`, `disk_io`, `disk_space`, `ports`, `processes`, `borg`, `containers`, `command`, `filesystems`, `folders`, `vms`, `host_control`, `cloud`, `x_monitor_self`, `group` |
| `interval` | Polling frequency in seconds (default: 60)                         |
| `schedule` | Actions to run on a cron schedule — see [Scheduled actions](#scheduled-actions) (default: none) |
| `actions` | Your own command buttons on the monitor's page — see [Custom actions](#custom-actions) (default: none) |

### Warning and failure limits

Every pair of limits — `warning` / `threshold`, `cpu_warning` / `cpu_threshold`, `stale_warning` / `stale_threshold` and the rest — is two independent levels. Set either one to `null` to turn that level off while keeping the other: a monitor with `threshold: null` warns but never fails, and one with `warning: null` fails without warning first. Leaving a key out keeps its default.

```yaml
- name: Load
  type: load
  warning: 200
  threshold: null    # warn on a busy box, never fail on it
```

### Scheduled actions

Any action a monitor offers can run on its own at set times, the way cron runs a job. Each `schedule` entry names the action and a cron expression; `args` passes the same parameters a dialog would.

```yaml
- name: Borg Home
  type: borg
  schedule:
    - action: run_backup      # the action_id behind the Run Backup button
      cron: "0 3 * * *"       # 03:00 every day
    - action: verify_restore
      cron: "30 4 * * sun"    # 04:30 on Sundays
- name: Frigate
  type: frigate
  schedule:
    - action: sync_recordings
      cron: "@weekly"
```

The expression has the usual five fields (minute, hour, day of month, month, day of week) in the X-Monitor host's local time, with `*`, ranges, lists, `/` steps, month and day names, and the aliases `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. As in cron, an expression restricting both the day of month and the day of week runs on either.

A scheduled run goes through the same path as the button: it launches the same job, and the monitor's own guards apply, so a backup that is already running refuses a second one. Each run logs its outcome on the monitor, and the monitor's page lists its schedules with their next run. The Schedules page in the sidebar lists every schedule in the fleet, soonest first, with its monitor, action, cron expression, next run, and when its last run started and whether it did. Each time runs once: it is recorded before the action starts, so a restart never repeats it, and runs missed while X-Monitor was down collapse into one when it returns. A failed run is not retried until its next time. A new schedule, or one whose expression or `args` changed, first runs at its next time, never at once.

### Triggered actions

An action can also run because of what a monitor sees rather than the time. Each `triggers` entry names the action and one condition: a `status` (one name or a list), or a `metric` with exactly one of `above`, `below` or `equals`. `for` is how long the condition must hold first (default: at once), and `args` passes the same parameters a dialog would.

```yaml
- name: Root Disk
  type: disk_space
  actions:
    - name: Clear Cache
      command: rm -rf /var/cache/app/*
  triggers:
    - action: custom:clear_cache  # a custom action, or the action_id behind any button
      metric: used_pct
      above: 90
      for: 10m
- name: Media Server
  type: systemd_service
  triggers:
    - action: restart_service
      status: failed
```

Every cycle the monitor records, polled or pushed by its agent, is checked against its triggers. An entry runs once each time its condition becomes true and has held for `for`, and it is armed again only once a cycle shows the condition cleared, so a monitor that stays failed runs the action once, not every cycle. A cycle that does not report what the entry watches, such as one without that metric, neither starts nor clears it. The run is recorded before the action starts, so a restart never repeats it, and the time the condition started holding survives a restart too. A triggered run goes through the same path as the button, logs its outcome on the monitor, and appears on the monitor's page and on the Schedules page next to the scheduled ones. Changing an entry's condition, `for` or `args` starts it afresh.

A metric's name is the one shown in the monitor's metrics and exports. The NixOS monitor's own `auto_switch` is the better way to switch on drift, since it also refuses to roll back a generation newer than the flake.

### Custom actions

Every monitor, whatever its type, accepts an `actions` list of your own commands. Each one becomes a button in the monitor's page header, next to the plugin's own actions.

```yaml
- name: Nginx
  type: systemd_service
  service_name: nginx
  actions:
    - name: Clear Cache
      command: rm -rf /var/cache/nginx/*
    - name: Reboot Host
      command: systemctl reboot
      icon: power_settings_new
      danger: true
      confirm: Reboot this host?
  schedule:
    - action: custom:clear_cache    # a custom action's id is `custom:` plus its id
      cron: "@weekly"
```

| Option    | Description |
|-----------|-------------|
| `name`    | Button label (required) |
| `command` | Shell command to run (required) |
| `id`      | Id used by `schedule`, made from `name` when omitted: lower case with other characters as `_` |
| `icon`    | Material icon name (default: `terminal`) |
| `confirm` | Question asked before it runs; the command runs only on a yes |
| `danger`  | Shows the button in the danger colour (default: `false`) |
| `more`    | Puts the action in the header's More menu instead of on a button of its own (default: `false`) |
| `timeout` | How long the command may run, as seconds or a duration such as `2m` |
| `agent`   | Run on this agent instead of the monitor's own host |

The command runs where the monitor's own commands run: over its agent, or over SSH to its host. It succeeds on exit code 0, and each run is logged on the monitor with the start of its output, or of its error when it fails. Custom ids start with `custom:`, so they never clash with the plugin's own actions, and [`schedule`](#scheduled-actions) and [`triggers`](#triggered-actions) can run them like any other action.

---

### `uptime`
Checks host availability using ICMP ping. With `mac:` set it can also wake the host with a Wake-on-LAN magic packet.

| Option              | Description                                        |
|---------------------|----------------------------------------------------|
| `target_host`       | IP address or hostname to ping                     |
| `interval`          | Polling frequency in seconds (default: `60`)       |
| `mac`               | *(Optional)* The host's MAC address; adds a **Wake** button (asks for confirmation) |
| `wol_broadcast`     | Address the packet is sent to (default: `255.255.255.255`); a subnet's broadcast address such as `192.168.1.255` reaches it from a host with several networks |
| `wol_port`          | UDP port (default: `9`)                            |
| `wol_password`      | *(Optional)* SecureOn password, as six hex bytes (`01:02:03:04:05:06`) or a dotted quad |
| `wake_via`          | *(Optional)* The `id` of another monitor whose host sends the packet instead of the X-Monitor server — for a host on a subnet only that one reaches. It uses that monitor's SSH connection or agent |
| `wake_command`      | *(Optional, with `wake_via`)* The command that sends it there, overriding the default. `{mac}`, `{hex}` (the whole packet), `{broadcast}`, `{port}` and `{password}` are filled in, shell-quoted; write other braces doubled |
| `wake_on_down`      | Send a wake automatically when the host goes **failed** (default: `false`) |
| `wake_retry`        | Time between automatic wakes while it stays down (default: `10m`) |
| `wake_max_attempts` | Automatic wakes before giving up until the host is seen up again (default: `3`) |

**Metrics**: `up` (1/0), `latency_ms`

```yaml
- name: "Core Gateway"
  id: "gateway-ping"
  type: "uptime"
  target_host: "192.168.1.1"
  interval: 30
```

Without `wake_via`, the packet is one UDP broadcast from the X-Monitor server, so it reaches hosts on the server's own network. With it, X-Monitor builds the packet and the other host sends it with `python3` or, failing that, `socat`; a host with neither needs a `wake_command`, such as `wakeonlan -i {broadcast} -p {port} {mac}` or `etherwake -i eth0 {mac}` (which sends raw Ethernet frames and so usually needs root). Every wake, manual or automatic, is logged to the monitor's events with where it was sent and whether that worked; the last automatic one says it is giving up.

```yaml
- name: "NAS"
  id: "nas-ping"
  type: "uptime"
  target_host: "192.168.20.5"
  mac: "00:11:22:33:44:55"
  wake_via: "host1-cpu"            # any monitor on a host in that subnet
  wol_broadcast: "192.168.20.255"
  wake_on_down: true               # wake it whenever it drops, every 10m, 3 times at most
```

---

### `push`
The inverse of every other monitor: instead of X-Monitor reaching out to a target, an external script, cron job, or task with no fixed host calls X-Monitor's REST API to say "I'm alive." X-Monitor reports `failed` once a heartbeat hasn't arrived within `max_age` — a dead man's switch, not a poll.

`interval` controls how often X-Monitor *checks* for staleness, not how often heartbeats are expected — that's `max_age`'s job. A missing `max_age` defaults to twice the interval, tolerating one missed beat before alarming.

| Option      | Description                                                                 |
|-------------|------------------------------------------------------------------------------|
| `max_age`   | Seconds since the last heartbeat before reporting `failed` (default: `interval * 2`) |
| `token`     | Shared secret the caller must present when pushing through `/api/push/{id}/{token}`. Generate with `openssl rand -hex 20`. Optional when a push-scoped [API token](../README.md#api-tokens) covers the monitor; with neither, nothing can push to it. |
| `interval`  | How often the staleness check itself runs (default: `60`)                    |

**Metrics**: `last_push_epoch` (Unix timestamp of the last heartbeat), `reported_up` (1/0, the caller's own status), `value` (optional, if the caller supplies one)

To push a heartbeat, hit `GET` or `POST /api/push/{id}/{token}`, optionally with `status` (`up` or `down`, default `up`), `msg`, and `value` query parameters. This endpoint is not covered by the dashboard's sign-in (see [Authentication](../README.md#authentication)) — the per-monitor token is its credential instead.

Alternatively, push to `/api/push/{id}` with a push-scoped [API token](../README.md#api-tokens) in an `Authorization: Bearer` header. One such token can cover several monitors (or all of them), it stays out of URLs and so out of proxy access logs, and each heartbeat's event names the token that sent it. Both routes work side by side.

```yaml
- name: "Nightly Backup Job"
  id: "nightly-backup"
  type: "push"
  interval: 1h
  max_age: 26h   # daily job, tolerate one slipped run
  token: "a1b2c3d4e5f6..."   # openssl rand -hex 20
```

```bash
# At the end of the cron job:
curl "https://x-monitor.example.com/api/push/nightly-backup/a1b2c3d4e5f6...?status=up"

# Or report a failure the job detected itself, while still checking in on time:
curl "https://x-monitor.example.com/api/push/nightly-backup/a1b2c3d4e5f6...?status=down&msg=disk+full"

# Or with a push-scoped API token (x-monitor token new backup-jobs --scope push):
curl -X POST -H "Authorization: Bearer $XMONITOR_PUSH_TOKEN" \
  "https://x-monitor.example.com/api/push/nightly-backup?status=up"
```

---

### `http`
Generic endpoint probe: is this URL reachable and answering sanely, and how fast. Covers the thin "GET this URL with this auth, check the body looks right" service checks that don't warrant a dedicated plugin. Two probe kinds, selected by the URL scheme:

- **`http://` / `https://`** — the request runs from the X-Monitor host (the URL must be reachable from it), with configurable method, headers, body and basic auth. Latency is recorded and charted.
- **`ws://` / `wss://`** — the probe pipes `body` into `websocat` on the *target* over SSH (websocat must be installed there); on agent-backed hosts the agent samples it locally. Success is a reply matching `expect`.

A reply matching every expectation is online; anything else — a connection failure, an unexpected status, or a body that fails the `expect` checks (e.g. a login page served with a 200) — is failed. There is no warning tier.

| Option              | Description                                                              |
|---------------------|--------------------------------------------------------------------------|
| `url`               | Endpoint to probe *(required)*                                          |
| `method`            | HTTP method (default: `GET`)                                            |
| `headers`           | *(Optional)* Extra request headers                                      |
| `body`              | *(Optional)* Request body, or the text sent into the websocket          |
| `username`          | *(Optional)* Basic-auth username (http only)                            |
| `password` / `password_command` | Basic-auth secret, literal or resolved once at startup      |
| `request_timeout`   | Probe timeout in seconds (default: `10`)                                |
| `check_title`       | Card and chart title in the UI (default: `PROBE`)                       |
| `expect.status`     | Accepted HTTP status, int or list (default: `200`)                      |
| `expect.body_contains` | String or list — all must appear in the body, case-insensitive       |
| `expect.body_contains_any` | String or list — at least one must appear, case-insensitive      |

**Metrics**: `probe_ok` (always); `probe_status`, `probe_latency_ms` (http only)

```yaml
# An OPDS feed behind basic auth: a 200 that is actually a login page fails
- name: "Calibre-Web"
  type: "http"
  url: "http://books.example.com:8083/opds"
  username: "x-monitor"
  password_command: "cat /run/secrets/calibre-x-monitor"
  check_title: "OPDS FEED"
  expect:
    body_contains: "<feed"
    body_contains_any: ["atom", "opds"]

# A CalDAV server: PROPFIND with the 207 Multi-Status reply as success
- name: "Radicale"
  type: "http"
  url: "https://dav.example.com/"
  method: "PROPFIND"
  headers: { "Depth": "0", "Content-Type": "application/xml" }
  body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>'
  username: "x-monitor"
  password_command: "cat /run/secrets/radicale-x-monitor"
  check_title: "PROPFIND"
  expect:
    status: 207

# A websocket service, probed on the target itself (needs websocat there)
- name: "OpenBooks"
  type: "http"
  url: "ws://127.0.0.1:9777/ws"
  body: '{"type":1,"payload":{}}'
  check_title: "IRC BRIDGE"
  expect:
    body_contains: '"appearance":1'
  ssh_config:
    host: "server.example.com"
```

---

### `dns_record`
Resolves a DNS record and reports failed on NXDOMAIN, no answer, a timeout, or (when `expected` is set) an answer outside the accepted values — catching a stale record, a botched migration, or a DNS provider outage.

Runs in-process via [dnspython](https://www.dnspython.org/) rather than over SSH: there is no target host, only a domain to ask about. Query the system resolver by default, or point `resolver` at a specific one (public or internal) — doing so doubles as a liveness probe for that resolver, distinct from [`unbound`](#unbound)'s SERVFAIL-rate monitoring of one resolver's own stats.

| Option        | Description                                                                 |
|---------------|-------------------------------------------------------------------------------|
| `domain`      | Domain name to query *(required)*                                            |
| `record_type` | One of `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SOA` (default: `A`)          |
| `resolver`    | Resolver IP to query directly (default: system resolver)                     |
| `port`        | Resolver port (default: `53`)                                                |
| `timeout`     | Query timeout in seconds (default: `5`)                                      |
| `expected`    | *(Optional)* List of acceptable answer values. Any answer outside this list fails the monitor. Order-independent — only presence in the answer set is checked. |

**Metrics**: `resolved` (1/0), `ttl` (seconds), `matches_expected` (1/0, only when `expected` is set)

```yaml
# Pin an A record to known IPs — fails if it ever points elsewhere
- name: "Website A Record"
  id: "website-a-record"
  type: "dns_record"
  domain: "example.com"
  record_type: "A"
  expected:
    - "93.184.216.34"
  interval: 5m

# Confirm MX still points at the expected mail provider
- name: "Mail Routing"
  id: "example-mx"
  type: "dns_record"
  domain: "example.com"
  record_type: "MX"
  expected:
    - "10 mail.example.com"
  interval: 1h

# Query a specific resolver directly, e.g. to check an internal DNS server
- name: "Internal DNS"
  id: "internal-dns-check"
  type: "dns_record"
  domain: "heimdall.technet"
  resolver: "10.0.0.1"
  interval: 1m
```

---

### `ddns_updater`
Keeps a DNS record pointed at this network's current public IP, and reports on it while doing so — a built-in replacement for standalone dynamic-DNS-updater services. Each cycle: look up the current public IP, resolve what the domain currently answers publicly, and push an update to the provider only when the two differ. Because a provider update is a real side effect (and most providers rate-limit or ban accounts that call too often), it is never fired on a fixed schedule — only on detected drift, and even then no more often than `min_interval`.

Currently speaks FreeDNS's (afraid.org, including `*.mooo.com` and its other free subdomains) per-host dynamic update URL convention: a plain HTTPS GET to a secret, account-specific URL that updates the record to the caller's apparent IP, responding `good <ip>` or `nochg <ip>` on success. Other providers using the same "secret update URL" convention work too; anything returning JSON or requiring a signed request does not, yet.

Resolves the public record against an explicit `resolver` (default `8.8.8.8`) rather than the local/default resolver — a local network commonly has a hosts-file override pinning this exact hostname to a LAN IP (so internal clients don't route out to the internet and back for it), which would mask real DDNS drift by always answering with that LAN IP instead.

| Option        | Description                                                                 |
|---------------|-------------------------------------------------------------------------------|
| `domain`      | Domain whose public record is kept current *(required, unless supplied by one of the two below)* |
| `domain_file` | Path to a file containing the domain (keeps the name out of config.yaml)      |
| `domain_command` | Shell command whose stdout is the domain                                   |
| `update_url`  | Provider's per-host dynamic update URL, including its own secret token       |
| `update_url_file` | Path to a file containing the update URL (keeps the token out of config.yaml) |
| `update_url_command` | Shell command whose stdout is the update URL                         |
| `resolver`    | Resolver IP to check the current public record against (default: `8.8.8.8`)  |
| `record_type` | Record type being kept current (default: `A`)                                |
| `timeout`     | Timeout in seconds for both the IP lookup and the update request (default: `10`) |
| `min_interval`| Minimum seconds between update attempts regardless of how often `interval` ticks (default: `300`) |

Precedence when more than one source is set, for the domain and the update URL alike: the inline value > the `_file` > the `_command`. The domain is resolved on first use and remembered, so a `domain_file` that is not readable yet does not permanently break the monitor.

The domain is worth hiding for the same reason the update URL is: it names the connection whose address is being published. A `domain_file` lets it come from a secrets manager instead of the config.

**Metrics**: `in_sync` (1/0), `last_update_epoch` (Unix timestamp of the last successful push)

**Actions**: Force Update — pushes an update immediately regardless of detected drift, bypassing `min_interval`.

```yaml
- name: "DDNS"
  id: "ddns-home"
  type: "ddns_updater"
  domain_file: "/run/secrets/rendered/x-monitor-ddns-domain"
  update_url_file: "/run/secrets/freedns_update_url"
  interval: 5m
```

---

### `systemd_service`
Monitors systemd units over SSH. Operates in two modes depending on whether `max_age` is set.

**Continuous mode** (default) — for long-running daemons. Checks `systemctl is-active` each cycle and reports `online`/`warning`/`failed` from the unit's state, or `unavailable` when the journal cannot be read.

**Oneshot mode** (`max_age` set) — for timer-driven services that run and exit (e.g. `nixos-upgrade`, backup jobs). Checks the result and timestamp of the last completed run via `systemctl show`. Reports `failed` if the last run did not succeed or completed more than `max_age` seconds ago, and `unavailable` when the unit's state could not be queried.

| Option         | Description                                                                     |
|----------------|---------------------------------------------------------------------------------|
| `service_name` | Name of the systemd unit (e.g. `nginx.service`)                                 |
| `lines`        | Number of `journalctl` log lines to fetch per cycle (default: `10`)             |
| `interval`     | Polling frequency in seconds (default: `60`)                                    |
| `max_age`      | *(Oneshot mode)* Max seconds since last successful run before reporting `failed` |
| `ssh_config`   | SSH connection details — see [SSH Config](#ssh-config) below                    |
| `allow_unit_file_edit` | Enable UI editing of the target service unit file. Defaults to `false`. |
| `allowed_write_paths` | Optional list of absolute paths where unit file writes are permitted. Defaults to standard systemd unit paths. |

**Continuous metrics**: `active` (1/0)

**Oneshot metrics**: `last_run_epoch` (Unix timestamp), `last_run_success` (1/0)

**Both modes**: `enabled` (1/0), from `systemctl is-enabled`; not recorded for units that cannot be enabled or disabled, such as static or masked ones

**Actions**: Restart Service; a Running toggle button that starts or stops the unit (continuous mode) or a Stop Service button (oneshot mode, where starting would wait for the whole run); and a Start on Boot toggle button that enables or disables the unit

The service detail UI also includes:

* `View Unit File` for the configured service
* `Reload Daemon` to run `systemctl daemon-reload`
* `Edit Unit File` when `allow_unit_file_edit: true` is enabled

> Note: Remote editing requires passwordless sudo access for the service commands and the configured write helper (currently `python3` on the target). Restrict `allowed_write_paths` carefully.

```yaml
# Continuous — long-running daemon
- name: "Nginx"
  id: "nginx-service"
  type: "systemd_service"
  service_name: "nginx.service"
  interval: 60
  ssh_config:
    host: "web-01.example.com"

# Oneshot — weekly timer-driven service
- name: "NixOS Upgrade"
  id: "myhost-nixos-upgrade"
  type: "systemd_service"
  service_name: "nixos-upgrade.service"
  interval: 3600
  max_age: 604800  # 1 week
  ssh_config:
    host: "myhost.example.com"
```

### `service_list`
Lists all systemd services on a host and provides a sortable service browser with control actions.

| Option                | Description                                                                                       |
|----------------------|---------------------------------------------------------------------------------------------------|
| `lines`              | Number of recent log lines to preserve for this plugin's internal event log (default: `10`)        |
| `interval`           | Polling frequency in seconds (default: `60`)                                                      |
| `ssh_config`         | SSH connection details — see [SSH Config](#ssh-config) below                                      |
| `allow_unit_file_edit` | Allow editing of unit files from the UI (disabled by default).                                    |
| `allowed_write_paths` | Optional list of absolute paths where unit file writes are permitted. Defaults to standard systemd unit paths. |

**Metrics**: `services_total`, `services_active`, `services_failed`

**Actions**: Reload Daemon

The service browser renders a sortable table of all units. Its Active and Enabled cells are toggle buttons, pressed while the unit is active or enabled: Active starts or stops the unit, and Enabled enables or disables it on boot. A value neither can show, such as `static` or `activating`, stays as plain text. Each row also offers:

* Restart Service
* View Status
* View Unit File
* Edit Unit File (when enabled)

```yaml
- name: "Systemd Service Browser"
  id: "systemd-service-browser"
  type: "service_list"
  interval: 60
  ssh_config:
    host: "web-01.example.com"
  allow_unit_file_edit: true
  allowed_write_paths:
    - /etc/systemd/system
```

```yaml
# Continuous with unit file editing enabled
- name: "Nginx"
  id: "nginx-service"
  type: "systemd_service"
  service_name: "nginx.service"
  interval: 60
  ssh_config:
    host: "web-01.example.com"
  allow_unit_file_edit: true
  allowed_write_paths:
    - /etc/systemd/system
```

---

### `nixos_upgrade`
Tracks a NixOS host against the flake it is deployed from: whether the running system *is* the one that flake currently evaluates to, how old the flake and its locked inputs are, and whether the booted kernel is still the current one.

Drift is a comparison of two store paths — `readlink -f /run/current-system` against what `nix eval` says `…config.system.build.toplevel` is — so it is exact rather than inferred from a `configurationRevision` that a config may never set.

Two cadences share one monitor. Every `interval` it runs one cheap script (`readlink`, `stat`, `nixos-version`) and re-checks drift against the last evaluation, so a completed switch clears the flag on the next cycle. Every `eval_interval` it additionally runs `nix eval` and `nix flake metadata` — the expensive half. The last evaluation is stored with the monitor, so a X-Monitor restart resumes that schedule instead of re-evaluating. A failed evaluation is not held for the whole `eval_interval`: it is retried after `retry_interval`, so a fixed flake or a restored network clears the error promptly. A poll from the dashboard always runs the full evaluation. When the running closure changes between evaluations — a deploy landed — the monitor re-evaluates before judging drift, so a system that is *newer* than the stored target is not reported as out of date.

Both actions launch a **detached** job on the target, polled to completion by this monitor's own cycle (see [Job control](develop.md#job-control)), so a `nixos-rebuild switch` survives a dropped SSH connection and a X-Monitor restart. Keep `interval` at a few minutes if you want a running job's output to advance at that rate. Every update, build, switch and reboot is listed in the **Jobs** table, a launch that failed included, and its Log button opens the command and its output, following new lines while the job runs.

| Option | Description |
|--------|-------------|
| `flake` | Flake reference the host is deployed from (default: `/etc/nixos`). Either a local path (`/etc/nixos`, `path:…`, `git+file://…`) or a remote ref (`github:owner/config`) |
| `configuration` | `nixosConfigurations` attribute to compare against (default: the target's own hostname, resolved on the target) |
| `eval_agent` | Run `nix eval` and `nix flake metadata` on this agent's host instead of the target (default: unset, evaluate on the target). For a target too small to evaluate its own flake — a 2 GB SBC will swap itself to death doing it. The probe and both actions still run on the target |
| `eval_interval` | How often to evaluate the flake and read its metadata (default: `1h`) |
| `retry_interval` | How soon to re-evaluate after a failed evaluation (default: `15m`, never longer than `eval_interval`) |
| `eval_timeout` | Timeout for those two commands (default: `10m`) — a cold evaluation of a large config is not fast |
| `max_input_age` | Warn once the oldest locked input is older than this (default: unset, never warns) |
| `drift_status` | Status when the system is out of date: `warning` (default) or `failed` |
| `reboot_status` | Status when a reboot is pending: `warning` (default), `failed`, or `online` to ignore it |
| `require_sudo` | Prefix every action with `sudo -n` (default: `true`) |
| `nix_bin` / `rebuild_bin` | Binaries to invoke (defaults: `nix` / `nixos-rebuild`) |
| `nix_args` | Extra arguments on every `nix` call (default: `["--extra-experimental-features", "nix-command flakes"]`; set `[]` to drop them) |
| `rebuild_args` | Extra arguments on `nixos-rebuild switch`, e.g. `["--use-remote-sudo"]` |
| `build_host` | Compile the switch on this host instead of the target, as `nixos-rebuild --build-host` (default: unset, build on the target). For a target that cannot build its own closure; pairs with `rebuild_args: ["--max-jobs", "0"]` to stop it building at all. Needs SSH from the target's root to a nix-trusted user on that host |
| `build_args` | Arguments for the `build` action (default: `["--keep-going", "--print-build-logs"]`). `--keep-going` so one unbuildable package costs its own path rather than the rest of the closure, while the job still exits non-zero |
| `build_agent` | Run the build job on this agent's host instead (default: `switch_agent`). Lets one host build every other host's closure to warm a shared cache while each switch stays where it is; the build reads the flake itself, so it needs no access to the target |
| `switch_agent` | Run the switch and update jobs on this agent's host instead of the target (default: unset, run on the target). The probe stays on the target, so drift is still read from the machine it describes. With `target_host` this lets one host build and activate every other's closure |
| `target_host` | The machine the closure is copied to and activated on, as `nixos-rebuild --target-host`, e.g. `root@thor.technet` (default: unset, activate locally). Only meaningful with `switch_agent`, and needs SSH from that agent's root to this host |
| `auto_switch` | Launch Rebuild & Switch without being asked once drift outlasts `auto_switch_after` (default: `false`) |
| `auto_switch_after` | How long drift must last before an automatic switch (default: `30m`), so a deploy of your own lands first |
| `update_at` | Launch Update Flake every day at this local time, e.g. `"02:00"` (default: unset). Needs a flake Update Flake can write; otherwise the monitor warns and never runs it |
| `build_at` | Launch the build action every day at this local time, e.g. `"02:30"` (default: unset) |
| `switch_wrapper` | Command the switch runs under, outside `sudo`, e.g. `["systemd-inhibit", "--what=idle:sleep", "--mode=block"]` to keep a laptop or phone awake through it |
| `push_ssh_key` | Private key, on the host Update Flake runs on, that can push to a `github:` flake's repo, such as a write deploy key. Update Flake is offered for a `github:` flake only when this is set. `github.com` must already be in that host's known_hosts, since the host key is checked strictly (default: unset) |
| `commit_author` | Author of the commit Update Flake pushes to a `github:` flake (default: `X-Monitor <x-monitor@localhost>`) |
| `commit_message` | Subject of that commit; the updated inputs are listed below it (default: `chore(flake): update inputs`) |
| `post_switch` | Shell run after every switch, whether it succeeded or not, e.g. to restart a session the switch stopped; the job keeps the switch's own exit status |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `up_to_date` (1/0), `reboot_required` (1/0), `flake_reachable` (1/0), `generation`, `last_switch_epoch`, `flake_last_modified_epoch`, `inputs_last_modified_epoch`, `flake_eval_epoch`

**Actions**: Update Flake (`nix flake update`), Rebuild & Switch (`nixos-rebuild switch --flake`), Reboot (`systemctl reboot`, after a confirmation)

Reboot runs on the target itself, never on `switch_agent`, and is refused while a job is running so it cannot cut a switch short.

**Status**: `failed` when the flake evaluates and errors — a config that no longer builds is a real failure, and the error is logged; `drift_status` when the two closures differ; `reboot_status` when the booted `initrd`/`kernel`/`kernel-modules`/`systemd` are not the current ones; `warning` when the oldest locked input exceeds `max_input_age`; `unavailable` when the target is unreachable, `/run/current-system` cannot be read, `nix flake metadata` fails, or the evaluation host never answered.

With `auto_switch`, drift that has lasted `auto_switch_after` launches the same job the button does, and the job panel shows it. Each target closure gets one attempt: a switch that fails, or succeeds without converging, is not repeated until the flake evaluates to something new. It never runs off a failed evaluation, and it never runs when the running generation was created after the flake last changed, because that system came from somewhere else (an unpushed checkout, a local test build) and switching would roll it back. That case still reports drift.

With `update_at` or `build_at`, that job launches once a day at the given local time, on `switch_agent`'s host like the button. Each slot runs once: the slot is stored with the monitor when the job launches, so a restart never repeats it, and a slot missed while X-Monitor was down runs once when it returns, however many days it missed. Turning a schedule on never fires at once; it first runs at its next slot. A running job holds it until the job finishes, and when both are due the update goes first. Stagger the clocks of monitors that depend on one another, such as the monitor that updates a shared flake and those that build from it: a monitor runs one job at a time, but nothing orders jobs across monitors.

Update Flake works on a local flake path in place, as root. On a `github:owner/repo[/branch]` flake with a `push_ssh_key` it runs as the monitoring user in a fresh shallow clone over SSH: `nix flake update`, a commit of `flake.lock` if anything moved, and a push back to the same branch. A branch that moved in the meantime rejects the push and the job fails, with nothing left behind. The pushed revision is new drift for every monitor on that flake, so with `auto_switch` one button updates the whole fleet. Any other remote ref is not offered the button: update it where it lives and X-Monitor picks up the new revision on its next evaluation. Checking never mutates anything: `--no-write-lock-file` is passed to both commands, and `--refresh` only for a remote ref, where a mutable branch would otherwise be served from Nix's tarball cache.

> Both actions run as root by default (`require_sudo`), so the SSH user needs passwordless sudo for `nixos-rebuild`, `nix` and `systemctl reboot`. Set `require_sudo: false` when X-Monitor already connects as root, or add `--use-remote-sudo` to `rebuild_args` for the build-locally-activate-remotely arrangement.

```yaml
# Local checkout on the host, with a staleness limit on its inputs
- name: "Web Server NixOS"
  id: "web-01-nixos"
  type: "nixos_upgrade"
  flake: "/etc/nixos"
  interval: 5m
  eval_interval: 1h
  max_input_age: 30d
  ssh_config:
    host: "web-01.example.com"

# Deployed from a remote flake; drift is an alarm, not a nudge
- name: "Gateway NixOS"
  id: "gateway-nixos"
  type: "nixos_upgrade"
  flake: "github:owner/nixos-config"
  configuration: "gateway"
  drift_status: "failed"
  interval: 5m
  eval_interval: 6h
  ssh_config:
    host: "gateway.example.com"
```

---

### `nix_gc`
Whether Nix garbage collection is actually keeping a host's store in check: when it last ran, what it freed, whether it is still scheduled, and how much of the store filesystem is left. A collection that quietly stopped running — a masked timer, a unit that fails every week, a host that was never given `nix.gc.automatic` — otherwise shows up only as a disk that fills months later.

One cheap script per cycle reads the store filesystem (`df`), the store path and indirect-GC-root counts, every profile's generation links, the `nix-gc` unit and timer state (`systemctl show`), and the last collection's own summary line from the journal. Nothing here needs root, and nothing takes the GC lock: `nix-store --gc --print-dead` would give an exact reclaimable figure but walks the whole store — minutes, with the lock held — so it is deliberately not run.

The last collection's epoch, outcome and yield are stored with the monitor, so a journal that has since rotated past that run does not erase what X-Monitor already saw. The stored record only ever moves forward.

Profiles are discovered rather than configured: every symlink under `/nix/var/nix/profiles/` and `/nix/var/nix/profiles/per-user/*/` whose target is its own generation link. Their generation counts and the age of the oldest generation still on disk are what a `--delete-older-than` collection is supposed to be bounding, so they are the direct evidence that it is working.

The action launches a **detached** `nix-collect-garbage` on the target, polled to completion by this monitor's own cycle (see [Job control](develop.md#job-control)), so a collection that runs for an hour survives a dropped connection and a X-Monitor restart.

| Option | Description |
|--------|-------------|
| `unit` | Collection unit to read (default: `nix-gc.service`) |
| `timer` | Timer that schedules it (default: `nix-gc.timer`) |
| `store` | Store path whose filesystem is measured (default: `/nix/store`) |
| `max_age` | Age of the last collection before it counts as stale (default: `2w`) |
| `stale_status` | Status for a stale collection: `failed` (default), `warning`, or `online` to ignore it |
| `timer_status` | Status when the timer is not active: `warning` (default), `failed`, or `online` |
| `warning` / `threshold` | Store filesystem percent used at which to warn / fail (defaults: `80` / `90`) |
| `max_generations` | Warn once any one profile keeps more than this many generations (default: unset, never warns) |
| `max_generation_age` | Warn once the oldest generation on disk is older than this (default: unset, never warns) |
| `require_sudo` | Prefix the action with `sudo -n` (default: `true`) |
| `gc_bin` | Binary the action invokes (default: `nix-collect-garbage`) |
| `gc_args` | Arguments it is given (default: `["--delete-older-than", "7d"]`) |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `last_gc_epoch`, `last_gc_success` (1/0), `last_gc_freed_gb`, `last_gc_deleted`, `next_gc_epoch`, `timer_active` (1/0), `store_used_pct`, `store_size_gb`, `store_used_gb`, `store_avail_gb`, `store_paths`, `gc_roots`, `profiles`, `generations`, `oldest_generation_epoch`

**Actions**: Collect Garbage (`nix-collect-garbage`)

**Status**: `failed` when the last collection failed, when it is older than `max_age` (`stale_status`), or when the store filesystem is at `threshold`; `warning` at the `warning` mark, past `max_generations` or `max_generation_age`, and when the timer is inactive (`timer_status`); `unavailable` when the store cannot be read at all, when the probe returned nothing, or when nothing on the host records that a collection ever ran.

A collection currently in flight is never counted as stale, so a run that overruns `max_age` does not alarm while it is still working.

> The journal, not the unit, is what dates a run and decides whether it succeeded: systemd drops an inactive unit's `InactiveEnterTimestamp` and resets its `Result` to `success` across a daemon re-exec — which is exactly what a NixOS switch does — so `systemctl show` alone reports a run that failed hours ago as a healthy unit that has never run. `Result` is consulted only as a fallback, when the journal holds no outcome line at all. A failed run is reported with the `error:` line the journal recorded for it, and keeps whatever it did manage to free before failing.
>
> The SSH user therefore needs journal read access (`systemd-journal`) for the freshness check, and passwordless `sudo` for `nix-collect-garbage` if the action is to be used.

```yaml
# The stock NixOS weekly collection, alarming if two pass without one
- name: "Garbage Collection"
  id: "web-01-nix-gc"
  type: "nix_gc"
  interval: 1h
  ssh_config:
    host: "web-01.example.com"

# A small host where the store filling is the real risk
- name: "Garbage Collection"
  id: "sbc-nix-gc"
  type: "nix_gc"
  interval: 1h
  max_age: 10d
  warning: 70
  threshold: 85
  max_generation_age: 30d
  gc_args: ["--delete-older-than", "3d"]
  ssh_config:
    host: "sbc.example.com"
```

---

### `attic_push`
Whether the closures one host builds for the fleet are built from the flake's latest revision and pushed to an [Attic](https://github.com/zhaofengli/attic) binary cache. A watcher that silently stopped uploading, or a nightly build that never ran, otherwise shows up only as another host compiling for hours.

One script, run on the building host, evaluates each tracked target from the flake, checks whether that store path is in the local store, and asks the cache which paths of its closure it lacks. Paths signed by an upstream cache (`upstream_keys`) are left out, since Attic never stores them, so what is counted is exactly what the fleet built itself. Only the first evaluation passes `--refresh`, so every target is judged at the same revision. A target that is not built locally is checked by its root path alone.

The script runs as a detached job on the target, so restarting or redeploying X-Monitor never kills a run in flight; the restarted monitor adopts the running job and keeps polling it. A cycle with no job running launches the check, and while it runs the monitor polls it every `job_poll` rather than every `interval`, keeping the previous snapshot and status on the dashboard. When it finishes, its whole output becomes the new snapshot. Each run, its progress and its output are listed under **Check runs**.

| Option | Description |
|--------|-------------|
| `flake` | Flake the targets are evaluated from (default: `/etc/nixos`) |
| `configurations` | `nixosConfigurations` names, each tracked by its `config.system.build.toplevel` |
| `installables` | Any other derivation, as a map of display name to flake attribute path |
| `cache_url` | The cache as a substituter URL, such as `https://attic.example/main`; it must allow anonymous reads |
| `upstream_keys` | Signing key names whose paths the cache never holds (default: `["cache.nixos.org-1"]`) |
| `missing_limit` | Missing paths listed per target (default: `50`); the count is always exact |
| `pending_status` | Status for a target not yet built or not fully pushed (default: `warning`) |
| `timeout` | Time a run may take before it is killed (default: `30m`) |
| `job_poll` | How often a running check is polled (default: `30s`) |
| `nix_bin` / `nix_args` | Nix binary and its arguments (defaults: `nix`, `["--extra-experimental-features", "nix-command flakes"]`) |

**Metrics**: `targets_total`, `targets_built`, `targets_pushed`, `missing_paths`

**Status**: `failed` when a target does not evaluate; `pending_status` when one is not built or has paths missing from the cache; `unavailable` when the cache cannot be queried, the check could not start, or it ended without reporting anything.

```yaml
# Every host's system closure, built on the cache's own host
- name: "Attic Push"
  id: "builder-attic-push"
  type: "attic_push"
  interval: 1h
  flake: "github:example/fleet"
  configurations: ["builder", "laptop", "sbc"]
  cache_url: "https://attic.example/fleet"
  agent: "builder"
```


---

### `vuln_scan`
What a host exposes to the network and whether any of it is known to be vulnerable: one `nmap --script vuln` sweep per cycle, with service detection, parsed from nmap's XML into a row per open port and a row per finding.

The scan runs on the monitor's agent or SSH host and is pointed at `scan_host`, which is deliberately a different machine. The monitor is labelled with `scan_host`, since that is the host it is about, and a card names where the scan ran from. A host scanning itself goes over loopback, which its firewall trusts, so it reports every listening socket rather than what a peer can actually reach. Scan a host from somewhere else on the network, and pick the vantage point that matters — the LAN, or the VPN the host is reached through.

Each finding is graded, and the monitor takes the worst grade:

- **Vulnerable** (`failed`): a script's vulns-library table with a `VULNERABLE`, `VULNERABLE (Exploitable)` or `VULNERABLE (DoS)` state, or a plain-text result that says `VULNERABLE` outright.
- **Likely** (`likely_status`, default `warning`): a `LIKELY VULNERABLE` state. Some scripts only ever reach this — `http-slowloris-check` flags most web servers — so exclude what you do not want to hear about via `scripts`.
- **Noted** (`online`): a script that returned structured output without a verdict, listed for the record.

The `vulners` script (part of the `vuln` category, and needs the scanning host to reach vulners.com) matches detected versions against a CVE database rather than testing anything, so its advisories are graded by CVSS score instead: `threshold_cvss` and above fails, `warning_cvss` and above warns, anything lower is noted. Version matching is loose — a distribution that backports fixes keeps the old version string — so set these to what you are willing to investigate.

A host that does not answer on the `discovery_ports` is `unavailable` rather than clean, and so is a scan that overruns `timeout` or a scanning host with no `nmap`. Nothing here needs root: an unprivileged nmap uses connect scans and a TCP probe for discovery, which is all the `vuln` scripts need. `require_sudo` is there for a scan that wants SYN scanning or OS detection via `nmap_args`.

| Option | Description |
|--------|-------------|
| `scan_host` | Host or address nmap is pointed at (default: the monitor's `target_host`, then `localhost`) |
| `ports` | Port spec passed as `-p` (default: unset, nmap's top 1000) |
| `scripts` | Script expression passed as `--script` (default: `vuln`) |
| `script_args` | Passed as `--script-args` (default: unset) |
| `service_detection` | Add `-sV` so scripts see what is listening (default: `true`) |
| `discovery_ports` | TCP ports probed to decide the host is up; empty skips discovery with `-Pn` (default: `[22, 80, 443]`) |
| `nmap_args` | Extra arguments appended verbatim (default: `[]`) |
| `warning_cvss` / `threshold_cvss` | CVSS score at which a `vulners` advisory warns / fails (defaults: `4.0` / `7.0`) |
| `likely_status` | Status for a `LIKELY VULNERABLE` finding: `warning` (default), `failed`, or `online` to list it only |
| `max_findings` | Rows kept in the findings table; the counts are always complete (default: `200`) |
| `require_sudo` | Prefix the scan with `sudo -n` (default: `false`) |
| `nmap_bin` | Binary to run (default: `nmap`) |
| `timeout` | Deadline for the whole scan (default: `20m`) |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `vulnerable`, `suspected`, `noted`, `open_ports`, `scan_seconds`, `host_up` (1/0), `last_scan_epoch`

**Status**: `failed` on any vulnerable finding; `warning` on a likely one (`likely_status`) or a `vulners` advisory at `warning_cvss`; `unavailable` when the host did not answer discovery, the scan did not finish in `timeout`, or nmap could not run.

> A full `-sV --script vuln` sweep of the top 1000 ports takes a few minutes per host and probes every service it finds, so give it a long `interval` (daily is plenty) and a `timeout` to match. The scanning host needs `nmap` on the agent's PATH.

```yaml
# Every host scanned from the monitoring server, over the VPN they are reached by
- name: "Vulnerability Scan"
  id: "web-01-vuln-scan"
  type: "vuln_scan"
  interval: 1d
  timeout: 30m
  scan_host: "web-01.example.com"
  scripts: "vuln and not http-slowloris-check"
  agent: "monitor"

# The monitoring server itself, scanned from somewhere else
- name: "Vulnerability Scan"
  id: "monitor-vuln-scan"
  type: "vuln_scan"
  interval: 1d
  scan_host: "monitor.example.com"
  warning_cvss: 7.0
  threshold_cvss: 9.0
  ssh_config:
    host: "web-01.example.com"
```

### `smart`
SMART health of every physical disk on a host, via `smartctl`. Classification is by positive assertion: only an explicit `PASSED` verdict counts a disk as healthy, so a check that could not run reads as **unavailable** rather than as a clean disk. Virtual block devices (zram, ZFS zvols, loop/md/device-mapper nodes) are filtered out before probing, and a device that genuinely has no SMART support is skipped rather than counted.

> Needs passwordless `sudo` access to `smartctl` for the SSH user (e.g. `x-monitor ALL=(ALL) NOPASSWD: /usr/bin/smartctl`).

| Option       | Description                                                                 |
|--------------|-----------------------------------------------------------------------------|
| `interval`   | Polling frequency (default: `60`). `smartctl` is slow and its answer changes rarely — `1h` is a sensible setting. |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below                |

**Metrics**: `disks_total`, `disks_ok`, `disks_failed`, `disks_unknown`

**Tiles**: one per disk, showing its verdict (`PASSED`, `FAILED` or `unknown`) with its temperature and power-on hours when smartctl reports them, read in the same `smartctl -H -A` call.

**Status**: `failed` if any disk fails, `unavailable` if a disk cannot be read, smartctl could not run, or the host has no SMART-capable disk, otherwise `online`.

```yaml
- name: "SMART"
  id: "ragnarok-smart"
  type: "smart"
  interval: 1h
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `zfs`
ZFS pool state and capacity, via `zpool list`. Every pool's health and used percentage is read each cycle; per-pool usage is charted individually as well as rolled up.

| Option       | Description                                                                 |
|--------------|-----------------------------------------------------------------------------|
| `pools`      | Pool names to query (default: every pool on the host)                       |
| `warning`    | Pool usage % that triggers `warning` (default: `80`)                        |
| `threshold`  | Pool usage % that triggers `failed` (default: `90`)                         |
| `interval`   | Polling frequency (default: `60`; `1h` suits a pool that changes slowly)    |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below                |

**Metrics**: `pools_total`, `pools_ok`, `pools_degraded`, `zfs_usage_max`, `pool_usage_<pool>`

**Tiles**: one per pool, showing its health word and usage (e.g. `ONLINE · 78%`), colored failed for an unhealthy pool and otherwise by usage against the thresholds.

**Status**: `failed` for any pool not `ONLINE`, or usage at `threshold`; `warning` above `warning`; `unavailable` if `zpool` could not run or the host has no pools.

```yaml
- name: "ZFS"
  id: "ragnarok-zfs"
  type: "zfs"
  interval: 1h
  warning: 80
  threshold: 90
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `btrfs`
Btrfs filesystem state and capacity, the btrfs sibling of [`zfs`](#zfs). Every mounted btrfs filesystem is reported once, under its topmost mountpoint, with its usage and the device error counters btrfs keeps.

Btrfs publishes no pool health word, so the verdict comes from those counters — read, write, flush, corruption and generation failures, counted per device since the filesystem was made and cleared only by `btrfs device stats -z`. Any of them above zero is this monitor's DEGRADED.

Usage is measured in raw device terms (bytes occupied / device size), so a DUP or RAID1 profile — where a byte of data costs two bytes of disk — reads as the fuller filesystem it really is, rather than as the half-full one `df` suggests.

Unallocated space is watched separately, because it is the btrfs failure `df` cannot see: once a filesystem has no unallocated space left it cannot create a new chunk, and writes start failing with ENOSPC however much free space the percentage reports.

Everything is read through the mountpoint, which needs no privilege — this monitor adds no sudo rule.

| Option                | Description                                                                        |
|-----------------------|------------------------------------------------------------------------------------|
| `filesystems`         | Mountpoints to report (default: every mounted btrfs filesystem). Each filesystem is named by its topmost mountpoint, so list `/`, not a subvolume mounted beneath it. |
| `warning`             | Usage % that triggers `warning` (default: `80`)                                    |
| `threshold`           | Usage % that triggers `failed` (default: `90`)                                     |
| `unallocated_warning` | Unallocated bytes below which the filesystem warns (default: `1073741824`, one GiB) |
| `interval`            | Polling frequency (default: `60`). The probe is three cheap ioctl reads per filesystem — well under a second even on a small ARM board. |
| `ssh_config`          | SSH connection details — see [SSH Config](#ssh-config) below                        |

**Metrics**: `filesystems_total`, `filesystems_ok`, `filesystems_degraded`, `btrfs_usage_max`, `device_errors`, `fs_usage_<mount>`, `fs_errors_<mount>`, `fs_unallocated_<mount>`

**Status**: `failed` for any filesystem with a non-zero device error counter, or usage at `threshold`; `warning` above `warning` or with unallocated space under `unallocated_warning`; `unavailable` if the host has no btrfs filesystem, btrfs-progs is missing, or the probe could not run.

```yaml
- name: "Btrfs"
  id: "ragnarok-btrfs"
  type: "btrfs"
  interval: 10m
  warning: 90
  threshold: 96
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `md`
Linux software RAID health, read from `/proc/mdstat` — the mdadm sibling of [`zfs`](#zfs). Counts arrays that are clean, degraded or rebuilding.

| Option       | Description                                                  |
|--------------|--------------------------------------------------------------|
| `interval`   | Polling frequency (default: `60`)                            |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `arrays_total`, `arrays_ok`, `arrays_degraded`

**Tiles**: one per array, showing its RAID level and state (e.g. `raid1 · clean`), or its rebuild progress while it resyncs or recovers (e.g. `raid5 · resync 42%`).

**Status**: `failed` for a degraded array, `warning` while one is rebuilding, `unavailable` on a host with no arrays or when `/proc/mdstat` cannot be read.

```yaml
- name: "RAID"
  id: "ragnarok-md"
  type: "md"
  interval: 10m
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `disk_io`
Disk read/write throughput, from two `/proc/diskstats` samples a second apart taken on the target. With no `device`, it auto-detects the busiest whole disk (ignoring partitions and virtual devices) and persists the choice, showing it on the card.

Kernel names like `sda` are assigned in the order drives answer at boot, so one drive failing to appear renames every drive after it. Give `device` a path under `/dev/disk/by-id/` instead: it is resolved to the current kernel name on each poll, and the monitor fails with "is not present" when the drive itself is gone rather than silently measuring a different disk.

| Option       | Description                                                              |
|--------------|--------------------------------------------------------------------------|
| `device`     | Block device to measure — a `/dev/disk/by-id/...` path (recommended) or a kernel name like `sda` (default: auto-detect the busiest) |
| `interval`   | Polling frequency (default: `60`, recommend `30s`)                        |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below             |

**Metrics**: `read_kbps`, `write_kbps`

```yaml
- name: "Disk I/O"
  id: "ragnarok-disk-io"
  type: "disk_io"
  interval: 30s
  device: "/dev/disk/by-id/ata-EXAMPLE_SSD_1TB_1234567890"
  ssh_config:
    host: "ragnarok.example.com"
```
---

### `disk_space`
Monitors disk space usage for a path or mountpoint over SSH via `df`. Works on any mounted Linux filesystem — no ZFS or other tools required. Marks the path failed when usage reaches the configured threshold, and warns first when a `warning` is set.

| Option      | Description                                                       |
|-------------|-------------------------------------------------------------------|
| `path`      | Filesystem path or mountpoint to monitor (e.g. `/`, `/Storage`)  |
| `warning`   | Usage percentage that triggers a `warning` status (optional)     |
| `threshold` | Usage percentage that triggers a `failed` status (default: `90`) |
| `interval`  | Polling frequency (default: `60`, recommend `10m`)                |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below     |

**Metrics**: `used_pct`, `size_gb`, `used_gb`, `avail_gb`

```yaml
- name: "Root Disk"
  id: "myhost-disk-root"
  type: "disk_space"
  path: "/"
  threshold: 90
  interval: 10m
  ssh_config:
    host: "myhost.example.com"
```

---

### `cpu`
CPU utilization from two `/proc/stat` samples a second apart, taken on the target so the sleep costs one round trip rather than two. The same two samples give every core's utilization, drawn as a bar per core on the monitor's page, and the busiest core is kept as `cpu_core_max_pct`.

The per-core bars come from a snapshot that is replaced every cycle, so they cost no history however many cores the host has. Per-core *history* is opt-in with `per_core_metrics`, because it writes one metric row per core per cycle — a 64-thread host at a one-minute interval adds about 92,000 rows a day.

A single pinned core is usually a stuck or single-threaded process that the overall figure hides on a many-core host. Set both `core_warning` and `core_threshold` to let the busiest core change the status too; without both, it is only shown. The bars are colored by these bounds when they are set, else by `warning`/`threshold`.

| Option             | Description                                                              |
|--------------------|--------------------------------------------------------------------------|
| `warning`          | CPU % that triggers `warning` (default: `70`)                            |
| `threshold`        | CPU % that triggers `failed` (default: `85`)                             |
| `per_core_metrics` | Record `cpu<n>_pct` for every core (default: `false`)                    |
| `core_warning`     | Busiest-core % that triggers `warning` (optional, off by default)         |
| `core_threshold`   | Busiest-core % that triggers `failed` (optional, off by default)          |
| `interval`         | Polling frequency (default: `60`)                                        |
| `ssh_config`       | SSH connection details — see [SSH Config](#ssh-config) below             |

**Metrics**: `cpu_pct`, `cpu_core_max_pct`, and `cpu<n>_pct` per core with `per_core_metrics: true`

```yaml
- name: "CPU"
  id: "ragnarok-cpu"
  type: "cpu"
  interval: 1m
  warning: 70
  threshold: 85
  core_warning: 95       # optional: flag a single pinned core
  core_threshold: 100
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `memory`
Memory use from `/proc/meminfo`, reported as the share of total memory that is *unavailable* — the number that matters, since cache is reclaimable.

| Option       | Description                                                  |
|--------------|--------------------------------------------------------------|
| `warning`    | Memory % that triggers `warning` (default: `75`)             |
| `threshold`  | Memory % that triggers `failed` (default: `90`)              |
| `interval`   | Polling frequency (default: `60`)                            |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `memory_pct`, `memory_used_gb`, `memory_total_gb`

```yaml
- name: "Memory"
  id: "ragnarok-memory"
  type: "memory"
  interval: 1m
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `load`
Load average from `/proc/loadavg`, normalized by core count so 100% means the host is exactly at capacity. Both limits are optional and independent: with neither, load is collected and charted but never changes the status — useful on a box where a high load average is normal.

| Option       | Description                                                              |
|--------------|--------------------------------------------------------------------------|
| `warning`    | 1m load as % of cores that triggers `warning` (optional)                  |
| `threshold`  | 1m load as % of cores that triggers `failed` (optional)                   |
| `interval`   | Polling frequency (default: `60`)                                         |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below             |

**Metrics**: `load_pct_1m`, `load_pct_5m`, `load_pct_15m`, `load_1m`, `cpu_count`

```yaml
- name: "Load"
  id: "ragnarok-load"
  type: "load"
  interval: 1m
  warning: 70
  threshold: 100
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `temperature`
Every thermal zone under `/sys/class/thermal`. The hottest zone sets the status; each zone is also kept as its own metric and chip, so a single hot sensor is identifiable rather than hidden in a maximum. A host with no zones (a VM, typically) stays `online` with no metric rather than reporting a problem it cannot see.

| Option       | Description                                                  |
|--------------|--------------------------------------------------------------|
| `warning`    | °C that triggers `warning` (default: `70`)                   |
| `threshold`  | °C that triggers `failed` (default: `80`)                    |
| `interval`   | Polling frequency (default: `60`)                            |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `temp_c`, `temp_zone_<zone>`

```yaml
- name: "Temperature"
  id: "ragnarok-temperature"
  type: "temperature"
  interval: 1m
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `interrupts`
Interrupt and context-switch rates, from two `/proc/stat` snapshots a second apart. Takes its own sample rather than sharing the [`cpu`](#cpu) monitor's, so a host can run either without the other.

| Option       | Description                                                       |
|--------------|-------------------------------------------------------------------|
| `warning`    | Interrupts/sec that triggers `warning` (default: `20000`)         |
| `threshold`  | Interrupts/sec that triggers `failed` (default: `50000`)          |
| `interval`   | Polling frequency (default: `60`)                                 |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below      |

**Metrics**: `irq_per_sec`, `ctxt_per_sec`

```yaml
- name: "Interrupts"
  id: "ragnarok-interrupts"
  type: "interrupts"
  interval: 1m
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `gpu`
Every NVIDIA, AMD and Intel card on the host, in one command per cycle: NVIDIA cards through `nvidia-smi`, AMD (`amdgpu`) and Intel (`i915`/`xe`) cards through `/sys/class/drm`, which needs no extra tools and no root. The vendor is detected per card, so one monitor covers a desktop with an Intel iGPU and an NVIDIA dGPU. Each card gets its own metric family and chip, and the worst card sets the status.

**Numbering.** NVIDIA cards keep `nvidia-smi`'s indices, so existing `gpu<n>_*` series carry over. AMD and Intel cards are numbered after the host's NVIDIA cards, in DRM card order. The NVIDIA count comes from the PCI bus rather than from `nvidia-smi`, so an AMD card keeps its number when `nvidia-smi` is missing or suspended.

**A sleeping card is not woken.** An AMD or Intel card whose runtime power state is `suspended` (a laptop's idle dGPU) is reported as idle — `gpu<n>_util` of `0`, shown as *asleep* — without reading any of its other files, since reading them would power it up every cycle.

**Intel utilization** comes only from `intel_gpu_top`, sampled once for 0.5 s and bounded to 2 s, and is the busiest engine's share (render, video, and so on). It needs `intel_gpu_top` installed and perf access for the user X-Monitor runs as (`CAP_PERFMON`, or `kernel.perf_event_paranoid` of `0` or less). Without it, an Intel card reports its clock and any temperatures but no utilization, and the log says why; the load is never guessed from the clock.

A GPU that sleeps with a laptop lid can wedge `nvidia-smi` uninterruptibly. After `timeout_trip` consecutive timeouts the monitor stops running `nvidia-smi` for `suspend_seconds` rather than stranding a process per cycle; other cards keep reporting, and a host with only NVIDIA cards reports `unavailable`.

| Option            | Description                                                       |
|-------------------|-------------------------------------------------------------------|
| `vendor`          | `auto` (default), or `nvidia`, `amd`, `intel`, or a list of them, to probe only those cards |
| `intel_gpu_top`   | Sample Intel utilization with `intel_gpu_top` when it is installed (default: `true`) |
| `util_warning`    | GPU utilization % that triggers `warning` (default: `85`)         |
| `util_threshold`  | GPU utilization % that triggers `failed` (default: `95`)          |
| `mem_warning`     | GPU memory % that triggers `warning` (default: `85`)              |
| `mem_threshold`   | GPU memory % that triggers `failed` (default: `95`)               |
| `temp_warning`    | °C that triggers `warning` (default: `80`)                        |
| `temp_threshold`  | °C that triggers `failed` (default: `90`)                         |
| `timeout_trip`    | Consecutive timeouts before `nvidia-smi` is suspended (default: `2`) |
| `suspend_seconds` | How long `nvidia-smi` stays suspended (default: `1800`)           |
| `ssh_config`      | SSH connection details — see [SSH Config](#ssh-config) below      |

**Metrics**: `gpu_util`, `gpu_mem_pct`, `gpu_temp` (the peak across cards that report each), and per card:

| Metric                  | NVIDIA (`nvidia-smi`)  | AMD (sysfs)                          | Intel (sysfs, `intel_gpu_top`)          |
|-------------------------|------------------------|--------------------------------------|-----------------------------------------|
| `gpu<n>_util`           | `utilization.gpu`      | `gpu_busy_percent`                   | busiest engine, `intel_gpu_top` only    |
| `gpu<n>_mem_pct`        | `memory.used / total`  | `mem_info_vram_used / total`         | —                                       |
| `gpu<n>_temp`           | `temperature.gpu`      | hwmon `edge`                         | hwmon `pkg` (`xe` only)                 |
| `gpu<n>_temp_junction`  | —                      | hwmon `junction`                     | —                                       |
| `gpu<n>_temp_mem`       | —                      | hwmon `mem`                          | hwmon `vram` (`xe` discrete only)       |
| `gpu<n>_power_w`        | `power.draw`           | hwmon `power1_average` or `power1_input` | `intel_gpu_top` GPU power           |
| `gpu<n>_clock_mhz`      | `clocks.sm`            | current `pp_dpm_sclk` level          | `gt_act_freq_mhz`, or `xe`'s `act_freq` |
| `gpu<n>_mem_busy_pct`   | —                      | `mem_busy_percent`                   | —                                       |

Only the utilization, VRAM and temperature readings count against the thresholds. On an AMD APU the "VRAM" is the firmware's carve-out from system memory, and the edge temperature and power are the whole chip's, CPU included — raise `temp_warning` there if the CPU normally runs hot.

```yaml
- name: "GPU"
  id: "odin-gpu"
  type: "gpu"
  interval: 1m
  temp_threshold: 88
  ssh_config:
    host: "odin.example.com"
```

---

### `oom`
Kernel OOM kills, from `/proc/vmstat`'s `oom_kill` counter. An OOM kill is an event, not a level: memory is back to normal before the next sample, so the [`memory`](#memory) monitor cannot see it. The counter is read every cycle so no kill is ever missed, and the alert is held for `alert_for` cycles afterwards so a kill is still visible when you look.

On an agent-backed host the monitor also follows the kernel journal, so a kill is reported the moment it happens and names the process the counter can only total.

| Option       | Description                                                                |
|--------------|----------------------------------------------------------------------------|
| `is_warning` | Report a kill as `warning` instead of `failed` (default: `false`)          |
| `alert_for`  | Collections a kill keeps the monitor alerting (default: `3`)               |
| `interval`   | Polling frequency (default: `60`)                                           |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below               |

**Metrics**: `oom_kills_total`, `oom_kills_new`

```yaml
- name: "OOM Kills"
  id: "ragnarok-oom"
  type: "oom"
  interval: 1m
  alert_for: 3
  ssh_config:
    host: "ragnarok.example.com"
```
---

### `processes`
Monitors running processes over SSH via `ps`, shown as a tree: each process sits under its parent, and its CPU %, MEM % and PROCS count add up its whole branch, with its own share in SELF CPU % and SELF MEM %. A chevron collapses or opens a branch, sorting orders siblings within their parent, and the filter keeps each match with the processes above it. Per-row SIGTERM and SIGKILL buttons are available directly in the UI.

| Option          | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `max_processes` | Busiest processes kept in the tree, each with its ancestors (default: `20`); totals still count every process |
| `require_sudo`  | Prefix kill commands with `sudo` (default: `false`)                          |
| `cpu_warning`   | Busiest single process's own CPU % that triggers `warning` (optional)                |
| `cpu_threshold` | Busiest single process's own CPU % that triggers `failed` (optional)                 |
| `interval`      | Polling frequency (default: `60`)                                             |
| `ssh_config`    | SSH connection details — see [SSH Config](#ssh-config) below                 |

**Metrics**: `process_count`, `top_cpu_pct`

```yaml
- name: "Heimdall Processes"
  id: "heimdall-processes"
  type: "processes"
  interval: 30s
  max_processes: 20
  cpu_warning: 80
  cpu_threshold: 95
  ssh_config:
    host: "heimdall.example.com"
```

---

### `throughput`
Network interface throughput, from two `/proc/net/dev` samples a second apart. With no `interface`, it auto-detects the non-virtual interface with the highest cumulative byte count (ignoring `lo`, `veth`, `docker`, `virbr`, `br-`, `tun`, `tap` prefixes) and persists the choice, showing it on the card.

| Option       | Description                                                              |
|--------------|--------------------------------------------------------------------------|
| `interface`  | Interface to measure, e.g. `eth0` (default: auto-detect the busiest)      |
| `interval`   | Polling frequency (default: `60`, recommend `30s`)                        |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below             |

**Metrics**: `rx_kbps`, `tx_kbps`

```yaml
- name: "Throughput"
  id: "ragnarok-throughput"
  type: "throughput"
  interval: 30s
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `connections`
TCP connection counts by state, read from `/proc/net/tcp`. Thresholds apply to the total, which is what catches a connection leak or a flood.

| Option       | Description                                                  |
|--------------|--------------------------------------------------------------|
| `warning`    | Total connections that trigger `warning` (default: `500`)    |
| `threshold`  | Total connections that trigger `failed` (default: `1000`)    |
| `interval`   | Polling frequency (default: `60`)                            |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `conn_total`, `conn_established`, `conn_listen`, `conn_timewait`

```yaml
- name: "Connections"
  id: "ragnarok-connections"
  type: "connections"
  interval: 1m
  warning: 500
  threshold: 1000
  ssh_config:
    host: "ragnarok.example.com"
```

---

### `wifi`
WiFi link quality and signal strength from `/proc/net/wireless`. With no `interface`, it picks the interface with the best link quality and persists the choice. Quality thresholds are inverted — *lower* is worse.

| Option              | Description                                                  |
|---------------------|--------------------------------------------------------------|
| `interface`         | Wireless interface, e.g. `wlan0` (default: the strongest)    |
| `quality_warning`   | Link quality at or below which the status is `warning` (default: `40`) |
| `quality_threshold` | Link quality at or below which the status is `failed` (default: `20`)  |
| `interval`          | Polling frequency (default: `60`)                            |
| `ssh_config`        | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `link_quality`, `signal_dbm`

```yaml
- name: "WiFi"
  id: "odin-wifi"
  type: "wifi"
  interval: 1m
  quality_warning: 40
  quality_threshold: 20
  ssh_config:
    host: "odin.example.com"
```
---

### `power`
Battery charge, whether the device is on external power, and how worn the battery is, from `/sys/class/power_supply`. The headline battery is the first one powering the system itself, so an accessory battery such as a phone's keyboard case (kernel scope `Device`) is listed beside it but never taken for it. A host with no battery stays online with no metric.

**Plugged in** is true when any charger or USB input is live, or the battery reports charging or full. **Capacity left** is the battery's learned full capacity as a share of its factory design capacity; it is left out when the gauge reports only the design figure, as the PinePhone's does. **Health** is the kernel's own verdict when it reports a problem, otherwise `Good`, `Worn` or `Replace` by capacity left. Low charge only counts against the status while running on battery.

| Option               | Description                                                  |
|----------------------|--------------------------------------------------------------|
| `battery`            | Supply name to report on, e.g. `BAT0` (default: the first system battery). Naming one gives that battery a page of its own: only its chip is shown, and an accessory battery counts as plugged in only when it says it is charging |
| `charge_warning`     | Charge at or below which, on battery, the status is `warning` (default: `20`) |
| `charge_threshold`   | Charge at or below which, on battery, the status is `failed` (default: `10`)  |
| `capacity_warning`   | Capacity left at or below which the status is `warning` (default: `60`) |
| `capacity_threshold` | Capacity left at or below which the status is `failed` (default: `40`)  |
| `interval`           | Polling frequency (default: `60`)                            |
| `ssh_config`         | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `charge_pct`, `plugged_in` (1 or 0), `capacity_health_pct`, `battery_<name>_charge_pct` per battery

```yaml
- name: "Power"
  id: "odin-power"
  type: "power"
  interval: 1m
  ssh_config:
    host: "odin.example.com"
```
---

### `reboot_required`
Whether the host must reboot to run the kernel and core libraries it has installed. It runs every check that applies to the host, in one cheap script, and reports a reboot when any of them asks for one:

- **Debian / Ubuntu** — `/var/run/reboot-required` exists; the packages that asked for it are read from `/var/run/reboot-required.pkgs`. Debian writes this flag only when `unattended-upgrades` or `update-notifier-common` is installed.
- **RHEL / Fedora** — `needs-restarting -r` (or `dnf needs-restarting -r`) exits `1`; the core packages it lists are shown.
- **NixOS** — the booted system's `initrd`, `kernel`, `kernel-modules` or `systemd` differ from the current system's, the same comparison [`nixos_upgrade`](#nixos_upgrade) makes; the parts that differ are shown.
- **Any other host (Arch and friends)** — the running kernel (`uname -r`) has no directory under `/usr/lib/modules`, because a kernel upgrade removed it.

A host where none of these applies (a container with no module tree, say) is `unavailable`. Nothing here needs root.

| Option          | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `reboot_status` | Status when a reboot is required: `warning` (default), `failed`, or `online` to only record it |
| `interval`      | Polling frequency (default: `60`; `1h` is plenty)                             |
| `ssh_config`    | SSH connection details — see [SSH Config](#ssh-config) below                 |

**Metrics**: `reboot_required` (1/0)

```yaml
- name: "Reboot Required"
  id: "server-reboot"
  type: "reboot_required"
  interval: 1h
  ssh_config:
    host: "server.example.com"
```

---

### `package_updates`
Pending package updates and how many of them are security fixes, normalised across apt, dnf and pacman. It only reads what the package manager already has cached — it never refreshes metadata and needs no root — so the counts are as fresh as the host's own `apt update` / `dnf makecache` timer:

- **apt** — `apt list --upgradable` (or `apt-get -s dist-upgrade` without `apt`); an update is a security update when it comes from a `-security` suite.
- **dnf** — `dnf --cacheonly check-update`, with `dnf --cacheonly updateinfo list --security` for the security flag and `rpm -q` for installed versions. A non-root `--cacheonly` reads the system cache.
- **pacman** — `checkupdates` from `pacman-contrib` when installed (it syncs a temporary copy of the databases, so it needs network access but no root), otherwise `pacman -Qu` against the last `pacman -Sy`. Arch has no security metadata of its own; when `arch-audit` is installed, the packages it lists are flagged as security updates.

The manager is detected in that order unless `manager` names one. The dashboard lists every pending package with its installed and available version and its security flag, security updates first.

A host with none of the three managers is `unavailable`. That includes NixOS, whose updates are tracked by [`nixos_upgrade`](#nixos_upgrade) instead; the message says so. A cache the manager cannot read (dnf with no system cache yet, say) is `unavailable` too.

| Option               | Description                                                                 |
|----------------------|-----------------------------------------------------------------------------|
| `manager`            | `apt`, `dnf` or `pacman` (default: auto-detect)                             |
| `warning`            | Pending updates that trigger `warning` (default: none)                      |
| `threshold`          | Pending updates that trigger `failed` (default: none)                       |
| `security_warning`   | Pending security updates that trigger `warning` (default: `1`, so any; `null` to disable) |
| `security_threshold` | Pending security updates that trigger `failed` (default: none)              |
| `interval`           | Polling frequency (default: `1h`)                                           |
| `ssh_config`         | SSH connection details — see [SSH Config](#ssh-config) below                |

**Metrics**: `updates_pending`, `security_updates_pending`

```yaml
- name: "Package Updates"
  id: "server-updates"
  type: "package_updates"
  interval: 1h
  warning: 50              # a long-neglected host
  security_threshold: 5    # any security update warns; five fail
  ssh_config:
    host: "server.example.com"
```

---

### `interfaces`
Every network interface on the host with its state, carrier, MAC, MTU, link speed and IPv4/IPv6 addresses, from `ip -j addr` and `/sys/class/net` (plain `ip addr` stands in when `ip` has no JSON output). Where [`throughput`](#throughput) measures one busy interface, this lists them all — for catching a dropped link or a changed DHCP lease.

An interface counts as up when its operstate is `up`, or `unknown` with a carrier (loopback, WireGuard and other tunnels report `unknown`). Interfaces you name in `expect_up` are checked:

- **missing, down or without carrier** → `failed`;
- **addresses changed since the previous cycle** (a new DHCP lease, a new IPv6 prefix) → `warning` for that cycle, with an event naming the old and new addresses. Temporary IPv6 privacy addresses rotate by design, so they are listed but never compared; a link that drops and comes back with the same address is not a change.

Other interfaces are listed and counted, but never change the status. An `expect_up` interface is always listed, even when `include`/`exclude` would hide it.

| Option             | Description                                                              |
|--------------------|--------------------------------------------------------------------------|
| `include`          | Glob patterns of interfaces to list, e.g. `["eth*", "wlan*"]` (default: all) |
| `exclude`          | Glob patterns of interfaces to leave out, e.g. `["veth*", "docker*"]`     |
| `include_loopback` | List the loopback interface too (default: `false`)                       |
| `expect_up`        | Interfaces that must be up with carrier; also watched for address changes |
| `interval`         | Polling frequency (default: `60`)                                         |
| `ssh_config`       | SSH connection details — see [SSH Config](#ssh-config) below             |

**Metrics**: `interfaces_up`, `interfaces_total` (both over the listed interfaces); `interface_<name>_up` (1/0) per `expect_up` interface

```yaml
- name: "Interfaces"
  id: "server-interfaces"
  type: "interfaces"
  interval: 1m
  exclude: ["veth*", "docker*", "br-*"]
  expect_up: ["eth0", "wg0"]
  ssh_config:
    host: "server.example.com"
```

---

### `sessions`
Who is logged in, from where and since when: every active session with its user, tty or seat, remote host, type (`tty`, `x11`, `wayland`, with the PAM service such as `sshd`), login time and idle time, read from `loginctl`. Where logind is not running (a container, a non-systemd host) it falls back to `who -u --ips`. The per-user service manager and the display manager's login screen are sessions to logind but not people logging in, so they are left out (`manager`, `greeter` and `lock-screen` classes).

With `allowed_users` and/or `allowed_sources` set, a session outside them sets `violation_status` (`warning` by default) for as long as it lasts, and logs one event the first time it is seen. `allowed_sources` takes CIDRs (`192.0.2.0/24`, `2001:db8::/32`), hostnames and globs (`*.example.com`); a local session (console, desktop) has no source and always passes that check. Once the first cycle has recorded who is already on, each later new session logs an event too.

A **Recent logins** table shows the last `recent_logins` logins from `last --time-format iso` (util-linux or wtmpdb), with reboot records left out; it stays empty where `last` is missing.

| Option             | Description                                                                  |
|--------------------|------------------------------------------------------------------------------|
| `allowed_users`    | User names (globs allowed) that may log in (default: anyone)                |
| `allowed_sources`  | CIDRs, hostnames or globs remote sessions may come from (default: anywhere) |
| `violation_status` | Status while a session is outside the allowlists: `warning` (default) or `failed` |
| `recent_logins`    | Rows in the recent logins table (default: `10`; `0` hides it)               |
| `interval`         | Polling frequency (default: `60`)                                            |
| `ssh_config`       | SSH connection details — see [SSH Config](#ssh-config) below                |

**Metrics**: `sessions_total`, `sessions_remote`, `sessions_unexpected`, `users_total`

```yaml
- name: "Sessions"
  id: "server-sessions"
  type: "sessions"
  interval: 1m
  allowed_users: ["admin", "deploy"]
  allowed_sources: ["192.0.2.0/24", "*.example.com"]
  ssh_config:
    host: "server.example.com"
```

---

### `borg`
Whether a Borg repository is being backed up, can be restored from, and is being checked, plus a file browser and the maintenance jobs that go with it. Everything runs as `borg` on the target over SSH, so the repository can be a local path there or a remote `ssh://` one.

Each cycle lists the newest archives (`borg list --json`) and, with `collect_stats`, reads their sizes (`borg info --json`). Both run in one command so they do not fight over the chunks cache lock.

**Browsing.** The **Browse archive** panel lists one folder at a time: pick an archive, click into folders, tick files or folders, then restore them. borg has to read the whole archive to list any folder, so the first visit to a big archive takes a while. Archives never change, so every folder listed is kept and reopening it is instant. A top-level folder that borg never stored, such as `Storage` for a backup of `/Storage/System`, is still shown.

**Restoring** always extracts into a new folder under `restore_dir`, named after the archive and the time, and never over live files. It runs as a detached job, listed under Jobs with its progress. The archive table's restore button does the same for a path you type.

**Maintenance.** Check, Compact and Prune run as detached jobs, one job at a time per monitor (see [Job control](develop.md#job-control)). Prune applies the `keep_*` policy for real, so use Prune Preview first to see what it would drop. Compact is what actually frees the space afterwards (borg 1.2 or later). An archive row can show what changed since the previous archive (`borg diff`), or delete the archive. **Prune, delete and Break Lock are off unless `allow_delete: true`**, and each one asks for confirmation.

**Running backups on a schedule.** With a `schedule` (see [Scheduled actions](#scheduled-actions)) this monitor can take over from borgmatic or Vorta. `prune_after_backup` and `compact_after_backup` make each real backup prune by the `keep_*` policy and then compact, the way borgmatic runs `create prune compact`; each step runs only while the ones before it succeeded or ended with a borg warning, and the job exits with the worst status. A dry run never prunes.

Before any job starts, X-Monitor checks whether it should run at all. For an `ssh://` repository it reads the server's SSH banner, and while one of the `skip_while_active` units is running it waits too. A job that would not get through is skipped, not failed: it logs why, records no job, and the next scheduled run tries again. The `max_age` check still fails the monitor if the backups stay away too long.

Jobs can be made to stay out of the way. `job_nice` and `job_io_idle` run them at a lower CPU priority and in the idle I/O class, which needs no extra rights. `inhibit_sleep` holds off suspend and shutdown until the job ends; the account running it needs polkit's `org.freedesktop.login1.inhibit-block-sleep` and `inhibit-block-shutdown` rights. `job_lock` names a lock file, and monitors that share it run their jobs one after another instead of at once, such as one host backing up to several repositories.

**Checks of each kind.** The Check action takes a `kind`: `all` (the default), `repository`, `archives`, `data` (every chunk re-read), or `extract`, which dry-runs an extract of the newest archive. Schedule each kind on its own cadence with `args`. `check_kinds` sets how old the last success of each may be, judged from X-Monitor's own Check jobs: a `data` check renews `repository` and `archives` too, and `all` renews both. A failed or overdue kind fails the monitor, alongside any `check_units`. A kind that has never run gets one of its ages, counted from when the monitor first expected it, before it counts as overdue, so a new schedule has time to reach it.

```yaml
schedule:
  - action: run_backup
    cron: "0 */3 * * *"
  - action: check_repo
    cron: "0 4 * * sun"
    args: {kind: archives}
  - action: check_repo
    cron: "0 5 1 * *"
    args: {kind: data}
check_kinds: {repository: 8d, archives: 8d, data: 32d}
```

**Purging excluded files.** New exclude patterns only keep files out of new archives. Purge Excluded rewrites the existing archives with `borg recreate` so they drop whatever the backup set's `exclude*` options now leave out, then compacts to free the space. It first deletes any `<archive>.recreate` left by an interrupted run, since borg refuses to start while one exists. Purge Preview is a dry run that lists the top-most path of each dropped tree, archive by archive. Both run as detached jobs and hold the repository lock for their whole run, and on a large remote repository that can take hours. Running the purge again with the same patterns rewrites every archive again, so it is a button, not a schedule. **Both are off unless `allow_purge: true`.**

| Option | Description |
|--------|-------------|
| `repo` | Repository path or URL (required) |
| `max_age` | Age of the newest archive before it counts as stale (default: `1d`) |
| `passphrase` / `passphrase_file` / `passphrase_command` | How borg gets the key passphrase; the file is read by X-Monitor, the command runs on the target |
| `ssh_key` / `rsh` | Key borg uses to reach a remote repo, or a full `BORG_RSH` command |
| `require_sudo` | Run borg as root through `sudo -n` (default: `false`) |
| `borg_bin` | borg binary (default: `borg`) |
| `list_archives` | How many of the newest archives to list (default: `10`) |
| `collect_stats` | Read sizes with `borg info` (default: `true`) |
| `cache_dir` | borg's cache and config dir for jobs, and for polls when set (default: `/var/cache/x-monitor-borg`) |
| `lock_wait` / `backup_lock_wait` | Seconds to wait for a lock in polls / in jobs (defaults: `30` / `600`) |
| `source_paths`, `exclude`, `exclude_from`, `exclude_caches`, `exclude_if_present`, `one_file_system`, `compression`, `archive_prefix` | The backup set for the Run Backup action |
| `canary_path` / `canary_interval` | A file extracted from the newest archive and compared with the live copy, and how often (default: `1d`) |
| `check_units` / `check_max_age` | systemd units that run `borg check`, read from the journal, and how old their last success may be (default: `8d`) |
| `keep_within`, `keep_last`, `keep_hourly`, `keep_daily`, `keep_weekly`, `keep_monthly`, `keep_yearly`, … | Retention policy for Prune Preview and Prune |
| `prune_match` | Archives the policy applies to (default: `<archive_prefix>-*`) |
| `restore_dir` | Where restores land (default: `/var/tmp/x-monitor-restore`) |
| `browse_limit` | Most entries shown per folder or diff (default: `2000`) |
| `allow_delete` | Allow Prune, deleting archives and Break Lock (default: `false`) |
| `check_verify_data` | Make the Check job read every chunk (`--verify-data`) when no `kind` is given, which is much slower (default: `false`) |
| `check_kinds` | How old the last successful Check of each kind may be, as `{repository, archives, data, extract: age}` (default: none) |
| `prune_after_backup` / `compact_after_backup` | Prune by the `keep_*` policy, then compact, after each real backup (defaults: `false`) |
| `skip_when_unreachable` | Skip a job while an `ssh://` repository's server does not answer SSH (default: `true`) |
| `skip_while_active` | systemd units that make a job skip while one of them is running (default: none) |
| `job_nice` / `job_io_idle` | Run jobs at this niceness / in the idle I/O class (defaults: unchanged) |
| `inhibit_sleep` | Hold off suspend and shutdown while a job runs (default: `false`) |
| `job_lock` | Lock file that makes jobs of every monitor sharing it run one at a time (default: none) |
| `allow_purge` | Allow Purge Preview and Purge Excluded (default: `false`) |
| `purge_match` | Archives a purge rewrites (default: every archive in the repo) |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `archive_count`, `last_backup_epoch`, `archive_list`, `original_size`, `compressed_size`, `deduplicated_size`, `dedup_ratio`, `total_chunks`, `unique_chunks`, `canary_ok`, `canary_checked_epoch`, `checks_ok`, `check_ok_epoch`

**Actions**: Run Backup, Dry Run, Verify Restore, Prune Preview, Check, Compact, Prune, Purge Preview, Purge Excluded, Break Lock; per archive: Changes, Restore, Delete; the browser's Restore selected

**Status**: `failed` when borg reports an error, the repo has no archives, the newest one is older than `max_age`, the restore canary does not match, a check unit failed or is older than `check_max_age`, or a kind in `check_kinds` failed or is older than its age; `unavailable` when the host, the borg binary or the repo cannot be reached, a lock was not released in time, or the output could not be read.

> Prune, delete, Purge Excluded and Break Lock act on the repository itself. Break Lock is only safe when no borg process is using the repo, since breaking a live lock can corrupt it, so X-Monitor refuses it while one of its own jobs is running. Delete only accepts an archive the monitor has listed.

```yaml
- name: "Vault backups"
  id: "vault-borg"
  type: "borg"
  interval: 1h
  repo: "ssh://borg@backup.example.com/srv/borg/vault"
  passphrase_file: "/run/secrets/borg-vault"
  ssh_key: "/root/.ssh/borg"
  require_sudo: true
  max_age: 26h
  canary_path: "/etc/hostname"
  check_units: ["borgmatic-check.service"]
  keep_daily: 7
  keep_weekly: 4
  keep_monthly: 6
  allow_delete: true
  ssh_config:
    host: "vault.example.com"
```

---

### `containers`
Monitors Docker or Podman containers over SSH via `<runtime> ps -a`, counting running vs. stopped containers and listing each one with its state and image in a table. Paused/created containers are treated as benign. Named containers listed in `expect_running` are required — any that are missing or not running drive the status to **failed** and expose a per-container **Restart** action in the UI. Other unexpectedly-stopped containers drive **warning** (unless `stopped_warning: false`).

For safety, the restart action only ever targets containers explicitly listed in `expect_running`.

**Prune.** The **Prune** button runs `<runtime> system prune -f` on the target after a confirmation that spells out what it deletes: every stopped container, unused networks, dangling images and the build cache. `prune_all_images: true` adds `-a` (every image no container uses) and `prune_volumes: true` adds `--volumes` (every unused volume, with its data). The space reclaimed and the number of objects deleted are shown when it finishes and logged as an event; a failed prune is logged as an error event without changing the status. There is no per-container "pull and recreate": a plain `docker run` container cannot be recreated with its original options from what the runtime reports, so pull and recreate through whatever started it (compose, systemd, `podman auto-update`).

**Image updates.** Each cycle the target also reports every container's image reference and the RepoDigests of the image it runs (`<runtime> container inspect` / `image inspect`), so the target needs nothing beyond the runtime. Every `update_check_interval` X-Monitor itself asks each image's registry for the digest its tag points at now (a `HEAD` on `/v2/<repo>/manifests/<tag>`), and the **Update** column shows one of:

- **Update available** — the registry's digest is not among the image's RepoDigests, so a pull and a recreate of the container would change it. This also catches a container still running an older image after its tag was pulled anew.
- **Up to date** — the registry's digest matches.
- **Pinned by digest** / **Local image** — the reference names a digest, or the image has no RepoDigests (built locally), so there is nothing to compare; these are never checked.
- **Not checked yet** / **Check failed** — no answer from the registry so far.

The count of distinct images with an update is the `images_update_available` metric and the **IMAGE UPDATES** card. By default it does not change the status; `update_warning: true` makes it a **warning**. A registry that fails or refuses is only logged as a warning event — it never changes the status — and the last digest it did report keeps being used until a check succeeds again.

Docker Hub (`registry-1.docker.io`, with `library/` for official images), ghcr.io, quay.io and any other v2 registry work anonymously through the bearer-token challenge the registry sends. A private registry or repository needs credentials under `registries`, keyed by the host as image references name it (`docker.io`, `ghcr.io`, `registry.example.com:5000`).

**Rate limits.** Docker Hub limits anonymous pulls per IP, and other registries throttle too. A check sends one `HEAD` per distinct image (Docker Hub does not count a `HEAD` as a pull) plus one token request, and its answers are cached until the next check, but keep `update_check_interval` in hours rather than minutes, and give Docker Hub credentials when many hosts share one public IP. A `429` answer is logged as a rate-limit event. The check runs in place of one ordinary poll, so on an agent-backed host a monitor with update checks on is polled through the agent rather than sampled by it; `update_check_interval: 0` turns the checks off and restores sampling.

| Option                  | Description                                                            |
|-------------------------|------------------------------------------------------------------------|
| `runtime`               | `docker` (default) or `podman`                                         |
| `expect_running`        | *(Optional)* List of container names that must be running (→ Restart actions) |
| `stopped_warning`       | Treat any stopped container as a warning (default: `true`)             |
| `update_check_interval` | How often X-Monitor asks registries for image updates (default: `6h`; `0` turns update detection off) |
| `update_warning`        | Make the status **warning** while any image has an update (default: `false`) |
| `registries`            | *(Optional)* Per-registry credentials, `{host: {username, password or password_command, insecure}}`; `insecure: true` talks plain HTTP to that registry |
| `prune_all_images`      | Prune also removes every image no container uses (`-a`), not only dangling ones (default: `false`) |
| `prune_volumes`         | Prune also removes unused volumes and their data (`--volumes`) (default: `false`) |
| `ssh_config`            | SSH connection details — see [SSH Config](#ssh-config) below           |

**Metrics**: `containers_total`, `containers_running`, `containers_stopped`, `images_update_available`

```yaml
- name: "Docker"
  id: "server-docker"
  type: "containers"
  interval: 1m
  runtime: "docker"
  expect_running:
    - "nginx"
    - "postgres"
  update_check_interval: 6h
  update_warning: false
  registries:
    registry.example.com:5000:
      username: "robot"
      password_command: "cat /run/secrets/registry-password"
  ssh_config:
    host: "server.example.com"
```

---

### `command`
The generic escape hatch: runs an arbitrary command over SSH and derives status from it, for checks that don't warrant a dedicated plugin. Two modes:

- **Exit-code mode** (no `pattern`): exit `0` → online, non-zero → failed (or warning with `nonzero_is_warning: true`).
- **Pattern mode** (`pattern` set): a regex with one capture group extracts a number from stdout, stored as the `value` metric and charted, then compared against `warning`/`threshold` — same semantics as the numeric plugins. Set `invert: true` when *lower* is worse (e.g. free space, days-until-expiry).

Every run is wrapped in `timeout` so a hung target can't stall the polling loop.

| Option              | Description                                                              |
|---------------------|--------------------------------------------------------------------------|
| `command`           | Shell command to run on the target *(required)*                         |
| `timeout`           | Per-run timeout in seconds (default: `30`)                              |
| `pattern`           | *(Optional)* Regex with one capture group extracting a number           |
| `warning` / `threshold` | Value bounds, each optional (pattern mode only)                     |
| `invert`            | If true, values *below* the bounds are bad (default: `false`)           |
| `nonzero_is_warning`| Treat non-zero exit as warning instead of failed (default: `false`)     |
| `value_label` / `value_unit` | UI label / unit suffix for the extracted value                 |
| `ssh_config`        | SSH connection details — see [SSH Config](#ssh-config) below            |

**Metrics**: `exit_code` (always); `value` (pattern mode)

```yaml
# Pattern mode: TLS cert expiry, fewer days left is worse
- name: "Cert Expiry"
  id: "server-cert"
  type: "command"
  interval: 6h
  command: 'echo "days=$(( ($(date -d "$(openssl x509 -enddate -noout -in /etc/ssl/cert.pem | cut -d= -f2)" +%s) - $(date +%s)) / 86400 ))"'
  pattern: 'days=(-?\d+)'
  warning: 21
  threshold: 7
  invert: true
  value_label: "DAYS LEFT"
  value_unit: " d"
  ssh_config:
    host: "server.example.com"

# Exit-code mode: a failing backup script -> warning
- name: "Nightly Export"
  id: "server-export"
  type: "command"
  interval: 1h
  command: "/usr/local/bin/check-export"
  nonzero_is_warning: true
  ssh_config:
    host: "server.example.com"
```

A pending reboot has its own monitor type, [`reboot_required`](#reboot_required), which knows each distro's check.

---

### `filesystems`
Auto-discovers and monitors **every** mounted filesystem on the target over SSH via a single `df` call — no per-path configuration. This is the fleet-wide counterpart to [`disk_space`](#disk_space) (which watches one explicit path). Pseudo/virtual filesystems (tmpfs, proc, cgroup, overlay, …) are excluded so only real storage appears. Overall status is the worst usage across all filesystems.

| Option       | Description                                                  |
|--------------|--------------------------------------------------------------|
| `warning`    | Usage % that triggers warning (default: `80`)               |
| `threshold`  | Usage % that triggers failed (default: `90`)                |
| `exclude_mounts` | Mountpoints to leave out, along with everything mounted beneath them — for images that are read-only or full by design |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `worst_used_pct`; `fs_<mount>_used_pct`, `fs_<mount>_size_gb` per filesystem

```yaml
- name: "Filesystems"
  id: "server-filesystems"
  type: "filesystems"
  interval: 5m
  warning: 80
  threshold: 90
  ssh_config:
    host: "server.example.com"
```

---

### `folders`
Monitors the size of arbitrary directories over SSH via `du` — for watching things a filesystem check can't see: a growing log directory, a download spool, a media library nearing a soft cap. Each folder may set its own `warning`/`threshold` (in GB); a folder with neither is size-only. A folder that can't be read (missing/permission/timeout) is unmeasured and reports `unavailable`, unless another folder measured `warning` or `failed`.

| Option     | Description                                                                 |
|------------|-----------------------------------------------------------------------------|
| `folders`  | List of `{ path, warning?, threshold? }` — warning/threshold are sizes in GB |
| `timeout`  | Per-`du` timeout in seconds (default: `60`)                                 |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below              |

**Metrics**: `worst_folder_gb`; `folder_<path>_gb` per folder

The `folders` card draws one meter per folder, scaled to the largest folder at each refresh.

```yaml
- name: "Folders"
  id: "server-folders"
  type: "folders"
  interval: 1h
  folders:
    - path: "/var/log"
      warning: 5
      threshold: 10
    - path: "/srv/media"   # size-only
  ssh_config:
    host: "server.example.com"
```

---

### `vms`
Monitors libvirt/KVM virtual machines over SSH via `virsh list --all`, counting running vs. off. Domains in an error state (paused, crashed) drive warning; "shut off" is treated as benign. Named domains in `expect_running` are required — any not running drives status to **failed** and exposes a per-VM **Running** toggle button that starts or shuts it down (restricted to listed domains for safety). `virsh shutdown` only asks the guest to stop, so the button can show the VM running until a later poll sees it off.

| Option           | Description                                                       |
|------------------|-------------------------------------------------------------------|
| `uri`            | libvirt connection URI (default: `qemu:///system`)               |
| `expect_running` | *(Optional)* Domain names that must be running (→ Running toggle) |
| `offline_warning`| Any error-state domain => warning (default: `true`)              |
| `ssh_config`     | SSH connection details — see [SSH Config](#ssh-config) below      |

**Metrics**: `vms_total`, `vms_running`, `vms_stopped`, and `vm_running_<name>` (1/0) for each domain in `expect_running`

```yaml
- name: "Virtual Machines"
  id: "server-vms"
  type: "vms"
  interval: 1m
  expect_running:
    - "web"
  ssh_config:
    host: "server.example.com"
```

---

### `host_control`
A host's power and boot controls, one monitor per host. It shows the current power profile and the ones available, the boot entries with the default and the one-shot next-boot entry, and whether the host can suspend, and offers the actions below. It is a control surface rather than a health check: it is **online** whenever the host answers, and a host without one of the tools simply shows that control as `n/a`.

What it reads, and from where:

| Control | Read with | Fallbacks |
|---------|-----------|-----------|
| Power profile | `powerprofilesctl list` (power-profiles-daemon) | `tuned-adm list`, then `/sys/firmware/acpi/platform_profile` |
| Boot entries | `bootctl list --json=short` (systemd-boot), with the one-shot entry from the `LoaderEntryOneShot` EFI variable | `grub-editenv list` plus the `menuentry` titles in `grub.cfg` (GRUB), then `efibootmgr` (`BootOrder` / `BootNext`) |
| Suspend | `/sys/power/state` (`mem` or `freeze`) | — |

**Every action is off** unless it is listed under `allow:`. The dashboard only shows the buttons of allowed actions, and asks for confirmation, naming the host, before each one. An action that is not allowed is refused and logged (`… refused: not in allow`); every attempt, allowed or refused, is logged to the monitor's events with the action and its outcome.

| Action | `allow:` name | Runs |
|--------|---------------|------|
| Reboot | `reboot` | `sudo -n systemctl reboot` |
| Shut Down | `shutdown` | `sudo -n systemctl poweroff` |
| Suspend | `suspend` | `sudo -n systemctl suspend` (shown only when the host can suspend) |
| Power Profile | `power_profile` | `powerprofilesctl set <profile>`, `tuned-adm profile <profile>`, or writes `platform_profile` through `tee`, each through `sudo -n` |
| Next Boot | `next_boot` | `bootctl set-oneshot <entry>`, `grub-reboot <entry>` (`grub2-reboot` on Fedora-style hosts), or `efibootmgr --bootnext <entry>`, through `sudo -n`; with **Reboot now** ticked (offered only when `reboot` is allowed too) it reboots straight afterwards |
| Identify / Stop Identify | `identify` | `ledctl locate=<identify_device>` / `ledctl locate_off=<identify_device>`, or with `identify_method: beep`, `beep -r 5`, falling back to a bell on `/dev/console` |

Reboot, shutdown and suspend take the host away mid-command, so a connection that drops after the command was sent counts as success; a host that could not be reached at all is a failure. The SSH connection is re-dialled on the next poll, and an agent reconnects by itself when the host is back.

| Option            | Description |
|-------------------|-------------|
| `allow`           | Actions to offer: any of `reboot`, `shutdown`, `suspend`, `power_profile`, `next_boot`, `identify` (default: none) |
| `privilege`       | `sudo` (default) runs each action as `sudo -n …`, which fails at once with a clear message instead of waiting for a password; `none` runs it as the SSH or agent user, for a root login or a polkit rule |
| `identify_method` | `ledctl` (default when `identify_device` is set) or `beep` (the default otherwise) |
| `identify_device` | The drive whose enclosure LED `ledctl` blinks, e.g. `/dev/sda` |
| `ssh_config`      | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `power_profiles`, `boot_entries`, `suspend_supported` (1/0)

```yaml
- name: "host1 control"
  id: "host1-control"
  type: "host_control"
  interval: 5m
  allow: [reboot, shutdown, suspend, power_profile, next_boot, identify]
  identify_device: "/dev/sda"
  ssh_config:
    host: "host1"
```

With `privilege: sudo`, the X-Monitor user needs passwordless sudo for exactly the commands it runs, and nothing else. Keep only the lines for the actions you allow; boot-entry reads fall back to running unprivileged, so their lines are needed only where the ESP or `grub.cfg` is root-only. Command paths vary by distribution (`command -v systemctl` on the host shows yours), and sudo matches the arguments exactly:

```
# /etc/sudoers.d/x-monitor — edit with: visudo -f /etc/sudoers.d/x-monitor
x-monitor ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/systemctl suspend
x-monitor ALL=(root) NOPASSWD: /usr/bin/powerprofilesctl set *, /usr/sbin/tuned-adm profile *
x-monitor ALL=(root) NOPASSWD: /usr/bin/tee /sys/firmware/acpi/platform_profile
x-monitor ALL=(root) NOPASSWD: /usr/bin/bootctl list --json=short, /usr/bin/bootctl set-oneshot *
x-monitor ALL=(root) NOPASSWD: /usr/bin/cat /boot/grub/grub.cfg, /usr/bin/cat /boot/grub2/grub.cfg, /usr/sbin/grub-reboot *, /usr/sbin/grub2-reboot *
x-monitor ALL=(root) NOPASSWD: /usr/bin/efibootmgr --bootnext *
x-monitor ALL=(root) NOPASSWD: /usr/sbin/ledctl locate=/dev/sda, /usr/sbin/ledctl locate_off=/dev/sda
x-monitor ALL=(root) NOPASSWD: /usr/bin/beep -r 5, /usr/bin/tee /dev/console
```

A `*` lets the profile or boot entry vary, which is safe here because X-Monitor only ever passes a name it read from the host, shell-quoted. On NixOS the same rule goes in the system configuration, with the store paths of the system profile:

```nix
security.sudo.extraRules = [{
  users = [ "x-monitor" ];
  commands = map (command: { inherit command; options = [ "NOPASSWD" ]; }) [
    "/run/current-system/sw/bin/systemctl reboot"
    "/run/current-system/sw/bin/systemctl poweroff"
    "/run/current-system/sw/bin/systemctl suspend"
    "/run/current-system/sw/bin/powerprofilesctl set *"
    "/run/current-system/sw/bin/bootctl list --json=short"
    "/run/current-system/sw/bin/bootctl set-oneshot *"
    "/run/current-system/sw/bin/ledctl locate=/dev/sda"
    "/run/current-system/sw/bin/ledctl locate_off=/dev/sda"
  ];
}];
```

GRUB's one-shot entry (`grub-reboot`) only takes effect when the host's GRUB config has `GRUB_DEFAULT=saved`.

---

### `cloud`
Detects the cloud provider of the target and surfaces its instance metadata (id, type, region/zone) over SSH via the link-local metadata endpoint (`169.254.169.254`). Auto-detects across AWS (IMDSv2), GCP, and Azure, or query one provider explicitly. Informational — no thresholds; reports online when metadata is reachable, unavailable when the host isn't on a recognized cloud.

| Option       | Description                                                   |
|--------------|--------------------------------------------------------------|
| `provider`   | `auto` (default), `aws`, `gcp`, or `azure`                   |
| `ssh_config` | SSH connection details — see [SSH Config](#ssh-config) below |

**Metrics**: `on_cloud` (1 = on a recognized cloud, 0 = not)

```yaml
- name: "Instance Metadata"
  id: "server-cloud"
  type: "cloud"
  interval: 15m
  provider: "auto"
  ssh_config:
    host: "server.example.com"
```

---

### `x_monitor_self`
X-Monitor watching itself: its own memory, CPU and uptime, whether every other monitor is collecting on schedule, and how long each one's collection takes.

A **late** monitor has gone `stale_warning` intervals without finishing a cycle, and a **stalled** one `stale_threshold` intervals. A **slow** monitor's recent cycles take, on average, more than `slow_cycle_fraction` of its interval, or more than `slow_cycle_seconds` when that is set.

The page lists every monitor's last, average and longest cycle over its last 20 cycles, slowest first, with how long its SSH commands waited for a free channel. That wait is time spent queued behind other monitors on the same host at the `MaxSessions` ceiling (see [SSH Config](#ssh-config)), so a monitor that is slow because of the wait needs fewer neighbours or the agent, not a faster target.

| Option                | Description                                                                     |
|-----------------------|---------------------------------------------------------------------------------|
| `memory_warning`      | RSS in MB that sets warning (default: `256`)                                   |
| `memory_threshold`    | RSS in MB that sets failed (default: `512`)                                    |
| `stale_warning`       | Intervals overdue before a monitor counts as late, a warning (default: `6`)    |
| `stale_threshold`     | Intervals overdue before a monitor counts as stalled, a failure (default: `10`) |
| `slow_cycle_fraction` | Share of its interval a monitor's average cycle may take before it counts as slow, a warning (default: `0.5`; `0` turns it off) |
| `slow_cycle_seconds`  | Seconds a monitor's average cycle may take before it counts as slow (default: `0`, off) |

**Metrics**: `memory_mb`, `cpu_pct`, `uptime_seconds`, `monitors_total`, `monitors_late`, `monitors_stalled`, `monitors_slow`, `slowest_cycle_seconds`

```yaml
- name: "X-Monitor"
  id: "x-monitor"
  type: "x_monitor_self"
  interval: 60
  slow_cycle_seconds: 20
```

---

### `group`
A logical container for other monitors. Aggregates the worst-case status of all descendants, and renders them one of two ways: as **collapsible cards**, one per child, or — when the group declares a `layout:` — as a **composite layout** built out of individual widgets pulled from its children.

| Option          | Description                                                                                     |
|-----------------|-------------------------------------------------------------------------------------------------|
| `children`      | A list of nested plugin definitions, or links (`ref: <id>`, optional `name`) to monitors defined elsewhere — see [Links](../README.md#links) |
| `layout`        | Rows of widget references. Present ⇒ composite layout; absent ⇒ collapsible cards.               |
| `grid_min_width`| Card mode only: minimum width of a child card before it wraps (default: `"320px"`)               |

Groups can be nested to arbitrary depth. **Poll Now** on a group polls every descendant first, then re-aggregates from their fresh statuses.

#### Card mode (default)

Each child is a collapsible card. Expansion state is preserved across page refreshes within the same server session. Each child entry can set:

| Child Option     | Description                                                                                  |
|------------------|------------------------------------------------------------------------------------------------|
| `grid_col_span`  | How many card widths this child occupies (default: `1`)                                       |
| `grid_height`    | Explicit CSS height for the child cell, e.g. `"400px"` (default: auto). Adds a scrollbar if content overflows. |
| `grid_min_width` | Overrides the group's `grid_min_width` for this child                                         |

```yaml
- name: "System Stats"
  type: "group"
  children:
    - name: "Ragnarok System"
      type: "group"
      children:
        - name: "CPU"
          type: "cpu"
          ...

# Child spanning two card widths
- name: "Overview"
  type: "group"
  children:
    - name: "Processes"
      type: "processes"
      grid_col_span: 2
      grid_height: "600px"
      ...
```

#### Composite mode

Give the group a `layout:` and it stops wrapping children in cards: it builds its own rows of cells and renders **one widget of one child** into each. Any widget of any descendant can be shown, hidden, resized or retitled, so cards, charts and tables from different monitors can share a row.

A cell names its widget as `"<child_id>.<widget_name>"` — the same widget names listed under [Plugin Layout](#plugin-layout). A child's id is its `id:` if set, otherwise its `name:`, so give a child an explicit `id` before referencing it (a `name` containing a dot is ambiguous). Nested groups are reachable too: a layout may address any descendant, at any depth, not just direct children.

Three refs are special:

| Ref form            | Renders                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------|
| `"<child_id>.<widget>"` | One widget of that child                                                                  |
| `"<child_id>.status"`   | A status card the group itself draws (child name + live state), for children that declare no `status_card` of their own |
| `"<child_id>"`          | The whole child, laid out by its own default layout — the escape hatch for `systemd_service` and nested groups, whose hand-written UIs have no addressable widgets |

Widgets a layout does not name are never built, so a composite page costs only what it shows. Each cell accepts the same per-widget properties as a plugin layout (`flex`, `height`, `min_width`, `visible`), plus `title`, which overrides the widget's own heading — the way to tell two hosts' CPU cards apart.

```yaml
- name: "Fleet Overview"
  type: "group"
  layout:
    # One row: both hosts' status, then both CPU cards side by side.
    - - "ragnarok.status"
      - "heimdall.status"
      - widget: "ragnarok-cpu.cpu_card"
        title: "RAGNAROK CPU"
      - widget: "heimdall-cpu.cpu_card"
        title: "HEIMDALL CPU"
    # One row: the two CPU charts, each half the width.
    - - widget: "ragnarok-cpu.cpu_chart"
        height: "300px"
      - widget: "heimdall-cpu.cpu_chart"
        height: "300px"
    # One row: a wide table beside a narrow card.
    - - widget: "ragnarok-procs.table"
        flex: 3
      - "ragnarok-procs.count_card"
    # A monitor with a hand-written UI, rendered whole under a heading.
    - - widget: "nginx"
        title: "Nginx"
  children:
    - name: "Ragnarok"
      id: "ragnarok"
      type: "uptime"
      target_host: "ragnarok.lan"
    - name: "Ragnarok CPU"
      id: "ragnarok-cpu"
      type: "cpu"
      ssh_config:
        host: "ragnarok.lan"
    - name: "Nginx"
      id: "nginx"
      type: "systemd_service"
      service_name: "nginx.service"
      ssh_config:
        host: "ragnarok.lan"
```

A ref naming a child or widget that does not exist renders nothing and is logged as a warning at startup of the page.

---

### Plugin Layout

Every plugin with a declarative UI supports a `layout:` key controlling how its widgets are arranged on its detail page. Without one the plugin uses its built-in default (its `_DEFAULT_LAYOUT`).

A layout is a list of **rows**; each row is a list of widgets sharing that row, laid out as flex cells that wrap when they run out of width. An entry is either a bare widget name or a mapping with these keys:

| Per-widget option | Description                                                                                         |
|-------------------|-------------------------------------------------------------------------------------------------------|
| `widget`          | The widget name (required in mapping form)                                                          |
| `flex`            | Share of the row's width relative to its siblings (default: `1`)                                    |
| `min_width`       | Width below which the cell wraps to its own line (default: `"280px"`)                               |
| `height`          | Explicit CSS height for this cell, e.g. `"400px"`. Adds a scrollbar on overflow (default: auto).     |
| `visible`         | `false` to hide the widget (default: `true`)                                                        |

The same keys can instead be given as a **mapping of widget name → properties**, which keeps the plugin's default rows and only overrides the named widgets — the usual way to hide a panel or make one chart taller.

**Widget names by plugin type:**

| Plugin             | Widget names                                                                 |
|--------------------|------------------------------------------------------------------------------|
| `uptime`           | `host_card`, `status_card`, `latency_card`, `wake` (with `mac`), `uptime_strip`, `chart`, `events` |
| `systemd_service`  | hand-written UI — not individually addressable                              |
| `cpu`              | `host_card`, `cpu_card`, `cores`, `cpu_chart`, `events`                     |
| `memory`           | `host_card`, `mem_pct_card`, `mem_used_card`, `memory_chart`, `events`      |
| `load`             | `host_card`, `load_1m_card`, `load_chart`, `events`                         |
| `temperature`      | `host_card`, `temp_card`, `sensors`, `temp_chart`, `events`                 |
| `interrupts`       | `host_card`, `irq_card`, `ctxt_card`, `irq_chart`, `ctxt_chart`, `events`   |
| `gpu`              | `host_card`, `gpu_util_card`, `gpu_mem_card`, `gpu_temp_card`, `gpus`, `gpu_chart`, `events` |
| `oom`              | `host_card`, `oom_total_card`, `oom_recent_card`, `oom_chart`, `events`     |
| `throughput`       | `host_card`, `iface_card`, `rx_card`, `tx_card`, `rx_chart`, `events`       |
| `connections`      | `host_card`, `conn_total_card`, `conn_states_card`, `conn_total_chart`, `events` |
| `wifi`             | `host_card`, `wifi_iface_card`, `quality_card`, `signal_card`, `quality_chart`, `signal_chart`, `events` |
| `power`            | `host_card`, `charge_card`, `power_card`, `state_card`, `health_card`, `capacity_card`, `batteries`, `charge_chart`, `capacity_chart`, `events` |
| `smart`            | `host_card`, `smart_total_card`, `smart_failed_card`, `smart_disk_tiles`, `events` |
| `zfs`              | `host_card`, `zfs_total_card`, `zfs_degraded_card`, `zfs_pool_tiles`, `zfs_pools`, `zfs_chart`, `events` |
| `md`               | `host_card`, `md_total_card`, `md_degraded_card`, `md_array_tiles`, `events` |
| `disk_io`          | `host_card`, `io_device_card`, `read_card`, `write_card`, `read_chart`, `events` |
| `processes`        | `host_card`, `count_card`, `top_cpu_card`, `table`, `logs`                  |
| `disk_space`       | `host_card`, `path_card`, `threshold_card`, `usage_card`, `avail_card`, `total_card`, `chart`, `logs` |
| `folders`          | `host_card`, `count_card`, `folders`, `events`                              |
| `freshrss`         | `host_card`, `refresh_card`, `feeds_card`, `stale_card`, `share_card`, `chart`, `events` |
| `qbittorrent`      | `host_card`, `connection_card`, `speed_card`, `torrents_card`, `stalled_card`, `errored_card`, `share_card`, `chart`, `events` |
| `frigate`          | `host_card`, `state_card`, `fps_card`, `detector_card`, `armed_card`, `camera_bars` (fps per camera against its detect fps), `chart`, `events` |
| `syncthing`        | `host_card`, `folders_card`, `devices_card`, `errors_card`, `need_card`, `stalled_card`, `folder_tiles` (state per folder), `chart`, `events` |
| `traccar`          | `host_card`, `stale_card`, `devices_card`, `device_bars` (hours since each device last reported, to twice `stale_threshold`), `chart`, `events` |

Any other plugin's names are the keys of its `UI_SPEC` `cards`, `charts` and `tables`, plus `events`, `logs`, `jobs` and `host_card` where it has them.

**Examples:**

```yaml
# Overrides only: keep the default rows, make the chart taller, hide the logs.
- name: "Ragnarok CPU"
  type: "cpu"
  layout:
    cpu_chart:
      height: "500px"
    logs:
      visible: false

# Full replacement: two stat cards on one row, a double-width chart below.
- name: "Heimdall Memory"
  type: "memory"
  layout:
    - - "host_card"
      - "mem_pct_card"
      - "mem_used_card"
    - - widget: "memory_chart"
        height: "400px"
```

---

### SSH Config

All SSH-based plugins (`systemd_service`, `cpu`, `smart`, `disk_space`, `throughput`, …) accept an `ssh_config` block:

| Field        | Description                                                         |
|--------------|---------------------------------------------------------------------|
| `host`       | Remote hostname or IP address                                       |
| `user`       | SSH username (defaults to the current OS user if omitted)           |
| `port`       | SSH port (default: `22`)                                            |
| `key_file`   | Path to a private key file (uses the SSH agent / default key if omitted) |

```yaml
ssh_config:
  host: "myhost.example.com"
  user: "x-monitor"
  port: 22
  key_file: "/home/x_monitor/.ssh/id_ed25519"
```

X-Monitor speaks SSH natively (AsyncSSH) rather than shelling out to the system
`ssh` client, and opens one persistent connection per host — every SSH-based
monitor on that host runs its commands as a channel on that one connection
rather than a separate connection each. Host key verification is
trust-on-first-use: the first successful connection to a host stores its key
(under `$XMONITOR_SSH_CONTROL_DIR/known_hosts`, defaulting to a `x-monitor-ssh`
directory under the system temp dir), and every later connection is checked
against it — a changed key is refused rather than silently accepted.

**The number of monitors you can point at one host is bounded by how many
concurrent SSH sessions that host's `sshd` allows** (`MaxSessions` in
`sshd_config`, default `10`). X-Monitor caps its own concurrency per host below
that default (8 regular monitors + 2 for long-running jobs like `borg`, at
most 10 total in flight at once), so a host running its `sshd` at the
OpenSSH default is safe by construction — extra monitors queue rather than
fail. Hosts with many monitors, or where jobs may overlap with a burst of
polling, benefit from raising `MaxSessions` in that host's own `sshd_config`
(e.g. `MaxSessions 50`) to reduce queuing — or from running the
[agent](agent.md) on that host, where commands are frames multiplexed on one
socket and no session ceiling applies.

---

### Out-of-tree plugins

A monitor type X-Monitor does not ship can live in a directory of your own, named under `plugin_paths:` in `config.yaml`. A relative path is taken from the directory `config.yaml` is in.

```yaml
plugin_paths:
  - /etc/x-monitor/plugins            # searched in order; the first directory holding the type wins
  - path: ./my-plugins
    override: true                # its plugins replace X-Monitor's own of the same name

plugins:
  - name: "Weather"
    id: "weather"
    type: "weather"               # /etc/x-monitor/plugins/weather.py, or a weather/ package
```

A plugin type `<type>` is either `<type>.py` or a package directory `<type>/` with an `__init__.py`. The module must define exactly one concrete `Plugin` subclass (classes it imports, such as `Plugin` or `SignalPlugin`, do not count), written the same way as X-Monitor's own plugins: pure `commands()`/`parse()` or `requests()`/`parse_results()` returning a `CollectResult`, with the page described by a `UI_SPEC`.

```python
from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import Command, CollectResult


class Weather(Plugin):
    def commands(self):
        return [Command('curl -s wttr.in/?format=%t')]

    def parse(self, results):
        ok = results[0].exit_code == 0
        return CollectResult(status='online' if ok else 'failed', logs=[(results[0].stdout, 'INFO')])
```

A name X-Monitor already uses stays X-Monitor's: the file is ignored with a warning in the log, unless its `plugin_paths` entry says `override: true`, which is logged too. A missing type, or a module that defines no `Plugin` class or more than one, stops only that monitor from loading, with the reason in the log. An edited plugin file is read again on the next config reload, and takes effect for the monitors that reload adds or changes; the rest keep running the code they started with until a restart.
