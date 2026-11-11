// The pages the declarative spec cannot draw alone: a systemd service's (a continuous service or a oneshot one judged
// by the age of its last run), the borg monitor's spec plus its archive browser, and the journal's spec plus its log
// search. Each reads the monitor's attributes and readings by their Python names.

import type { Plugin } from "../../monitors/base/plugin_base.ts";
import type { BrowserView, LogSearchView, ValueCardView } from "../../shared/page_view.ts";
import { status_of } from "../../shared/status.ts";
import type { ButtonSpec, LayoutRow } from "../../shared/ui_spec.ts";
import { buttons_view, host_card, info_card, log_feed, status_card } from "./components.ts";
import { plugin_attr } from "./engine.ts";
import { PluginLayout } from "./layout.ts";

// ── systemd services ─────────────────────────────────────────────────────────

// A state the systemd monitor reports, such as {text: "IDLE", level: "online"}.
interface StateText {
  text: string;
  level: string;
}

// What the systemd monitor's custom_view() hands over (src/monitors/systemd_service.ts).
export interface SystemdViewData {
  mode: "continuous" | "oneshot";
  service_name: string | null;
  default_layout: LayoutRow[];
  inline_layout: LayoutRow[];
  unit_file: { title: string; buttons: (ButtonSpec & { visible?: boolean })[] };
  logs: { title: string; limit: number; full_height: boolean };
  status_card?: { title: string; on_text: string; off_text: string; value: number | null };
  last_collection?: string;
  max_age_text?: string;
  state?: StateText | null;
  history_visible?: boolean;
  result?: StateText | null;
  age?: StateText | null;
}

function state_card(title: string, state: StateText | null | undefined): ValueCardView {
  return state ? info_card(title, state.text, status_of(state.level)) : info_card(title, "--");
}

// A systemd service's page from what the monitor reports: a continuous service shows whether it is active, a oneshot
// one its last run; the layout is the monitor's own, made compact inline.
export function systemd_service_rows(plugin: Plugin, data: SystemdViewData, context: "page" | "inline"): PluginLayout {
  const layout = new PluginLayout(plugin.config, context === "page" ? data.default_layout : data.inline_layout);
  layout.cell("host_card").push(host_card(plugin.target));
  layout.cell("service_card").push(info_card("SERVICE", String(data.service_name ?? "")));
  const buttons = data.unit_file.buttons.filter((button) => button.visible !== false).map(({ visible: _visible, ...button }) => button);
  layout.cell("unit_file_card").push(buttons_view(plugin, buttons, data.unit_file.title));
  layout.cell("logs").push(log_feed(plugin, data.logs));

  if (data.mode === "continuous") {
    const card = data.status_card;
    layout.cell("status_card").push(status_card(card?.value ?? null, card?.title, card?.on_text, card?.off_text));
    layout.cell("time_card").push(info_card("LAST COLLECTION", data.last_collection ?? "--:--:--"));
    return layout;
  }
  layout.cell("maxage_card").push(info_card("MAX AGE", data.max_age_text ?? "--"));
  layout.cell("state_card").push(state_card("CURRENT STATE", data.state));
  if (data.history_visible) layout.cell("history").push(state_card("LAST RESULT", data.result), state_card("LAST RUN", data.age));
  return layout;
}

// ── borg ─────────────────────────────────────────────────────────────────────

// The archive browser's starting point: the archive names (from the monitor's custom_view() data, else its last
// listing), the browse limit and where restores go.
export function browser_view(plugin: Plugin, data: Record<string, unknown> | null = null): BrowserView {
  const names = (list: unknown): string[] => (Array.isArray(list) ? list.map((archive) => (typeof archive === "object" && archive !== null ? (archive as Record<string, unknown>).name : archive)).filter(Boolean).map(String) : []);
  let archives = names(data?.archives);
  if (data?.archives === undefined) {
    const cached = plugin_attr(plugin, "cached_archives");
    archives = names(Array.isArray(cached) && Array.isArray(cached[0]) ? cached[0] : cached);
  }
  return {
    type: "browser",
    monitor_id: plugin.id,
    archives,
    restore_dir: String(data?.restore_dir ?? plugin_attr(plugin, "restore_dir") ?? ""),
    browse_limit: Number(data?.browse_limit ?? plugin_attr(plugin, "browse_limit") ?? 2000),
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

// The entries of a listing the browse action returned in its metadata, or null when it carried none.
function listing_entries(metadata: Record<string, string> | null): Record<string, unknown>[] | null {
  if (!metadata?.listing) return null;
  try {
    const listing = JSON.parse(metadata.listing) as { entries?: unknown };
    return Array.isArray(listing.entries) ? (listing.entries as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

// The children of `path` in `archive`: the monitor's cached listing when it has one, else what its browse action
// lists; borg reads the whole archive to list a folder, so a large one takes a while.
export async function browse_folder(engine: { dispatch_action(plugin: unknown, action_id: string, args?: Record<string, unknown>): Promise<[boolean, Record<string, string> | null]> }, plugin: Plugin, archive: string, path: string): Promise<BrowseFolder> {
  const cached = (plugin as unknown as { listing?: (archive: string, path: string) => Record<string, unknown>[] | null }).listing;
  let entries = typeof cached === "function" ? cached.call(plugin, archive, path) : null;
  if (entries === null) {
    const [ok, metadata] = await engine.dispatch_action(plugin, "browse_archive", { archive, path });
    entries = listing_entries(metadata) ?? (typeof cached === "function" ? cached.call(plugin, archive, path) : null);
    if (!ok || entries === null) return { status: String(metadata?.content || "") || "Listing failed", rows: [] };
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

// The journal monitor's own log search, from its custom_view() data when it gives one.
export function own_log_search(plugin: Plugin, data: { monitor_ids?: string[]; show_host?: boolean; default_limit?: number } | null = null): LogSearchView {
  return {
    type: "log_search",
    monitors: (data?.monitor_ids ?? [plugin.id]).map((id) => ({ id, target: plugin.target })),
    show_host: data?.show_host ?? false,
    default_limit: Number(data?.default_limit ?? plugin_attr(plugin, "max_entries") ?? 500),
  };
}
