import { afterEach, describe, expect, it, vi } from "vitest";

import { is_watched } from "../../src/core/coordination/jobs.ts";
import { DatabaseManager } from "../../src/core/database/database.ts";
import type { JobDict } from "../../src/core/state/records.ts";
import { job_panel } from "../../src/server/views/components.ts";
import { job_log_view, job_summary, job_title, JobWatches, LEASE_SECONDS } from "../../src/server/views/job_log.ts";
import {
  action_names, build_body, cancel_job, lede, monitor_page_view, new_context, poll_now, run_header_action, run_header_toggle, schedule_lines, start_job,
} from "../../src/server/views/monitor.ts";
import type { ActionState } from "../../src/monitors/base/plugin_base.ts";
import type { ActionButtonSpec } from "../../src/shared/ui_spec.ts";
import { SystemdService } from "../../src/monitors/systemd_service.ts";
import { make_plugin } from "../harness.ts";
import { apply, SpecPlugin, widgets_by_type } from "./helpers.ts";

// A monitor whose header actions, their states and their outcomes a test sets.
class ActionPlugin extends SpecPlugin {
  actions: ActionButtonSpec[] = [];
  states: Record<string, ActionState> = {};
  ran: string[] = [];
  message = "";
  succeeds = true;
  polled = 0;

  override get_actions(): ActionButtonSpec[] {
    return this.actions;
  }

  override action_state(action: ActionButtonSpec): ActionState {
    return this.states[action.action_id ?? ""] ?? "normal";
  }

  override async run_action(action_id: string): Promise<[boolean, string]> {
    this.ran.push(action_id);
    return [this.succeeds, this.message];
  }

  override async run_cycle(): Promise<boolean> {
    this.polled += 1;
    return true;
  }
}

function action_plugin(actions: ActionButtonSpec[], config: Record<string, unknown> = {}): ActionPlugin {
  const plugin = make_plugin(ActionPlugin, { name: "host", id: "host", type: "nixos_upgrade", ...config });
  plugin.actions = actions;
  return plugin;
}

const TOGGLE: ActionButtonSpec = { action_id: "start_on_boot", name: "Start on Boot", kind: "toggle", metric: "enabled", on_action_id: "enable_service", off_action_id: "disable_service" };
const no_notifications = { notifications: null };

// ── Header ───────────────────────────────────────────────────────────────────

describe("the header", () => {
  it("names the monitor's type and host, and a group by type alone", () => {
    expect(lede(action_plugin([]))).toBe("nixos upgrade · test.host");
    expect(lede(action_plugin([], { type: "group" }))).toBe("group");
  });

  it("names both of a toggle's actions", () => {
    expect(action_names([TOGGLE, { action_id: "restart", name: "Restart" }])).toEqual({ enable_service: "Start on Boot: on", disable_service: "Start on Boot: off", restart: "Restart" });
  });

  it("captions each scheduled and triggered action by its button's name", () => {
    const plugin = action_plugin([{ action_id: "switch", name: "Rebuild" }], { schedule: [{ action: "switch", cron: "0 4 * * *" }], triggers: [{ action: "switch", status: "warning" }] });
    expect(schedule_lines(plugin, new Date(2026, 9, 22, 18, 30))).toEqual(["Scheduled: Rebuild · 0 4 * * * · next Fri 23 Oct 04:00", "Triggered: Rebuild · when status is warning"]);
  });
});

describe("a toggle", () => {
  it("is pressed while its state metric is on and released while off", () => {
    const plugin = action_plugin([TOGGLE]);
    apply(plugin, { metrics: { enabled: 1 } });
    expect(monitor_page_view(no_notifications, plugin).actions[0].toggle!.pressed).toBe(true);
    apply(plugin, { metrics: { enabled: 0 } });
    expect(monitor_page_view(no_notifications, plugin).actions[0].toggle!.pressed).toBe(false);
  });

  it("has no state before the monitor reports one", () => {
    expect(monitor_page_view(no_notifications, action_plugin([TOGGLE])).actions[0].toggle!.pressed).toBeNull();
  });

  it("runs its on action, reads the state back and says so", async () => {
    const plugin = action_plugin([TOGGLE]);
    const reply = await run_header_toggle(plugin, "Start on Boot", "enable_service", "disable_service", true);
    expect(reply.notice).toBe("Start on Boot: on");
    expect(plugin.ran).toEqual(["enable_service"]);
    expect(plugin.polled).toBe(1);
  });

  it("runs its off action from pressed", async () => {
    const plugin = action_plugin([TOGGLE]);
    expect((await run_header_toggle(plugin, "Start on Boot", "enable_service", "disable_service", false)).notice).toBe("Start on Boot: off");
    expect(plugin.ran).toEqual(["disable_service"]);
  });

  it("says when its action fails and does not poll", async () => {
    const plugin = action_plugin([TOGGLE]);
    plugin.succeeds = false;
    expect((await run_header_toggle(plugin, "Start on Boot", "enable_service", "disable_service", true)).notice).toBe("Start on Boot could not be turned on");
    expect(plugin.polled).toBe(0);
  });
});

describe("an action's state", () => {
  const REBUILD: ActionButtonSpec = { action_id: "switch", name: "Rebuild", job: "switch" };

  it("runs a normal action and names it in the notice", async () => {
    const plugin = action_plugin([REBUILD]);
    expect((await run_header_action(plugin, "switch")).notice).toBe("Rebuild succeeded");
    expect(plugin.ran).toEqual(["switch"]);
  });

  it("shows the action's own message in place of the generic notice", async () => {
    const plugin = action_plugin([REBUILD]);
    plugin.message = "Lock broken";
    expect((await run_header_action(plugin, "switch")).notice).toBe("Lock broken");
  });

  it("carries the state for greying out, filling or hiding", () => {
    for (const state of ["disabled", "accent", "hidden"] as const) {
      const plugin = action_plugin([REBUILD]);
      plugin.states = { switch: state };
      expect(monitor_page_view(no_notifications, plugin).actions[0].state).toBe(state);
    }
  });

  it("ignores a click on a running action", async () => {
    const plugin = action_plugin([REBUILD]);
    plugin.states = { switch: "accent" };
    await run_header_action(plugin, "switch");
    expect(plugin.ran).toEqual([]);
  });

  it("names the dialog a dialog action opens", () => {
    const view = monitor_page_view(no_notifications, action_plugin([{ action_id: "preview", name: "Preview", kind: "dialog", dialog: "preview" }]));
    expect(view.actions[0]).toMatchObject({ kind: "dialog", dialog: "preview" });
  });
});

describe("a detached action", () => {
  it("hands back the job it started, so its live log opens", async () => {
    const plugin = action_plugin([{ action_id: "custom:sync", name: "Sync", detached: true }]);
    const job_id = plugin.jobs!.create("action:custom:sync", "sync-all");
    expect((await run_header_action(plugin, "custom:sync")).job_id).toBe(job_id);
  });
});

describe("the Cancel button", () => {
  const REBUILD: ActionButtonSpec = { action_id: "switch", name: "Rebuild", job: "switch" };

  it("is hidden while no job runs and shown while one does", () => {
    const plugin = action_plugin([REBUILD]);
    expect(monitor_page_view(no_notifications, plugin).cancel).toEqual({ present: true, visible: false });
    plugin.jobs!.set_pid(plugin.jobs!.create("switch", "nixos-rebuild switch"), 42);
    expect(monitor_page_view(no_notifications, plugin).cancel).toEqual({ present: true, visible: true });
  });

  it("cancels the running job", async () => {
    const plugin = action_plugin([REBUILD]);
    plugin.jobs!.set_pid(plugin.jobs!.create("switch", "nixos-rebuild switch"), 42);
    expect((await cancel_job(plugin)).notice).toBe("Cancellation requested");
    expect((await cancel_job(plugin)).notice).toBe("No job is running");
  });

  it("is absent without a job action", () => {
    expect(monitor_page_view(no_notifications, action_plugin([TOGGLE])).cancel.present).toBe(false);
  });
});

describe("the More menu", () => {
  const actions: ActionButtonSpec[] = [
    { action_id: "switch", name: "Rebuild" },
    { action_id: "prune", name: "Prune", more: true, variant: "danger" },
    { action_id: "verify", name: "Verify", more: true },
  ];

  it("holds only the actions marked more, a danger one marked so", () => {
    const view = monitor_page_view(no_notifications, action_plugin(actions));
    expect(view.actions.filter((action) => action.more).map((action) => [action.name, action.danger])).toEqual([["Prune", true], ["Verify", false]]);
    expect(view.more).toEqual({ visible: true, filled: false });
  });

  it("fills while one of its actions runs and hides when every item is hidden", () => {
    const running = action_plugin(actions);
    running.states = { verify: "accent" };
    expect(monitor_page_view(no_notifications, running).more.filled).toBe(true);
    const hidden = action_plugin(actions);
    hidden.states = { prune: "hidden", verify: "hidden" };
    expect(monitor_page_view(no_notifications, hidden).more.visible).toBe(false);
  });
});

describe("the Notifications button", () => {
  it("is shown only when notifications go somewhere", () => {
    expect(monitor_page_view(no_notifications, action_plugin([])).mute.present).toBe(false);
    const notifications = { channels: { desk: { TYPE: "desktop" } }, maintenance_for: () => null, muted_by: () => null, monitor_name: (id: string) => id } as never;
    expect(monitor_page_view({ notifications }, action_plugin([])).mute).toEqual({ present: true, maintenance: null, muted_by: null, sending: true });
  });

  it("names the group that mutes the monitor", () => {
    const notifications = { channels: { desk: { TYPE: "desktop" } }, maintenance_for: () => "Patch night", muted_by: () => "site", monitor_name: () => "Site" } as never;
    expect(monitor_page_view({ notifications }, action_plugin([])).mute).toEqual({ present: true, maintenance: "Patch night", muted_by: "Site", sending: false });
  });
});

describe("Poll Now", () => {
  it("polls the monitor and says so", async () => {
    const plugin = action_plugin([]);
    expect((await poll_now(plugin)).notice).toBe("host polled");
    expect(plugin.polled).toBe(1);
  });
});

// ── The job panel ────────────────────────────────────────────────────────────

describe("the job panel", () => {
  it("has no buttons without a run action", () => {
    const panel = job_panel(action_plugin([]), { title: "Jobs" });
    expect([panel.title, panel.run, panel.cancel]).toEqual(["Jobs", null, null]);
  });

  it("lists recent jobs with their durations", () => {
    const plugin = action_plugin([]);
    const job_id = plugin.jobs!.create("switch", "nixos-rebuild switch");
    plugin.jobs!.finish(job_id, "failed", 1, "Exited with status 1");
    const panel = job_panel(plugin, { title: "Jobs" });
    expect(panel.rows.map((row) => [row.id, row.kind, row.state])).toEqual([[job_id, "switch", "failed"]]);
  });

  it("shows the running job's progress and offers Cancel", () => {
    const plugin = action_plugin([]);
    const job_id = plugin.jobs!.create("gc", "nix-collect-garbage");
    plugin.jobs!.set_progress(job_id, "deleting 3 paths");
    const panel = job_panel(plugin, { run_action_id: "gc", run_label: "Collect" });
    expect(panel.progress).toEqual({ text: "deleting 3 paths", state: "online" });
    expect(panel.run!.enabled).toBe(false);
    expect(panel.cancel!.visible).toBe(true);
  });

  it("says why it cannot run while its predicate says no", () => {
    const panel = job_panel(action_plugin([]), { run_action_id: "gc", enabled_if: () => false, disabled_text: "No store" });
    expect(panel.progress).toEqual({ text: "No store", state: "unavailable" });
    expect(panel.run!.enabled).toBe(false);
  });

  it("refuses to start a second job", () => {
    const plugin = action_plugin([]);
    expect(start_job(plugin, "gc", "Collect").notice).toBe("Collect started");
    plugin.jobs!.create("gc", "nix-collect-garbage");
    expect(start_job(plugin, "gc", "Collect").notice).toBe("A job is already running");
  });
});

// ── Job logs ─────────────────────────────────────────────────────────────────

describe("a job's log", () => {
  afterEach(() => vi.useRealTimers());

  it("is titled by the action's name for a detached action, else its kind", () => {
    const plugin = action_plugin([{ action_id: "custom:sync", name: "Sync" }]);
    expect(job_title(plugin, { kind: "action:custom:sync" })).toBe("Sync");
    expect(job_title(plugin, { kind: "switch" })).toBe("Switch");
  });

  it("sums a job up in one line", () => {
    expect(job_summary({ started: "2026-10-23 02:30:00", state: "failed", exit_code: 1, duration: 42 })).toBe("Started 2026-10-23 02:30:00 · failed · exit 1 · 42 Seconds");
  });

  it("shows the command, the output after a sequence, and the error once it ends", async () => {
    const plugin = action_plugin([]);
    const job_id = plugin.jobs!.create("switch", "nixos-rebuild switch --flake /etc/nixos");
    plugin.jobs!.append_output(job_id, ["building", "error: builder failed"]);
    const view = (await job_log_view(plugin, job_id))!;
    expect([view.title, view.command, view.error, view.running]).toEqual(["Switch log", "nixos-rebuild switch --flake /etc/nixos", null, true]);
    expect(view.lines.map((line) => line.message)).toEqual(["building", "error: builder failed"]);
    expect((await job_log_view(plugin, job_id, view.lines[0].seq))!.lines.map((line) => line.message)).toEqual(["error: builder failed"]);
    plugin.jobs!.finish(job_id, "failed", 1, "Exited with status 1");
    expect((await job_log_view(plugin, job_id))!).toMatchObject({ error: "Exited with status 1", running: false });
  });

  it("is gone once the job is no longer kept", async () => {
    expect(await job_log_view(action_plugin([]), 999)).toBeNull();
  });

  it("watches a running job while open and stops on close", () => {
    const plugin = action_plugin([]);
    const job = plugin.data.job(plugin.jobs!.create("gc", "nix-collect-garbage")) as JobDict;
    const watches = new JobWatches();
    const lease = watches.open(plugin, job)!;
    expect(is_watched(job.id)).toBe(true);
    watches.close(lease);
    expect(is_watched(job.id)).toBe(false);
  });

  it("stops watching when the page stops renewing", () => {
    vi.useFakeTimers();
    const plugin = action_plugin([]);
    const job = plugin.data.job(plugin.jobs!.create("gc", "nix-collect-garbage")) as JobDict;
    const watches = new JobWatches();
    const lease = watches.open(plugin, job)!;
    vi.advanceTimersByTime((LEASE_SECONDS - 1) * 1000);
    expect(watches.renew(lease)).toBe(true);
    vi.advanceTimersByTime((LEASE_SECONDS - 1) * 1000);
    expect(is_watched(job.id)).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(is_watched(job.id)).toBe(false);
    expect(watches.renew(lease)).toBe(false);
  });

  it("does not watch a finished job", () => {
    const plugin = action_plugin([]);
    const job_id = plugin.jobs!.create("gc", "true");
    plugin.jobs!.finish(job_id, "succeeded", 0);
    expect(new JobWatches().open(plugin, plugin.data.job(job_id)!)).toBeNull();
  });
});

// ── Custom pages ─────────────────────────────────────────────────────────────

describe("a systemd service's page", () => {
  it("shows a continuous service's state, last collection and unit file buttons", () => {
    const plugin = make_plugin(SystemdService, { name: "nginx", id: "nginx", type: "systemd_service", service_name: "nginx.service" });
    apply(plugin, { metrics: { active: 1 }, status: "online" });
    const body = build_body(plugin, "page", new_context());
    expect(widgets_by_type(body.rows, "value").map((card) => [card.title, card.text])).toEqual([
      ["TARGET HOST", "test.host"], ["SERVICE", "nginx.service"], ["SERVICE STATUS", "ACTIVE"], ["LAST COLLECTION", expect.stringMatching(/^\d\d:\d\d:\d\d$/)],
    ]);
    expect(widgets_by_type(body.rows, "buttons")[0].buttons.map((button) => button.label)).toEqual(["View Unit File", "Reload Daemon"]);
    expect(widgets_by_type(body.rows, "feed")[0]).toMatchObject({ title: "Logs", full_height: true });
  });

  it("offers editing only where allowed", () => {
    const plugin = make_plugin(SystemdService, { name: "nginx", id: "nginx", type: "systemd_service", service_name: "nginx.service", allow_unit_file_edit: true });
    expect(widgets_by_type(build_body(plugin, "page", new_context()).rows, "buttons")[0].buttons.map((button) => button.label)).toContain("Edit Unit File");
  });

  it("judges a oneshot service by its last run", () => {
    const plugin = make_plugin(SystemdService, { name: "backup", id: "backup", type: "systemd_service", service_name: "backup.service", max_age: "1h" });
    apply(plugin, { metrics: { is_running: 0, last_run_epoch: 0, last_run_success: 0 }, status: "failed" });
    const cards = widgets_by_type(build_body(plugin, "page", new_context()).rows, "value").map((card) => [card.title, card.text, card.state]);
    expect(cards).toEqual(expect.arrayContaining([["MAX AGE", "1 Hour", null], ["CURRENT STATE", "NEVER RUN", "failed"], ["LAST RESULT", "FAILED", "failed"], ["LAST RUN", "Never run", "failed"]]));
  });
});

describe("a monitor's dialogs", () => {
  it("come with the page, their plugin fields filled and row fields left for the row", () => {
    const plugin = make_plugin(SpecPlugin, {
      name: "borg", id: "borg",
      ui_spec: { dialogs: { diff: { kind: "read", title: "Changes in {row[name]} of {plugin.name}", action_id: "diff_archive", params: { archive: "name" } } } },
    });
    const view = monitor_page_view(no_notifications, plugin, new Date());
    expect(view.dialogs.borg.diff).toMatchObject({ kind: "read", title: "Changes in {row[name]} of borg", action_id: "diff_archive", params: { archive: "name" } });
  });

  it("are gathered for a group's children too", () => {
    const db = new DatabaseManager();
    const group = make_plugin(SpecPlugin, { name: "G", id: "g", type: "group", layout: [["child.buttons"]] }, db);
    group.children = [make_plugin(SpecPlugin, { name: "child", id: "child", ui_spec: { buttons: { buttons: [{ id: "x" }] }, dialogs: { d: { kind: "read", title: "T" } } } }, db)];
    expect(Object.keys(monitor_page_view(no_notifications, group).dialogs.child)).toEqual(["d"]);
  });
});
