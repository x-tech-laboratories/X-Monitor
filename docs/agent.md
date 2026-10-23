# The X-Monitor Agent

The X-Monitor agent is a small daemon that runs on a monitored host, dials **outward** to
X-Monitor over a WebSocket, and holds that connection open. It needs no inbound port, no
certificate of its own, and no firewall rule — it reuses the dashboard's port, so a host
behind NAT works with no extra setup.

Agents that keep monitoring their host while cut off from X-Monitor are planned in
[offline-agents-plan.md](offline-agents-plan.md).

Two things travel on that one connection:

- **Commands** — the same shell command strings the SSH transport carried. Every monitor
  works over an agent unmodified, because both transports return the same
  `(exit_code, stdout, stderr)`.
- **Events** — sources the agent watches locally and pushes the instant they change. This
  is what a polled transport cannot do at any interval.

## Server config

Each agent has its own ed25519 key pair, with no passphrase:

```bash
ssh-keygen -t ed25519 -N "" -C web-01 -f web-01.key
```

`web-01.key` goes only to the monitored host, for example as a sops-nix secret. Declare each
agent that may connect with the contents of `web-01.key.pub`, then point monitors at it by id:

```yaml
agents:
  - id: "web-01"
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... web-01"
    host: "web-01.example.com"   # label only; X-Monitor never dials the agent

plugins:
  - name: "Web Servers"
    type: "group"
    agent: "web-01"              # inherited by every child below
    children:
      - name: "Nginx"
        type: "systemd_service"
        service_name: "nginx.service"
      - name: "Disk"
        type: "disk_space"
```

| Field   | Description                                                                 |
|---------|-----------------------------------------------------------------------------|
| `id`    | Agent identity; a monitor's `agent:` key refers to this                      |
| `public_key` | The agent's OpenSSH ed25519 public key, one line. It is not secret, so it can sit in a generated or world-readable `config.yaml` |
| `host`  | Display label for the target. Optional — defaults to the id                  |

On each connection X-Monitor sends the agent a fresh random nonce, and the agent signs it with its
private key. X-Monitor holds no agent secrets. An agent without a valid `public_key` can never
connect.

`agent:` on a group is inherited by every monitor beneath it, so moving a whole host
between transports is one line. A monitor with both `agent:` and `ssh_config:` uses the
agent; drop the `agent:` key to fall back to SSH.

## Installing the agent

```bash
pip install x-monitor            # ships the `x-monitor-agent` command
```

```yaml
# /etc/x-monitor-agent.yaml
url: "ws://x-monitor.example.com:8080/api/agent/ws"   # wss:// behind TLS
id: "web-01"
key_file: "/run/secrets/x_monitor_agent_key"
```

| Field        | Description                                                          |
|--------------|----------------------------------------------------------------------|
| `url`        | The server's agent endpoint. `wss://` when the dashboard is behind TLS |
| `id`         | Must match an `id` in the server's `agents:` list                     |
| `key_file`   | Path to the agent's unencrypted OpenSSH ed25519 private key (`ssh-keygen -t ed25519 -N ""`). Keep it with your secret manager, readable only by the agent's user |
| `hostname`   | Hostname reported to the server. Defaults to the machine's own         |

```bash
x-monitor-agent --config /etc/x-monitor-agent.yaml
```

Every setting can come from the environment instead (`XMONITOR_AGENT_URL`, `XMONITOR_AGENT_ID`,
`XMONITOR_AGENT_KEY_FILE`, `XMONITOR_AGENT_HOSTNAME`), so a systemd unit or container can run the
agent without a config file.

On NixOS the flake exports `nixosModules.agent` for the monitored host, alongside the
existing `nixosModules.default` for the server. The agent module defaults to
`packages.agent`, a standalone build carrying only what the agent imports — a monitored
host never builds nicegui, peewee, dnspython or asyncssh to run one:

```nix
services.x-monitor-agent = {
  enable = true;
  url = "ws://x-monitor.example.com:8080/api/agent/ws";
  id = "web-01";
  keyFile = config.sops.secrets.x_monitor_agent_key.path;
  extraGroups = [ "systemd-journal" ];      # for journal streams and unit logs
  path = [ pkgs.smartmontools ];            # tools the monitors' commands invoke
};
```

The agent runs unprivileged as `x-monitor-agent`. Grant that user the same scoped `NOPASSWD`
sudo rules the SSH user had — a narrow grant per command is a better posture than running
the agent as root.

The agent reconnects on its own with exponential backoff and jitter, so a server restart
needs no action on the host. A monitor whose agent is not currently connected reports
failed with an explicit message — the same way a refused SSH dial behaves — and recovers
by itself.

## Desktop notifications

An agent running in your graphical session can show X-Monitor's notifications on your desktop. It runs
as a separate agent with `notify_only: true`, which refuses commands. See
[notifications.md](notifications.md#desktop-notifications).

## Event streams

A plugin declares the streams it wants via `subscriptions()`; the server sends that set to
the agent on connect, and the agent watches them locally. Three watcher kinds ship today:

| Kind      | What it does                                                | Params |
|-----------|-------------------------------------------------------------|--------|
| `journal` | Follows the systemd journal and pushes matching entries as they are written | `unit`, `identifier`, `priority`, `kernel`, `grep` |
| `path`    | Pushes when a path's mtime or size changes                   | `path`, `interval` (default `0.25`) |
| `sample`  | Runs a command locally on a fast interval and pushes its output | `command`, `interval` (default `1.0`), `on_change` |

`path` and `sample` still sample — but *locally*, where a `stat()` or a fork costs
microseconds rather than an SSH round trip. That is what makes per-second resolution
practical without the target's `sshd` ever seeing it.

Two plugins use this today:

- **`oom`** follows the kernel journal for the OOM killer's own message. The polled
  `/proc/vmstat` counter still runs and remains the authority on totals, but a kill is now
  reported the moment it happens and carries the process name — which the counter cannot.
- **`systemd_service`** follows its unit's journal, so the log view is live rather than a
  snapshot of the last *n* lines taken up to `interval` ago, and a crash-restart loop
  between two polls is no longer invisible.

In both cases the **poll still owns status**. A streamed log line adds detail; it never
flips a monitor's state on its own.

## Agent vs SSH

| | Agent | SSH |
|---|---|---|
| Software on target | `x-monitor-agent` | none |
| Concurrency per host | unbounded (frames on one socket) | capped by the target's `MaxSessions` |
| Per-command cost | one local fork | SSH channel + fork |
| Detection latency | immediate, for subscribed streams | one `interval` |
| Works on appliances | no | yes |
| Privilege | whatever the commands need (same `sudo` rules) | whatever the commands need |

The agent does **not** change the privilege story: `smartctl` needs root either way, and
the same `NOPASSWD` rules apply. Run the agent as an unprivileged user with the same narrow
sudo grants the SSH user had rather than as root.
