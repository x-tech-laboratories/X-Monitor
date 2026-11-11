import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmd_result, type ActionPlan, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { oneshot_state, SystemdService } from "../../src/monitors/systemd_service.ts";
import { make_plugin, store_of } from "../harness.ts";

const continuous_config: PluginConfig = { name: "test-nginx", id: "test-nginx", service_name: "nginx.service", interval: 60, ssh_config: { host: "test.host" } };
const oneshot_config: PluginConfig = { name: "test-upgrade", id: "test-upgrade", service_name: "nixos-upgrade.service", interval: 3600, max_age: "1w", ssh_config: { host: "test.host" } };

const now = () => Math.trunc(Date.now() / 1000);

function oneshot_output({ result = "success", exit_code = "0", epoch = null as number | null, active = "inactive", sub = "dead" } = {}): string {
  return `result=${result} exit=${exit_code} epoch=${epoch ?? now() - 3600} active=${active} sub=${sub}`;
}

type Output = [exit_code: number, stdout: string, stderr: string];

// Runs parse on outputs in commands() order, the boot state defaulting to enabled, and writes the result.
function run(plugin: SystemdService, outputs: Output[]): CollectResult {
  const all = outputs.length === 2 ? [...outputs, [0, "enabled", ""] as Output] : outputs;
  const result = plugin.parse(all.map(([code, stdout, stderr]) => cmd_result(code, stdout, stderr)));
  store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, result);
  return result;
}

const continuous = (extra: PluginConfig = {}): SystemdService => make_plugin(SystemdService, { ...continuous_config, ...extra });
const oneshot = (extra: PluginConfig = {}): SystemdService => make_plugin(SystemdService, { ...oneshot_config, ...extra });
const latest_status = (plugin: SystemdService) => store_of(plugin).latest_status(plugin.id);
const latest_metric = (plugin: SystemdService, name: string) => store_of(plugin).latest_metric(plugin.id, name)?.value ?? null;
const log_lines = (plugin: SystemdService) => store_of(plugin).log_lines(plugin.target, "", 100).filter((line) => line.plugin_id === plugin.id);

describe("continuous mode", () => {
  it("calls an active service online", () => {
    const plugin = continuous();
    run(plugin, [[0, "active", ""], [0, "log line", ""]]);
    expect(latest_status(plugin)).toBe("online");
  });

  it("warns on an inactive service", () => {
    const plugin = continuous();
    run(plugin, [[1, "inactive", ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("records the active metric", () => {
    const plugin = continuous();
    run(plugin, [[0, "active", ""], [0, "", ""]]);
    expect(latest_metric(plugin, "active")).toBeCloseTo(1.0);
  });

  it("records the inactive metric", () => {
    const plugin = continuous();
    run(plugin, [[1, "inactive", ""], [0, "", ""]]);
    expect(latest_metric(plugin, "active")).toBeCloseTo(0.0);
  });

  it("calls a journal failure unavailable", () => {
    const plugin = continuous();
    run(plugin, [[0, "active", ""], [-1, "", "journalctl: permission denied"]]);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("keeps the journal lines", () => {
    const plugin = continuous();
    run(plugin, [[0, "active", ""], [0, "2024-05-01T12:00:00+0000 host nginx[1]: started", ""]]);
    const rows = log_lines(plugin);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("started");
  });

  it("deduplicates a repeated journal line", () => {
    const plugin = continuous();
    const line = "2024-05-01T12:00:00+0000 host nginx[1]: same message";
    for (let index = 0; index < 2; index++) run(plugin, [[0, "active", ""], [0, line, ""]]);
    expect(log_lines(plugin)).toHaveLength(1);
  });

  it("classifies an error line as an error", () => {
    const plugin = continuous();
    run(plugin, [[0, "active", ""], [0, "2024-05-01T12:00:00+0000 host nginx[1]: FAILED to bind", ""]]);
    expect(log_lines(plugin)[0].level).toBe("ERROR");
  });
});

describe("oneshot mode", () => {
  it("calls a successful recent run online", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output(), ""], [0, "logs", ""]]);
    expect(latest_status(plugin)).toBe("online");
  });

  it("records the boot state", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output(), ""], [0, "", ""], [1, "disabled", ""]]);
    expect(latest_metric(plugin, "enabled")).toBeCloseTo(0.0);
  });

  it("fails a unit that never ran", () => {
    const plugin = oneshot();
    run(plugin, [[0, "result=empty exit=empty epoch=0 active=inactive sub=dead", ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails a failed result", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ result: "failed", exit_code: "1" }), ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("fails a run older than max_age", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ epoch: now() - 14 * 24 * 3600 }), ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls a run within max_age online", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ epoch: now() - 3 * 24 * 3600 }), ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls a running unit online", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ active: "activating", sub: "start" }), ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "is_running")).toBeCloseTo(1.0);
  });

  it("counts an active running substate as running", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ active: "active", sub: "running" }), ""], [0, "", ""]]);
    expect(latest_metric(plugin, "is_running")).toBeCloseTo(1.0);
  });

  it("does not mark an inactive unit running", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output(), ""], [0, "", ""]]);
    expect(latest_metric(plugin, "is_running")).toBeCloseTo(0.0);
  });

  it("takes exit code zero as success over the result", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ result: "exit-code", exit_code: "0" }), ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls a failed query unavailable", () => {
    const plugin = oneshot();
    run(plugin, [[-1, "", "SSH timeout"], [-1, "", "SSH timeout"]]);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("records the last run time", () => {
    const plugin = oneshot();
    const epoch = now() - 100;
    run(plugin, [[0, oneshot_output({ epoch }), ""], [0, "", ""]]);
    expect(latest_metric(plugin, "last_run_epoch")).toBeCloseTo(epoch);
  });

  it("records a successful last run", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output(), ""], [0, "", ""]]);
    expect(latest_metric(plugin, "last_run_success")).toBeCloseTo(1.0);
  });

  it("records a failed last run", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ result: "failed", exit_code: "1" }), ""], [0, "", ""]]);
    expect(latest_metric(plugin, "last_run_success")).toBeCloseTo(0.0);
  });
});

describe("journal sourced state", () => {
  it("calls a journal success within max_age online", () => {
    const plugin = oneshot();
    const epoch = now() - 3600;
    run(plugin, [[0, `result=success exit=0 epoch=${epoch} active=inactive sub=dead source=journal`, ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "last_run_epoch")).toBe(epoch);
  });

  it("fails a journal failure", () => {
    const plugin = oneshot();
    const epoch = now() - 3600;
    run(plugin, [[0, `result=timeout exit=empty epoch=${epoch} active=inactive sub=dead source=journal`, ""], [0, "", ""]]);
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "last_run_success")).toBe(0.0);
  });
});

describe.skipIf(spawnSync("bash", ["-c", "true"]).status !== 0)("oneshot state script", () => {
  let bin_dir = "";

  beforeEach(() => {
    bin_dir = mkdtempSync(join(tmpdir(), "x-monitor-systemd-"));
  });

  afterEach(() => {
    rmSync(bin_dir, { recursive: true, force: true });
  });

  function stub(name: string, body: string): void {
    const path = join(bin_dir, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
    chmodSync(path, 0o755);
  }

  // Runs the oneshot state script under bash against stub systemctl and journalctl on PATH.
  function run_state_script(plugin: SystemdService, { exit_ts = "", inactive_ts = "", journal_line = "", result = "success" } = {}): [tokens: Record<string, string>, journal_called: boolean] {
    const calls = join(bin_dir, "journalctl.calls");
    stub("systemctl", 'while [ $# -gt 0 ]; do case "$1" in -p) prop="$2"; shift;; esac; shift; done\n' + 'case "$prop" in\n' + `  Result) echo "${result}";;\n` + "  ExecMainStatus) echo 0;;\n" + "  ActiveState) echo inactive;;\n" + "  SubState) echo dead;;\n" + `  ExecMainExitTimestamp) echo "${exit_ts}";;\n` + `  InactiveEnterTimestamp) echo "${inactive_ts}";;\n` + "esac\n");
    stub("journalctl", `echo "$@" >> "${calls}"\nprintf "%s" "${journal_line}"\n`);
    const outcome = spawnSync("bash", ["-c", plugin.oneshot_state_command()], { encoding: "utf8", env: { ...process.env, PATH: `${bin_dir}:${process.env.PATH ?? ""}` } });
    expect(outcome.status).toBe(0);
    const tokens = Object.fromEntries(outcome.stdout.trim().split(/\s+/).map((token) => [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]));
    return [tokens, existsSync(calls)];
  }

  it("prefers the systemd timestamp without touching the journal", () => {
    const [tokens, journal_called] = run_state_script(oneshot(), { exit_ts: "Sat 2026-08-29 08:03:34 EST", journal_line: "1700000000.000000 host systemd[1]: nixos-upgrade.service: Deactivated successfully." });
    expect(tokens.source).toBe("systemd");
    expect(Number(tokens.epoch)).toBeGreaterThan(1700000000);
    expect(journal_called).toBe(false);
  });

  it("takes the epoch from the journal when the timestamps are empty", () => {
    const [tokens, journal_called] = run_state_script(oneshot(), { journal_line: "1788008614.198164 Heimdall systemd[1]: nixos-upgrade.service: Deactivated successfully." });
    expect(journal_called).toBe(true);
    expect(tokens).toEqual({ result: "success", exit: "0", epoch: "1788008614", active: "inactive", sub: "dead", source: "journal" });
  });

  it("carries the result of a journal failure line", () => {
    const [tokens] = run_state_script(oneshot(), { journal_line: "1788441135.956421 Heimdall systemd[1]: nixos-upgrade.service: Failed with result 'timeout'." });
    expect(tokens.epoch).toBe("1788441135");
    expect(tokens.result).toBe("timeout");
    expect(tokens.exit).toBe("empty");
    expect(tokens.source).toBe("journal");
  });

  it("still reads never ran without a journal line", () => {
    const [tokens, journal_called] = run_state_script(oneshot());
    expect(journal_called).toBe(true);
    expect(tokens.epoch).toBe("0");
    expect(tokens.source).toBe("systemd");
  });
});

describe("max age parsing", () => {
  it("reads a human duration", () => expect(oneshot({ max_age: "1w" }).max_age).toBe(604800));
  it("reads a number", () => expect(oneshot({ max_age: 3600 }).max_age).toBe(3600));
  it("is continuous without max_age", () => expect(continuous().max_age).toBeNull());
});

describe("actions", () => {
  it("restarts", () => {
    const plugin = continuous();
    expect((plugin.plan_action("restart_service") as ActionPlan).command).toBe("sudo systemctl restart nginx.service");
    expect(plugin.interpret_action("restart_service", cmd_result(0, "", ""))).toBe(true);
  });

  it("reports a failed restart", () => expect((continuous().interpret_action("restart_service", cmd_result(1, "", "Unit not found")) as CollectResult).success).toBe(false));

  it("stops", () => {
    const plugin = continuous();
    expect((plugin.plan_action("stop_service") as ActionPlan).command).toBe("sudo systemctl stop nginx.service");
    expect(plugin.interpret_action("stop_service", cmd_result(0, "", ""))).toBe(true);
  });

  it("disables", () => {
    const plugin = continuous();
    expect((plugin.plan_action("disable_service") as ActionPlan).command).toBe("sudo systemctl disable nginx.service");
    expect(plugin.interpret_action("disable_service", cmd_result(0, "", ""))).toBe(true);
  });

  it("reports a failed disable", () => expect((continuous().interpret_action("disable_service", cmd_result(1, "", "error")) as CollectResult).success).toBe(false));

  it("plans nothing for an unknown action", () => expect(continuous().plan_action("nuke")).toBeNull());

  it("gives a continuous unit restart and two switches", () => {
    expect(continuous().get_actions()).toEqual([
      { name: "Restart Service", action_id: "restart_service", variant: "primary", icon: "play_arrow" },
      { name: "Running", kind: "toggle", metric: "active", icon: "play_circle", on_action_id: "start_service", off_action_id: "stop_service", action_id: "active" },
      { name: "Start on Boot", kind: "toggle", metric: "enabled", icon: "power_settings_new", on_action_id: "enable_service", off_action_id: "disable_service", action_id: "enabled" },
    ]);
  });

  it("keeps a oneshot unit's stop button", () => {
    expect(oneshot().get_actions().map((action) => (action.kind === "toggle" ? action.name : action.action_id))).toEqual(["restart_service", "stop_service", "Start on Boot"]);
  });

  it("starts", () => {
    const plugin = continuous();
    expect((plugin.plan_action("start_service") as ActionPlan).command).toBe("sudo systemctl start nginx.service");
    expect(plugin.interpret_action("start_service", cmd_result(0, "", ""))).toBe(true);
  });

  it("names start in a failed start", () => expect((continuous().interpret_action("start_service", cmd_result(1, "", "boom")) as CollectResult).logs[0][0]).toContain("systemctl start failed"));

  it("queries the boot state", () => expect(continuous().commands().at(-1)!.text).toBe("systemctl is-enabled nginx.service"));

  it.each([[[0, "enabled", ""], 1.0], [[0, "enabled-runtime", ""], 1.0], [[1, "disabled", ""], 0.0]] as [Output, number][])("records boot state %o as %d", (answer, expected) => {
    const plugin = continuous();
    run(plugin, [[0, "active", ""], [0, "", ""], answer]);
    expect(latest_metric(plugin, "enabled")).toBeCloseTo(expected);
  });

  it.each([[[0, "static", ""]], [[1, "masked", ""]], [[1, "", "Failed to get unit file state"]]] as [Output][])("records no boot state for a unit that cannot be switched (%o)", (answer) => {
    expect("enabled" in run(continuous(), [[0, "active", ""], [0, "", ""], answer]).metrics).toBe(false);
  });

  it("writes the unit file only to an allowed path", () => {
    const plan = continuous().plan_action("write_unit_file", { content: "[Unit]\n" }) as ActionPlan;
    expect(plan.command).toContain("P=$(systemctl show -p FragmentPath --value nginx.service); ");
    expect(plan.command).toContain(`if [ -z "$P" ] || [ "$P" = 'n/a' ]; then`);
    expect(plan.command).toContain(Buffer.from("[Unit]\n").toString("base64"));
  });
});

describe("pushed events", () => {
  it("follows the unit's journal", () => {
    expect(continuous().subscriptions()).toEqual([{ id: "test-nginx", kind: "journal", params: { unit: "nginx.service" } }]);
    expect(continuous({ service_name: null }).subscriptions()).toEqual([]);
  });

  it("turns a pushed line into a log line and leaves the status alone", () => {
    const result = continuous().parse_event("test-nginx", { message: "worker FAILED" }, 1_700_000_000)!;
    expect(result.status).toBeNull();
    expect(result.log_lines[0][0]).toBe("worker FAILED");
    expect(result.log_lines[0][1]).toBe("ERROR");
    expect(result.log_lines[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("ignores an empty pushed line", () => expect(continuous().parse_event("test-nginx", { message: " " }, 0)).toBeNull());
});

describe("page", () => {
  it("describes the continuous page", () => {
    const plugin = continuous({ allow_unit_file_edit: true });
    run(plugin, [[0, "active", ""], [0, "", ""]]);
    const data = plugin.custom_view().data as Record<string, unknown>;
    expect(plugin.custom_view().kind).toBe("systemd_service");
    expect(data.mode).toBe("continuous");
    expect((data.status_card as { value: number }).value).toBe(1);
    expect(data.last_collection).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect((data.inline_layout as unknown[][])[0][0]).toEqual({ widget: "host_card", visible: false });
    expect((data.dialogs as Record<string, { title: string }>).view_unit_file.title).toBe("Unit file: nginx.service");
    expect((data.unit_file as { buttons: { visible: boolean }[] }).buttons.at(-1)!.visible).toBe(true);
  });

  it("describes the oneshot page", () => {
    const plugin = oneshot();
    run(plugin, [[0, oneshot_output({ result: "failed", exit_code: "1" }), ""], [0, "", ""]]);
    const data = plugin.custom_view().data as Record<string, unknown>;
    expect(data.mode).toBe("oneshot");
    expect(data.max_age_text).toBe("1 Week");
    expect(data.state).toEqual({ text: "IDLE", level: "online" });
    expect(data.result).toEqual({ text: "FAILED", level: "failed" });
  });

  it("shows a running oneshot unit without its history", () => {
    expect(oneshot_state(1, 100, 1, 60, 200)).toEqual({ state: { text: "RUNNING", level: "warning" }, history_visible: false, result: null, age: null });
    expect(oneshot_state(0, 0, 0, 60, 200).state).toEqual({ text: "NEVER RUN", level: "failed" });
    expect(oneshot_state(null, null, null, 60, 200).state).toEqual({ text: "UNKNOWN", level: "unavailable" });
    expect(oneshot_state(0, 100, 1, 60, 200).age!.level).toBe("failed");
  });
});
