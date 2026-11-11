// The views beside the monitors: recent events, every schedule, the notifications dialog, the system menu's log
// levels and config reload, and Settings with backups and page plugins.

import { Badge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { BackupSettings } from "@x-tech-laboratories/x-libs/web/react/backup_settings";
import { SearchBox, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { PageHeading, Section, SettingsGroup, SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { PluginSettings, type PluginHost } from "@x-tech-laboratories/x-libs/web/react/plugins";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState, type MouseEvent } from "react";

import { filter_rows } from "../../shared/table_rows.ts";
import { backups, calls, live, type ScheduleRow } from "../api.ts";
import { notify_error } from "../ui.tsx";
import { LevelBadge } from "./body.tsx";

// ── Events ───────────────────────────────────────────────────────────────────

const EVENT_LEVELS: [string, string][] = [["", "All levels"], ["ERROR", "Error"], ["WARNING", "Warning"], ["INFO", "Info"]];

export function EventsView() {
  const [level, set_level] = useState("");
  const [target, set_target] = useState("");
  const [search, set_search] = useState("");
  const [term, set_term] = useState("");
  const events = use_resource(() => calls.events({ level, target: target.trim(), search: search.trim() }), [level, target, search], live);
  return (
    <div className="page">
      <PageHeading title="Events" subtitle="The most recent 500 events from every monitor" />
      <Section title="" tools={<>
        <Select label="Level" options={EVENT_LEVELS} value={level} on_change={set_level} />
        <SearchBox label="Filter by target" value={target} on_input={set_target} />
        <SearchBox label="Search messages" value={search} on_input={set_search} />
        <SearchBox label="Filter" value={term} on_input={set_term} />
      </>}>
        <Loaded resource={events}>
          {(found) => (
            <DataTable
              caption="Events"
              rows={filter_rows(found, term, ["timestamp", "level", "target", "message"])}
              row_key={(row) => `${row.timestamp}|${row.target}|${row.message}`}
              columns={[
                { label: "Time", sort: (row) => row.timestamp, cell: (row) => row.timestamp },
                { label: "Level", sort: (row) => row.level, cell: (row) => <LevelBadge level={row.level} /> },
                { label: "Target", sort: (row) => row.target, cell: (row) => row.target },
                { label: "Message", cell: (row) => <span className="pre-wrap">{row.message}</span> },
              ]}
            />
          )}
        </Loaded>
      </Section>
    </div>
  );
}

// ── Schedules ────────────────────────────────────────────────────────────────

export function SchedulesTable({ rows }: { rows: ScheduleRow[] }) {
  const [term, set_term] = useState("");
  return (
    <Section title="" tools={<SearchBox label="Filter" value={term} on_input={set_term} />}>
      <DataTable
        caption="Schedules"
        rows={filter_rows(rows, term, ["monitor", "action", "cron", "next", "last", "outcome"])}
        row_key={(row) => row.id}
        on_row_click={(row) => { location.hash = link(["monitor", row.monitor_id]); }}
        columns={[
          { label: "Monitor", cell: (row) => <a href={link(["monitor", row.monitor_id])}>{row.monitor}</a> },
          { label: "Action", cell: (row) => row.action },
          { label: "When", cell: (row) => row.cron },
          { label: "Next run", cell: (row) => row.next },
          { label: "Last run", cell: (row) => row.last },
          // A row that has not run yet leaves the outcome empty.
          { label: "Outcome", cell: (row) => (row.outcome ? <Badge tone={(row.outcome_badge || "none") as Tone} title={row.message}>{row.outcome}</Badge> : null) },
        ]}
      />
    </Section>
  );
}

export function SchedulesView() {
  const rows = use_resource(() => calls.schedules(), [], live);
  return (
    <div className="page">
      <PageHeading title="Schedules" subtitle="Every action a monitor runs on its own, soonest first; click a row to open its monitor" />
      <Loaded resource={rows}>{(found) => <SchedulesTable rows={found} />}</Loaded>
    </div>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

function NotificationsDialog({ on_close }: { on_close: () => void }) {
  const view = use_resource(() => calls.notifications(), [], live);
  const send_test = async (channel_id: string) => {
    try {
      await calls.send_test(channel_id);
      toast(`Test sent to ${channel_id}`, { tone: "good" });
    } catch (error) {
      // A failed test is the answer the operator asked for, so it is shown in full.
      toast(`Test to ${channel_id} failed: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
    }
  };
  const unmute = async (id: string, name: string) => {
    try {
      await calls.mute(id, false);
      toast(`${name} unmuted`, { tone: "good" });
    } catch (error) {
      notify_error(error);
    }
    void view.reload(true);
  };
  return (
    <Dialog title="Notifications" on_close={on_close} buttons={<button onClick={on_close}>Close</button>}>
      <Loaded resource={view}>
        {(found) => (
          <>
            <h3 className="tile-label">Channels</h3>
            <ul className="plain-list">
              {found.channels.map((channel) => (
                <li key={channel.id} className="list-row">
                  <span>{channel.id} <span className="muted small">{channel.type}</span></span>
                  <button type="button" className="flat" onClick={() => void send_test(channel.id)}>Send test</button>
                </li>
              ))}
            </ul>
            {found.windows.length > 0 && (
              <>
                <h3 className="tile-label">Maintenance</h3>
                <ul className="plain-list">
                  {found.windows.map((window) => (
                    <li key={window.name} className="list-row">
                      <span>{window.name} <span className="muted small">{window.describe}</span></span>
                      {window.active && <Badge tone="warn">Active now</Badge>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="tile-label">Muted</h3>
            {found.muted.length === 0 ? <p className="muted small">No monitors are muted.</p> : (
              <ul className="plain-list">
                {found.muted.map((monitor) => (
                  <li key={monitor.id} className="list-row">
                    <span>{monitor.name}</span>
                    <button type="button" className="flat" onClick={() => void unmute(monitor.id, monitor.name)}>Unmute</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Loaded>
    </Dialog>
  );
}

export function open_notifications(): void {
  open_dialog((close) => <NotificationsDialog on_close={close} />);
}

// ── System ───────────────────────────────────────────────────────────────────

const ROOT = "root";

const LEVEL_NAMES = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

function LogLevelsDialog({ on_close }: { on_close: () => void }) {
  const view = use_resource(() => calls.log_levels(), []);
  const [logger, set_logger] = useState(ROOT);
  const [level, set_level] = useState("DEBUG");
  const apply = async (name: string, chosen: string | null) => {
    try {
      await calls.set_log_level(name, chosen);
      toast(`${name || ROOT} is now ${chosen || "inherited"}`, { tone: "good" });
    } catch (error) {
      notify_error(error);
    }
    void view.reload(true);
  };
  return (
    <Dialog title="Log levels" on_close={on_close} buttons={<button onClick={on_close}>Close</button>}>
      <p className="muted small">Changes apply at once and last until X-Monitor restarts or the config sets them again.</p>
      <Loaded resource={view}>
        {(found) => (
          <>
            <ul className="plain-list">
              {Object.entries(found.levels).map(([name, current]) => (
                <li key={name} className="list-row">
                  <span className="break-all">{name} <span className="muted small">{current}</span></span>
                  {name !== ROOT && <button type="button" className="flat" onClick={() => void apply(name, null)}>Reset</button>}
                </li>
              ))}
            </ul>
            <h3 className="tile-label">Change</h3>
            <div className="button-row">
              <label className="field">
                <span className="field-label">Logger</span>
                <input type="text" list="known-loggers" value={logger} onChange={(event) => set_logger(event.currentTarget.value)} />
                <datalist id="known-loggers">{[ROOT, ...found.loggers].map((name) => <option key={name} value={name} />)}</datalist>
              </label>
              <Select label="Level" options={LEVEL_NAMES.map((name): [string, string] => [name, name])} value={level} on_change={set_level} />
              <button type="button" className="flat" onClick={() => void apply(logger, level)}>Apply</button>
            </div>
          </>
        )}
      </Loaded>
    </Dialog>
  );
}

export function open_log_levels(): void {
  open_dialog((close) => <LogLevelsDialog on_close={close} />);
}

// Re-reads the config now and says what changed, or why nothing did.
export async function reload_config(): Promise<void> {
  try {
    const answer = await calls.reload();
    toast(answer.summary, { tone: answer.restart_required?.length ? "warn" : "good" });
  } catch (error) {
    // A failed reload names why in its summary, which stays until it is read.
    toast(error instanceof Error ? error.message : String(error), { tone: "bad", sticky: true });
  }
}

// The header button whose menu holds X-Monitor's own runtime controls.
export function SystemMenu() {
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    open_context_menu({ clientX: box.left, clientY: box.bottom, preventDefault: () => undefined }, [
      { label: "Reload config", run: () => void reload_config() },
      { label: "Log levels", run: open_log_levels },
    ]);
  };
  return <button type="button" aria-haspopup="menu" onClick={open}>System</button>;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function SettingsView({ plugins }: { plugins: PluginHost }) {
  return (
    <div className="page">
      <PageHeading title="Settings" />
      <SettingsGroup heading="Backups" hint="Copies of the state database: metrics, events, jobs and accounts.">
        <BackupSettings device={backups} data_name="metrics, events, jobs and accounts" on_restored={() => setTimeout(() => window.location.reload(), 3000)} />
      </SettingsGroup>
      <PluginSettings host={plugins} />
      <SettingsGroup heading="System">
        <SettingRow label="Config"><button type="button" onClick={() => void reload_config()}>Reload config</button></SettingRow>
        <SettingRow label="Logging"><button type="button" onClick={open_log_levels}>Log levels</button></SettingRow>
      </SettingsGroup>
    </div>
  );
}
