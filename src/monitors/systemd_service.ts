// One systemd unit's health, in two modes: continuous (is-active plus a journal tail) or, when max_age is set, oneshot
// (systemctl show state: did the last run succeed, and recently enough). On agent-backed hosts it also subscribes to
// the unit's journal stream, so log lines arrive live between polls while the poll stays the authority on status.
// Config: service_name, lines, max_age, allow_unit_file_edit, allowed_write_paths. Continuous mode: an inactive unit is
// warning and an unreadable journal is unavailable; oneshot mode: a never-ran unit, a failed last run, or one older
// than max_age is failed, and a unit whose state could not be queried is unavailable. A reboot clears systemd's unit
// timestamps, so when they are empty the last run is taken from the unit's journal instead of being reported as never
// ran. Both modes record whether the unit starts on boot, which drives the Start on Boot toggle; continuous mode also
// has a Running toggle that starts and stops the unit.

import { int_or_null, partition, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command, type LogEntry, type LogLineEntry } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { StreamSpec } from "../shared/agent_protocol.ts";
import type { Status } from "../shared/status.ts";
import { iso_local } from "../shared/time.ts";
import type { ActionButtonSpec, ButtonSpec, DialogSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { make_inline_layout } from "./base/child_cards.ts";
import { Plugin, type CustomView } from "./base/plugin_base.ts";
import { format_age, format_duration, parse_duration, type PluginConfig } from "./base/plugin_helpers.ts";

const default_unit_file_write_paths = ["/etc/systemd/system", "/run/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"];

export const CONTINUOUS_LAYOUT: LayoutRow[] = [["host_card", "service_card", "status_card", "time_card"], ["unit_file_card"], ["logs"]];
export const ONESHOT_LAYOUT: LayoutRow[] = [["host_card", "service_card", "maxage_card", "state_card"], ["unit_file_card"], ["history"], ["logs"]];

const running_substates = new Set(["running", "start", "start-pre", "start-post", "start-chroot", "reload"]);

// The is-enabled answers a boot toggle can show; static, masked and the rest cannot be enabled or disabled.
const boot_states: Record<string, number> = { enabled: 1, "enabled-runtime": 1, disabled: 0 };

const command_map: Record<string, string> = { start_service: "start", restart_service: "restart", stop_service: "stop", enable_service: "enable", disable_service: "disable" };

// The oneshot state script with @@UNIT@@ for the unit; a reboot clears every timestamp it reads, so it falls back to
// the unit's last completion line in the journal, whose short-unix stamp and quoted result stand in.
const oneshot_state_template = "result=$(systemctl show @@UNIT@@ -p Result --value); exit_code=$(systemctl show @@UNIT@@ -p ExecMainStatus --value); active=$(systemctl show @@UNIT@@ -p ActiveState --value); sub=$(systemctl show @@UNIT@@ -p SubState --value); ts=$(systemctl show @@UNIT@@ -p ExecMainExitTimestamp --value); [ -z \"$ts\" ] || [ \"$ts\" = \"n/a\" ] && ts=$(systemctl show @@UNIT@@ -p InactiveEnterTimestamp --value); if [ -n \"$ts\" ] && [ \"$ts\" != \"n/a\" ]; then   epoch=$(date -d \"$ts\" +%s 2>/dev/null || echo 0); else epoch=0; fi; source=systemd; if [ \"$epoch\" = 0 ]; then line=$(journalctl -u @@UNIT@@ -o short-unix -q -n 1 -g 'Deactivated successfully|Failed with result' 2>/dev/null); if [ -n \"$line\" ]; then   epoch=${line%% *}; epoch=${epoch%%.*}; source=journal;   case \"$line\" in *\"Failed with result\"*)     result=$(printf \"%s\" \"$line\" | sed -n \"s/.*Failed with result '\\([^']*\\)'.*/\\1/p\");     exit_code=empty;;   esac; fi; fi; echo \"result=${result:-empty} exit=${exit_code:-empty} epoch=$epoch active=${active:-unknown} sub=${sub:-unknown} source=$source\"";

export const UNIT_FILE_DIALOGS: Record<string, DialogSpec> = {
  view_unit_file: { kind: "read", title: "Unit file: {plugin.service_name}", action_id: "view_unit_file", params: {}, render: "textarea_readonly" },
  edit_unit_file: {
    kind: "edit", title: "Edit unit file: {plugin.service_name}",
    load_action_id: "view_unit_file", load_params: {},
    save_action_id: "write_unit_file", save_params: {}, save_content_kwarg: "content",
    success_message: "Unit file written successfully",
  },
};

// ── Journal ──────────────────────────────────────────────────────────────────

const error_words = ["ERROR", "FAIL", "CRITICAL"];

function level_of_line(text: string): string {
  const upper = text.toUpperCase();
  return error_words.some((word) => upper.includes(word)) ? "ERROR" : "INFO";
}

// A journal line's leading short-iso time, when it has one, and the whole line as the message.
function split_iso_line(line: string): [log_time: string | null, message: string] {
  const [first, separator] = partition(line, " ");
  if (separator && first.includes("T") && /^\d{4}$/.test(first.slice(0, 4))) return [first, line];
  return [null, line];
}

function parse_journal(result: CmdResult): [ok: boolean, lines: LogLineEntry[]] {
  if (result.exit_code !== 0) return [false, []];
  const lines: LogLineEntry[] = [];
  for (const line of split_lines(result.stdout)) {
    if (!line.trim()) continue;
    const [log_time, message] = split_iso_line(line);
    lines.push([message, level_of_line(line), log_time]);
  }
  return [true, lines];
}

// The "enabled" metric for a unit that can be switched on or off at boot, or nothing for one that cannot.
function boot_metric(result: CmdResult): Record<string, number> {
  const state = boot_states[result.stdout.trim()];
  return state === undefined ? {} : { enabled: state };
}

// ── Oneshot page state ───────────────────────────────────────────────────────

// A label and the status it is colored by.
export interface StateText {
  text: string;
  level: Status;
}

// What the oneshot page shows from the latest metrics: the current state, and the last result and age while the unit
// is not running.
export interface OneshotState {
  state: StateText;
  history_visible: boolean;
  result: StateText | null;
  age: StateText | null;
}

export function oneshot_state(is_running: number | null, last_run_epoch: number | null, last_run_success: number | null, max_age: number, now: number): OneshotState {
  if (is_running !== null && is_running > 0.5) return { state: { text: "RUNNING", level: "warning" }, history_visible: false, result: null, age: null };
  if (last_run_epoch === null) return { state: { text: "UNKNOWN", level: "unavailable" }, history_visible: true, result: null, age: null };
  const is_ok = last_run_success !== null && last_run_success > 0.5;
  const epoch = Math.trunc(last_run_epoch);
  const result: StateText = { text: is_ok ? "SUCCESS" : "FAILED", level: is_ok ? "online" : "failed" };
  if (epoch === 0) return { state: { text: "NEVER RUN", level: "failed" }, history_visible: true, result, age: { text: "Never run", level: "failed" } };
  const age = Math.trunc(now) - epoch;
  return { state: { text: "IDLE", level: "online" }, history_visible: true, result, age: { text: format_age(age), level: age > max_age ? "failed" : "online" } };
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class SystemdService extends Plugin {
  readonly service_name: string | null;
  readonly lines: unknown;
  readonly max_age: number | null;
  readonly allow_unit_file_edit: boolean;
  readonly allowed_write_paths: string[];

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.service_name = (config.service_name as string | null | undefined) ?? null;
    this.lines = config.lines ?? 10;
    this.max_age = "max_age" in config ? parse_duration(config.max_age, "max_age") : null;
    this.allow_unit_file_edit = Boolean(config.allow_unit_file_edit ?? false);
    this.allowed_write_paths = ((config.allowed_write_paths as string[] | undefined) ?? default_unit_file_write_paths).map(String);
  }

  private get unit(): string {
    return String(this.service_name);
  }

  override commands(): Command[] {
    const journal = command(`journalctl -u ${this.unit} -n ${String(this.lines)} --no-pager --output=short-iso`);
    const enabled = command(`systemctl is-enabled ${this.unit}`);
    if (this.max_age !== null) return [command(this.oneshot_state_command()), journal, enabled];
    return [command(`systemctl is-active ${this.unit}`), journal, enabled];
  }

  // Follows this unit's journal live on an agent-backed host, so a crash-restart loop between two polls shows; the
  // poll still runs and stays the authority on the unit's state.
  override subscriptions(): StreamSpec[] {
    if (!this.service_name) return [];
    return [{ id: this.id, kind: "journal", params: { unit: this.service_name } }];
  }

  // Log lines only: the unit's status stays owned by the poll, so one noisy line never flips a healthy service.
  override parse_event(_stream_id: string, payload: Record<string, unknown>, timestamp: number): CollectResult | null {
    const message = String(payload.message ?? "").trim();
    if (!message) return null;
    const log_time = iso_local(new Date(timestamp * 1000)).replace(" ", "T");
    return new CollectResult({ log_lines: [[message, level_of_line(message), log_time]] });
  }

  override parse(results: CmdResult[]): CollectResult {
    return this.max_age !== null ? this.parse_oneshot(results) : this.parse_continuous(results);
  }

  private parse_continuous(results: CmdResult[]): CollectResult {
    const [state_result, journal_result, enabled_result] = results;
    const is_active = state_result.exit_code === 0 && state_result.stdout.trim() === "active";
    const metrics: Record<string, number> = { active: is_active ? 1 : 0, ...boot_metric(enabled_result) };
    const [journal_ok, log_lines] = parse_journal(journal_result);
    if (!journal_ok) return new CollectResult({ metrics, logs: [[`Log collection failed: ${journal_result.stderr}`, "WARNING"]], status: "unavailable" });
    return new CollectResult({ metrics, log_lines, status: is_active ? "online" : "warning" });
  }

  private parse_oneshot(results: CmdResult[]): CollectResult {
    const [state_result, journal_result, enabled_result] = results;
    if (state_result.exit_code !== 0) return CollectResult.unavailable(`Failed to query service state: ${state_result.stderr}`);

    const tokens: Record<string, string> = {};
    for (const token of split_words(state_result.stdout.trim())) {
      if (!token.includes("=")) continue;
      const [key, , value] = partition(token, "=");
      tokens[key] = value;
    }
    const result = tokens.result ?? "empty";
    const exit_code = tokens.exit ?? "empty";
    const active = tokens.active ?? "unknown";
    const sub = tokens.sub ?? "unknown";
    const source = tokens.source ?? "systemd";
    const epoch = int_or_null(tokens.epoch ?? "0") ?? 0;

    const logs: LogEntry[] = [[`systemd state: result=${JSON.stringify(result)} exit_code=${JSON.stringify(exit_code)} epoch=${epoch} active=${JSON.stringify(active)} sub=${JSON.stringify(sub)} source=${JSON.stringify(source)}`, "INFO"]];
    const is_running = active === "activating" || (active === "active" && running_substates.has(sub));
    const is_success = result === "success" || exit_code === "0";
    const age = epoch > 0 ? Math.trunc(Date.now() / 1000) - epoch : -1;
    const metrics: Record<string, number> = { last_run_epoch: epoch, last_run_success: is_success ? 1 : 0, is_running: is_running ? 1 : 0, ...boot_metric(enabled_result) };

    let status: Status;
    if (is_running) {
      logs.push(["Service is currently running", "INFO"]);
      status = "online";
    } else if (epoch === 0) {
      logs.push(["Service has never run", "WARNING"]);
      status = "failed";
    } else if (!is_success) {
      logs.push([`Last run failed (result: ${result}, exit: ${exit_code})`, "ERROR"]);
      status = "failed";
    } else if (age > this.max_age!) {
      logs.push([`Last run was ${format_age(age)}, exceeds max_age of ${format_duration(this.max_age!)}`, "WARNING"]);
      status = "failed";
    } else {
      logs.push([`Last run ${format_age(age)}, result: ${result}`, "INFO"]);
      status = "online";
    }
    const [, log_lines] = parse_journal(journal_result);
    return new CollectResult({ metrics, logs, log_lines, status });
  }

  oneshot_state_command(): string {
    return oneshot_state_template.replaceAll("@@UNIT@@", this.unit);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    const actions: ActionButtonSpec[] = [{ name: "Restart Service", action_id: "restart_service", variant: "primary", icon: "play_arrow" }];
    // Starting a oneshot unit blocks until its run ends, so only a continuous unit gets a Running toggle.
    if (this.max_age === null) actions.push({ name: "Running", kind: "toggle", metric: "active", icon: "play_circle", on_action_id: "start_service", off_action_id: "stop_service", action_id: "active" });
    else actions.push({ name: "Stop Service", action_id: "stop_service", variant: "danger", icon: "stop" });
    actions.push({ name: "Start on Boot", kind: "toggle", metric: "enabled", icon: "power_settings_new", on_action_id: "enable_service", off_action_id: "disable_service", action_id: "enabled" });
    return actions;
  }

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    const verb = command_map[action_id];
    if (verb !== undefined) return action_plan(`sudo systemctl ${verb} ${this.unit}`);
    if (action_id === "daemon_reload") return action_plan("sudo systemctl daemon-reload");
    if (action_id === "view_unit_file") return action_plan(`sudo systemctl cat ${shell_quote(this.unit)}`);
    if (action_id === "write_unit_file") {
      const content_b64 = Buffer.from(String(args.content ?? ""), "utf8").toString("base64");
      const allowed_checks = this.allowed_write_paths.map((path) => `"$P" = ${shell_quote(path)} || case "$P" in ${shell_quote(`${path}/`)}*) true;; *) false;; esac`).join(" || ");
      return action_plan(
        `P=$(systemctl show -p FragmentPath --value ${shell_quote(this.unit)}); ` +
          "if [ -z \"$P\" ] || [ \"$P\" = 'n/a' ]; then echo 'Unit file path unavailable' >&2; exit 1; fi; " +
          `if ! ( ${allowed_checks} ); then echo "Write path not allowed: $P" >&2; exit 1; fi; ` +
          `echo ${shell_quote(content_b64)} | base64 -d | sudo tee "$P" > /dev/null`,
      );
    }
    return null;
  }

  override interpret_action(action_id: string, result: unknown, _args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    if (action_id === "view_unit_file") {
      if (outcome.exit_code !== 0) return CollectResult.failed(outcome.stderr.trim() || "Unable to read unit file");
      return new CollectResult({ success: true, metadata: { content: outcome.stdout } });
    }
    if (action_id === "write_unit_file") {
      if (outcome.exit_code !== 0) return CollectResult.failed(outcome.stderr.trim() || "Unable to write unit file");
      return new CollectResult({ logs: [["Unit file written successfully", "INFO"]], success: true });
    }
    if (outcome.exit_code !== 0) return CollectResult.failed(`systemctl ${command_map[action_id] ?? action_id} failed: ${outcome.stderr}`);
    return true;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override get UI_SPEC(): UISpec {
    return { dialogs: UNIT_FILE_DIALOGS };
  }

  unit_file_buttons(): (ButtonSpec & { visible: boolean })[] {
    return [
      { id: "view_unit_file", label: "View Unit File", icon: "article", color: "primary", kind: "dialog", dialog: "view_unit_file", visible: true },
      { id: "daemon_reload", label: "Reload Daemon", icon: "refresh", color: "secondary", kind: "dispatch", visible: true },
      { id: "edit_unit_file", label: "Edit Unit File", icon: "edit", color: "secondary", kind: "dialog", dialog: "edit_unit_file", visible: this.allow_unit_file_edit },
    ];
  }

  override custom_view(): CustomView {
    const default_layout = this.max_age !== null ? ONESHOT_LAYOUT : CONTINUOUS_LAYOUT;
    const metric = (name: string): number | null => this.data.latest_metric(name)?.value ?? null;
    const base = {
      service_name: this.service_name,
      default_layout,
      inline_layout: make_inline_layout(default_layout),
      layout: this.config.layout ?? null,
      unit_file: { title: "Unit file", buttons: this.unit_file_buttons() },
      dialogs: Object.fromEntries(Object.entries(UNIT_FILE_DIALOGS).map(([name, dialog]) => [name, { ...dialog, title: dialog.title!.replace("{plugin.service_name}", String(this.service_name)) }])),
      logs: { title: "Logs", limit: 100, full_height: true },
    };
    if (this.max_age === null) {
      const status_time = this.data.latest_status_time(this.id);
      return {
        kind: "systemd_service",
        data: {
          ...base,
          mode: "continuous",
          status_card: { metric: "active", title: "SERVICE STATUS", on_text: "ACTIVE", off_text: "INACTIVE", value: metric("active") },
          last_collection: status_time === null ? "--:--:--" : iso_local(status_time).slice(11),
        },
      };
    }
    const values = { is_running: metric("is_running"), last_run_epoch: metric("last_run_epoch"), last_run_success: metric("last_run_success") };
    return {
      kind: "systemd_service",
      data: {
        ...base,
        mode: "oneshot",
        max_age: this.max_age,
        max_age_text: format_duration(this.max_age),
        metrics: values,
        ...oneshot_state(values.is_running, values.last_run_epoch, values.last_run_success, this.max_age, Date.now() / 1000),
      },
    };
  }
}
