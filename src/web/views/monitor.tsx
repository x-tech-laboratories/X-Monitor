// One monitor's page: its name and what it watches, its schedule, the Poll Now button, its action buttons in their
// current states with the less used ones under More, Cancel while a job runs, the Notifications toggle, and its body.

import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { PageHeading } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { ApiError } from "@x-tech-laboratories/x-libs/web/api";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { useEffect, useState, type MouseEvent } from "react";

import type { HeaderActionView, MonitorPageView } from "../../shared/page_view.ts";
import { calls, live } from "../api.ts";
import { confirmed, notify, notify_error } from "../ui.tsx";
import { Body, Page } from "./body.tsx";
import { open_job_log, open_spec_dialog } from "./dialogs.tsx";

// ── Header actions ───────────────────────────────────────────────────────────

// Opens the action's dialog, or asks its confirm question and runs it, then says how it went.
async function run_header_action(view: MonitorPageView, action: HeaderActionView, reload: () => void): Promise<void> {
  // An action that is running or greyed out would only be refused.
  if (action.state !== "normal") return;
  if (action.kind === "dialog") {
    await open_spec_dialog(view.id, view.dialogs[view.id], String(action.dialog));
    return;
  }
  if (action.confirm && !(await confirmed(action.confirm))) return;
  try {
    const reply = await calls.run_header_action(view.id, action.action_id);
    notify(reply);
    if (reply.success && reply.job_id !== null) await open_job_log(view.id, reply.job_id);
  } catch (error) {
    notify_error(error);
  }
  reload();
}

function button_class(action: HeaderActionView): string | undefined {
  const parts = [action.state === "accent" ? "accent solid" : null, action.danger ? "danger" : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function ActionButton({ view, action, reload }: { view: MonitorPageView; action: HeaderActionView; reload: () => void }) {
  if (action.state === "hidden") return null;
  return <button type="button" className={button_class(action)} disabled={action.state === "disabled"} onClick={() => void run_header_action(view, action, reload)}>{action.name}</button>;
}

// A toggle button, pressed while its state metric is on, that runs its on or off action and reads the state back.
function ToggleButton({ view, action, reload }: { view: MonitorPageView; action: HeaderActionView; reload: () => void }) {
  const [busy, set_busy] = useState(false);
  const toggle = action.toggle!;
  const click = async () => {
    if (busy || toggle.pressed === null) return;
    set_busy(true);
    try {
      notify(await calls.toggle(view.id, { name: action.name, on_action_id: toggle.on_action_id, off_action_id: toggle.off_action_id, wanted: !toggle.pressed }));
    } catch (error) {
      notify_error(error);
    } finally {
      set_busy(false);
    }
    reload();
  };
  // A monitor that has not reported the state yet has nothing for the button to show.
  return <button type="button" className={toggle.pressed ? "active" : undefined} aria-pressed={Boolean(toggle.pressed)} disabled={busy || toggle.pressed === null} onClick={() => void click()}>{action.name}</button>;
}

function MoreButton({ view, reload }: { view: MonitorPageView; reload: () => void }) {
  const more = view.actions.filter((action) => action.more);
  if (more.length === 0 || !view.more.visible) return null;
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    open_context_menu({ clientX: box.left, clientY: box.bottom, preventDefault: () => undefined }, more.filter((action) => action.state !== "hidden").map((action) => ({
      label: action.name,
      danger: action.danger,
      disabled: action.state === "disabled" || action.state === "accent",
      checked: action.state === "accent" ? true : undefined,
      run: () => void run_header_action(view, action, reload),
    })));
  };
  return <button type="button" className={view.more.filled ? "accent solid" : undefined} aria-haspopup="menu" onClick={open}>More</button>;
}

function PollButton({ view, reload }: { view: MonitorPageView; reload: () => void }) {
  const [polling, set_polling] = useState(false);
  const click = async () => {
    if (polling) return;
    set_polling(true);
    try {
      notify(await calls.poll(view.id));
    } catch (error) {
      notify_error(error);
    } finally {
      set_polling(false);
    }
    reload();
  };
  // The button takes the accent only while a poll runs, so the fill means "working" rather than "click me".
  return <button type="button" className={polling ? "accent solid" : undefined} onClick={() => void click()}>{polling ? "Polling..." : "Poll Now"}</button>;
}

function CancelButton({ view, reload }: { view: MonitorPageView; reload: () => void }) {
  if (!view.cancel.present || !view.cancel.visible) return null;
  const click = async () => {
    try {
      notify(await calls.cancel(view.id));
    } catch (error) {
      notify_error(error);
    }
    reload();
  };
  return <button type="button" className="danger" onClick={() => void click()}>Cancel</button>;
}

// The Notifications toggle: pressed sends this monitor's notifications, released mutes them, or a group's for all in it.
function MuteButton({ view, reload }: { view: MonitorPageView; reload: () => void }) {
  if (!view.mute.present) return null;
  const click = async () => {
    try {
      const answer = await calls.mute(view.id, view.mute.sending);
      notify({ notice: answer.message, tone: "positive" });
    } catch (error) {
      notify_error(error);
    }
    reload();
  };
  return (
    <>
      {view.mute.maintenance && <button type="button" disabled>In maintenance: {view.mute.maintenance}</button>}
      {view.mute.muted_by
        ? <button type="button" disabled aria-pressed={false}>Muted by {view.mute.muted_by}</button>
        : <button type="button" className={view.mute.sending ? "active" : undefined} aria-pressed={view.mute.sending} onClick={() => void click()}>Notifications</button>}
    </>
  );
}

export function MonitorHeader({ view, reload }: { view: MonitorPageView; reload: () => void }) {
  return (
    <PageHeading
      title={view.name}
      subtitle={<>{view.lede}{view.schedule.map((line) => <span key={line} className="muted small schedule-line">{line}</span>)}</>}
      actions={(
        <span className="button-row">
          <PollButton view={view} reload={reload} />
          {view.actions.map((action) => (action.toggle
            ? <ToggleButton key={action.action_id} view={view} action={action} reload={reload} />
            : action.more ? null : <ActionButton key={action.action_id} view={view} action={action} reload={reload} />))}
          <MoreButton view={view} reload={reload} />
          <CancelButton view={view} reload={reload} />
          <MuteButton view={view} reload={reload} />
        </span>
      )}
    />
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function MonitorPage({ view, reload }: { view: MonitorPageView; reload: () => void }) {
  return (
    <Page.Provider value={{ dialogs: view.dialogs, reload }}>
      <div className="page">
        <MonitorHeader view={view} reload={reload} />
        <Body body={view.body} />
      </div>
    </Page.Provider>
  );
}

export function MonitorView({ id }: { id: string }) {
  const page = use_resource(() => calls.monitor(id), [id], live);
  // A monitor gone from the config, or never in it, sends the viewer to the overview.
  useEffect(() => {
    if (page.error instanceof ApiError && page.error.status === 404) {
      toast(`No monitor with id ${JSON.stringify(id)}`, { tone: "warn" });
      location.hash = "#/";
    }
  }, [page.error]);
  return <Loaded resource={page}>{(view) => <MonitorPage view={view} reload={() => void page.reload(true)} />}</Loaded>;
}
