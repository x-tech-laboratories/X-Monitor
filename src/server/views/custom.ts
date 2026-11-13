// The pages the declarative spec cannot draw alone: a systemd service's (a continuous service or a oneshot one judged
// by the age of its last run), and the journal's spec plus its log search. Each reads the monitor's attributes and readings by their Python names.

import type { Plugin } from "../../monitors/base/plugin_base.ts";
import type { LogSearchView, ValueCardView } from "../../shared/page_view.ts";
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
