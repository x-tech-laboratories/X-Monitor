// The shapes of config.yaml (or config.json) as ConfigFileManager returns them. Every field is optional: the file has
// no required section, an empty one loads as {}, and each reader defaults a missing key itself. Nothing checks the file
// against these types at load; the loader only warns about structural mistakes (see config_file.ts).

import type { PluginConfig } from "../../monitors/base/plugin_helpers.ts";

export type { PluginConfig } from "../../monitors/base/plugin_helpers.ts";

// A monitor's `ssh_config`, or the shared `ssh_defaults` merged into it, where the monitor's own keys win.
export interface SSHConfig {
  host?: string;
  port?: number;
  username?: string;
  key_path?: string;
  password?: string;
  [key: string]: unknown;
}

// One `agents:` entry: the agent dials in and proves it holds the private half of `public_key`, an OpenSSH ed25519
// public key line; `host` is only a label, since the server never dials the agent.
export interface AgentSettings {
  id?: string;
  public_key?: string;
  host?: string;
  [key: string]: unknown;
}

export interface DatabaseSettings {
  path?: string;
  write_batch_seconds?: number;
  [key: string]: unknown;
}

export interface LoggingSettings {
  retention_days?: number;
  metric_retention_days?: number;
  metric_downsample_days?: number;
  cycle_timings?: boolean;
  // The root log level at startup: DEBUG, INFO, WARNING, ERROR or CRITICAL.
  level?: string;
  // Per-logger levels, such as {"x_monitor.core.connectors.ssh_connector": "DEBUG"}.
  levels?: Record<string, string>;
  [key: string]: unknown;
}

// How much history the in-memory store keeps per stream, apart from how long the database file keeps it.
export interface MemorySettings {
  metric_history?: number;
  event_history?: number;
  log_history?: number;
  job_output?: number;
  jobs_per_plugin?: number;
  finished_job_output?: number;
  [key: string]: unknown;
}

// One `auth.tokens` entry: a named client's bearer token and its scope.
export interface ApiTokenSettings {
  name?: string;
  // read, control or push.
  scope?: string;
  // sha256:<64 hex digits>.
  token_hash?: string;
  token_file?: string;
  token?: string;
  // Push only: the monitor ids it may push to, all when absent.
  monitors?: string[];
  [key: string]: unknown;
}

// The operator account, how long a sign-in lasts, and the API tokens; each secret inline or as a *_file path.
export interface AuthSettings {
  username?: string;
  password?: string;
  password_file?: string;
  session_secret?: string;
  session_secret_file?: string;
  session_hours?: number;
  remember_days?: number;
  tokens?: ApiTokenSettings[];
  [key: string]: unknown;
}

export interface InfluxDBExporterSettings {
  url?: string;
  interval?: number;
  org?: string;
  bucket?: string;
  token?: string;
  database?: string;
  [key: string]: unknown;
}

export interface MQTTExporterSettings {
  host?: string;
  // 1883, or 8883 with tls.
  port?: number;
  username?: string;
  password?: string;
  password_file?: string;
  // True, or a mapping of ca_certs, certfile, keyfile and insecure.
  tls?: unknown;
  client_id?: string;
  base_topic?: string;
  discovery_prefix?: string;
  discovery?: boolean;
  retain?: boolean;
  // An optional periodic republish of everything, in seconds or a duration.
  interval?: unknown;
  [key: string]: unknown;
}

export interface ExporterSettings {
  influxdb?: InfluxDBExporterSettings;
  mqtt?: MQTTExporterSettings;
  [key: string]: unknown;
}

// When a monitor notifies: `notifications.defaults`, or a monitor's own `notify:` layered over what it inherits.
export interface NotifySettings {
  channels?: string[];
  // The statuses that count as a problem: failed, warning, unavailable.
  on?: string[];
  // Problem cycles in a row before the first notification.
  after?: number;
  // A duration the problem must last unbroken before the first notification.
  for?: unknown;
  // A duration between reminders while the problem lasts; 0 is off.
  repeat?: unknown;
  recovery?: boolean;
  [key: string]: unknown;
}

// One `notifications.channels` entry; the other keys depend on `type`.
export interface NotificationChannelSettings {
  id?: string;
  type?: string;
  // Desktop only: the agent that shows the notification.
  agent?: string;
  [key: string]: unknown;
}

export interface NotificationSettings {
  // The dashboard's address, for links to a monitor's page.
  base_url?: string;
  channels?: NotificationChannelSettings[];
  defaults?: NotifySettings;
  [key: string]: unknown;
}

// A flat mapping onto Halon tokens; `scheme` is auto, light or dark.
export interface ThemeSettings {
  scheme?: string;
  primary?: string;
  background?: string;
  [key: string]: unknown;
}

export interface XMonitorConfig {
  agents?: AgentSettings[];
  database?: DatabaseSettings;
  plugins?: PluginConfig[];
  notifications?: NotificationSettings;
  theme?: ThemeSettings;
  exporters?: ExporterSettings;
  logging?: LoggingSettings;
  memory?: MemorySettings;
  ssh_defaults?: SSHConfig;
  control?: Record<string, unknown>[];
  auth?: AuthSettings;
  // Folders of out-of-tree monitor types: a path, or {path, override}.
  plugin_paths?: unknown[];
  [key: string]: unknown;
}
