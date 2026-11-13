// Local command execution: the server sends the same shell command strings the SSH transport sent, so this returns the
// same (exit_code, stdout, stderr) triple and maps every failure into it rather than throwing. X-Libs runs each
// command in its own process group, so a timeout kills everything it started.

import { run_command } from "@x-tech-laboratories/x-libs/agent/commands";

export const DEFAULT_TIMEOUT = 30.0;

export async function run(command: string, timeout: number = DEFAULT_TIMEOUT): Promise<[exit_code: number, stdout: string, stderr: string]> {
  const result = await run_command(command, { timeout_in_seconds: timeout });
  return [result.exit_code, result.stdout, result.stderr];
}
