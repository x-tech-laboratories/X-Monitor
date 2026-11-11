import { describe, expect, it } from "vitest";

import { action_plan, cmd_result } from "../../../src/core/connectors/types.ts";
import { parse_custom_actions } from "../../../src/monitors/base/custom_actions.ts";
import { Plugin } from "../../../src/monitors/base/plugin_base.ts";
import type { ActionButtonSpec } from "../../../src/shared/ui_spec.ts";

describe("parsing", () => {
  it("reads a missing list as none", () => {
    expect(parse_custom_actions(null)).toEqual([]);
  });

  it("takes the id from the name", () => {
    const [action] = parse_custom_actions([{ name: "Clear Cache!", command: "rm -rf /var/cache/app/*" }]);
    expect(action.action_id).toBe("custom:clear_cache");
    expect(action.command).toBe("rm -rf /var/cache/app/*");
    expect(action.icon).toBe("terminal");
  });

  it("reads an explicit id and options", () => {
    const [action] = parse_custom_actions([{
      name: "Reboot", id: "reboot", command: "systemctl reboot", icon: "power", confirm: "Reboot this host?", danger: true, timeout: "2m", agent: "odin",
    }]);
    expect(action.action_id).toBe("custom:reboot");
    expect(action.plan()).toEqual(action_plan("systemctl reboot", { timeout: 120, agent: "odin" }));
    expect(action.button()).toEqual({ action_id: "custom:reboot", name: "Reboot", icon: "power", variant: "danger", confirm: "Reboot this host?" });
  });

  it("puts a `more` button in the more menu", () => {
    const [action] = parse_custom_actions([{ name: "Rotate Logs", command: "logrotate -f /etc/logrotate.conf", more: true }]);
    expect(action.button().more).toBe(true);
  });

  it("runs a detached action as a followed job", () => {
    const [action] = parse_custom_actions([{ name: "Sync", command: "sync-all", detached: true, timeout: "1h" }]);
    expect(action.plan()).toEqual(action_plan("sync-all", { timeout: 3600, detached: true }));
    expect(action.button().detached).toBe(true);
  });

  it("runs an action inline by default", () => {
    const [action] = parse_custom_actions([{ name: "Sync", command: "sync-all" }]);
    expect(action.plan().detached).toBe(false);
    expect("detached" in action.button()).toBe(false);
  });

  it("keeps a button on its own by default", () => {
    const [action] = parse_custom_actions([{ name: "Rotate Logs", command: "true" }]);
    expect("more" in action.button()).toBe(false);
  });

  it.each([
    [{ name: "x", command: "y" }],
    [[{ name: "No command" }]],
    [[{ command: "true" }]],
    [[{ name: "!!!", command: "true" }]],
    [[{ name: "Same", command: "a" }, { name: "same", command: "b" }]],
  ])("refuses the malformed entries %j", (value) => {
    expect(() => parse_custom_actions(value)).toThrow();
  });
});

describe("outcome", () => {
  it("logs the output on success", () => {
    const [action] = parse_custom_actions([{ name: "Flush", command: "flush" }]);
    const outcome = action.interpret(cmd_result(0, "flushed 3\n", ""));
    expect(outcome.success).toBe(true);
    expect(outcome.logs).toEqual([["Flush ran: flushed 3", "INFO"]]);
    expect(outcome.metadata).toEqual({ content: "flushed 3\n" });
  });

  it("logs the exit code and error on failure", () => {
    const [action] = parse_custom_actions([{ name: "Flush", command: "flush" }]);
    const outcome = action.interpret(cmd_result(2, "", "permission denied\n"));
    expect(outcome.success).toBe(false);
    expect(outcome.logs).toEqual([["Flush failed (exit 2): permission denied", "ERROR"]]);
  });
});

class WithOwnActions extends Plugin {
  override get_actions(): ActionButtonSpec[] {
    return [{ action_id: "restart", name: "Restart", icon: "restart_alt" }];
  }
}

class WithoutActions extends Plugin {}

const actions = [{ name: "Clear Cache", command: "rm -rf /tmp/cache" }];

describe("any plugin accepts them", () => {
  it("puts custom buttons after the plugin's own", () => {
    const plugin = new WithOwnActions("nginx", { actions });
    const ids = plugin.all_actions().map((action) => action.action_id ?? action.name);
    expect(ids.at(-1)).toBe("custom:clear_cache");
    expect(ids.slice(0, -1)).toEqual(plugin.get_actions().map((action) => action.action_id ?? action.name));
  });

  it("gives them to a plugin with no actions of its own", () => {
    const plugin = new WithoutActions("Rack", { actions });
    expect(plugin.all_actions().map((action) => action.action_id)).toEqual(["custom:clear_cache"]);
    expect(plugin.custom_action("custom:clear_cache")?.command).toBe("rm -rf /tmp/cache");
    expect(plugin.custom_action("clear_cache")).toBeNull();
  });
});
