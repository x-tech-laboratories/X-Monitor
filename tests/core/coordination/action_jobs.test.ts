import { beforeEach, describe, expect, it } from "vitest";

import { poll_command } from "../../../src/core/connectors/job_commands.ts";
import { ExecContext } from "../../../src/core/connectors/engine.ts";
import { action_plan, cmd_result, CollectResult, type ActionPlan, type CmdResult } from "../../../src/core/connectors/types.ts";
import { ActionJobs, bounded } from "../../../src/core/coordination/action_jobs.ts";
import type { XMonitorEngine } from "../../../src/core/coordination/engine.ts";
import { set_log_sink } from "../../../src/core/logging.ts";
import { make_engine, Probe, wire } from "./engine_harness.ts";

const actions = [{ name: "Sync", command: "sync-all", detached: true, timeout: "1h" }];

// The stdout one poll of a detached job prints.
function poll(out: string, exit_code: number | null = null, alive = true): CmdResult {
  return cmd_result(0, `===XMONITOR_SIZE===\n${out.length}\n===XMONITOR_EXIT===\n${exit_code ?? ""}\n===XMONITOR_ALIVE===\n${alive ? 1 : 0}\n===XMONITOR_OUT===\n${out}`, "");
}

interface Setup {
  engine: XMonitorEngine;
  plugin: Probe;
  answer: CmdResult;
  plans: ActionPlan[];
}

// An engine whose connector answers every command with `answer`, and a monitor wired to it.
function setup(plugin?: Probe, from?: XMonitorEngine): Setup {
  const engine = from ?? make_engine().engine;
  const state: Setup = { engine, plugin: plugin ?? wire(engine, Probe, { id: "rack", name: "Rack", actions }), answer: cmd_result(0), plans: [] };
  engine.connectors.execute = async (_context: ExecContext, plan: ActionPlan) => {
    state.plans.push(plan);
    return state.answer;
  };
  return state;
}

const logged = (state: Setup) => state.engine.db.plugin_events(state.plugin.id, "", "", 0).reverse().map((event) => [event.message.replace("[Rack] ", ""), event.level]);

beforeEach(() => set_log_sink(() => {}));

describe("launch", () => {
  it("starts a job for a detached action", async () => {
    const state = setup();
    state.answer = cmd_result(0, "4242\n");
    const [success, metadata] = await state.engine.dispatch_action(state.plugin, "custom:sync");
    const job = state.plugin.jobs!.action_job("custom:sync")!;
    expect(success).toBe(true);
    expect(metadata!.job_id).toBe(String(job.id));
    expect(state.plans[0].command).toContain("setsid");
    expect(state.plans[0].command).toContain("timeout 3600 sh -c sync-all");
    expect(job.pid).toBe(4242);
    expect(logged(state)).toEqual([["Sync started in the background (pid 4242)", "INFO"]]);
  });

  it("makes a failed launch the action's failure", async () => {
    const state = setup();
    state.answer = cmd_result(-1, "", "agent offline");
    const [success] = await state.engine.dispatch_action(state.plugin, "custom:sync");
    expect(success).toBe(false);
    expect(state.plugin.jobs!.action_job("custom:sync")).toBeNull();
    expect(logged(state)).toEqual([["Sync failed (exit -1): agent offline", "ERROR"]]);
  });

  it("refuses a second run while one runs", async () => {
    const state = setup();
    state.answer = cmd_result(0, "4242\n");
    await state.engine.dispatch_action(state.plugin, "custom:sync");
    expect(await state.engine.dispatch_action(state.plugin, "custom:sync")).toEqual([false, { content: "Sync is already running" }]);
    expect(state.plans).toHaveLength(1);
  });

  it("leaves a command without a timeout alone", () => {
    expect(bounded("sync-all", null)).toBe("sync-all");
  });
});

describe("follow", () => {
  async function launched(): Promise<[Setup, number]> {
    const state = setup();
    state.answer = cmd_result(0, "4242\n");
    await state.engine.dispatch_action(state.plugin, "custom:sync");
    return [state, state.plugin.jobs!.action_job("custom:sync")!.id];
  }

  it("gives a running job output and progress", async () => {
    const [state, job_id] = await launched();
    state.answer = poll("copied 1\ncopied 2\n");
    await state.engine.action_jobs.poll_all();
    expect(state.plugin.jobs!.action_job("custom:sync")!.progress).toBe("copied 2");
    expect(state.engine.db.job_output(job_id, -1, 0).map((row) => row.message)).toEqual(["copied 1", "copied 2"]);
    expect(logged(state)).toHaveLength(1);
  });

  it("interprets a finished job from its whole output", async () => {
    const [state, job_id] = await launched();
    state.answer = poll("copied 1\n");
    await state.engine.action_jobs.poll_all();
    state.answer = poll("copied 2\n", 0, false);
    await state.engine.action_jobs.poll_all();
    expect(state.plugin.jobs!.action_job("custom:sync")).toBeNull();
    expect(state.engine.db.get_job(job_id)!.state).toBe("succeeded");
    expect(logged(state).at(-1)).toEqual(["Sync ran: copied 1\ncopied 2", "INFO"]);
  });

  it("reports a failed job", async () => {
    const [state, job_id] = await launched();
    state.answer = poll("no space\n", 3, false);
    await state.engine.action_jobs.poll_all();
    expect(state.engine.db.get_job(job_id)!.state).toBe("failed");
    expect(logged(state).at(-1)).toEqual(["Sync failed (exit 3): no space", "ERROR"]);
  });

  it("fails a job that vanished", async () => {
    const [state, job_id] = await launched();
    state.answer = poll("", null, false);
    await state.engine.action_jobs.poll_all();
    expect(state.engine.db.get_job(job_id)!.error).toBe("Process ended without writing an exit code");
  });

  it("leaves a job running after an unanswered poll", async () => {
    const [state] = await launched();
    state.answer = cmd_result(-1, "", "timed out");
    await state.engine.action_jobs.poll_all();
    expect(state.plugin.jobs!.action_job("custom:sync")).not.toBeNull();
  });

  it("adopts a running job in a restarted follower", async () => {
    const [state, job_id] = await launched();
    const fresh = new ActionJobs(state.engine);
    state.answer = poll("done\n", 0, false);
    await fresh.poll_all();
    expect(state.plans.at(-1)!.command).toContain("kill -0 4242");
    expect(state.engine.db.get_job(job_id)!.state).toBe("succeeded");
  });

  it("hands a plugin action its arguments back", async () => {
    const { engine } = make_engine();
    const plugin = wire(engine, Probe, { id: "rack", name: "Rack" });
    const seen: unknown[] = [];
    plugin.plan_action = () => action_plan("long", { detached: true });
    plugin.interpret_action = (action_id, result, args) => {
      seen.push([action_id, (result as CmdResult).stdout, args]);
      return new CollectResult({ logs: [["done", "INFO"]] });
    };
    const state = setup(plugin, engine);
    state.answer = cmd_result(0, "7\n");
    await engine.dispatch_action(plugin, "diff", { archive: "b2" });
    state.answer = poll("a\n", 0, false);
    await engine.action_jobs.poll_all();
    expect(seen).toEqual([["diff", "a", { archive: "b2" }]]);
  });

  it("reads the job's workdir in a poll", () => {
    expect(poll_command("$HOME/x", 1, 0)).toContain("tail -c +1");
  });
});
