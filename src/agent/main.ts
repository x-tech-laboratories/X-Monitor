#!/usr/bin/env node
// x-monitor-agent: connects outward to an X-Monitor server and serves it commands and live events.

import { parseArgs } from "node:util";

import { set_root_log_level } from "../core/logging.ts";
import { XMonitorAgent } from "./agent.ts";
import { AgentConfigFailure, load_config } from "./config.ts";

const USAGE = `usage: x-monitor-agent [--config PATH] [--verbose]

X-Monitor agent — connects outward to a X-Monitor server and serves it commands and live events.

options:
  --config PATH  Path to the agent config file
  --verbose      Log every frame handled`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values: { config?: string; verbose?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { config: { type: "string" }, verbose: { type: "boolean" }, help: { type: "boolean", short: "h" } } }));
  } catch (error) {
    console.error(`${USAGE}\nx-monitor-agent: error: ${(error as Error).message}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  set_root_log_level(values.verbose ? "DEBUG" : "INFO");
  let agent: XMonitorAgent;
  try {
    agent = new XMonitorAgent(load_config(values.config ?? null));
    await agent.start();
  } catch (error) {
    if (error instanceof AgentConfigFailure || (error as Error).name === "AgentConfigError") {
      console.error((error as Error).message);
      return 1;
    }
    throw error;
  }
  const stop = () => void agent.stop().then(() => {
    console.log("x-monitor-agent stopped");
    process.exit(0);
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise<number>(() => undefined);
}

if (import.meta.main) process.exitCode = await main();
