"""TypedDict shapes for config.yaml, as returned by ConfigFileManager's
properties. Every field is optional (total=False): config.yaml has no
required top-level section (an empty file loads as {}, per
ConfigFileManager._load), and each consumer already defaults missing keys
via .get(). These types document the shape a present key must have; nothing
checks YAML against them at load. What the loader does check is structural
only — ConfigFileManager warns about an unknown top-level section, a section
written as the wrong kind of YAML, and a plugin or agent entry missing the key
that identifies it. Anything finer degrades as it always has: a per-field
try/except with a logged fallback, or a KeyError inside whichever module reads
the bad key.
"""

from typing import Any, Dict, List, TypedDict


class SSHConfig(TypedDict, total=False):
    """A plugin's `ssh_config` block, or the shared `ssh_defaults` merged
    into it by XMonitorEngine._apply_ssh_defaults (plugin-level keys win)."""
    host: str
    port: int
    username: str
    key_path: str
    password: str


class AgentSettings(TypedDict, total=False):
    """One entry in the top-level `agents:` list. The agent dials into the
    dashboard's port over a WebSocket and proves it holds the private half of
    `public_key`, an OpenSSH ed25519 public key line; `host` is only a
    display/label value, since the server never dials the agent."""
    id: str
    public_key: str
    host: str


class DatabaseSettings(TypedDict, total=False):
    path: str
    write_batch_seconds: float


class LoggingSettings(TypedDict, total=False):
    retention_days: int
    metric_retention_days: int
    metric_downsample_days: int
    cycle_timings: bool
    level: str                  # root log level at startup: DEBUG, INFO, WARNING, ERROR, CRITICAL
    levels: Dict[str, str]      # per-logger levels, e.g. {'x_monitor.core.connectors.ssh_connector': 'DEBUG'}


class MemorySettings(TypedDict, total=False):
    """How much history the in-memory state store keeps per stream. State is
    held in Python objects and served to the UI from there, so these bound
    how far back a chart/table can read without touching the database.
    Distinct from `logging.retention_days`, which bounds the database file."""

    metric_history: int
    event_history: int
    log_history: int
    job_output: int
    jobs_per_plugin: int
    finished_job_output: int


class ApiTokenSettings(TypedDict, total=False):
    """One entry in ``auth.tokens``: a named client's bearer token and its scope.
    Give the secret as ``token_hash`` (from ``x-monitor token new``), or as
    ``token_file`` or ``token``, which are hashed at startup."""
    name: str
    scope: str                  # read, control or push
    token_hash: str             # sha256:<64 hex digits>
    token_file: str
    token: str
    monitors: List[str]         # push only: the monitor ids it may push to; all when absent


class AuthSettings(TypedDict, total=False):
    """The single operator account guarding the dashboard, how long a sign-in
    lasts, and the API tokens other clients use. Each secret may be given
    inline or as a ``*_file`` path read once at startup. Without
    ``session_secret`` a key is generated per start, so a restart signs
    everyone out."""
    username: str
    password: str
    password_file: str
    session_secret: str
    session_secret_file: str
    session_hours: int
    remember_days: int
    tokens: List[ApiTokenSettings]


class InfluxDBExporterSettings(TypedDict, total=False):
    url: str
    interval: int
    org: str
    bucket: str
    token: str
    database: str


class MQTTExporterSettings(TypedDict, total=False):
    host: str
    port: int                   # 1883, or 8883 with tls
    username: str
    password: str
    password_file: str
    tls: Any                    # true, or a mapping of ca_certs, certfile, keyfile, insecure
    client_id: str
    base_topic: str             # x-monitor
    discovery_prefix: str       # homeassistant
    discovery: bool             # publish Home Assistant discovery configs
    retain: bool
    interval: Any               # optional periodic republish of everything, in seconds or a duration


class ExporterSettings(TypedDict, total=False):
    influxdb: InfluxDBExporterSettings
    mqtt: MQTTExporterSettings


class NotifySettings(TypedDict, total=False):
    """When a monitor notifies: `notifications.defaults`, or a monitor's or
    group's own `notify:` mapping layered over what it inherits."""
    channels: List[str]
    on: List[str]               # statuses that count as a problem: failed, warning, unavailable
    after: int                  # problem cycles in a row before the first notification
    # `for`: a duration the problem must last unbroken before the first notification (a keyword, so not declared here)
    repeat: Any                 # duration between reminders while the problem lasts; 0 is off
    recovery: bool


class NotificationChannelSettings(TypedDict, total=False):
    """One entry in `notifications.channels`. The other keys depend on `type`."""
    id: str
    type: str
    agent: str                  # desktop: the agent that shows the notification


class NotificationSettings(TypedDict, total=False):
    base_url: str               # the dashboard's address, for links to a monitor's page
    channels: List[NotificationChannelSettings]
    defaults: NotifySettings


class ThemeSettings(TypedDict, total=False):
    """Consumed by core/ui/theme.py's configure(); kept as Dict[str, Any]
    at that call site since theme keys are a flat mapping onto Halon tokens,
    not individually load-bearing to any other module. `scheme` is the one
    non-color key: auto (follow the browser), light, or dark."""
    scheme: str
    primary: str
    background: str


class PluginConfig(TypedDict, total=False):
    """One entry in config.yaml's `plugins` list (or a group's nested
    `children`). `type` selects which x_monitor.plugins.<type> module
    XMonitorEngine.setup_modules loads; everything else is plugin-specific
    and read via PluginConfigMixin._init_config or the plugin's own
    __init__/commands()/parse(). Deliberately not exhaustive beyond the
    keys every plugin can rely on — a per-plugin config shape would need
    one TypedDict per plugin type for marginal benefit, since plugins
    already validate their own keys via .get() with sensible defaults."""
    name: str
    type: str
    id: str
    interval: Any               # int seconds, or a duration string like '5m' — see parse_duration
    offset: Any                 # pins polls to the clock: run when UTC time is this far past a multiple of interval
    schedule: List[Dict[str, Any]]  # actions run on a cron schedule: [{action, cron, args}] — see coordination/schedule.py
    actions: List[Dict[str, Any]]  # user command buttons: [{name, command, id, icon, confirm, danger, timeout, agent}] — see plugins/base/custom_actions.py
    timeout: Any
    target_host: str
    agent: str                  # id of the agent to reach this target through, instead of SSH
    ssh_config: SSHConfig
    children: List["PluginConfig"]  # group plugins only
    ref: str                    # makes this entry a link to the monitor with this id, defined elsewhere
    layout: Any                 # List[LayoutRow] | Dict[str, dict] — see spec_types.UISpec['layout']
    notify: Any                 # bool | NotifySettings; passed down to a group's children


class XMonitorConfig(TypedDict, total=False):
    agents: List[AgentSettings]
    database: DatabaseSettings
    plugins: List[PluginConfig]
    notifications: NotificationSettings
    theme: ThemeSettings
    exporters: ExporterSettings
    logging: LoggingSettings
    memory: MemorySettings
    ssh_defaults: SSHConfig
    control: List[Dict[str, Any]]
    auth: AuthSettings
    plugin_paths: List[Any]     # directories of out-of-tree plugins: a path, or {path, override}
