import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cmd_result, CollectResult, type CmdResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { json_dumps } from "../../src/monitors/base/python_text.ts";
import { NixosUpgrade, split_eval_output } from "../../src/monitors/nixos_upgrade.ts";
import { make_plugin, store_of } from "../harness.ts";

const base_config: PluginConfig = { name: "test-nixos", id: "test-nixos", interval: 300, flake: "/etc/nixos", ssh_config: { host: "test.host" } };

const CURRENT = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nixos-system-host-26.11";
const TARGET = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-host-26.11";
const KERNEL = "/nix/store/cccccccccccccccccccccccccccccccc-linux-6.18.46/bzImage";
const NEW_KERNEL = "/nix/store/dddddddddddddddddddddddddddddddd-linux-6.19.1/bzImage";
const NEWER = "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-nixos-system-host-26.11";

const latest_status = (plugin: NixosUpgrade) => store_of(plugin).store.statuses.get("test-nixos")?.state ?? null;
const latest_metric = (plugin: NixosUpgrade, name: string) => store_of(plugin).latest_metric("test-nixos", name)?.value ?? null;

const now_epoch = () => Math.trunc(Date.now() / 1000);

// The stdout the probe script produces on a NixOS target.
function probe(options: { current?: string; booted?: string; switched?: number; generation?: number; version?: string; kernels?: [string, string] } = {}): CmdResult {
  const current = options.current ?? CURRENT;
  const version = options.version ?? "26.11.20260826.9fbb54b";
  const [booted_kernel, current_kernel] = options.kernels ?? [KERNEL, KERNEL];
  const lines = [
    "hostname=host",
    `current=${current}`,
    `booted=${options.booted ?? current}`,
    `switched=${options.switched ?? now_epoch() - 3600}`,
    `profile=system-${options.generation ?? 210}-link`,
    `version=${version}`,
    `version_json={"nixosVersion":"${version}"}`,
  ];
  for (const part of ["initrd", "kernel", "kernel-modules", "systemd"]) {
    lines.push(`booted_part=${booted_kernel}/${part}`);
    lines.push(`current_part=${current_kernel}/${part}`);
  }
  return cmd_result(0, lines.join("\n") + "\n", "");
}

// The stdout `nix flake metadata --json` produces.
function metadata(options: { revision?: string; last_modified?: number; inputs?: Record<string, number>; dirty?: boolean } = {}): CmdResult {
  const last_modified = options.last_modified ?? now_epoch() - 7200;
  const inputs = options.inputs ?? { nixpkgs: now_epoch() - 86400 };
  const nodes: Record<string, unknown> = { root: { inputs: Object.fromEntries(Object.keys(inputs).map((name) => [name, name])) } };
  for (const [name, stamp] of Object.entries(inputs)) nodes[name] = { locked: { lastModified: stamp, rev: "0".repeat(40) } };
  const rev_key = options.dirty ? "dirtyRev" : "rev";
  return cmd_result(0, json_dumps({
    lastModified: last_modified,
    locked: { [rev_key]: options.revision ?? "f".repeat(40), lastModified: last_modified },
    locks: { nodes, root: "root", version: 7 },
  }), "");
}

function plugin_of(extra: PluginConfig = {}): NixosUpgrade {
  return make_plugin(NixosUpgrade, { ...base_config, ...extra });
}

function apply(plugin: NixosUpgrade, result: CollectResult): void {
  store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, result);
}

// The output the evaluation script prints once both of its commands have run.
function eval_output(eval_result: CmdResult, metadata_result: CmdResult): string {
  const sections: string[] = [];
  for (const [name, result] of [["eval", eval_result], ["metadata", metadata_result]] as const) {
    for (const [stream, text] of [["stdout", result.stdout], ["stderr", result.stderr], ["exit", String(result.exit_code)]]) {
      sections.push(`@@x-monitor-eval ${name} ${stream}\n${text}\n`);
    }
  }
  return sections.join("");
}

// The raw stdout one poll_command produces on the target.
function poll(size: number, exit_code: number | null, alive: boolean, out: string): CmdResult {
  return cmd_result(0, `===XMONITOR_SIZE===\n${size}\n===XMONITOR_EXIT===\n${exit_code ?? ""}\n===XMONITOR_ALIVE===\n${alive ? 1 : 0}\n===XMONITOR_OUT===\n${out}`, "");
}

// Whether the plugin's next cycle launches an evaluation beside its probe.
function launches_eval(plugin: NixosUpgrade): boolean {
  const commands = plugin.commands();
  return commands.length === 2 && commands[1].text.includes("setsid");
}

// Runs one cycle on the plugin's commands, feeding it these outputs.
function cycle(plugin: NixosUpgrade, ...outputs: CmdResult[]): CollectResult {
  plugin.commands();
  const result = plugin.parse(outputs);
  apply(plugin, result);
  return result;
}

// Drives the plugin until this cycle's probe is judged, launching and finishing an evaluation whenever one is due.
function collect(plugin: NixosUpgrade, options: { probe?: CmdResult; eval_result?: CmdResult; metadata?: CmdResult; pid?: number } = {}): CollectResult {
  const probe_result = options.probe ?? probe();
  if (!launches_eval(plugin)) return cycle(plugin, probe_result);
  cycle(plugin, probe_result, cmd_result(0, `${options.pid ?? 4343}\n`, ""));
  const commands = plugin.commands();
  expect(commands).toHaveLength(2);
  expect(commands[1].text).toContain("XMONITOR_SIZE");
  const eval_result = options.eval_result ?? cmd_result(0, TARGET + "\n", "");
  const metadata_result = options.metadata ?? metadata();
  const code = eval_result.exit_code === 0 && metadata_result.exit_code === 0 ? 0 : 1;
  const result = plugin.parse([probe_result, poll(1, code, false, eval_output(eval_result, metadata_result))]);
  apply(plugin, result);
  return result;
}

function stored_state(plugin: NixosUpgrade): Record<string, unknown> {
  return JSON.parse(plugin.data.latest_metric("flake_eval_epoch")!.metadata!) as Record<string, unknown>;
}

// Ages the stored evaluation by `seconds`, as if that much time had passed.
function rewind_eval(plugin: NixosUpgrade, seconds: number): void {
  const state = stored_state(plugin);
  state.evaluated_epoch = now_epoch() - seconds;
  apply(plugin, new CollectResult({ metrics: { flake_eval_epoch: state.evaluated_epoch as number }, metadata: { flake_eval_epoch: json_dumps(state) } }));
}

// Runs the cycle that launches an evaluation, returning its job row.
function launch_eval(plugin: NixosUpgrade, pid = 4343) {
  expect(launches_eval(plugin)).toBe(true);
  cycle(plugin, probe(), cmd_result(0, `${pid}\n`, ""));
  return plugin.jobs!.running_side("eval")!;
}

// Runs one cycle that polls the running evaluation beside the probe.
function poll_eval(plugin: NixosUpgrade, poll_result: CmdResult, probe_result: CmdResult = probe()): CollectResult {
  const commands = plugin.commands();
  expect(commands).toHaveLength(2);
  expect(commands[1].text).toContain("XMONITOR_SIZE");
  const result = plugin.parse([probe_result, poll_result]);
  apply(plugin, result);
  return result;
}

// A poll of an evaluation that has finished with these results.
function finished(eval_result: CmdResult = cmd_result(0, TARGET + "\n", ""), metadata_result: CmdResult = metadata(), code = 0): CmdResult {
  return poll(1, code, false, eval_output(eval_result, metadata_result));
}

describe("drift", () => {
  it("calls a matching closure online", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", "") });
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "up_to_date")).toBe(1.0);
  });

  it("warns on a differing closure", () => {
    const plugin = plugin_of();
    collect(plugin);
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "up_to_date")).toBe(0.0);
  });

  it("takes the drift status from config", () => {
    const plugin = plugin_of({ drift_status: "failed" });
    collect(plugin);
    expect(latest_status(plugin)).toBe("failed");
  });

  it("falls back to warning for an unrecognised drift status", () => {
    expect(plugin_of({ drift_status: "catastrophe" }).drift_status).toBe("warning");
  });

  it("logs both closures on drift", () => {
    const message = collect(plugin_of()).logs.find(([text]) => text.includes("out of date"))![0];
    expect(message).toContain(TARGET);
    expect(message).toContain(CURRENT);
  });

  it("re-evaluates a new closure before calling it drift", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", "") });
    const result = collect(plugin, { probe: probe({ current: NEWER }) });
    expect("up_to_date" in result.metrics).toBe(false);
    expect(latest_status(plugin)).toBe("online");
    expect(launches_eval(plugin)).toBe(true);
  });

  it("calls a new closure that still differs after evaluation drift", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", "") });
    collect(plugin, { probe: probe({ current: NEWER }) });
    collect(plugin, { probe: probe({ current: NEWER }), eval_result: cmd_result(0, TARGET + "\n", "") });
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "up_to_date")).toBe(0.0);
  });

  it("fails a failed evaluation", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(1, "", "error: attribute 'nope' missing") });
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "up_to_date")).toBeNull();
  });

  it("calls a non-NixOS host unavailable", () => {
    const plugin = plugin_of();
    collect(plugin, { probe: cmd_result(0, "current=\nbooted=\n", "") });
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable target unavailable", () => {
    const plugin = plugin_of();
    collect(plugin, { probe: cmd_result(255, "", "ssh: connect failed") });
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable eval host unavailable", () => {
    const plugin = plugin_of();
    cycle(plugin, probe(), cmd_result(-1, "", "Agent 'x' is not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "up_to_date")).toBeNull();
    expect(plugin.jobs!.running_side("eval")).toBeNull();
  });

  it("folds a failed launch as a failed evaluation", () => {
    const plugin = plugin_of();
    cycle(plugin, probe(), cmd_result(1, "", "setsid: not found"));
    expect(latest_status(plugin)).toBe("failed");
    expect(stored_state(plugin).eval_error).toContain("setsid: not found");
  });
});

describe("reboot", () => {
  it("needs no reboot on the same kernel", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", "") });
    expect(latest_metric(plugin, "reboot_required")).toBe(0.0);
    expect(latest_status(plugin)).toBe("online");
  });

  it("requires a reboot on a changed kernel", () => {
    const plugin = plugin_of();
    collect(plugin, { probe: probe({ kernels: [KERNEL, NEW_KERNEL] }), eval_result: cmd_result(0, CURRENT + "\n", "") });
    expect(latest_metric(plugin, "reboot_required")).toBe(1.0);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("takes the reboot status from config", () => {
    const plugin = plugin_of({ reboot_status: "failed" });
    collect(plugin, { probe: probe({ kernels: [KERNEL, NEW_KERNEL] }), eval_result: cmd_result(0, CURRENT + "\n", "") });
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("flake metadata", () => {
  it("records the revision and inputs", () => {
    const plugin = plugin_of();
    const modified = now_epoch() - 7200;
    const oldest = now_epoch() - 86400;
    collect(plugin, { metadata: metadata({ revision: "a".repeat(40), last_modified: modified, inputs: { nixpkgs: oldest, "flake-utils": oldest + 60 } }) });
    expect(latest_metric(plugin, "flake_last_modified_epoch")).toBe(modified);
    expect(latest_metric(plugin, "inputs_last_modified_epoch")).toBe(oldest);
    expect(latest_metric(plugin, "flake_reachable")).toBe(1.0);
    const state = stored_state(plugin);
    expect(state.flake_revision).toBe("a".repeat(40));
    expect(state.oldest_input).toBe("nixpkgs");
  });

  it("reads and marks a dirty checkout's revision", () => {
    const plugin = plugin_of();
    collect(plugin, { metadata: metadata({ revision: "a".repeat(40) + "-dirty", dirty: true }) });
    expect(stored_state(plugin).flake_revision).toBe("a".repeat(40) + "-dirty");
    expect(plugin.revision_text).toBe("a".repeat(12) + "-dirty");
  });

  it("calls a metadata failure unavailable and keeps drift", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", ""), metadata: cmd_result(1, "", "error: unable to fetch") });
    expect(latest_metric(plugin, "flake_reachable")).toBe(0.0);
    expect(latest_metric(plugin, "up_to_date")).toBe(1.0);
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("warns on stale inputs when max_input_age is set", () => {
    const plugin = plugin_of({ max_input_age: "7d" });
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", ""), metadata: metadata({ inputs: { nixpkgs: now_epoch() - 30 * 86400 } }) });
    expect(latest_status(plugin)).toBe("warning");
  });

  it("ignores stale inputs without max_input_age", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(0, CURRENT + "\n", ""), metadata: metadata({ inputs: { nixpkgs: now_epoch() - 365 * 86400 } }) });
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("eval schedule", () => {
  it("evaluates on the first cycle", () => {
    expect(launches_eval(plugin_of())).toBe(true);
  });

  it("does not repeat a fresh evaluation", () => {
    const plugin = plugin_of();
    collect(plugin);
    expect(launches_eval(plugin)).toBe(false);
  });

  it("redoes a stale evaluation", () => {
    const plugin = plugin_of();
    collect(plugin);
    rewind_eval(plugin, 7200);
    expect(launches_eval(plugin)).toBe(true);
  });

  it("does not retry a fresh failure at once", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(1, "", "error: attribute missing") });
    expect(launches_eval(plugin)).toBe(false);
  });

  it("retries a failed evaluation after retry_interval", () => {
    const plugin = plugin_of();
    collect(plugin, { eval_result: cmd_result(1, "", "error: attribute missing") });
    rewind_eval(plugin, 20 * 60);
    expect(launches_eval(plugin)).toBe(true);
  });

  it("retries failed metadata too", () => {
    const plugin = plugin_of();
    collect(plugin, { metadata: cmd_result(1, "", "error: unable to download") });
    rewind_eval(plugin, 20 * 60);
    expect(launches_eval(plugin)).toBe(true);
  });

  it("ignores retry_interval after a healthy evaluation", () => {
    const plugin = plugin_of();
    collect(plugin);
    rewind_eval(plugin, 20 * 60);
    expect(launches_eval(plugin)).toBe(false);
  });

  it("never lets retry_interval exceed eval_interval", () => {
    expect(plugin_of({ eval_interval: "10m", retry_interval: "15m" }).retry_interval).toBe(600);
  });

  it("evaluates on a dashboard poll", async () => {
    const plugin = plugin_of();
    collect(plugin);
    expect(await plugin.run_cycle()).toBe(true);
    expect(launches_eval(plugin)).toBe(true);
  });

  it("still tracks drift on a probe-only cycle", () => {
    const plugin = plugin_of();
    collect(plugin);
    const result = collect(plugin, { probe: probe({ current: TARGET }) });
    expect(result.metrics.up_to_date).toBe(1.0);
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("commands", () => {
  it("runs on the target by default", () => {
    expect(plugin_of().commands().every((each) => each.agent === null)).toBe(true);
  });

  it("offloads only the evaluation to eval_agent", () => {
    const [probe_command, launch] = plugin_of({ eval_agent: "big-host", configuration: "host" }).commands();
    expect(probe_command.agent).toBeNull();
    expect(launch.agent).toBe("big-host");
  });

  it("waits for the probed hostname before an offloaded evaluation", () => {
    const plugin = plugin_of({ eval_agent: "big-host" });
    expect(plugin.commands()).toHaveLength(1);
    cycle(plugin, probe());
    expect(plugin.commands()[1].agent).toBe("big-host");
    expect(plugin.eval_script()).toContain('nixosConfigurations.\\"host\\"');
    expect(plugin.eval_script()).not.toContain("uname");
  });

  it("needs no refresh for a local flake", () => {
    const script = plugin_of().eval_script();
    expect(script).not.toContain("--refresh");
    expect(script).toContain('"/etc/nixos#nixosConfigurations.\\"$(uname -n)\\"');
  });

  it("refreshes a remote flake", () => {
    expect(plugin_of({ flake: "github:owner/config" }).eval_script().split("--refresh").length - 1).toBe(2);
  });

  it("lets configuration override the hostname", () => {
    const script = plugin_of({ configuration: "ragnarok" }).eval_script();
    expect(script).toContain('nixosConfigurations.\\"ragnarok\\"');
    expect(script).not.toContain("$(uname -n)");
  });

  it("never writes the lock file", () => {
    expect(plugin_of().eval_script().split("--no-write-lock-file").length - 1).toBe(2);
  });

  it("carries its own timeout", () => {
    const plugin = plugin_of({ eval_timeout: "20m" });
    expect(plugin.eval_command().startsWith("timeout 1200 sh -c ")).toBe(true);
    expect(plugin.commands()[1].text).toContain("timeout 1200");
  });
});

describe("read only", () => {
  it("offers no actions", () => {
    const plugin = plugin_of();
    expect(plugin.get_actions()).toEqual([]);
    for (const action_id of ["update_flake", "switch", "build", "reboot"]) expect(plugin.plan_action(action_id)).toBeNull();
  });

  it("ignores the removed management keys", () => {
    const commands = plugin_of({ auto_switch: true, build_at: "02:30", switch_agent: "builder", push_ssh_key: "/run/key" }).commands();
    expect(commands).toHaveLength(2);
    expect(commands.every((each) => each.agent === null)).toBe(true);
    expect(commands.some((each) => each.text.includes("nixos-rebuild") || each.text.includes("flake update"))).toBe(false);
  });

  it("never launches anything on drift but the evaluation", () => {
    const plugin = plugin_of({ auto_switch: true, auto_switch_after: "0s" });
    collect(plugin);
    rewind_eval(plugin, 7200);
    const commands = plugin.commands();
    expect(commands).toHaveLength(2);
    expect(commands[1].text).not.toContain("nixos-rebuild");
  });
});

describe("local path", () => {
  it.each([
    ["/etc/nixos", "/etc/nixos"],
    ["path:/etc/nixos", "/etc/nixos"],
    ["git+file:///etc/nixos", "/etc/nixos"],
    ["git+file:///etc/nixos?ref=main", "/etc/nixos"],
    ["./config", "./config"],
    ["github:owner/config", null],
    ["gitlab:owner/config", null],
  ])("reads %s as %s", (ref, expected) => {
    expect(plugin_of({ flake: ref }).local_path).toBe(expected);
  });
});

describe("detached evaluation", () => {
  it("records the launch as a side job", () => {
    const plugin = plugin_of();
    const command_text = plugin.eval_command();
    const job = launch_eval(plugin, 4343);
    expect([job.kind, job.pid]).toEqual(["eval", 4343]);
    expect(job.workdir).toBe(plugin.eval_workdir);
    expect(job.command).toBe(command_text);
    expect(plugin.jobs!.running()).toBeNull();
  });

  it("fixes the workdir per monitor", () => {
    const plugin = plugin_of();
    expect(plugin.eval_workdir).toBe(plugin_of().eval_workdir);
    expect(plugin.eval_workdir.endsWith("nixos_upgrade-test-nixos-eval")).toBe(true);
  });

  it("keeps the stored state while an evaluation runs", () => {
    const plugin = plugin_of();
    collect(plugin);
    rewind_eval(plugin, 7200);
    launch_eval(plugin);
    const result = poll_eval(plugin, poll(0, null, true, ""));
    expect(result.metrics.up_to_date).toBe(0.0);
    expect(plugin.jobs!.running_side("eval")).not.toBeNull();
  });

  it("never relaunches a running evaluation", async () => {
    const plugin = plugin_of();
    launch_eval(plugin);
    await plugin.run_cycle();
    expect(plugin.force_eval).toBe(false);
    expect(launches_eval(plugin)).toBe(false);
    poll_eval(plugin, poll(0, null, true, ""));
    expect(plugin.jobs!.recent(99)).toHaveLength(1);
  });

  it("folds the result when it finishes", () => {
    const plugin = plugin_of();
    const job = launch_eval(plugin);
    const result = poll_eval(plugin, finished(cmd_result(0, CURRENT, "")));
    expect(result.metrics.up_to_date).toBe(1.0);
    expect(plugin.jobs!.running_side("eval")).toBeNull();
    const row = plugin.jobs!.recent(1)[0];
    expect([row.id, row.state]).toEqual([job.id, "succeeded"]);
    expect(launches_eval(plugin)).toBe(false);
  });

  // The test store's memory persistence keeps no finished job's log, so this reads the store's in-memory tail.
  it("keeps the finished output in the job log", () => {
    const plugin = plugin_of();
    const job = launch_eval(plugin);
    poll_eval(plugin, finished(cmd_result(0, TARGET, "evaluating...")));
    const log = store_of(plugin).job_output(job.id, -1, 0).map((line) => line.message);
    expect(log).toContain(TARGET);
    expect(log).toContain("evaluating...");
  });

  it("fails an evaluation error", () => {
    const plugin = plugin_of();
    launch_eval(plugin);
    poll_eval(plugin, finished(cmd_result(1, "", "error: attribute 'nope' missing"), metadata(), 1));
    expect(latest_status(plugin)).toBe("failed");
    const state = stored_state(plugin);
    expect(state.eval_error).toContain("attribute 'nope' missing");
    expect(state.eval_unreachable).toBe(false);
    expect(plugin.jobs!.recent(1)[0].state).toBe("failed");
  });

  it("calls a vanished evaluation a failed job and an eval error", () => {
    const plugin = plugin_of();
    launch_eval(plugin);
    poll_eval(plugin, poll(0, null, false, ""));
    const row = plugin.jobs!.recent(1)[0];
    expect([row.state, row.exit_code]).toEqual(["failed", -1]);
    expect(latest_status(plugin)).toBe("failed");
    expect(stored_state(plugin).eval_error).toContain("without writing an exit code");
  });

  it("says when an evaluation timed out", () => {
    const plugin = plugin_of();
    launch_eval(plugin);
    poll_eval(plugin, poll(0, 124, false, ""));
    expect(stored_state(plugin).eval_error).toContain("Timed out after 10 Minutes");
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls an unanswered poll unreachable and keeps the job", () => {
    const plugin = plugin_of();
    launch_eval(plugin);
    poll_eval(plugin, cmd_result(-1, "", "Agent 'x' is not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(plugin.jobs!.running_side("eval")).not.toBeNull();
    poll_eval(plugin, finished(cmd_result(0, CURRENT, "")));
    expect(latest_status(plugin)).toBe("online");
  });

  it("records the launch even when the probe failed", () => {
    const plugin = plugin_of();
    expect(launches_eval(plugin)).toBe(true);
    cycle(plugin, cmd_result(255, "", "ssh: connect failed"), cmd_result(0, "4343\n", ""));
    expect(plugin.jobs!.running_side("eval")!.pid).toBe(4343);
  });

  it("stores a finish that lands on a failed probe", () => {
    const plugin = plugin_of();
    launch_eval(plugin);
    poll_eval(plugin, finished(), cmd_result(255, "", "ssh: connect failed"));
    expect(stored_state(plugin).target).toBe(TARGET);
  });

  it("adopts the running evaluation after a restart", () => {
    const plugin = plugin_of();
    const job = launch_eval(plugin);
    const restarted = make_plugin(NixosUpgrade, base_config, store_of(plugin));
    expect(launches_eval(restarted)).toBe(false);
    poll_eval(restarted, finished());
    expect(restarted.jobs!.recent(1)[0].id).toBe(job.id);
    expect(restarted.jobs!.running_side("eval")).toBeNull();
  });

  it("polls the evaluation on the eval agent", () => {
    const plugin = plugin_of({ eval_agent: "big-host", configuration: "host" });
    const job = launch_eval(plugin);
    expect(plugin.job_agent(job)).toBe("big-host");
    expect(plugin.commands()[1].agent).toBe("big-host");
  });

  it("polls a running evaluation every job_poll", () => {
    const plugin = plugin_of();
    expect(plugin.next_cycle_in()).toBeNull();
    launch_eval(plugin);
    expect(plugin.next_cycle_in()).toBe(30);
    const slower = make_plugin(NixosUpgrade, { ...base_config, job_poll: "1m" }, store_of(plugin));
    expect(slower.next_cycle_in()).toBe(60);
  });

  it("splits the script's output back into both results", () => {
    const folder = mkdtempSync(join(tmpdir(), "nixos-upgrade-"));
    const nix = join(folder, "nix");
    writeFileSync(nix, "#!/bin/sh\n" + 'case "$*" in\n' + "  *\"flake metadata\"*) echo '{\"lastModified\": 5}'; echo \"fetching\" >&2 ;;\n" + `  *eval*) echo "warning: dirty" >&2; printf ${TARGET}; exit 0 ;;\n` + "esac\n");
    chmodSync(nix, 0o755);
    const plugin = plugin_of({ nix_bin: nix, nix_args: [] });
    const run = spawnSync("sh", ["-c", `mkdir -p "${plugin.eval_workdir}" && ${plugin.eval_command()}`], { encoding: "utf8", env: { ...process.env, HOME: folder } });
    expect(run.status).toBe(0);
    const parts = split_eval_output(run.stdout, "missing");
    expect(parts.eval).toEqual(cmd_result(0, TARGET, "warning: dirty"));
    expect(parts.metadata).toEqual(cmd_result(0, '{"lastModified": 5}', "fetching"));
    // nix's stderr is printed as it runs, before any command's stdout, so the job's log shows it live.
    expect(run.stdout.startsWith("@@x-monitor-eval eval stderr\nwarning: dirty\n@@x-monitor-eval metadata stderr\nfetching\n")).toBe(true);
  });

  it("fails a command the run never reported on", () => {
    const parts = split_eval_output("@@x-monitor-eval eval stdout\n" + TARGET + "\n", "killed");
    expect(parts.eval).toEqual(cmd_result(1, "", "killed"));
    expect(parts.metadata).toEqual(cmd_result(1, "", "killed"));
  });
});

describe("page", () => {
  const rows_of = (plugin: NixosUpgrade) => Object.fromEntries(plugin.detail_rows.map((row) => [row.label, row.value]));

  it("shows the resolved hostname as the configuration", () => {
    const plugin = plugin_of();
    collect(plugin);
    expect(rows_of(plugin).Configuration).toBe("host");
  });

  it("prefers the configured name", () => {
    const plugin = plugin_of({ configuration: "gateway" });
    collect(plugin);
    expect(rows_of(plugin).Configuration).toBe("gateway");
  });

  it("names the configuration before any probe", () => {
    expect(rows_of(plugin_of()).Configuration).toBe("the target's hostname");
  });

  it("covers both closures in the detail rows", () => {
    const plugin = plugin_of();
    collect(plugin);
    const rows = rows_of(plugin);
    expect(rows["Running closure"]).toBe(CURRENT);
    expect(rows["Flake closure"]).toBe(TARGET);
    expect(rows.Flake).toBe("/etc/nixos");
  });

  it("walks the drift card through its states", () => {
    const plugin = plugin_of();
    expect(plugin.drift_text).toBe("UNKNOWN");
    collect(plugin);
    expect(plugin.drift_text).toBe("OUT OF DATE");
    expect(plugin.drift_color).toBe("warning");
    collect(plugin, { probe: probe({ current: TARGET }) });
    expect(plugin.drift_text).toBe("UP TO DATE");
    expect(plugin.drift_color).toBe("online");
  });

  it("walks the reboot card through its states", () => {
    const plugin = plugin_of();
    collect(plugin);
    expect(plugin.reboot_text).toBe("NOT NEEDED");
    collect(plugin, { probe: probe({ kernels: [KERNEL, NEW_KERNEL] }) });
    expect(plugin.reboot_text).toBe("REQUIRED");
  });

  it("titles the details table", () => {
    expect((plugin_of().UI_SPEC.tables!.details as { title?: string }).title).toBe("Deployment details");
  });

  it("shows no job panel", () => {
    const spec = plugin_of().UI_SPEC;
    expect(spec.job_panel).toBeUndefined();
    expect(spec.buttons).toBeUndefined();
    expect(spec.layout!.every((row) => !row.includes("jobs"))).toBe(true);
    expect(spec.cards!.flake_card.value).toBe("/etc/nixos");
  });
});
