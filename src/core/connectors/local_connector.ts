// Runs a monitor's commands on the host X-Monitor itself runs on, which is how an agent runs the monitors it is handed.

import { run_command } from "@x-tech-laboratories/x-libs/agent/commands";

import type { TransportConnection } from "../contracts.ts";

export const LOCAL_EXEC_TIMEOUT = 60.0;

// The same execute() shape as SSHConnection and AgentConnection, running each command as a local process in its own
// process group, so a timeout stops everything it started.
export class LocalConnection implements TransportConnection {
  readonly host: string;

  constructor(host: string) {
    this.host = host;
  }

  async execute(command: string, timeout: number | null = LOCAL_EXEC_TIMEOUT): Promise<[number, string, string]> {
    const result = await run_command(command, { timeout_in_seconds: timeout ?? LOCAL_EXEC_TIMEOUT });
    return [result.exit_code, result.stdout, result.stderr];
  }

  // Nothing to close: each command is its own process.
  close(): void {}
}
