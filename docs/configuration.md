# Configuration

Every monitor type and its keys are in the [plugin reference](plugins.md); agents are in the [agent guide](agent.md).

X-Monitor uses a YAML file to define the hierarchy of your infrastructure. The YAML config is the **source of truth** for infrastructure definitions; SQLite is used for runtime state and overrides.

```yaml
database:
  path: "x-monitor.db"

plugins:
  - name: "Internal Network"
    type: "group"
    children:
      - name: "Core Gateway"
        id: "gateway-ping"
        type: "uptime"
        target_host: "192.168.1.1"
        interval: 30

  - name: "Web Servers"
    type: "group"
    children:
      - name: "Nginx Service"
        type: "systemd_service"
        service_name: "nginx.service"
        ssh_config:
          host: "web-01.example.com"
          user: "x-monitor"
```

## Links

Monitors form a graph rather than a strict tree. A monitor is **defined** once,
where its config nests it, and any other group can hold it too through a
**link**: an entry with `ref:` set to the monitor's id. A link may carry its own
`name`, which labels that one place; the monitor keeps a single id, status,
history and page however many groups hold it.

That lets one tree show the same monitors several ways, each under its own root:

```yaml
plugins:
  - name: "By host"
    id: "by-host"
    type: "group"
    children:
      - name: "Heimdall"
        id: "heimdall"
        type: "group"
        children:
          - name: "Availability"
            id: "heimdall-up"
            type: "uptime"
            target_host: "heimdall.lan"

  - name: "By domain"
    id: "by-domain"
    type: "group"
    children:
      - name: "Availability"
        id: "availability"
        type: "group"
        children:
          - ref: "heimdall-up"
            name: "Heimdall"
```

A group's status is the worst of everything it holds, links included, unless
its `aggregate` setting says otherwise (`best`, or `{quorum: n}`). Any monitor,
not only a group, can hold `children`: its page shows them under its own, and
polling it polls them first. Muting a
group or covering it with a maintenance window reaches every monitor beneath
it, linked or defined, while `notify:` settings pass down only to the monitors a
group defines, so each monitor has one notification rule wherever it is shown.
A link must sit inside a group; one at the top level, one to an unknown id, or
one that would put a group inside itself is logged and ignored.

Every monitor type, its config keys, and its `ssh_config` / layout options are
documented in the [plugin reference](plugins.md). Agent declaration and
installation are covered in the [agent guide](agent.md). A plugin type of your own can live in a directory outside X-Monitor, named under `plugin_paths:` (see [out-of-tree plugins](plugins.md#out-of-tree-plugins)).

## Signing in

With no user configured, the dashboard and API are open: anyone who can reach the port can read everything and run actions. Declare a user and every route goes behind X-Monitor's sign-in page:

```yaml
auth:
  username: "admin"                                            # lower-cased; letters, digits, '.', '_' or '-'
  password_file: "/run/secrets/x_monitor_dashboard_password"   # or password:
  session_hours: 12      # how long a sign-in lasts (default 12)
  remember_days: 30      # how long "Keep me signed in" lasts (default 30)
```

`auth.username` with `password` or `password_file` declares one admin. More admins come from an accounts file of `name:hash` lines named by `X_MONITOR_PASSWORD_HASH_FILE`; `npm run hash-password [name]` asks for a password and writes the line there, or prints it when the variable is unset. Single sign-on is set up with the `X_MONITOR_OIDC_*` variables. If only one of `username` and `password` is set, that account is not enabled and an error is logged. `auth.session_secret` is ignored, since sessions are kept in the state database.

Signing in opens a session kept in the state database: with "Keep me signed in" unticked it ends with the browser or after `session_hours`, and ticked it lasts `remember_days`. A user can add a second factor (an authenticator app), see their sessions and **Sign out** of them under **Your account**. An admin manages users under **Users**, each with a role:

| Role | May |
|------|-----|
| `viewer` | Read everything and change nothing |
| `operator` | Also poll, run actions and send test notifications |
| `admin` | Also manage users and the state backups |

Without a session or a token, the API answers `401` instead of showing the sign-in page; HTTP Basic credentials are not accepted. `/api/push/...` checks its own per-monitor or push token, and the agent socket checks the agent's key.

### API tokens

Rather than share a password with every scraper and script, give each client its own token. A signed-in user makes one under **Your account**, or a token can be declared in the config. Mint one to declare with:

```bash
x-monitor token new prometheus --scope read
```

It prints the token once and the entry to add under `auth:`. X-Monitor keeps only the token's SHA-256 hash:

```yaml
auth:
  username: "admin"
  password_file: "/run/secrets/x_monitor_dashboard_password"
  tokens:
    - name: "prometheus"
      scope: read
      token_hash: "sha256:…"   # as printed by x-monitor token new
    - name: "ops-laptop"
      scope: control
      token_file: "/run/secrets/x_monitor_ops_token"   # the token itself, hashed at startup
    - name: "backup-jobs"
      scope: push
      token_hash: "sha256:…"
      monitors: ["nightly-backup", "weekly-backup"]   # omit for every push monitor
```

A client sends `Authorization: Bearer <token>`. The scopes are:

| Scope | Acts as |
|-------|---------|
| `read` | A viewer: reads on `/api/...` and `/metrics` |
| `control` | An operator: also poll now, run a monitor's action, send a test notification |
| `push` | `/api/push/{id}` for the monitors in `monitors`, or every push monitor when it is absent; it signs nothing else in, so it gets `401` anywhere else |

A token never opens the dashboard itself, which stays behind the sign-in page. A token with too little for a route gets `403`, and an unknown one `401`. Each action taken with a token is written to the monitor's events and the log under the token's name, so the audit trail shows which client acted. Declared tokens are read at startup, so revoking one means deleting its entry and restarting. `token: "..."` in plain text also works, but logs a warning. Read and control tokens need a user to be configured, since without one the API is open anyway; push tokens work either way.

For Prometheus, set `authorization: {credentials_file: /run/secrets/x_monitor_scrape_token}` on the scrape job.

## While it runs

Editing `config.yaml` takes effect while X-Monitor runs: the change is picked up within a few seconds, or at once with `kill -HUP`, `POST /api/config/reload`, or **Reload config** in the dashboard's **System** menu. Unchanged monitors keep running and keep their connections; added, removed and changed ones start, stop or restart; and a file that does not load whole is refused, leaving the running config in place. The events feed records what each reload did, including any setting (`database`, `memory`, `auth`, `theme`) that only takes effect on restart.

Logging verbosity can change while X-Monitor runs, for the whole process or one module: from the dashboard's **System** menu (**Log levels**), through `POST /api/log-levels` (see [integrations](integrations.md#runtime-control)), or, when the dashboard is unreachable, with `kill -USR1` (one step more verbose) and `kill -USR2` (one step quieter). `logging.level` and `logging.levels` in `config.yaml` set the starting values.

## Running

```bash
x-monitor --config config.yaml          # or: nix run, or npm start in a checkout
```

`--config` names the config file (`config.yaml` by default); a JSON file loads the same way, since JSON is valid YAML. `--db` names the state database and overrides `database.path`. The server listens on every address on port 8080; `--host` and `--port`, or `X_MONITOR_HOST` and `X_MONITOR_PORT`, change that. In a checkout, `npm run dev:server` runs it on `config.example.json` and restarts it on every change.

## State backups

The state database is backed up daily into a `backups` folder beside it, keeping the last 14 by default. **Settings** lists the backups, takes one now, changes the schedule, and restores or deletes one. Everything but the list is an admin's, and X-Monitor restarts to take a restored backup in. The same is served at `/api/state-backups`.
