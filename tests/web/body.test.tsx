// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DialogView, TableView, WidgetView } from "../../src/shared/page_view.ts";
import { calls } from "../../src/web/api.ts";
import { Body, Page } from "../../src/web/views/body.tsx";
import { body_of, Hosted, reply } from "./page_fixtures.tsx";

vi.mock("../../src/web/api.ts", async (original) => {
  const actual = await original<typeof import("../../src/web/api.ts")>();
  return { ...actual, calls: Object.fromEntries(Object.keys(actual.calls).map((name) => [name, vi.fn()])) };
});

const mocked = calls as unknown as Record<keyof typeof calls, ReturnType<typeof vi.fn>>;

function draw(widgets: WidgetView[], dialogs: Record<string, Record<string, DialogView>> = {}) {
  render(<Hosted><Page.Provider value={{ dialogs, reload: () => undefined }}><Body body={body_of(widgets)} /></Page.Provider></Hosted>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("cards", () => {
  it("colour a measured number and badge a state word", () => {
    draw([{ type: "value", title: "CPU", text: "97.5%", state: "failed" }, { type: "value", title: "STATE", text: "IDLE", state: "online" }]);
    expect(screen.getByText("97.5%").className).toContain("tone-bad");
    expect(screen.getByText("IDLE").className).toContain("badge");
  });

  it("draw a gauge, a share bar and an uptime strip", () => {
    draw([
      { type: "gauge", title: "CPU", text: "78.0%", percent: 78, state: "warning", caption: null },
      { type: "share", title: "QUERIES", parts: [{ label: "Allowed", text: "3", percent: 75, color: "series-1" }] },
      { type: "strip", title: "AVAILABILITY", cells: 2, rows: [{ label: null, states: ["online", "failed"], share_text: "50.0% up" }] },
    ]);
    expect(screen.getByRole("meter", { name: "CPU" })).toBeTruthy();
    expect(screen.getByText("Allowed 3")).toBeTruthy();
    expect(screen.getByText("50.0% up")).toBeTruthy();
  });

  it("draw repeated items as meters with the empty text when there are none", () => {
    draw([
      { type: "repeat", title: "SPACE USED", container: "bars", items: [{ label: "root", value: "41%", state: null, percent: 41 }], empty_text: "No data", marker: 85 },
      { type: "repeat", title: null, container: "chips", items: [], empty_text: "No answers yet", marker: null },
    ]);
    expect(screen.getByRole("meter", { name: "root" }).getAttribute("aria-valuenow")).toBe("41");
    expect(screen.getByText("No answers yet")).toBeTruthy();
  });
});

const TABLE: TableView = {
  type: "table",
  monitor_id: "host",
  title: "Units",
  row_key: "unit",
  columns: [
    { name: "unit", label: "Unit", field: "unit", align: "left", sortable: true, colored: false, toggle: null },
    { name: "enabled", label: "Enabled", field: "enabled", align: "left", sortable: true, colored: false, toggle: { on_action_id: "enable_service", off_action_id: "disable_service", params: { service_name: "unit" } } },
    { name: "grade", label: "Grade", field: "grade", align: "left", sortable: true, colored: true, toggle: null },
    { name: "actions", label: "", field: "actions", align: "center", sortable: false, colored: false, toggle: null },
  ],
  rows: [
    { unit: "nginx.service", enabled: "disabled", grade: "failed", _toggle_enabled: false, _color_grade: "failed" },
    { unit: "tmp.mount", enabled: "static", grade: "fine", _toggle_enabled: null, _color_grade: "online" },
  ],
  row_actions: [{ id: "restart", icon: "refresh", danger: false, tooltip: "Restart", kind: null, dialog: null, action_id: "restart_service", params: { service_name: "unit" }, notify: true, confirm: "Restart {row[unit]}?" }],
  filter_placeholder: "Filter",
  filter_fields: ["unit", "enabled", "grade"],
  tree: null,
};

describe("a spec table", () => {
  it("shows a toggle cell as a pressable button and a value it cannot show as text", () => {
    draw([TABLE]);
    expect(screen.getByRole("button", { name: "disabled" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "static" })).toBeNull();
    expect(screen.getByText("static")).toBeTruthy();
  });

  it("flips a toggle for its row", async () => {
    mocked.toggle.mockResolvedValue(reply({ notice: "Enabled on: nginx.service succeeded" }));
    draw([TABLE]);
    fireEvent.click(screen.getByRole("button", { name: "disabled" }));
    expect(await screen.findByText("Enabled on: nginx.service succeeded")).toBeTruthy();
    expect(mocked.toggle).toHaveBeenCalledWith("host", { label: "Enabled", row_key: "nginx.service", action_id: "enable_service", args: { service_name: "nginx.service" }, wanted: true });
  });

  it("asks before a row action and runs it for that row", async () => {
    mocked.run_action.mockResolvedValue(reply({ notice: "Restart succeeded" }));
    draw([TABLE]);
    fireEvent.click(screen.getAllByRole("button", { name: "Restart" })[0]);
    expect(await screen.findByText("Restart nginx.service?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Restart succeeded")).toBeTruthy();
    expect(mocked.run_action).toHaveBeenCalledWith("host", "restart_service", { service_name: "nginx.service" }, "Restart");
  });

  it("colours a word by its state", () => {
    draw([TABLE]);
    expect(screen.getByText("failed").className).toContain("badge");
  });

  it("filters on every word the box holds", async () => {
    draw([TABLE]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "tmp" } });
    await waitFor(() => expect(screen.queryByText("nginx.service")).toBeNull());
    expect(screen.getByText("tmp.mount")).toBeTruthy();
  });
});

describe("buttons and dialogs", () => {
  const dialogs: Record<string, Record<string, DialogView>> = {
    host: {
      reboot: {
        kind: "form", title: "Reboot host1", render: null, action_id: "reboot", params: {}, load_action_id: null, load_params: {}, save_action_id: null, save_params: {}, save_content_kwarg: "content", success_message: "Saved",
        fields: [{ name: "entry", label: "Entry", placeholder: "", type: "select", options: [["0001", "Linux"], ["0003", "Windows"]], default: "0003" }],
        submit_label: "Reboot", confirm: "Reboot into {row[entry]}?",
      },
      unit: {
        kind: "read", title: "Unit file: nginx", render: "textarea_readonly", action_id: "view_unit_file", params: {}, load_action_id: null, load_params: {}, save_action_id: null, save_params: {}, save_content_kwarg: "content", success_message: "Saved", fields: [], submit_label: "Run", confirm: null,
      },
    },
  };

  it("open a read dialog with what the action returned", async () => {
    mocked.run_action.mockResolvedValue(reply({ content: "[Unit]\nDescription=nginx" }));
    draw([{ type: "buttons", monitor_id: "host", title: "Unit file", buttons: [{ id: "view", label: "View Unit File", icon: null, flat: true, danger: false, kind: "dialog", dialog: "unit", notify: true, confirm: null }] }], dialogs);
    fireEvent.click(screen.getByRole("button", { name: "View Unit File" }));
    const box = await screen.findByRole("textbox", { name: "Unit file: nginx" });
    expect((box as HTMLTextAreaElement).value).toBe("[Unit]\nDescription=nginx");
  });

  it("submit a form after confirming with the chosen values", async () => {
    mocked.run_action.mockResolvedValue(reply({ content: "Rebooting" }));
    draw([{ type: "buttons", monitor_id: "host", title: null, buttons: [{ id: "reboot", label: "Reboot", icon: null, flat: false, danger: true, kind: "dialog", dialog: "reboot", notify: true, confirm: null }] }], dialogs);
    fireEvent.click(screen.getByRole("button", { name: "Reboot" }));
    const dialog = await screen.findByRole("dialog", { name: "Reboot host1" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reboot" }));
    expect(await screen.findByText("Reboot into 0003?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("textbox", { name: "Output" })).toBeTruthy();
    expect(mocked.run_action).toHaveBeenCalledWith("host", "reboot", { entry: "0003" }, "reboot");
  });

  it("run a plain button and tell its outcome", async () => {
    mocked.run_action.mockResolvedValue(reply({ notice: "Reload Daemon succeeded" }));
    draw([{ type: "buttons", monitor_id: "host", title: null, buttons: [{ id: "daemon_reload", label: "Reload Daemon", icon: null, flat: true, danger: false, kind: "dispatch", dialog: null, notify: true, confirm: null }] }]);
    fireEvent.click(screen.getByRole("button", { name: "Reload Daemon" }));
    expect(await screen.findByText("Reload Daemon succeeded")).toBeTruthy();
  });
});

describe("the job panel", () => {
  it("has no run buttons without a run action, and opens a job's log", async () => {
    mocked.job_log.mockResolvedValue({ id: 7, title: "Switch log", summary: "Started 2026-10-23 02:30:00 · failed · exit 1 · 42 Seconds", command: "nixos-rebuild switch --flake /etc/nixos", error: "Exited with status 1", running: false, lines: [{ seq: 0, stream: "stdout", message: "error: builder failed", timestamp: "" }] });
    draw([{ type: "jobs", monitor_id: "host", title: "Jobs", run: null, cancel: null, progress: { text: "", state: null }, rows: [{ id: 7, started: "2026-10-23 02:30:00", kind: "switch", state: "failed", duration: "42 Seconds", duration_seconds: 42 }] }]);
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    expect(await screen.findByText("Switch log")).toBeTruthy();
    expect(screen.getByText("nixos-rebuild switch --flake /etc/nixos")).toBeTruthy();
    expect(screen.getByText("Exited with status 1")).toBeTruthy();
    expect(screen.getByText("error: builder failed")).toBeTruthy();
  });

  it("watches a running job's log while it is open and stops on close", async () => {
    mocked.job_log.mockResolvedValue({ id: 8, title: "Gc log", summary: "running", command: "nix-collect-garbage", error: null, running: true, lines: [] });
    mocked.watch_job.mockResolvedValue({ lease: "8-1" });
    mocked.end_watch.mockResolvedValue(undefined);
    draw([{ type: "jobs", monitor_id: "host", title: "Jobs", run: null, cancel: null, progress: { text: "", state: null }, rows: [{ id: 8, started: "now", kind: "gc", state: "running", duration: "5 Seconds", duration_seconds: 5 }] }]);
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    expect(await screen.findByText("No output")).toBeTruthy();
    await waitFor(() => expect(mocked.watch_job).toHaveBeenCalledWith("host", 8));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Gc log" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocked.end_watch).toHaveBeenCalledWith("8-1"));
  });
});
