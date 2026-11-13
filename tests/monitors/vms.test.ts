import { describe, expect, it } from "vitest";

import { cmd_result, type ActionPlan, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { parse_row, Vms } from "../../src/monitors/vms.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const vms = (extra: PluginConfig = {}): Vms => make_plugin(Vms, { name: "test-vms", id: "test-vms", ssh_config: { host: "test.host" }, ...extra });
const run = (plugin: Vms, code: number, stdout = "", stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const latest_status = (plugin: Vms) => store_of(plugin).latest_status("test-vms");
const latest_metric = (plugin: Vms, name: string) => store_of(plugin).latest_metric("test-vms", name)?.value ?? null;

const list = ` Id   Name       State
----------------------------------
 1    web        running
 2    cache      running
 -    db         shut off
`;

const list_paused = ` Id   Name       State
----------------------------------
 1    web        running
 3    stuck      paused
`;

describe("parse row", () => {
  it("ignores the header", () => expect(parse_row(" Id   Name       State")).toEqual([null, null]));
  it("ignores the separator", () => expect(parse_row("---------------------------")).toEqual([null, null]));
  it("reads a running row", () => expect(parse_row(" 1    web        running")).toEqual(["web", "running"]));
  it("reads a two-word state", () => expect(parse_row(" -    db         shut off")).toEqual(["db", "shut off"]));
});

describe("collection", () => {
  it("calls running and shut-off VMs online", () => {
    const plugin = vms();
    run(plugin, 0, list);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "vms_running")).toBeCloseTo(2.0);
    expect(latest_metric(plugin, "vms_total")).toBeCloseTo(3.0);
  });

  it("warns on a paused VM", () => {
    const plugin = vms();
    run(plugin, 0, list_paused);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails an expected VM that is off", () => {
    const plugin = vms({ expect_running: ["db"] });
    run(plugin, 0, list);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls expected VMs that run online", () => {
    const plugin = vms({ expect_running: ["web", "cache"] });
    run(plugin, 0, list);
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls a missing virsh unavailable", () => {
    const plugin = vms();
    run(plugin, 127, "", "bash: virsh: command not found");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable libvirt unavailable", () => {
    const plugin = vms();
    run(plugin, 1, "", "error: failed to connect to the hypervisor");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a virsh list error unavailable", () => {
    const plugin = vms({ expect_running: ["web"] });
    run(plugin, 1, "", "error: authentication failed");
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "vms_total")).toBeNull();
  });
});

describe("actions", () => {
  it("starts a listed VM", () => {
    const plugin = vms({ expect_running: ["web"] });
    const plan = plugin.plan_action("start:web") as ActionPlan;
    expect(plan.command).toBe("virsh -c 'qemu:///system' start 'web'");
    expect(plugin.interpret_action("start:web", cmd_result(0, "", ""))).toBe(true);
  });

  it("refuses an unlisted VM", () => expect((vms({ expect_running: ["web"] }).plan_action("start:evil") as CollectResult).success).toBe(false));

  it("gives each expected VM a running switch", () => {
    expect(vms({ expect_running: ["web", "db"] }).get_actions()).toEqual([
      { name: "db", kind: "toggle", metric: "vm_running_db", icon: "computer", on_action_id: "start:db", off_action_id: "shutdown:db", action_id: "vm_running_db" },
      { name: "web", kind: "toggle", metric: "vm_running_web", icon: "computer", on_action_id: "start:web", off_action_id: "shutdown:web", action_id: "vm_running_web" },
    ]);
  });

  it("records a running metric per expected VM", () => {
    const plugin = vms({ expect_running: ["web", "db"] });
    run(plugin, 0, list);
    expect(latest_metric(plugin, "vm_running_web")).toBe(1.0);
    expect(latest_metric(plugin, "vm_running_db")).toBe(0.0);
    expect(latest_metric(plugin, "vm_running_cache")).toBeNull();
  });
});

describe("page", () => {
  it("shares one bar between running and stopped VMs", () => {
    const spec = vms().UI_SPEC;
    const card = spec.cards!.running_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => [part.metric, part.color])).toEqual([["vms_running", "online"], ["vms_stopped", "neutral"]]);
    expect("stopped_card" in spec.cards!).toBe(false);
    expect(spec.layout).toContainEqual(["vms"]);
  });
});
