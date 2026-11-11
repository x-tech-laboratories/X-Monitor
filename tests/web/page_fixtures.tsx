// What the rendered tests share: the dialog, toast and menu hosts the Shell holds, and page views to draw.

import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { ContextMenus } from "@x-tech-laboratories/x-libs/web/react/menus";
import { Toasts } from "@x-tech-laboratories/x-libs/web/react/toasts";
import type { ReactNode } from "react";

import type { ActionReply, BodyView, MonitorPageView, WidgetView } from "../../src/shared/page_view.ts";

// The page with the hosts dialogs, toasts and menus open into.
export function Hosted({ children }: { children: ReactNode }) {
  return <>{children}<Dialogs /><Toasts /><ContextMenus /></>;
}

export function reply(fields: Partial<ActionReply> = {}): ActionReply {
  return { success: true, content: "", notice: "Done", tone: "positive", job_id: null, ...fields };
}

// A body of one row, a cell per widget.
export function body_of(widgets: WidgetView[], monitor_id = "host"): BodyView {
  return {
    monitor_id,
    rows: [{ hidden: false, cells: widgets.map((widget, index) => ({ widget: `w${index}`, flex: 1, visible: true, height: null, min_width: "280px", title: null, content: [widget] })) }],
    children: [],
    custom: null,
  };
}

export function page_of(fields: Partial<MonitorPageView> = {}): MonitorPageView {
  return {
    id: "host",
    name: "Host",
    lede: "nixos upgrade · host1",
    schedule: [],
    actions: [],
    more: { visible: false, filled: false },
    cancel: { present: false, visible: false },
    mute: { present: false, maintenance: null, muted_by: null, sending: true },
    body: body_of([]),
    dialogs: {},
    ...fields,
  };
}
