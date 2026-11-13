import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { action_plan, cmd_result, CollectResult, type ActionPlan } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { HostControl, parse_power } from "../../src/monitors/host_control.ts";
import type { ButtonSpec, DialogSpec } from "../../src/shared/ui_spec.ts";
import { make_plugin, store_of } from "../harness.ts";

const ppd = `  performance:
    CpuDriver:\tintel_pstate
    Degraded:   no

* balanced:
    CpuDriver:\tintel_pstate
    PlatformDriver:\tplatform_profile

  power-saver:
    CpuDriver:\tintel_pstate
`;

const tuned = `Available profiles:
- balanced                    - General non-specialized tuned profile
- powersave                   - Optimize for low power consumption
- throughput-performance      - Broadly applicable tuning
Current active profile: powersave
`;

const actions_all = ["reboot", "shutdown", "suspend", "power_profile", "identify"];
const has_sh = spawnSync("sh", ["-c", "true"]).status === 0;

const config = (extra: PluginConfig = {}): PluginConfig => ({ name: "host1 control", id: "host1-control", ssh_config: { host: "host1" }, ...extra });
const results = ({ power = `backend=ppd\n${ppd}`, sleep = "freeze mem disk" } = {}) => [cmd_result(0, power, ""), cmd_result(0, sleep, "")];
const host_control = (extra: PluginConfig = {}): HostControl => make_plugin(HostControl, config(extra));

function apply(plugin: HostControl, result: unknown): void {
  store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, result as CollectResult);
}

function collected(extra: PluginConfig = {}, power?: string): HostControl {
  const plugin = host_control(extra);
  apply(plugin, plugin.parse(results(power === undefined ? {} : { power })));
  return plugin;
}

const valid_shell = (text: string): boolean => spawnSync("sh", ["-n", "-c", text]).status === 0;

describe("parse power", () => {
  it("marks the current power-profiles-daemon profile", () => {
    expect(parse_power(`backend=ppd\n${ppd}`)).toEqual({ backend: "ppd", current: "balanced", profiles: ["performance", "balanced", "power-saver"] });
  });

  it("reads tuned", () => {
    const power = parse_power(`backend=tuned\n${tuned}`);
    expect(power.current).toBe("powersave");
    expect(power.profiles).toEqual(["balanced", "powersave", "throughput-performance"]);
  });

  it("reads the platform profile", () => {
    expect(parse_power("backend=sysfs\ncurrent=quiet\nchoices=quiet balanced performance")).toEqual({ backend: "sysfs", current: "quiet", profiles: ["quiet", "balanced", "performance"] });
  });

  it("reads nothing available", () => {
    expect(parse_power("backend=none")).toEqual({ backend: "none", current: null, profiles: [] });
    expect(parse_power("")).toEqual({ backend: "none", current: null, profiles: [] });
  });
});

describe("collection", () => {
  it("calls everything collected online", () => {
    const result = host_control().parse(results());
    expect(result.status).toBe("online");
    expect(result.metrics).toEqual({ power_profiles: 3.0, suspend_supported: 1.0 });
    expect((result.snapshot as { power: { current: string } }).power.current).toBe("balanced");
    expect((result.snapshot as { can_suspend: boolean }).can_suspend).toBe(true);
  });

  it("stays online with tools missing", () => {
    const result = host_control().parse([cmd_result(0, "backend=none", ""), cmd_result(1, "", "No such file")]);
    expect(result.status).toBe("online");
    expect(result.metrics).toEqual({ power_profiles: 0.0, suspend_supported: 0.0 });
    expect(result.logs.some(([, level]) => level === "WARNING" || level === "ERROR")).toBe(false);
  });

  it.skipIf(!has_sh)("writes valid shell", () => {
    for (const privilege of ["sudo", "none"]) for (const each of host_control({ privilege }).commands()) expect(valid_shell(each.text)).toBe(true);
  });

  it("never reads boot entries", () => {
    const texts = host_control().commands().map((each) => each.text);
    expect(texts).toHaveLength(2);
    expect(texts.some((text) => ["bootctl", "grub", "efibootmgr"].some((tool) => text.includes(tool)))).toBe(false);
  });

  it.skipIf(!has_sh)("runs the power command against a fake tool", () => {
    const directory = mkdtempSync(join(tmpdir(), "x-monitor-host-control-"));
    try {
      const bin_dir = join(directory, "bin");
      mkdirSync(bin_dir);
      writeFileSync(join(bin_dir, "powerprofilesctl"), `#!/bin/sh\ncat <<'EOF'\n${ppd}EOF\n`);
      chmodSync(join(bin_dir, "powerprofilesctl"), 0o755);
      const [power_command] = host_control({ privilege: "none" }).commands();
      const outcome = spawnSync("sh", ["-c", power_command.text], { encoding: "utf8", env: { ...process.env, PATH: `${bin_dir}:${process.env.PATH ?? ""}` } });
      expect(parse_power(outcome.stdout).current).toBe("balanced");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("allow list", () => {
  it.each(["reboot", "shutdown", "suspend", "identify", "identify_off"])("refuses %s by default", (action) => {
    const plan = collected().plan_action(action) as CollectResult;
    expect(plan).toBeInstanceOf(CollectResult);
    expect(plan.success).toBe(false);
    expect(plan.status).toBeNull();
    expect(plan.logs[0][0].endsWith("refused: not in allow")).toBe(true);
    expect(plan.logs[0][0]).toContain("host1");
  });

  it("refuses dialog actions", () => {
    expect((collected({ allow: ["reboot"] }).plan_action("power_profile", { profile: "balanced" }) as CollectResult).logs[0][0]).toContain("refused: not in allow");
  });

  it("offers no next-boot action", () => expect(collected({ allow: ["next_boot", "reboot"] }).plan_action("next_boot", { entry: "nixos-generation-100.conf" })).toBeNull());
  it("leaves an unknown action unhandled", () => expect(collected({ allow: actions_all }).plan_action("format_disk")).toBeNull());

  it("logs a refusal to the events", () => {
    const plugin = collected();
    apply(plugin, plugin.plan_action("reboot"));
    expect(store_of(plugin).plugin_events("host1-control", "", "", 1)[0].message).toContain("Reboot on host1 refused: not in allow");
  });
});

describe("power actions", () => {
  it.each([["reboot", "reboot"], ["shutdown", "poweroff"], ["suspend", "suspend"]])("runs %s through sudo", (action, verb) => {
    expect(collected({ allow: [action] }).plan_action(action)).toEqual(action_plan(`sudo -n systemctl ${verb}`));
  });

  it("runs without sudo when asked", () => expect(collected({ allow: ["reboot"], privilege: "none" }).plan_action("reboot")).toEqual(action_plan("systemctl reboot")));

  it("logs success", () => {
    const outcome = collected({ allow: ["suspend"] }).interpret_action("suspend", cmd_result(0, "", "")) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(outcome.logs).toEqual([["Suspend on host1: done", "INFO"]]);
  });

  it.each(["Connection lost", "", "Agent disconnected", "Timed out after 60.0s"])("takes a dropped connection after sending as success (%s)", (stderr) => {
    const outcome = collected({ allow: ["reboot"] }).interpret_action("reboot", cmd_result(-1, "", stderr)) as CollectResult;
    expect(outcome.success).toBe(true);
    expect(outcome.logs[0][0]).toContain("dropped the connection");
  });

  it.each(["Connect failed: [Errno 113] No route to host", "Agent 'host1' is not connected"])("takes never reaching the host as failure (%s)", (stderr) => {
    const outcome = collected({ allow: ["shutdown"] }).interpret_action("shutdown", cmd_result(-1, "", stderr)) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][1]).toBe("ERROR");
    expect(outcome.status).toBeNull();
  });

  it("takes a dropped connection as failure for an action that keeps the host up", () => {
    expect((collected({ allow: ["power_profile"] }).interpret_action("power_profile", cmd_result(-1, "", "Connection lost"), { profile: "balanced" }) as CollectResult).success).toBe(false);
  });

  it("explains a sudo refusal", () => {
    const outcome = collected({ allow: ["reboot"] }).interpret_action("reboot", cmd_result(1, "", "sudo: a password is required")) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.logs[0][0]).toContain("sudo refused (sudo: a password is required)");
    expect(outcome.logs[0][0]).toContain("without a password");
  });

  it("keeps the error of any other failure", () => {
    expect((collected({ allow: ["suspend"] }).interpret_action("suspend", cmd_result(1, "", "Sleep verb not supported")) as CollectResult).logs[0][0]).toBe("Suspend on host1 failed: Sleep verb not supported");
  });
});

describe("power profile", () => {
  it("sets it through power-profiles-daemon", () => {
    expect(collected({ allow: ["power_profile"] }).plan_action("power_profile", { profile: "power-saver" })).toEqual(action_plan("sudo -n powerprofilesctl set power-saver"));
  });

  it("sets it through tuned", () => {
    expect(collected({ allow: ["power_profile"] }, `backend=tuned\n${tuned}`).plan_action("power_profile", { profile: "balanced" })).toEqual(action_plan("sudo -n tuned-adm profile balanced"));
  });

  it("sets the platform profile", () => {
    expect(collected({ allow: ["power_profile"] }, "backend=sysfs\ncurrent=quiet\nchoices=quiet performance").plan_action("power_profile", { profile: "performance" })).toEqual(action_plan("echo performance | sudo -n tee /sys/firmware/acpi/platform_profile >/dev/null"));
  });

  it("refuses an unknown profile", () => {
    const plan = collected({ allow: ["power_profile"] }).plan_action("power_profile", { profile: "turbo; rm -rf /" }) as CollectResult;
    expect(plan).toBeInstanceOf(CollectResult);
    expect(plan.success).toBe(false);
    expect(plan.logs[0][0]).toContain("unknown profile");
  });

  it("names the profile in the outcome", () => {
    expect((collected({ allow: ["power_profile"] }).interpret_action("power_profile", cmd_result(0, "", ""), { profile: "balanced" }) as CollectResult).logs[0][0]).toBe("Power profile balanced on host1: done");
  });
});

describe("identify", () => {
  it("locates and stops with ledctl", () => {
    const plugin = collected({ allow: ["identify"], identify_device: "/dev/sda" });
    expect(plugin.identify_method).toBe("ledctl");
    expect(plugin.plan_action("identify")).toEqual(action_plan("sudo -n ledctl locate=/dev/sda"));
    expect(plugin.plan_action("identify_off")).toEqual(action_plan("sudo -n ledctl locate_off=/dev/sda"));
  });

  it("beeps by default", () => {
    const plugin = collected({ allow: ["identify"] });
    const plan = plugin.plan_action("identify") as ActionPlan;
    expect(plugin.identify_method).toBe("beep");
    expect(plan.command).toContain("sudo -n beep -r 5");
    expect(plan.command).toContain("printf '\\a' | sudo -n tee /dev/console");
    if (has_sh) expect(valid_shell(plan.command)).toBe(true);
    expect((plugin.plan_action("identify_off") as CollectResult).logs[0][0]).toContain("stops by itself");
  });

  it("refuses ledctl without a device", () => {
    expect((collected({ allow: ["identify"], identify_method: "ledctl" }).plan_action("identify") as CollectResult).logs[0][0]).toContain("identify_device is not set");
  });

  it("gates identify_off by identify", () => {
    expect((collected({ identify_device: "/dev/sda" }).plan_action("identify_off") as CollectResult).logs[0][0]).toContain("not in allow");
  });
});

// Fills a confirm template as the page does: the plugin's attributes and the dialog's row values.
function substitute(template: string, row: Record<string, string>, plugin: HostControl): string {
  return template.replaceAll("{plugin.target}", plugin.target).replace(/\{row\[(\w+)\]\}/g, (_, key: string) => row[key] ?? "");
}

describe("page", () => {
  it("reads the cards from the snapshot", () => {
    const plugin = collected();
    expect(plugin.profile_text).toBe("balanced");
    expect(plugin.suspend_text).toBe("Supported");
    expect(plugin.power_profiles).toEqual(["performance", "balanced", "power-saver"]);
  });

  it("shows placeholders before collection", () => {
    const plugin = host_control();
    expect(plugin.profile_text).toBe("n/a");
    expect(plugin.suspend_text).toBe("Unsupported");
  });

  it("shows the buttons the allow list offers", () => {
    const plugin = collected({ allow: ["reboot", "power_profile"] });
    const buttons = plugin.UI_SPEC.buttons!.controls;
    expect(buttons.filter((button) => (button.visible_if as (plugin: unknown) => boolean)(plugin)).map((button) => button.id)).toEqual(["reboot", "power_profile"]);
  });

  it("names the host in every confirm", () => {
    const plugin = collected({ allow: actions_all, identify_device: "/dev/sda" });
    const spec = plugin.UI_SPEC;
    for (const button of spec.buttons!.controls as ButtonSpec[]) {
      const template = button.confirm || (spec.dialogs![button.dialog!] as DialogSpec).confirm!;
      expect(substitute(template, { profile: "balanced" }, plugin)).toContain("host1");
    }
  });

  it("shows no boot entries", () => {
    const spec = collected({ allow: ["next_boot", "reboot"] }).UI_SPEC;
    expect("next_boot" in spec.dialogs!).toBe(false);
    expect("tables" in spec).toBe(false);
    expect(spec.buttons!.controls.map((button) => button.id)).not.toContain("next_boot");
    expect(spec.layout!.flat().some((cell) => cell === "next_boot_card" || cell === "boot_entries")).toBe(false);
  });
});
