import { describe, expect, it } from "vitest";

import { cmd_result, type ActionPlan, type CollectResult } from "../../src/core/connectors/types.ts";
import { level_for, type PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { parse_ps_output, process_tree, Processes, type ProcessEntry, type ProcessRow } from "../../src/monitors/processes.ts";
import { make_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = { name: "test-procs", id: "test-procs", max_processes: 5, ssh_config: { host: "test.host" } };
const threshold_config: PluginConfig = { ...base_config, name: "test-procs-thresh", id: "test-procs-thresh", cpu_warning: 50.0, cpu_threshold: 80.0 };

const ps_header = "  PID  PPID USER     %CPU %MEM COMMAND";
const ps_rows = ["  123     1 root      45.2  2.1 python3", " 4567     1 alice      3.0  0.5 bash", "   89     1 www-data   0.1  0.3 nginx"];
const ps_output_ok = [ps_header, ...ps_rows].join("\n") + "\n";
const ps_output_header_only = ps_header + "\n";
const ps_output_high_cpu = [ps_header, "  999     1 root      85.0  1.0 stress"].join("\n") + "\n";
const ps_output_warn_cpu = [ps_header, "  999     1 root      60.0  1.0 stress"].join("\n") + "\n";

const processes = (extra: PluginConfig = {}): Processes => make_plugin(Processes, { ...base_config, ...extra });
const thresholded = (): Processes => make_plugin(Processes, threshold_config);
const run = (plugin: Processes, stdout: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const rows_of = (result: { snapshot: unknown }) => result.snapshot as ProcessRow[];
const latest_status = (plugin: Processes) => store_of(plugin).latest_status(plugin.id);
const latest_metric = (plugin: Processes, name: string) => store_of(plugin).latest_metric(plugin.id, name)?.value ?? null;

describe("parse ps output", () => {
  it("reads the pid", () => expect(parse_ps_output(ps_output_ok)[0].pid).toBe(123));
  it("reads the ppid", () => expect(parse_ps_output(ps_output_ok)[0].ppid).toBe(1));
  it("reads the user", () => expect(parse_ps_output(ps_output_ok)[0].user).toBe("root"));
  it("reads the cpu", () => expect(parse_ps_output(ps_output_ok)[0].cpu).toBeCloseTo(45.2));
  it("reads the mem", () => expect(parse_ps_output(ps_output_ok)[0].mem).toBeCloseTo(2.1));
  it("reads the command", () => expect(parse_ps_output(ps_output_ok)[0].command).toBe("python3"));
  it("returns every row", () => expect(parse_ps_output(ps_output_ok)).toHaveLength(3));
  it("returns nothing for a header alone", () => expect(parse_ps_output(ps_output_header_only)).toEqual([]));
  it("returns nothing for empty output", () => expect(parse_ps_output("")).toEqual([]));
  it("keeps a command with spaces", () => expect(parse_ps_output(`${ps_header}\n  1 0 root 0.0 0.0 my command with spaces\n`)[0].command).toBe("my command with spaces"));

  it("skips malformed lines", () => {
    const parsed = parse_ps_output(`${ps_header}\nbadline\n  123 1 root 0.1 0.2 bash\n`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pid).toBe(123);
  });
});

const proc = (pid: number, ppid: number, cpu: number, mem = 0.0, command = "x"): ProcessEntry => ({ pid, ppid, user: "root", cpu, mem, command });

describe("process tree", () => {
  // systemd(1) -> firefox(10) -> two content processes (11, 12); sshd(20) stands alone under 1.
  const procs = [proc(1, 0, 0.5, 0.1, "systemd"), proc(10, 1, 5.0, 4.0, "firefox"), proc(11, 10, 20.0, 2.0, "Web Content"), proc(12, 10, 1.0, 1.0, "Web Content"), proc(20, 1, 0.0, 0.2, "sshd")];
  const rows = (max_processes = 20) => Object.fromEntries(process_tree(procs, max_processes).map((row) => [row.pid, row]));

  it("totals a parent's whole branch", () => {
    const tree = rows();
    expect(tree[10].cpu).toBeCloseTo(26.0);
    expect(tree[10].mem).toBeCloseTo(7.0);
    expect(tree[10].procs).toBe(3);
    expect(tree[1].cpu).toBeCloseTo(26.5);
    expect(tree[1].procs).toBe(5);
  });

  it("keeps a row's own share beside the total", () => {
    const tree = rows();
    expect([tree[10].own_cpu, tree[10].own_mem]).toEqual([5.0, 4.0]);
    expect([tree[11].cpu, tree[11].own_cpu, tree[11].procs]).toEqual([20.0, 20.0, 1]);
  });

  it("gives a root no parent row", () => {
    const tree = rows();
    expect(tree[1].ppid).toBeNull();
    expect(tree[11].ppid).toBe(10);
  });

  it("puts the busiest branch first", () => expect(process_tree(procs, 20).map((row) => row.pid).slice(0, 3)).toEqual([1, 10, 11]));

  it("keeps the busiest with their ancestors while the totals still count all", () => {
    const tree = rows(1);
    expect(new Set(Object.keys(tree).map(Number))).toEqual(new Set([1, 10, 11]));
    expect(tree[1].cpu).toBeCloseTo(26.5);
    expect(tree[1].procs).toBe(5);
  });

  it("does not hang on a parent loop", () => {
    const tree = Object.fromEntries(process_tree([proc(5, 6, 1.0), proc(6, 5, 2.0)], 20).map((row) => [row.pid, row]));
    expect(tree[5].cpu).toBeCloseTo(3.0);
    expect(tree[6].cpu).toBeCloseTo(3.0);
  });
});

describe("level for", () => {
  it("calls below the warning online", () => expect(level_for(30.0, 50.0, 80.0)).toBe("online"));
  it("calls the warning a warning", () => expect(level_for(50.0, 50.0, 80.0)).toBe("warning"));
  it("calls between the limits a warning", () => expect(level_for(60.0, 50.0, 80.0)).toBe("warning"));
  it("calls the failure limit failed", () => expect(level_for(80.0, 50.0, 80.0)).toBe("failed"));
});

describe("collection", () => {
  it("calls a successful collection online", () => {
    const plugin = processes();
    run(plugin, ps_output_ok);
    expect(latest_status(plugin)).toBe("online");
  });

  it("fills the process list", () => {
    const result = run(processes(), ps_output_ok);
    expect(rows_of(result)).toHaveLength(3);
    expect(rows_of(result)[0].pid).toBe(123);
  });

  it("records the process count", () => {
    const plugin = processes();
    run(plugin, ps_output_ok);
    expect(latest_metric(plugin, "process_count")).toBeCloseTo(3.0);
  });

  it("counts every process beyond the limit", () => {
    const plugin = processes();
    const output = ps_header + "\n" + Array.from({ length: 10 }, (_, index) => `  ${index + 10} 1 root 0.0 0.0 p`).join("\n") + "\n";
    const result = run(plugin, output);
    expect(latest_metric(plugin, "process_count")).toBeCloseTo(10.0);
    expect(rows_of(result)).toHaveLength(5);
  });

  it("records the top cpu", () => {
    const plugin = processes();
    run(plugin, ps_output_ok);
    expect(latest_metric(plugin, "top_cpu_pct")).toBeCloseTo(45.2);
  });

  it("calls an empty process list online", () => {
    const plugin = processes();
    const result = run(plugin, ps_output_header_only);
    expect(latest_status(plugin)).toBe("online");
    expect(result.snapshot).toEqual([]);
  });

  it("calls unparseable output unavailable", () => {
    const plugin = processes();
    run(plugin, "complete garbage\n!!!\n");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a transport failure unavailable", () => {
    const plugin = processes();
    run(plugin, "", -1, "timeout");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a missing ps unavailable", () => {
    const plugin = processes();
    run(plugin, "", 127, "sh: ps: not found");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("stays online without thresholds", () => {
    const plugin = processes();
    run(plugin, ps_output_high_cpu);
    expect(latest_status(plugin)).toBe("online");
  });

  it("warns on a top cpu past the warning", () => {
    const plugin = thresholded();
    run(plugin, ps_output_warn_cpu);
    expect(latest_status(plugin)).toBe("warning");
  });

  it("fails a top cpu past the threshold", () => {
    const plugin = thresholded();
    run(plugin, ps_output_high_cpu);
    expect(latest_status(plugin)).toBe("failed");
  });
});

describe("page", () => {
  it("titles the process table", () => expect((processes().UI_SPEC.tables!.table as { title?: string }).title).toBe("Processes"));
});

describe("kill action", () => {
  it("sends SIGTERM", () => {
    const plugin = processes();
    expect((plugin.plan_action("kill_term", { pid: 123 }) as ActionPlan).command).toBe("kill -TERM 123");
    expect((plugin.interpret_action("kill_term", cmd_result(0, "", ""), { pid: 123 }) as CollectResult).success).toBe(true);
  });

  it("sends SIGKILL", () => expect((processes().plan_action("kill_kill", { pid: 456 }) as ActionPlan).command).toBe("kill -KILL 456"));

  it("kills through sudo when asked", () => {
    const plugin = processes({ name: "test-sudo", id: "test-sudo", require_sudo: true });
    expect((plugin.plan_action("kill_term", { pid: 99 }) as ActionPlan).command).toBe("sudo -n kill -TERM 99");
  });

  it("reports a failed kill", () => {
    expect((processes().interpret_action("kill_term", cmd_result(1, "", "Operation not permitted"), { pid: 1 }) as CollectResult).success).toBe(false);
  });

  it("refuses a kill without a pid", () => expect((processes().plan_action("kill_term") as CollectResult).success).toBe(false));

  it("plans nothing for an unknown action", () => expect(processes().plan_action("reboot")).toBeNull());
});

describe("optional limits", () => {
  it("never fails with a warning only", () => {
    const plugin = processes({ cpu_warning: 50.0 });
    run(plugin, ps_output_high_cpu);
    expect(latest_status(plugin)).toBe("warning");
    expect(plugin.UI_SPEC.cards!.top_cpu_card.color).toEqual({ warning: 50.0, threshold: null });
  });

  it("never warns with a failure only", () => {
    const plugin = processes({ cpu_threshold: 80.0 });
    run(plugin, ps_output_warn_cpu);
    expect(latest_status(plugin)).toBe("online");
    run(plugin, ps_output_high_cpu);
    expect(latest_status(plugin)).toBe("failed");
  });
});
