// An agent that logs in to an AgentRegistry's hub over an in-process socket, so the agent link is tested with no
// network: it answers the challenge with a real key, records what the server sends, and replies on demand.

import { EventEmitter } from "node:events";

import { generate_agent_key, parse_private_key, sign_challenge } from "@x-tech-laboratories/x-libs/agent/keys";

import type { AgentRegistry } from "../../../src/core/connectors/agent_connector.ts";
import { code_version } from "../../../src/core/code_version.ts";
import { agent_app } from "../../../src/shared/agent_protocol.ts";

export interface AgentKey {
  private_text: string;
  public_line: string;
}

export function new_agent_key(): AgentKey {
  return generate_agent_key("test-agent");
}

// The server end of one fake agent's socket, which is also how the test plays the agent.
export class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  // Every message the server sent, parsed.
  readonly sent: Record<string, unknown>[] = [];
  close_code: number | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.close_code = code ?? 1000;
    this.emit("close");
  }

  // Sends one message from the agent.
  deliver(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  // The server's messages of one type.
  of_type(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === type);
  }

  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }

  // Answers a request the server made.
  reply(id: unknown, value: unknown): void {
    this.deliver({ type: "reply", id, value });
  }
}

// Logs a fake agent in as `agent_id` with `key`, then announces its capabilities unless told not to.
export function connect_agent(registry: AgentRegistry, agent_id: string, key: AgentKey, options: { caps?: string[]; code?: string; announce?: boolean } = {}): FakeAgentSocket {
  const socket = new FakeAgentSocket();
  registry.hub.accept(socket as never, agent_id, "key");
  const challenge = socket.of_type("challenge")[0];
  const signature = sign_challenge(parse_private_key(key.private_text), agent_app.name, agent_id, String(challenge.nonce));
  socket.deliver({ type: "hello", protocol: agent_app.protocol_version, host: `${agent_id}.lan`, agent_version: "1.0.0", runs: [], signature });
  if (options.announce !== false) {
    socket.deliver({ type: "capabilities", hostname: `${agent_id}.lan`, version: "1.0.0", caps: options.caps ?? [], code: options.code ?? code_version() });
  }
  return socket;
}
