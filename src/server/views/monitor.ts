// A monitor's page: the header (name, what it watches, its schedule, its action buttons in their current states, the
// cancel and notifications buttons) over its body, and the helpers the routes call to run what those buttons ask.

import type { Plugin } from "../../monitors/base/plugin_base.ts";
import type { ActionButtonSpec, LayoutRow } from "../../shared/ui_spec.ts";
import type { ActionReply, BodyView, DialogView, HeaderActionView, MonitorPageView, MuteView } from "../../shared/page_view.ts";
import { outcome_notice } from "../../shared/page_view.ts";
import { dialog_views } from "./components.ts";
import { own_log_search, systemd_service_rows, type SystemdViewData } from "./custom.ts";
import type { NotificationsLike, ViewEngine } from "./engine.ts";
import { child_cards, composite_body } from "./group.ts";
import { format_when } from "./schedules.ts";
import { build_spec, spec_layout } from "./spec.ts";

// ── Building ─────────────────────────────────────────────────────────────────

// What one page build gathers as it goes: every dialog a widget may open, by monitor id and name, and the time read.
export interface BuildContext {
  dialogs: Record<string, Record<string, DialogView>>;
  now: Date;
}

export function new_context(now: Date = new Date()): BuildContext {
  return { dialogs: {}, now };
}

// The monitor's type from its config.
function type_of(plugin: Plugin): string {
  return String(plugin.config.type ?? "");
}

// A monitor's body: its custom page, its spec's widgets, or its group grid, and a card per child when it holds any.
export function build_body(plugin: Plugin, context: "page" | "inline", build: BuildContext): BodyView {
  try {
    build.dialogs[plugin.id] ??= dialog_views(plugin);
  } catch {
    build.dialogs[plugin.id] ??= {};
  }
  const custom = plugin.custom_view();
  const kind = custom?.kind ?? type_of(plugin);

  if (kind === "group") {
    const layout_rows = plugin.config.layout;
    if (Array.isArray(layout_rows) && layout_rows.length > 0) return composite_body(plugin, layout_rows as LayoutRow[], build);
    return { monitor_id: plugin.id, rows: [], children: child_cards(plugin, build), custom: null };
  }

  if (kind === "systemd_service" && custom !== null) {
    return { monitor_id: plugin.id, rows: systemd_service_rows(plugin, custom.data as SystemdViewData, context).rows, children: [], custom: null };
  }

  const spec = plugin.UI_SPEC;
  let rows: BodyView["rows"] = [];
  if (spec) {
    const layout = spec_layout(plugin, spec.layout ?? [], context);
    build_spec(plugin, { context, layout });
    if (kind === "journal") {
      const search = custom?.kind === "journal" ? ((custom.data as { log_search?: { cell?: string; page_only?: boolean; monitor_ids?: string[]; show_host?: boolean; default_limit?: number } } | null)?.log_search ?? null) : null;
      if (context === "page" || search?.page_only === false) layout.cell(search?.cell ?? "log_search").push(own_log_search(plugin, search));
    }
    rows = layout.rows;
  }
  const own_custom = custom !== null && custom.kind !== "journal" ? { kind: custom.kind, data: custom.data, extra: {} } : null;
  return { monitor_id: plugin.id, rows, children: plugin.children.length > 0 ? child_cards(plugin, build) : [], custom: own_custom };
}

// ── Header ───────────────────────────────────────────────────────────────────

// The monitor's type and the host it watches, as one line under its name; a group watches no host of its own.
export function lede(plugin: Plugin): string {
  const kind = type_of(plugin);
  const target = kind === "group" ? null : plugin.target;
  return [kind.replaceAll("_", " "), target].filter((part) => part).map(String).join(" · ");
}

// Maps each action id to the label a person sees for it; a toggle's two ids get its name plus on or off.
export function action_names(actions: readonly ActionButtonSpec[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const action of actions) {
    if (action.kind === "toggle") {
      names[String(action.on_action_id)] = `${action.name}: on`;
      names[String(action.off_action_id)] = `${action.name}: off`;
    } else {
      names[action.action_id] = String(action.name);
    }
  }
  return names;
}

// One caption per scheduled action, naming it as its button does and giving its next run, then one per triggered one.
export function schedule_lines(plugin: Plugin, now: Date = new Date()): string[] {
  const entries = plugin.scheduled_actions ?? [];
  const triggered = plugin.triggered_actions ?? [];
  if (entries.length === 0 && triggered.length === 0) return [];
  const names = action_names(plugin.all_actions());
  return [
    ...entries.map((entry) => {
      const upcoming = entry.cron.next_after(now);
      return `Scheduled: ${names[entry.action] ?? entry.action} · ${entry.cron.expression} · ${upcoming ? `next ${format_when(upcoming)}` : "never"}`;
    }),
    ...triggered.map((entry) => `Triggered: ${names[entry.action] ?? entry.action} · ${entry.describe()}`),
  ];
}

// The action's state now, as the plugin reports it.
export function action_state(plugin: Plugin, action: ActionButtonSpec): HeaderActionView["state"] {
  return typeof plugin.action_state === "function" ? plugin.action_state(action) : "normal";
}

// A toggle's state metric: pressed above one half, or null before the monitor has reported it.
function toggle_pressed(plugin: Plugin, action: ActionButtonSpec): boolean | null {
  const record = plugin.data.latest_metric(String(action.metric));
  return record === null ? null : record.value > 0.5;
}

function header_action(plugin: Plugin, action: ActionButtonSpec): HeaderActionView {
  const toggle = action.kind === "toggle";
  return {
    action_id: String(action.action_id ?? action.on_action_id ?? ""),
    name: String(action.name ?? action.action_id),
    icon: action.icon ?? (toggle ? "toggle_on" : "play_arrow"),
    danger: action.variant === "danger",
    kind: action.kind ?? null,
    dialog: action.dialog ?? null,
    confirm: action.confirm ?? null,
    more: Boolean(action.more) && !toggle,
    state: toggle ? "normal" : action_state(plugin, action),
    toggle: toggle ? { pressed: toggle_pressed(plugin, action), on_action_id: String(action.on_action_id), off_action_id: String(action.off_action_id) } : null,
  };
}

// The Notifications toggle: shown when notifications go somewhere, pressed while this monitor's are sent.
export function mute_view(notifications: NotificationsLike | null | undefined, plugin: Plugin): MuteView {
  const channels = notifications?.channels;
  const count = channels instanceof Map ? channels.size : Object.keys(channels ?? {}).length;
  if (!notifications || count === 0) return { present: false, maintenance: null, muted_by: null, sending: true };
  const muter = notifications.muted_by(plugin.id);
  return {
    present: true,
    maintenance: notifications.maintenance_for(plugin.id),
    muted_by: muter !== null && muter !== plugin.id ? notifications.monitor_name(muter) : null,
    sending: muter === null,
  };
}

// The whole page of one monitor.
export function monitor_page_view(engine: Pick<ViewEngine, "notifications">, plugin: Plugin, now: Date = new Date()): MonitorPageView {
  const build = new_context(now);
  const body = build_body(plugin, "page", build);
  const actions = plugin.present().actions.map((action) => header_action(plugin, action));
  const more_states = actions.filter((action) => action.more).map((action) => action.state).filter((state) => state !== "hidden");
  const has_job_action = plugin.present().actions.some((action) => action.job || action.detached);
  return {
    id: plugin.id,
    name: plugin.name,
    lede: lede(plugin),
    schedule: schedule_lines(plugin, now),
    actions,
    more: { visible: more_states.length > 0, filled: more_states.includes("accent") },
    cancel: { present: plugin.jobs !== null && has_job_action, visible: plugin.jobs !== null && has_job_action && plugin.jobs.any_running() },
    mute: mute_view(engine.notifications, plugin),
    body,
    dialogs: build.dialogs,
  };
}

// ── Running what the page asks ───────────────────────────────────────────────

// The detached job an action just started, whose live log the page opens.
function started_job(plugin: Plugin, action_id: string): number | null {
  return plugin.jobs?.action_job(action_id)?.id ?? null;
}

// Runs one action with its arguments and says how it went under `label`.
export async function run_page_action(plugin: Plugin, action_id: string, args: Record<string, unknown> = {}, label: string = action_id): Promise<ActionReply> {
  const [success, content] = await plugin.run_action(action_id, args);
  return { success, content, notice: outcome_notice(label, success, content), tone: success ? "positive" : "negative", job_id: success ? started_job(plugin, action_id) : null };
}

// Runs a header action unless it is running, greyed out or hidden, which would only be refused.
export async function run_header_action(plugin: Plugin, action_id: string): Promise<ActionReply> {
  const action = plugin.present().actions.find((each) => each.action_id === action_id);
  if (action === undefined) return { success: false, content: "", notice: `Unknown action '${action_id}'`, tone: "negative", job_id: null };
  if (action_state(plugin, action) !== "normal") return { success: false, content: "", notice: `${action.name ?? action_id} is not available now`, tone: "warning", job_id: null };
  return run_page_action(plugin, action_id, {}, String(action.name ?? action_id));
}

// Flips a header toggle: runs its on or off action, then polls so the button shows what the target did.
export async function run_header_toggle(plugin: Plugin, toggle_name: string, on_action_id: string, off_action_id: string, wanted: boolean): Promise<ActionReply> {
  const action_id = wanted ? on_action_id : off_action_id;
  const word = wanted ? "on" : "off";
  let success = false;
  let content = "";
  [success, content] = await plugin.run_action(action_id, {});
  if (success) await plugin.run_cycle();
  return { success, content, notice: success ? `${toggle_name}: ${word}` : `${toggle_name} could not be turned ${word}`, tone: success ? "positive" : "negative", job_id: null };
}

// Flips a table's toggle cell for one row, then polls to read the state back.
export async function run_cell_toggle(plugin: Plugin, column_label: string, row_key_value: unknown, action_id: string, args: Record<string, unknown>, wanted: boolean): Promise<ActionReply> {
  let success = false;
  let content = "";
  try {
    [success, content] = await plugin.run_action(action_id, args);
    if (success) await plugin.run_cycle();
  } catch (error) {
    content = (error as Error).message;
  }
  const label = `${column_label} ${wanted ? "on" : "off"}: ${String(row_key_value)}`;
  return { success, content, notice: outcome_notice(label, success, content), tone: success ? "positive" : "negative", job_id: null };
}

// Polls the monitor now, its children first.
export async function poll_now(plugin: Plugin): Promise<ActionReply> {
  const success = await plugin.run_cycle();
  return { success, content: "", notice: `${plugin.name} polled`, tone: "positive", job_id: null };
}

// Cancels the monitor's running job, or its newest detached action.
export async function cancel_job(plugin: Plugin): Promise<ActionReply> {
  const cancelled = plugin.jobs !== null && (await plugin.jobs.cancel());
  return cancelled
    ? { success: true, content: "", notice: "Cancellation requested", tone: "warning", job_id: null }
    : { success: false, content: "", notice: "No job is running", tone: "info", job_id: null };
}

// Starts the job panel's run action without waiting for it, unless a job already runs.
export function start_job(plugin: Plugin, run_action_id: string, run_label: string | null): ActionReply {
  if (plugin.jobs?.is_running()) return { success: false, content: "", notice: "A job is already running", tone: "warning", job_id: null };
  void plugin.run_action(run_action_id).catch(() => undefined);
  return { success: true, content: "", notice: `${run_label ?? "Job"} started`, tone: "positive", job_id: null };
}
