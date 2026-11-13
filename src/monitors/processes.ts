// Processes from `ps`, sampled on the host by the agent where there is one, shown as a tree under their parents with
// per-row kill actions (SIGTERM or SIGKILL). Each row's CPU and MEM add up its whole branch, and its own share sits
// beside them. Config: max_processes, require_sudo, cpu_warning, cpu_threshold. The tree keeps the max_processes
// busiest processes and every ancestor of each, while the totals still count every process. The busiest process's own
// CPU share ranks against cpu_warning for warning and cpu_threshold for failed, each optional; with neither the monitor
// only reports. A failed or unparseable collection measured nothing and is unavailable.

import { format_fixed, parse_float, parse_int, round_half_even, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { LayoutRow, TableSpec, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { level_for, limit_from, type PluginConfig } from "./base/plugin_helpers.ts";

const kill_signals: Record<string, string> = { kill_term: "TERM", kill_kill: "KILL" };

const default_layout: LayoutRow[] = [["host_card", "count_card", "top_cpu_card"], ["table"], ["events"]];

// One process as ps reports it.
export interface ProcessEntry {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

// One row of the process tree.
export interface ProcessRow {
  pid: number;
  ppid: number | null;
  user: string;
  cpu: number;
  mem: number;
  own_cpu: number;
  own_mem: number;
  procs: number;
  command: string;
}

// ── Reading ps ───────────────────────────────────────────────────────────────

export function parse_ps_output(stdout: string): ProcessEntry[] {
  const processes: ProcessEntry[] = [];
  const lines = split_lines(stdout.trim());
  if (lines.length < 2) return processes;
  for (const line of lines.slice(1)) {
    const parts = split_words(line, 5);
    if (parts.length < 6) continue;
    try {
      processes.push({ pid: parse_int(parts[0]), ppid: parse_int(parts[1]), user: parts[2], cpu: parse_float(parts[3]), mem: parse_float(parts[4]), command: parts[5].trim() });
    } catch {
      continue;
    }
  }
  return processes;
}

// ── Building the tree ────────────────────────────────────────────────────────

// The pids above a process, nearest first, stopping at a root or a loop.
function ancestors(pid: number, parent_of: Map<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set([pid]);
  let parent = parent_of.get(pid);
  while (parent !== undefined && parent_of.has(parent) && !seen.has(parent)) {
    chain.push(parent);
    seen.add(parent);
    parent = parent_of.get(parent);
  }
  return chain;
}

// Rows for the tree: the busiest processes and their ancestors, each totalling its whole branch. `cpu` and `mem` hold
// the branch totals, `own_cpu` and `own_mem` the process alone, and `procs` how many processes the branch holds; the
// totals count every process, shown or not.
export function process_tree(processes: ProcessEntry[], max_processes: number): ProcessRow[] {
  const parent_of = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const totals = new Map(processes.map((entry) => [entry.pid, [entry.cpu, entry.mem, 1]]));
  for (const entry of processes) {
    for (const pid of ancestors(entry.pid, parent_of)) {
      const total = totals.get(pid)!;
      total[0] += entry.cpu;
      total[1] += entry.mem;
      total[2] += 1;
    }
  }

  const busiest = [...processes].sort((first, second) => second.cpu - first.cpu).slice(0, Math.max(0, max_processes));
  const kept = new Set<number>();
  for (const entry of busiest) {
    kept.add(entry.pid);
    for (const pid of ancestors(entry.pid, parent_of)) kept.add(pid);
  }

  const rows = processes.filter((entry) => kept.has(entry.pid)).map((entry) => {
    const total = totals.get(entry.pid)!;
    return {
      pid: entry.pid,
      ppid: kept.has(entry.ppid) ? entry.ppid : null,
      user: entry.user,
      cpu: round_half_even(total[0], 1),
      mem: round_half_even(total[1], 1),
      own_cpu: entry.cpu,
      own_mem: entry.mem,
      procs: total[2],
      command: entry.command,
    };
  });
  return rows.sort((first, second) => second.cpu - first.cpu);
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Processes extends Plugin {
  override readonly SAMPLED = true;
  readonly max_processes: number;
  readonly require_sudo: boolean;
  readonly cpu_warning: number | null;
  readonly cpu_threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.max_processes = parse_int(config.max_processes ?? 20);
    this.require_sudo = Boolean(config.require_sudo ?? false);
    this.cpu_warning = limit_from(config, "cpu_warning");
    this.cpu_threshold = limit_from(config, "cpu_threshold");
  }

  // Whether either CPU limit is configured, without which nothing is colored.
  private get ranks_cpu(): boolean {
    return this.cpu_warning !== null || this.cpu_threshold !== null;
  }

  // One process row, by its own CPU share against the configured thresholds.
  readonly row_cpu_level = (row: Record<string, unknown>): Status => level_for(Number(row.own_cpu), this.cpu_warning, this.cpu_threshold);

  override commands(): Command[] {
    return [command("ps -eo pid,ppid,user,pcpu,pmem,comm --sort=-%cpu")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Collection failed: ${stderr}`);

    const processes = parse_ps_output(stdout);
    const has_data_rows = split_lines(stdout.trim()).length > 1;
    if (processes.length === 0 && has_data_rows) return CollectResult.unavailable(`Could not parse ps output: ${JSON.stringify(stdout)}`);

    const process_count = processes.length;
    const top_cpu = processes.length > 0 ? Math.max(...processes.map((entry) => entry.cpu)) : 0;
    const overall = level_for(top_cpu, this.cpu_warning, this.cpu_threshold);
    return new CollectResult({
      metrics: { process_count, top_cpu_pct: top_cpu },
      snapshot: process_tree(processes, this.max_processes),
      logs: [[`${process_count} processes, top CPU ${format_fixed(top_cpu, 1)}%`, log_level_of(overall)]],
      status: overall,
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    const signal = kill_signals[action_id];
    if (signal === undefined) return null;
    const pid = args.pid;
    if (pid === null || pid === undefined) return CollectResult.failed("Kill action missing pid");
    // -n because a sudo that stops for a password never returns, and nothing here would ever answer it.
    const prefix = this.require_sudo ? "sudo -n " : "";
    return action_plan(`${prefix}kill -${signal} ${parse_int(pid)}`);
  }

  override interpret_action(action_id: string, result: unknown, args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    const signal = kill_signals[action_id];
    if (signal === undefined) return outcome.exit_code === 0;
    const pid = args.pid === undefined ? "None" : String(args.pid);
    if (outcome.exit_code !== 0) return CollectResult.failed(`Failed to send SIG${signal} to PID ${pid}: ${outcome.stderr}`);
    return new CollectResult({ logs: [[`Sent SIG${signal} to PID ${pid}`, "INFO"]], success: true });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    const table = {
      title: "Processes",
      row_key: "pid",
      tree: { parent_field: "ppid", column: "command" },
      columns: [
        { name: "command", label: "COMMAND", field: "command", sortable: true, align: "left" },
        { name: "pid", label: "PID", field: "pid", sortable: true, align: "right" },
        { name: "user", label: "USER", field: "user", sortable: true, align: "left" },
        { name: "cpu", label: "CPU %", field: "cpu", sortable: true, align: "right" },
        { name: "mem", label: "MEM %", field: "mem", sortable: true, align: "right" },
        { name: "own_cpu", label: "SELF CPU %", field: "own_cpu", sortable: true, align: "right", ...(this.ranks_cpu ? { cell_color_by: this.row_cpu_level } : {}) },
        { name: "own_mem", label: "SELF MEM %", field: "own_mem", sortable: true, align: "right" },
        { name: "procs", label: "PROCS", field: "procs", sortable: true, align: "right" },
      ],
      row_actions: [
        { id: "kill_term", icon: "cancel", color: "warning", tooltip: "SIGTERM (graceful)", kind: "dispatch", params: { pid: "pid" } },
        { id: "kill_kill", icon: "dangerous", color: "negative", tooltip: "SIGKILL (force)", kind: "dispatch", params: { pid: "pid" } },
      ],
    };
    return {
      layout: default_layout,
      cards: {
        count_card: { metric: "process_count", title: "PROCESSES", format: "int" },
        top_cpu_card: { metric: "top_cpu_pct", title: "TOP CPU", format: "percent1", ...(this.ranks_cpu ? { color: { warning: this.cpu_warning, threshold: this.cpu_threshold } } : {}) },
      },
      // The table carries a title, which TableSpec does not declare yet.
      tables: { table: table as TableSpec },
      events: true,
    };
  }
}
