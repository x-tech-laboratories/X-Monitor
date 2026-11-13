// Agent configuration: a deliberately small YAML file. The agent's job is to connect and obey, so everything about what
// to watch comes from the server, which keeps a fleet of agents identical and means adding a monitor never touches the
// monitored host. XMONITOR_AGENT_* environment variables override any field, so a container or a systemd unit can
// point at its key without a config file.

import { existsSync, readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";

import { parse as parse_yaml } from "yaml";

import { create_logger_for } from "../core/logging.ts";
import { load_private_key } from "./keys.ts";

const log = create_logger_for("x_monitor_agent.config");

export const DEFAULT_PATH = "/etc/x-monitor-agent.yaml";

// A setting the agent cannot start without; main prints it and exits, as the Python agent's SystemExit did.
export class AgentConfigFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigFailure";
  }
}

export interface AgentConfig {
  // The server's agent endpoint, such as wss://x-monitor.lan/api/agent/ws.
  url: string;
  // Must match an `id` in the server's `agents:` list.
  agent_id: string;
  key_file: string;
  // The private half of the key pair whose public half the server lists for this id.
  key: KeyObject;
  hostname: string | null;
  // Refuse commands and event streams, and only show desktop notifications.
  notify_only: boolean;
  // Where the agent keeps the monitors it runs itself and the records it has not synced yet.
  state_dir: string | null;
  // The socket the system agent serves its own notifications on while X-Monitor is out of reach.
  local_socket: string | null;
}

// Loads the key, failing loudly: falling through to no key would surface as a confusing rejection at the server.
function read_key(key_file: string): KeyObject {
  try {
    return load_private_key(key_file);
  } catch (error) {
    throw new AgentConfigFailure(`x-monitor-agent: could not load key_file ${key_file}: ${(error as Error).message}`);
  }
}

function truthy(value: unknown): boolean {
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

// Reads the config file, then lets the environment override each field.
export function load_config(path: string | null = null, environment: NodeJS.ProcessEnv = process.env): AgentConfig {
  let data: Record<string, unknown> = {};
  const config_path = path || environment.XMONITOR_AGENT_CONFIG || DEFAULT_PATH;
  if (existsSync(config_path)) {
    try {
      const loaded: unknown = parse_yaml(readFileSync(config_path, "utf8"));
      data = typeof loaded === "object" && loaded !== null && !Array.isArray(loaded) ? (loaded as Record<string, unknown>) : {};
    } catch (error) {
      log.error(`could not read ${config_path}: ${(error as Error).message}`);
    }
  } else if (path) {
    throw new AgentConfigFailure(`x-monitor-agent: config file not found: ${config_path}`);
  }

  const pick = (variable: string, field: string): unknown => environment[variable] || data[field];
  const url = pick("XMONITOR_AGENT_URL", "url");
  const agent_id = pick("XMONITOR_AGENT_ID", "id");
  const key_file = pick("XMONITOR_AGENT_KEY_FILE", "key_file");
  const hostname = pick("XMONITOR_AGENT_HOSTNAME", "hostname");
  const notify_only = environment.XMONITOR_AGENT_NOTIFY_ONLY ?? data.notify_only ?? false;
  const state_dir = pick("XMONITOR_AGENT_STATE_DIR", "state_dir");
  const local_socket = pick("XMONITOR_AGENT_LOCAL_SOCKET", "local_socket");

  const missing = ([["url", url], ["id", agent_id], ["key_file", key_file]] as const).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new AgentConfigFailure(`x-monitor-agent: missing required setting(s): ${missing.join(", ")} (set them in ${config_path} or as XMONITOR_AGENT_* environment variables)`);
  }
  return {
    url: String(url),
    agent_id: String(agent_id),
    key_file: String(key_file),
    key: read_key(String(key_file)),
    hostname: hostname ? String(hostname) : null,
    notify_only: truthy(notify_only),
    state_dir: state_dir ? String(state_dir) : null,
    local_socket: local_socket ? String(local_socket) : null,
  };
}
