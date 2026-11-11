import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import { Oom } from "../../src/monitors/oom.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const config: PluginConfig = { name: "test-oom", id: "test-oom", ssh_config: { host: "test.host" } };

function vmstat(oom_kill = 0, include = true): string {
  const lines = ["pgfault 1000", "pgmajfault 20"];
  if (include) lines.push(`oom_kill ${oom_kill}`);
  return lines.join("\n") + "\n";
}

const oom = (extra: PluginConfig = {}): Oom => make_plugin(Oom, { ...config, ...extra });
const run = (plugin: Oom, stdout: string) => run_cycle(plugin, () => cmd_result(0, stdout, ""));
const latest_status = (plugin: Oom) => store_of(plugin).latest_status("test-oom");
const latest_metric = (plugin: Oom, name: string) => store_of(plugin).latest_metric("test-oom", name)?.value ?? null;

describe("collection", () => {
  it("fails a new kill after the baseline", () => {
    const plugin = oom();
    run(plugin, vmstat(5));
    expect(latest_status(plugin)).toBe("online");
    run(plugin, vmstat(6));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "oom_kills_new")).toBeCloseTo(1.0);
  });

  it("warns on a kill when configured", () => {
    const plugin = oom({ is_warning: true });
    run(plugin, vmstat(0));
    run(plugin, vmstat(1));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("decays the alert after alert_for cycles", () => {
    const plugin = oom({ alert_for: 2 });
    run(plugin, vmstat(0));
    run(plugin, vmstat(1));
    expect(latest_status(plugin)).toBe("failed");
    run(plugin, vmstat(1));
    expect(latest_status(plugin)).toBe("warning");
    run(plugin, vmstat(1));
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls a missing counter unavailable", () => {
    const plugin = oom();
    run(plugin, vmstat(0, false));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreadable vmstat unavailable", () => {
    const plugin = oom();
    run_cycle(plugin, () => cmd_result(1, "", "cat: /proc/vmstat: Permission denied"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("notes a counter that went backwards as a reboot", () => {
    const plugin = oom();
    run(plugin, vmstat(5));
    const result = run(plugin, vmstat(1));
    expect(latest_status(plugin)).toBe("online");
    expect(result.logs[0][0]).toContain("host likely rebooted");
  });
});

describe("pushed events", () => {
  it("subscribes to a sample and the kernel journal", () => {
    expect(oom().subscriptions().map((stream) => stream.kind).sort()).toEqual(["journal", "sample"]);
  });

  it("gives each stream its own id", () => {
    const plugin = oom();
    const ids = Object.fromEntries(plugin.subscriptions().map((stream) => [stream.kind, stream.id]));
    expect(ids.sample).toBe(`${plugin.id}:sample`);
    expect(ids.journal).toBe(`${plugin.id}:journal`);
  });

  it("reports a kill from a pushed event", () => {
    const plugin = oom();
    const result = plugin.parse_event(`${plugin.id}:journal`, { message: "Out of memory: Killed process 1 (x)" }, 0.0)!;
    expect(result.status).toBe("failed");
    expect(result.logs[0][0]).toContain("OOM killer fired");
  });

  it("ignores an empty event", () => {
    const plugin = oom();
    expect(plugin.parse_event(`${plugin.id}:journal`, { message: "  " }, 0.0)).toBeNull();
  });

  it("parses a sample frame like a poll", () => {
    const plugin = oom();
    const result = plugin.parse_event(`${plugin.id}:sample`, { exit_code: 0, stdout: "oom_kill 4\n", stderr: "" }, 0.0)!;
    expect(result.metrics.oom_kills_total).toBe(4.0);
  });

  it("ignores an unknown stream", () => {
    const plugin = oom();
    expect(plugin.parse_event(`${plugin.id}:nope`, { message: "x" }, 0.0)).toBeNull();
  });
});

describe("page", () => {
  it("colors the recent kills card by the configured severity", () => {
    expect(oom().recent_color(0)).toBe("online");
    expect(oom().recent_color(2)).toBe("failed");
    expect(oom({ is_warning: true }).recent_color(2)).toBe("warning");
    expect(oom().recent_color(null)).toBeNull();
  });
});
