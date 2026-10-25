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

## Authentication

By default the dashboard and REST API are unauthenticated — anyone who can reach the port has full read access and can trigger control actions. Set `auth.username` and `auth.password` (or `auth.password_file`, to keep the secret out of the YAML config) to put every route behind a sign-in page:

```yaml
auth:
  username: "admin"
  password_file: "/run/secrets/x_monitor_dashboard_password"
  # Optional — sign a session with a fixed key so restarts do not sign everyone
  # out. Without it a key is generated per start.
  session_secret_file: "/run/secrets/x_monitor_session_secret"
  session_hours: 12      # How long a sign-in lasts (default 12)
  remember_days: 30      # How long "keep me signed in" lasts (default 30)
```

An unauthenticated browser is redirected to `/login`, where it exchanges the credentials for a signed, expiring session cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` when X-Monitor is reached over HTTPS — including behind a reverse proxy that sets `X-Forwarded-Proto`). "Keep me signed in" is what makes the cookie outlive the browser session. The dashboard header gains an account menu with **Sign out**, which drops the session at `/logout`. Repeated failures from one address are throttled after five attempts in five minutes.

Scripts and scrapers cannot follow a form redirect, so `/api/...` and `/metrics` also accept HTTP Basic credentials — the same username and password — and answer `401` rather than redirecting. No `WWW-Authenticate` header is sent, so a browser never sees the native credential dialog. `/api/push/...` stays public to the gate; it checks a per-monitor token or a push-scoped API token itself.

Every `*_file` value is read once at startup. If only one of `username`/`password` is set, auth stays disabled and a warning is logged.

### API tokens

Rather than hand the operator password to every scraper and script, give each client its own named token. Mint one with:

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

| Scope | Reaches |
|-------|---------|
| `read` | `GET` on `/api/...` and `/metrics` |
| `control` | Everything `read` does, plus the API's write routes: poll now, run a monitor's action, send a test notification |
| `push` | `/api/push/{id}` for the monitors in `monitors`, or every push monitor when it is absent |

A token never opens the dashboard itself — that stays behind the sign-in page. A token with the wrong scope for a route gets `403`, and an unknown one `401`. Each action taken with a token is written to the monitor's events and the log under the token's name, so the audit trail shows which client acted; revoking a client means deleting its entry and restarting. `token: "..."` in plain text also works, but logs a warning. Read and control tokens need `username`/`password` to be set, since without them the API is open anyway; push tokens work either way.

For Prometheus, set `authorization: {credentials_file: /run/secrets/x_monitor_scrape_token}` on the scrape job.

## While it runs

Editing `config.yaml` takes effect while X-Monitor runs: the change is picked up within a few seconds, or at once with `kill -HUP`, `POST /api/config/reload`, or **Reload config** in the dashboard's **System** menu. Unchanged monitors keep running and keep their connections; added, removed and changed ones start, stop or restart; and a file that does not load whole is refused, leaving the running config in place. The events feed records what each reload did, including any setting (`database`, `memory`, `auth`, `theme`) that only takes effect on restart.

Logging verbosity can change while X-Monitor runs, for the whole process or one module: from the dashboard's **System** menu (**Log levels**), through `POST /api/log-levels` (see [integrations](integrations.md#runtime-control)), or, when the dashboard is unreachable, with `kill -USR1` (one step more verbose) and `kill -USR2` (one step quieter). `logging.level` and `logging.levels` in `config.yaml` set the starting values.

## Dashboard only

To run just the dashboard against an existing database:

```bash
x-monitor-gui --db x-monitor.db --port 8080
```
