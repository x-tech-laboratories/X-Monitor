// Inventory of every systemd service on the target, from two systemctl list commands, drawn as a filterable table whose
// Active and Enabled cells are toggle buttons that start/stop and enable/disable the unit, with restart and unit-file
// view/edit actions per row. Config: lines, allow_unit_file_edit, and allowed_write_paths restricting where an edited
// unit file may be written back. The monitor is online whenever collection succeeds (failed units are surfaced as
// counts, not escalated), and a systemctl run that could not complete makes it unavailable.

import { action_plan, command, CollectResult, type ActionOutcome, type ActionPlanResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import type { ActionButtonSpec, LayoutRow, RowActionSpec, TableSpec, ToggleCellSpec, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { parse_int, split_lines, split_words } from "./base/text_parsing.ts";

const default_layout: LayoutRow[] = [["host_card", "count_card"], ["table"], ["events"]];

// Toggle states for the table's Active and Enabled cells; any other value stays as plain text.
const active_toggle: ToggleCellSpec = { on: ["active"], off: ["inactive", "failed"], on_action_id: "start_service", off_action_id: "stop_service", params: { service_name: "unit" } };
const enabled_toggle: ToggleCellSpec = { on: ["enabled", "enabled-runtime"], off: ["disabled"], on_action_id: "enable_service", off_action_id: "disable_service", params: { service_name: "unit" } };

const default_unit_file_write_paths = ["/etc/systemd/system", "/run/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"];

const list_units_command = "systemctl list-units --type=service --all --no-legend --no-pager --plain";
const list_unit_files_command = "systemctl list-unit-files --type=service --all --no-legend --no-pager";

const service_actions = ["start_service", "stop_service", "restart_service", "enable_service", "disable_service"];

// One service row, as the snapshot keeps it.
export interface ServiceRow {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled?: string;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class ServiceList extends Plugin {
  readonly max_logs: number;
  readonly allow_unit_file_edit: boolean;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.max_logs = parse_int(config.lines ?? 10);
    this.allow_unit_file_edit = Boolean(config.allow_unit_file_edit ?? false);
  }

  override commands(): Command[] {
    return [command(list_units_command), command(list_unit_files_command)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const [units_result, unit_files_result] = results;
    if (units_result.exit_code !== 0) return CollectResult.unavailable(`Collection failed: ${units_result.stderr}`);
    const services = ServiceList.parse_unit_list(units_result.stdout);
    if (unit_files_result.exit_code !== 0) return CollectResult.unavailable(`Unit-file collection failed: ${unit_files_result.stderr}`);

    const enabled_map = ServiceList.parse_unit_file_list(unit_files_result.stdout);
    for (const service of services) service.enabled = enabled_map.get(service.unit) ?? "unknown";

    const total = services.length;
    const active = services.filter((service) => service.active === "active").length;
    const failed = services.filter((service) => service.active === "failed").length;
    return new CollectResult({
      metrics: { services_total: total, services_active: active, services_failed: failed },
      snapshot: services,
      logs: [[`Collected ${total} services, ${active} active, ${failed} failed`, "INFO"]],
      status: "online",
    });
  }

  static parse_unit_list(stdout: string): ServiceRow[] {
    const services: ServiceRow[] = [];
    for (const line of split_lines(stdout)) {
      if (!line.trim()) continue;
      const parts = split_words(line, 4);
      if (parts.length < 5) continue;
      const [unit, load, active, sub, description] = parts;
      services.push({ unit, load, active, sub, description });
    }
    return services;
  }

  static parse_unit_file_list(stdout: string): Map<string, string> {
    const enabled_map = new Map<string, string>();
    for (const line of split_lines(stdout)) {
      if (!line.trim()) continue;
      const parts = split_words(line, 2);
      if (parts.length < 2) continue;
      enabled_map.set(parts[0], parts[1]);
    }
    return enabled_map;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    return [{ name: "Reload Daemon", action_id: "daemon_reload", variant: "secondary", icon: "refresh" }];
  }

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    const service_name = args.service_name as string | null | undefined;
    if (service_actions.includes(action_id)) {
      if (!service_name) return CollectResult.failed("Service action missing service_name");
      return action_plan(`sudo systemctl ${action_id.replace("_service", "")} ${shell_quote(service_name)}`);
    }
    if (action_id === "daemon_reload") return action_plan("sudo systemctl daemon-reload");
    if (action_id === "view_status") {
      if (!service_name) return CollectResult.failed("view_status missing service_name");
      return action_plan(`sudo systemctl status ${shell_quote(service_name)} --no-pager`);
    }
    if (action_id === "view_unit_file") {
      if (!service_name) return CollectResult.failed("view_unit_file missing service_name");
      return action_plan(`sudo systemctl cat ${shell_quote(service_name)}`);
    }
    if (action_id === "write_unit_file") {
      if (!service_name) return CollectResult.failed("write_unit_file missing service_name");
      const content_b64 = Buffer.from(String(args.content ?? ""), "utf8").toString("base64");
      const allowed_write_paths = ((this.config.allowed_write_paths as string[] | undefined) ?? default_unit_file_write_paths).map(String);
      const allowed_checks = allowed_write_paths.map((path) => `"$P" = ${shell_quote(path)} || case "$P" in ${shell_quote(`${path}/`)}*) true;; *) false;; esac`).join(" || ");
      return action_plan(
        `P=$(systemctl show -p FragmentPath --value ${shell_quote(service_name)}); ` +
          "if [ -z \"$P\" ] || [ \"$P\" = 'n/a' ]; then echo 'Unit file path unavailable' >&2; exit 1; fi; " +
          `if ! ( ${allowed_checks} ); then echo "Write path not allowed: $P" >&2; exit 1; fi; ` +
          `echo ${shell_quote(content_b64)} | base64 -d | sudo tee "$P" > /dev/null`,
      );
    }
    return null;
  }

  override interpret_action(action_id: string, result: unknown, args: Record<string, unknown> = {}): ActionOutcome {
    const outcome = result as CmdResult;
    if (action_id === "view_status") {
      if (outcome.exit_code !== 0) return CollectResult.failed(outcome.stderr.trim() || "Unable to fetch service status");
      return new CollectResult({ success: true, metadata: { content: outcome.stdout } });
    }
    if (action_id === "view_unit_file") {
      if (outcome.exit_code !== 0) return CollectResult.failed(outcome.stderr.trim() || "Unable to read unit file");
      return new CollectResult({ success: true, metadata: { content: outcome.stdout } });
    }
    if (action_id === "write_unit_file") {
      if (outcome.exit_code !== 0) return CollectResult.failed(outcome.stderr.trim() || "Unable to write unit file");
      return new CollectResult({ logs: [["Unit file written successfully", "INFO"]], success: true });
    }
    if (outcome.exit_code !== 0) {
      const verb = action_id !== "daemon_reload" ? action_id.replace("_service", "") : "daemon-reload";
      const service_name = args.service_name === undefined || args.service_name === null ? "None" : String(args.service_name);
      return CollectResult.failed(`systemctl ${verb} failed for ${service_name}: ${outcome.stderr}`);
    }
    return true;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  get service_count_text(): string {
    const count_metric = this.data.latest_metric("services_total");
    if (count_metric !== null) return String(Math.trunc(count_metric.value));
    return String((this.data.latest_snapshot<unknown[]>([]) ?? []).length);
  }

  override get UI_SPEC(): UISpec {
    const row_actions: RowActionSpec[] = [
      { id: "restart_service", icon: "replay", color: "primary", tooltip: "Restart Service", kind: "dispatch", action_id: "restart_service", params: { service_name: "unit" } },
      { id: "view_status", icon: "info", color: "info", tooltip: "View Status", kind: "dialog", dialog: "view_status" },
      { id: "view_file", icon: "article", color: "secondary", tooltip: "View Unit File", kind: "dialog", dialog: "view_unit_file" },
      { id: "edit_file", icon: "edit", color: "secondary", tooltip: "Edit Unit File", kind: "dialog", dialog: "edit_unit_file", visible_if: (plugin) => (plugin as ServiceList).allow_unit_file_edit },
    ];
    const table = {
      title: "Services",
      row_key: "unit",
      columns: [
        { name: "unit", label: "Unit", field: "unit", sortable: true, align: "left" },
        { name: "load", label: "Load", field: "load", sortable: true, align: "left" },
        { name: "active", label: "Active", field: "active", sortable: true, align: "left", toggle: active_toggle },
        { name: "sub", label: "Sub", field: "sub", sortable: true, align: "left" },
        { name: "enabled", label: "Enabled", field: "enabled", sortable: true, align: "left", toggle: enabled_toggle },
        { name: "description", label: "Description", field: "description", sortable: true, align: "left" },
      ],
      row_actions,
    };
    return {
      layout: default_layout,
      cards: { count_card: { title: "SERVICES", value_attr: "service_count_text" } },
      // The table carries a title, which TableSpec does not declare yet.
      tables: { table: table as TableSpec },
      filters: { table: { placeholder: "Filter services", fields: ["unit", "load", "active", "sub", "enabled", "description"] } },
      dialogs: {
        view_status: { kind: "read", title: "Status: {row[unit]}", action_id: "view_status", params: { service_name: "unit" }, render: "text" },
        view_unit_file: { kind: "read", title: "Unit file: {row[unit]}", action_id: "view_unit_file", params: { service_name: "unit" }, render: "textarea_readonly" },
        edit_unit_file: {
          kind: "edit", title: "Edit unit file: {row[unit]}",
          load_action_id: "view_unit_file", load_params: { service_name: "unit" },
          save_action_id: "write_unit_file", save_params: { service_name: "unit" },
          save_content_kwarg: "content", success_message: "Unit file written successfully",
        },
      },
      events: { title: "Plugin events" },
    };
  }
}
