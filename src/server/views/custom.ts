// The pages the declarative spec cannot draw alone: a systemd service's (a continuous service or a oneshot one judged
// by the age of its last run), the borg monitor's spec plus its archive browser, and the journal's spec plus its log
// search. Each reads the monitor's attributes and readings by their Python names.

import type { Plugin } from "../../monitors/base/plugin_base.ts";
import { format_age, format_duration } from "../../monitors/base/plugin_helpers.ts";
import type { BrowserView, LogSearchView, ValueCardView } from "../../shared/page_view.ts";
import { iso_local } from "../../shared/time.ts";
import type { ButtonSpec, LayoutRow } from "../../shared/ui_spec.ts";
import { buttons_view, host_card, info_card, latest_value, log_feed, status_card } from "./components.ts";
import { plugin_attr } from "./engine.ts";
import { make_inline_layout, PluginLayout } from "./layout.ts";

// ── systemd services ─────────────────────────────────────────────────────────

export const CONTINUOUS_LAYOUT: LayoutRow[] = [
  ["host_card", "service_card", "status_card", "time_card"],
  ["unit_file_card"],
  ["logs"],
];

export const ONESHOT_LAYOUT: LayoutRow[] = [
  ["host_card", "service_card", "maxage_card", "state_card"],
  ["unit_file_card"],
  ["history"],
  ["logs"],
];

function unit_file_buttons(): ButtonSpec[] {
  return [
    { id: "view_unit_file", label: "View Unit File", icon: "article", color: "primary", kind: "dialog", dialog: "view_unit_file" },
    { id: "daemon_reload", label: "Reload Daemon", icon: "refresh", color: "secondary", kind: "dispatch" },
    { id: "edit_unit_file", label: "Edit Unit File", icon: "edit", color: "secondary", kind: "dialog", dialog: "edit_unit_file", visible_if: (plugin) => Boolean(plugin_attr(plugin, "allow_unit_file_edit")) },
  ];
}

// The oneshot state, last result and last run cards, from the run metrics.
export function oneshot_cards(is_running: number | null, last_run_epoch: number | null, last_run_success: number | null, max_age: number, now_seconds: number): { state: ValueCardView; history_visible: boolean; result: ValueCardView; age: ValueCardView } {
  const result = info_card("LAST RESULT", "--");
  const age = info_card("LAST RUN", "--");
  if (is_running !== null && is_running > 0.5) return { state: info_card("CURRENT STATE", "RUNNING", "warning"), history_visible: false, result, age };
  if (last_run_epoch === null) return { state: info_card("CURRENT STATE", "UNKNOWN", "unavailable"), history_visible: true, result, age };
  const ok = last_run_success !== null && last_run_success > 0.5;
  const epoch = Math.trunc(last_run_epoch);
  const state = epoch === 0 ? info_card("CURRENT STATE", "NEVER RUN", "failed") : info_card("CURRENT STATE", "IDLE", "online");
  const result_card = info_card("LAST RESULT", ok ? "SUCCESS" : "FAILED", ok ? "online" : "failed");
  if (epoch === 0) return { state, history_visible: true, result: result_card, age: info_card("LAST RUN", "Never run", "failed") };
  const seconds = Math.trunc(now_seconds) - epoch;
  return { state, history_visible: true, result: result_card, age: info_card("LAST RUN", format_age(seconds), seconds > max_age ? "failed" : "online") };
}

// A systemd service's page: a continuous service shows whether it is active, a oneshot one its last run.
export function systemd_service_rows(plugin: Plugin, context: "page" | "inline", now: Date): PluginLayout {
  const max_age = plugin_attr(plugin, "max_age");
  const oneshot = max_age !== null && max_age !== undefined;
  const rows = oneshot ? ONESHOT_LAYOUT : CONTINUOUS_LAYOUT;
  const layout = new PluginLayout(plugin.config, context === "page" ? rows : make_inline_layout(rows));
  const service_name = String(plugin_attr(plugin, "service_name") ?? "");

  layout.cell("host_card").push(host_card(plugin.target));
  layout.cell("service_card").push(info_card("SERVICE", service_name));
  layout.cell("unit_file_card").push(buttons_view(plugin, unit_file_buttons(), "Unit file"));
  layout.cell("logs").push(log_feed(plugin, { title: "Logs", limit: 100, full_height: true }));

  if (!oneshot) {
    layout.cell("status_card").push(status_card(latest_value(plugin, "active"), "SERVICE STATUS", "ACTIVE", "INACTIVE"));
    const collected = plugin.data.latest_status_time(plugin.id);
    layout.cell("time_card").push(info_card("LAST COLLECTION", collected ? iso_local(collected).slice(11) : "--:--:--"));
    return layout;
  }

  layout.cell("maxage_card").push(info_card("MAX AGE", format_duration(Number(max_age))));
  const cards = oneshot_cards(latest_value(plugin, "is_running"), latest_value(plugin, "last_run_epoch"), latest_value(plugin, "last_run_success"), Number(max_age), now.getTime() / 1000);
  layout.cell("state_card").push(cards.state);
  const history = layout.cell("history");
  if (cards.history_visible) history.push(cards.result, cards.age);
  return layout;
}

// ── borg ─────────────────────────────────────────────────────────────────────

// The archive browser's starting point: the archive names the monitor last listed, and where restores go.
export function browser_view(plugin: Plugin): BrowserView {
  const cached = plugin_attr(plugin, "cached_archives") as [Record<string, unknown>[], unknown] | Record<string, unknown>[] | undefined;
  const archives = Array.isArray(cached) && Array.isArray(cached[0]) ? (cached[0] as Record<string, unknown>[]) : Array.isArray(cached) ? (cached as Record<string, unknown>[]) : [];
  return {
    type: "browser",
    monitor_id: plugin.id,
    archives: archives.map((archive) => archive.name).filter((name): name is string => Boolean(name)).map(String),
    restore_dir: String(plugin_attr(plugin, "restore_dir") ?? ""),
    browse_limit: Number(plugin_attr(plugin, "browse_limit") ?? 2000),
  };
}

export interface BrowseRow {
  name: string;
  path: string;
  dir: boolean;
  size: string;
  size_bytes: number | null;
  mtime: string;
}

export interface BrowseFolder {
  status: string;
  rows: BrowseRow[];
}

// A size as borg's browser writes it.
function format_size(size: number): string {
  let value = size;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (Math.abs(value) < 1024 || unit === "TB") return unit === "B" ? `${Math.trunc(value)} B` : `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${size} B`;
}

// The children of `path` in `archive`, listing it through the monitor's browse action when it has not been listed yet;
// borg reads the whole archive to list a folder, so a large one takes a while.
export async function browse_folder(plugin: Plugin, archive: string, path: string): Promise<BrowseFolder> {
  const listing = (plugin as unknown as { listing(archive: string, path: string): Record<string, unknown>[] | null }).listing.bind(plugin);
  let entries = listing(archive, path);
  if (entries === null) {
    const [ok, content] = await plugin.run_action("browse_archive", { archive, path });
    entries = listing(archive, path);
    if (!ok || entries === null) return { status: content || "Listing failed", rows: [] };
  }
  const limit = Number(plugin_attr(plugin, "browse_limit") ?? 2000);
  let status: string;
  if (entries.length === 0) status = "Nothing at this path.";
  else if (entries.length > limit) status = `Showing the first ${limit} entries — raise browse_limit to see more.`;
  else status = `${entries.length} entries`;
  return {
    status,
    rows: entries.slice(0, limit).map((entry) => ({
      name: String(entry.name),
      path: String(entry.path),
      dir: Boolean(entry.dir),
      size: entry.dir || entry.size === null || entry.size === undefined ? "" : format_size(Number(entry.size)),
      size_bytes: entry.dir ? null : ((entry.size as number | null) ?? null),
      mtime: String(entry.mtime ?? ""),
    })),
  };
}

// The question asked before a restore, listing up to ten of the ticked paths.
export function restore_question(archive: string, restore_dir: string, paths: readonly string[]): string {
  let shown = paths.slice(0, 10).map((path) => `  /${path}`).join("\n");
  if (paths.length > 10) shown += `\n  … and ${paths.length - 10} more`;
  return `Restore from ${archive} into a new folder under ${restore_dir}? Live files are not touched.\n\n${shown}`;
}

// ── journal ──────────────────────────────────────────────────────────────────

// The journal monitor's own log search, over its host alone.
export function own_log_search(plugin: Plugin): LogSearchView {
  return { type: "log_search", monitors: [{ id: plugin.id, target: plugin.target }], show_host: false, default_limit: Number(plugin_attr(plugin, "max_entries") ?? 500) };
}
