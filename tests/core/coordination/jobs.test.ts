import { describe, expect, it } from "vitest";

import { PluginDataView } from "../../../src/core/coordination/data_view.ts";
import { ACTION_LOOP, action_id_of, action_job_kind, JobsGateway, sleep_unless_watched, WATCHED_POLL_SECONDS } from "../../../src/core/coordination/jobs.ts";
import { DatabaseManager } from "../../../src/core/database/database.ts";
import { Plugin } from "../../../src/monitors/base/plugin_base.ts";

class SidePlugin extends Plugin {
  override readonly SIDE_JOB_KINDS = ["eval"];
}

function gateway_for(db = new DatabaseManager()): [SidePlugin, JobsGateway, DatabaseManager] {
  const plugin = new SidePlugin("p", { name: "p", id: "p", interval: 60 });
  plugin.target = "host";
  plugin.bind(new PluginDataView(db, plugin.id));
  const gateway = new JobsGateway(db, plugin);
  plugin.jobs = gateway;
  return [plugin, gateway, db];
}

function start(gateway: JobsGateway, kind: string): number {
  const job_id = gateway.create(kind, "true", "/tmp/x");
  gateway.set_pid(job_id, 100 + job_id);
  return job_id;
}

describe("kinds", () => {
  it("names its action in an action kind", () => {
    expect(action_id_of(action_job_kind("custom:sync"))).toBe("custom:sync");
  });

  it("names no action in a plain kind", () => {
    expect(action_id_of("backup")).toBeNull();
  });
});

describe("side jobs", () => {
  it("does not take a detached action for the main job", () => {
    const [, gateway] = gateway_for();
    start(gateway, action_job_kind("prune"));
    expect(gateway.running()).toBeNull();
    expect(gateway.is_running()).toBe(false);
    expect(gateway.action_job("prune")?.kind).toBe("action:prune");
    expect(gateway.any_running()).toBe(true);
  });

  it("does not take a named side kind for the main job", () => {
    const [, gateway] = gateway_for();
    start(gateway, "eval");
    expect(gateway.running()).toBeNull();
    expect(gateway.running_side("eval")?.kind).toBe("eval");
  });

  it("finds the main job beside side jobs", () => {
    const [, gateway] = gateway_for();
    start(gateway, "eval");
    start(gateway, "switch");
    start(gateway, action_job_kind("prune"));
    expect(gateway.running()?.kind).toBe("switch");
  });

  it("polls sooner while a side kind runs", () => {
    const [plugin, gateway] = gateway_for();
    plugin.job_poll_interval = 30;
    expect(plugin.next_cycle_in()).toBeNull();
    start(gateway, "eval");
    expect(plugin.next_cycle_in()).toBe(30);
  });

  it("does not poll the plugin sooner while an action runs", () => {
    const [plugin, gateway] = gateway_for();
    plugin.job_poll_interval = 30;
    start(gateway, action_job_kind("prune"));
    expect(plugin.next_cycle_in()).toBeNull();
  });
});

describe("action state", () => {
  it("fills a detached action while it runs", () => {
    const [plugin, gateway] = gateway_for();
    const action = { action_id: "prune", name: "Prune", detached: true };
    expect(plugin.action_state(action)).toBe("normal");
    start(gateway, action_job_kind("prune"));
    expect(plugin.action_state(action)).toBe("accent");
  });
});

describe("cancel", () => {
  it("stops a detached action when no main job runs", async () => {
    const sent: string[] = [];
    const [plugin, , db] = gateway_for();
    const gateway = new JobsGateway(db, plugin, async (command) => {
      sent.push(command);
    });
    const job_id = start(gateway, action_job_kind("prune"));
    expect(await gateway.cancel()).toBe(true);
    expect(sent[0]).toContain(String(100 + job_id));
    expect(gateway.action_job("prune")).toBeNull();
  });
});

describe("history", () => {
  it("keeps excluded kinds out of the history", () => {
    const [, gateway] = gateway_for();
    const kept = [start(gateway, "switch")];
    for (let index = 0; index < 3; index++) start(gateway, "eval");
    kept.push(start(gateway, "update"));
    expect(gateway.recent(2, ["eval"]).map((job) => job.id)).toEqual([...kept].reverse());
    expect(gateway.recent(99)).toHaveLength(5);
  });
});

describe("watching", () => {
  it("polls a watched job every few seconds", () => {
    const [plugin, gateway] = gateway_for();
    start(gateway, "gc");
    expect(plugin.next_cycle_in()).toBeNull();
    const unwatch = gateway.watch(gateway.running()!);
    expect(plugin.next_cycle_in()).toBe(WATCHED_POLL_SECONDS);
    unwatch();
    expect(plugin.next_cycle_in()).toBeNull();
  });

  it("lets a watch beat a slower job poll", () => {
    const [plugin, gateway] = gateway_for();
    plugin.job_poll_interval = 30;
    start(gateway, "gc");
    const unwatch = gateway.watch(gateway.running()!);
    try {
      expect(plugin.next_cycle_in()).toBe(WATCHED_POLL_SECONDS);
    } finally {
      unwatch();
    }
    expect(plugin.next_cycle_in()).toBe(30);
  });

  it("stops the fast polling once a watched job finishes", () => {
    const [plugin, gateway] = gateway_for();
    const job_id = start(gateway, "gc");
    const unwatch = gateway.watch(gateway.running()!);
    try {
      gateway.finish(job_id, "succeeded", 0);
      expect(plugin.next_cycle_in()).toBeNull();
    } finally {
      unwatch();
    }
  });

  it("wakes only its own loop on a new watch", async () => {
    const [plugin, gateway] = gateway_for();
    start(gateway, "gc");
    const other_abort = new AbortController();
    const own = sleep_unless_watched(60, plugin.id);
    let other_done = false;
    void sleep_unless_watched(60, ACTION_LOOP, other_abort.signal).then(() => {
      other_done = true;
    });
    const unwatch = gateway.watch(gateway.running()!);
    try {
      expect(await own).toBe(true);
      await Promise.resolve();
      expect(other_done).toBe(false);
    } finally {
      unwatch();
      other_abort.abort();
    }
  });

  it("ends an aborted sleep without calling it woken", async () => {
    const abort = new AbortController();
    const nap = sleep_unless_watched(60, "p", abort.signal);
    abort.abort();
    expect(await nap).toBe(false);
  });
});
