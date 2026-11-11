// The WebSocket agents dial into, on the same server and port as the dashboard, so an agent needs no listener,
// certificate or firewall rule of its own. The upgrade names the agent's id in the x-monitor-agent-host header, the
// server sends a fresh nonce, and the agent's hello carries it signed with the key whose public half `agents:` lists
// for that id; the server holds no agent secrets. X-Libs' hub does the login, and AgentRegistry the rest.

import { register_agent_route } from "@x-tech-laboratories/x-libs/server/agents/route";
import type { FastifyInstance } from "fastify";

import type { AgentRegistry } from "../core/connectors/agent_connector.ts";

export const AGENT_PATH = "/api/agent/ws";

// Mounts the socket agents connect to; the dashboard's sign-in does not cover it, as the key login does its own.
export function register_agent_endpoint(app: FastifyInstance, registry: AgentRegistry, path = AGENT_PATH): Promise<void> {
  return register_agent_route(app, registry.hub, path);
}
