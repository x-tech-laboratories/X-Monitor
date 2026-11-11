import { describe, expect, it } from "vitest";

import { cmd_result } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { CommandPlugin } from "../../src/monitors/command.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const command_monitor = (extra: PluginConfig = {}): CommandPlugin => make_plugin(CommandPlugin, { name: "test-cmd", id: "test-cmd", ssh_config: { host: "test.host" }, ...extra });
const run = (plugin: CommandPlugin, code: number, stdout = "", stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const latest_status = (plugin: CommandPlugin) => store_of(plugin).latest_status("test-cmd");
const latest_metric = (plugin: CommandPlugin, name: string) => store_of(plugin).latest_metric("test-cmd", name)?.value ?? null;

describe("exit code mode", () => {
  it("calls exit 0 online", () => {
    const plugin = command_monitor({ command: "true" });
    run(plugin, 0, "ok");
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "exit_code")).toBeCloseTo(0.0);
  });

  it("fails a non-zero exit", () => {
    const plugin = command_monitor({ command: "false" });
    run(plugin, 3, "", "boom");
    expect(latest_status(plugin)).toBe("failed");
  });

  it("warns on a non-zero exit when asked", () => {
    const plugin = command_monitor({ command: "false", nonzero_is_warning: true });
    run(plugin, 1);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails a timeout", () => {
    const plugin = command_monitor({ command: "sleep 100", timeout: 1 });
    run(plugin, 124);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails a missing command", () => {
    const plugin = command_monitor();
    run(plugin, 0);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = command_monitor({ command: "true" });
    run(plugin, -1, "", "Agent 'h' is not connected");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("wraps the command in a timeout and a quoted sh -c", () => {
    expect(command_monitor({ command: "echo 'hi'", timeout: 5 }).commands()[0].text).toBe("timeout 5 sh -c 'echo '\\''hi'\\'''");
  });
});

describe("pattern mode", () => {
  const thresholds = { pattern: "temp=(\\d+)", warning: 70, threshold: 80 };

  it("calls a value below the warning online", () => {
    const plugin = command_monitor({ command: "get_temp", ...thresholds });
    run(plugin, 0, "temp=42");
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "value")).toBeCloseTo(42.0);
  });

  it("warns between the limits", () => {
    const plugin = command_monitor({ command: "x", ...thresholds });
    run(plugin, 0, "temp=75");
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails past the threshold", () => {
    const plugin = command_monitor({ command: "x", ...thresholds });
    const result = run(plugin, 0, "temp=95");
    expect(latest_status(plugin)).toBe("failed");
    expect(result.logs[1][0]).toBe("VALUE: 95.0 -> failed");
  });

  it("fails output with no match", () => {
    const plugin = command_monitor({ command: "x", ...thresholds });
    run(plugin, 0, "nothing here");
    expect(latest_status(plugin)).toBe("failed");
  });

  it("treats a low value as bad when inverted", () => {
    const plugin = command_monitor({ command: "x", pattern: "free=(\\d+)", warning: 20, threshold: 10, invert: true });
    run(plugin, 0, "free=5");
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a high value online when inverted", () => {
    const plugin = command_monitor({ command: "x", pattern: "free=(\\d+)", warning: 20, threshold: 10, invert: true });
    run(plugin, 0, "free=90");
    expect(latest_status(plugin)).toBe("online");
  });

  it("reads a float value", () => {
    const plugin = command_monitor({ command: "x", pattern: "load=([\\d.]+)", warning: 4, threshold: 8 });
    run(plugin, 0, "load=2.5");
    expect(latest_metric(plugin, "value")).toBeCloseTo(2.5);
  });

  it("writes the value card with its unit", () => {
    expect(command_monitor({ command: "x", pattern: "(\\d+)", value_unit: "ms" }).value_text(2.5)).toBe("2.5ms");
  });
});

describe("actions", () => {
  it("plans no action", () => expect(command_monitor({ command: "true" }).plan_action("anything")).toBeNull());
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = command_monitor({ command: "x", pattern: "temp=(\\d+)", warning: 70 });
    run(plugin, 0, "temp=9999");
    expect(latest_status(plugin)).toBe("warning");
  });

  it("never warns with a failure only", () => {
    const plugin = command_monitor({ command: "x", pattern: "temp=(\\d+)", threshold: 80 });
    run(plugin, 0, "temp=79");
    expect(latest_status(plugin)).toBe("online");
    run(plugin, 0, "temp=80");
    expect(latest_status(plugin)).toBe("failed");
  });

  it("never fails with an inverted warning only", () => {
    const plugin = command_monitor({ command: "x", pattern: "free=(\\d+)", warning: 20, invert: true });
    run(plugin, 0, "free=0");
    expect(latest_status(plugin)).toBe("warning");
    expect(plugin.value_color(0.0)).toBe("warning");
  });

  it("never warns with an inverted failure only", () => {
    const plugin = command_monitor({ command: "x", pattern: "free=(\\d+)", threshold: 10, invert: true });
    run(plugin, 0, "free=11");
    expect(latest_status(plugin)).toBe("online");
    run(plugin, 0, "free=10");
    expect(latest_status(plugin)).toBe("failed");
  });
});
