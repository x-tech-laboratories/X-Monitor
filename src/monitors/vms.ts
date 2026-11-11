// Libvirt VM states via `virsh list --all`, sampled on the host by the agent where there is one, with a running toggle
// for each expected VM. Config: uri (the libvirt connection), expect_running, offline_warning. Any VM named in
// expect_running that is not running makes the status failed; VMs in other unexpected states are warning when
// offline_warning is on, while cleanly shut-off VMs count as benign. A missing virsh or an unreachable libvirt measured
// nothing, so both are unavailable.

import { partition, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { ActionButtonSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";

const running_states = new Set(["running"]);
const benign_states = new Set(["shut off", "shutoff"]);

const default_layout: LayoutRow[] = [["host_card", "total_card", "running_card"], ["vms"], ["events"]];

// The metric that is 1 while the expected VM `name` runs, which its toggle shows.
function running_metric(name: string): string {
  return `vm_running_${name}`;
}

function shell_single_quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// One `virsh list` row as [name, state], or [null, null] for a header, rule or short line.
export function parse_row(line: string): [name: string | null, state: string | null] {
  const stripped = line.trim();
  if (!stripped || stripped.startsWith("---") || [...stripped].every((character) => character === "-" || character === " ")) return [null, null];
  const parts = split_words(line);
  if ((parts[0] === "Id" && parts[1] === "Name") || parts[0] === "Id") return [null, null];
  if (parts.length < 3) return [null, null];
  return [parts[1], parts.slice(2).join(" ").toLowerCase()];
}

// The virsh list rows split into running, stopped (error-state) and benign (shut-off) names.
function classify_vms(stdout: string): [running: string[], stopped: string[], benign: string[]] {
  const running: string[] = [];
  const stopped: string[] = [];
  const benign: string[] = [];
  for (const line of split_lines(stdout)) {
    const [name, state] = parse_row(line);
    if (name === null) continue;
    if (running_states.has(state!)) running.push(name);
    else if (benign_states.has(state!)) benign.push(name);
    else stopped.push(name);
  }
  return [running, stopped, benign];
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Vms extends Plugin {
  override readonly SAMPLED = true;
  readonly uri: string;
  readonly expect_running: Set<string>;
  readonly offline_warning: boolean;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.uri = String(config.uri ?? "qemu:///system");
    this.expect_running = new Set(((config.expect_running as string[] | null | undefined) || []).map(String));
    this.offline_warning = Boolean(config.offline_warning ?? true);
  }

  private virsh(subcommand: string): string {
    return `virsh -c ${shell_single_quote(this.uri)} ${subcommand}`;
  }

  override commands(): Command[] {
    return [command(`${this.virsh("list --all")} 2>&1`)];
  }

  // Total, running and stopped counts, where a missing expected VM is failed, VMs in unexpected states are warning
  // (when offline_warning), and a missing virsh or unreachable libvirt is unavailable.
  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    const combined = `${stdout}\n${stderr}`.toLowerCase();
    if (exit_code !== 0 && (combined.includes("command not found") || combined.includes("not found"))) return CollectResult.unavailable("virsh not installed on target");
    if (exit_code !== 0 && combined.includes("failed to connect")) return CollectResult.unavailable(`libvirt not reachable: ${stderr}`);
    if (exit_code !== 0) return CollectResult.unavailable(`virsh list failed: ${stderr}`);

    const [running, stopped, benign] = classify_vms(stdout);
    const total = running.length + stopped.length + benign.length;
    const metrics: Record<string, number> = { vms_total: total, vms_running: running.length, vms_stopped: stopped.length + benign.length };
    for (const name of this.expect_running) metrics[running_metric(name)] = running.includes(name) ? 1 : 0;

    if (total === 0) return new CollectResult({ metrics, logs: [["No VMs defined", "INFO"]], status: "online" });

    const running_set = new Set(running);
    const missing = [...this.expect_running].filter((name) => !running_set.has(name)).sort();
    if (missing.length > 0) return new CollectResult({ metrics, logs: [[`Expected VMs not running: ${missing.join(", ")}`, "ERROR"]], status: "failed" });
    if (this.offline_warning && stopped.length > 0) {
      return new CollectResult({ metrics, logs: [[`${running.length} running, ${stopped.length} in error state: ${stopped.join(", ")}`, "WARNING"]], status: "warning" });
    }
    return new CollectResult({ metrics, logs: [[`${running.length} running, ${benign.length} shut off`, "INFO"]], status: "online" });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  // A running switch per expected VM; its action_id is the metric it shows, since a toggle acts through its on and off ids.
  override get_actions(): ActionButtonSpec[] {
    return [...this.expect_running].sort().map((name) => ({ name, kind: "toggle", metric: running_metric(name), icon: "computer", on_action_id: `start:${name}`, off_action_id: `shutdown:${name}`, action_id: running_metric(name) }));
  }

  override plan_action(action_id: string, _args: Record<string, unknown> = {}): ActionPlanResult {
    if (!action_id.includes(":")) return null;
    const [verb, , name] = partition(action_id, ":");
    if (!this.expect_running.has(name)) return CollectResult.failed(`Refusing to ${verb} unlisted VM ${JSON.stringify(name)}`);
    if (verb === "start") return action_plan(this.virsh(`start ${shell_single_quote(name)}`));
    if (verb === "shutdown") return action_plan(this.virsh(`shutdown ${shell_single_quote(name)}`));
    return null;
  }

  override interpret_action(action_id: string, result: unknown, _args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    if (outcome.exit_code !== 0) {
      const [verb, , name] = partition(action_id, ":");
      return CollectResult.failed(`${verb} of ${name} failed: ${outcome.stderr}`);
    }
    return true;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        total_card: { metric: "vms_total", title: "VMS", format: "int" },
        running_card: {
          kind: "share", title: "STATE", format: "int",
          parts: [
            { metric: "vms_running", label: "Running", color: "online" },
            { metric: "vms_stopped", label: "Stopped", color: "neutral" },
          ],
        },
      },
      events: true,
    };
  }
}
