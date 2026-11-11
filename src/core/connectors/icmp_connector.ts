// The ICMP connector: runs a monitor's PingRequest through the system ping and hands back a PingResult; reading the
// latency out of ping's output stays in the monitor.

import { run_program, type ProgramResult } from "@x-tech-laboratories/x-libs/agent/programs";

import { ping_result, type PingRequest, type PingResult } from "./types.ts";

export type ProgramRunner = (argv: readonly string[]) => Promise<ProgramResult>;

export class IcmpConnector {
  private readonly run: ProgramRunner;

  constructor(run: ProgramRunner = (argv) => run_program(argv)) {
    this.run = run;
  }

  async ping(request: PingRequest): Promise<PingResult> {
    const count_flag = process.platform === "win32" ? "-n" : "-c";
    const argv = ["ping", count_flag, String(request.count), "-W", String(Math.trunc(request.timeout)), request.host];
    try {
      const result = await this.run(argv);
      // A ping that never started is a failure to run, not an answer from the host.
      if (result.exit_code === -1 || (result.exit_code === 127 && result.stderr.endsWith("is not installed on this host"))) {
        return ping_result(result.stderr || "ping could not run", null);
      }
      return ping_result(null, result.exit_code, result.stdout, result.stderr);
    } catch (error) {
      return ping_result((error as Error).message || String(error), null);
    }
  }
}
