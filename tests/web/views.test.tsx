// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calls, type OverviewView, type TreeNode } from "../../src/web/api.ts";
import { LogSearch, LogsView, grouped_rows } from "../../src/web/views/logs.tsx";
import { filtered_monitors, next_chart_filter, OverviewPage } from "../../src/web/views/overview.tsx";
import { SchedulesTable } from "../../src/web/views/side_views.tsx";
import { branch_ids, expanded_after, failed_branch_ids, MonitorTree, tree_items } from "../../src/web/views/sidebar.tsx";
import { Hosted } from "./page_fixtures.tsx";

vi.mock("../../src/web/api.ts", async (original) => {
  const actual = await original<typeof import("../../src/web/api.ts")>();
  return { ...actual, calls: Object.fromEntries(Object.keys(actual.calls).map((name) => [name, vi.fn()])) };
});

const mocked = calls as unknown as Record<keyof typeof calls, ReturnType<typeof vi.fn>>;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// ── Overview ─────────────────────────────────────────────────────────────────

const OVERVIEW: OverviewView = {
  monitor_count: 2,
  lede: "2 monitors",
  fleet: {
    hosts: [{ id: "odin", name: "Odin", state: "failed", caption: "2 monitors · 1 failed", counts: { online: 1, failed: 1 } }],
    reachability: [{ id: "odin-up", host: "Odin", name: "Availability", metric: "up", states: ["online", "failed"], share_text: "50.0% up" }],
    deploys: null,
    findings: null,
  },
  status_counts: { online: 1, info: 0, failed: 1, warning: 0, unavailable: 0 },
  type_tiles: [{ name: "CPU", value: 1, status: "failed", breakdown: "1 failed" }, { name: "UPTIME", value: 1, status: "online", breakdown: "1 online" }],
  monitors: [
    { id: "odin-cpu", name: "CPU", type: "CPU", host: "odin", status: "Failed", status_key: "failed", status_badge: "bad" },
    { id: "odin-up", name: "Availability", type: "UPTIME", host: "odin", status: "Online", status_key: "online", status_badge: "good" },
  ],
  recent_metrics: [{ timestamp: "2026-10-21 22:35:13", target: "odin", plugin_id: "odin-cpu", metric_name: "cpu_pct", value: "27.26" }],
  recent_events: [{ timestamp: "2026-10-21 22:35:13", level: "ERROR", target: "odin", message: "disk full" }],
};

describe("the overview", () => {
  it("narrows the monitor table to a clicked status and clears on a second click", () => {
    expect(next_chart_filter(next_chart_filter({ field: null, value: null }, "status", "Failed"), "status", "Failed")).toEqual({ field: null, value: null });
    expect(filtered_monitors(OVERVIEW.monitors, { field: "type", value: "uptime" }).map((row) => row.id)).toEqual(["odin-up"]);
  });

  it("shows the hosts, strips, charts, monitors and recent activity", () => {
    render(<Hosted><OverviewPage view={OVERVIEW} /></Hosted>);
    expect(screen.getByRole("heading", { name: "All Monitors" })).toBeTruthy();
    expect(screen.getByText("2 monitors · 1 failed")).toBeTruthy();
    expect(screen.getByText("50.0% up")).toBeTruthy();
    expect(screen.getByRole("link", { name: "CPU" })).toBeTruthy();
    expect(screen.getByText("disk full")).toBeTruthy();
  });

  it("filters the table by a status button and by a type tile", () => {
    render(<Hosted><OverviewPage view={OVERVIEW} /></Hosted>);
    fireEvent.click(screen.getByRole("button", { name: /Online 1/ }));
    expect(screen.queryByRole("link", { name: "CPU" })).toBeNull();
    expect(screen.getByText(/Showing: ONLINE/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    fireEvent.click(screen.getByRole("button", { name: /^CPU/ }));
    expect(screen.queryByRole("link", { name: "Availability" })).toBeNull();
  });
});

// ── Sidebar ──────────────────────────────────────────────────────────────────

const NODES: TreeNode[] = [
  { id: "a", monitor: "a", label: "A", state: "failed", children: [{ id: "a/a-cpu", monitor: "a-cpu", label: "A-Cpu", state: "failed" }] },
  { id: "compute", monitor: "compute", label: "Compute", state: "online", children: [{ id: "compute/a-cpu", monitor: "a-cpu", label: "Host A", state: "failed" }] },
];

describe("the monitor tree", () => {
  it("flattens its nodes under their parents' keys", () => {
    expect(tree_items(NODES).map((item) => [item.id, item.parent_id])).toEqual([["a", null], ["a/a-cpu", "a"], ["compute", null], ["compute/a-cpu", "compute"]]);
    expect(branch_ids(NODES)).toEqual(["a", "compute"]);
    expect(failed_branch_ids(NODES)).toEqual(["a", "compute"]);
  });

  it("shuts a newly opened branch's siblings in accordion mode", () => {
    const items = tree_items(NODES);
    expect(expanded_after(items, ["a"], ["a", "compute"], true)).toEqual(["compute"]);
    expect(expanded_after(items, ["a"], ["a", "compute"], false)).toEqual(["a", "compute"]);
  });

  it("shows each place's label and keeps its open branches", () => {
    const saved = vi.fn();
    render(<MonitorTree nodes={NODES} settings={{ drawer_width: 248, expanded: [], accordion: false }} monitor_id={null} on_settings={saved} />);
    expect(screen.getByText("A")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByText("Host A")).toBeTruthy();
    expect(saved).toHaveBeenCalledWith({ expanded: ["a", "compute"] });
  });
});

// ── Schedules ────────────────────────────────────────────────────────────────

describe("the schedules table", () => {
  it("lists each schedule with its outcome and links to its monitor", () => {
    render(<SchedulesTable rows={[{ id: "borg:0", monitor_id: "borg", monitor: "Heimdall › On Disk", action: "Run Backup", cron: "0 */3 * * *", next: "Thu 22 Oct 21:00", last: "Thu 22 Oct 18:00", outcome: "Failed", outcome_badge: "bad", message: "failed" }]} />);
    expect(screen.getByRole("link", { name: "Heimdall › On Disk" }).getAttribute("href")).toBe("#/monitor/borg");
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});

// ── Logs ─────────────────────────────────────────────────────────────────────

describe("the log search", () => {
  it("searches every host and lists the entries", async () => {
    mocked.search_logs.mockResolvedValue({
      rows: [
        { key: "h:1", monitor_id: "h", epoch: 20, time: "t2", host: "heimdall", unit: "nginx.service", priority: 3, priority_name: "err", priority_badge: "bad", message: "disk full" },
        { key: "r:1", monitor_id: "r", epoch: 10, time: "t1", host: "ragnarok", unit: "nginx.service", priority: 6, priority_name: "info", priority_badge: "", message: "started" },
      ],
      summary: "2 entries from 2 hosts",
    });
    render(<LogSearch monitors={[{ id: "h", target: "heimdall" }, { id: "r", target: "ragnarok" }]} show_host default_limit={500} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("2 entries from 2 hosts")).toBeTruthy();
    expect(screen.getByText("disk full")).toBeTruthy();
    expect(mocked.search_logs).toHaveBeenCalledWith({ monitor_ids: ["h", "r"], since: "1h", priority: 6, unit: "", text: "", limit: 500 });
  });

  it("asks for a host when none is ticked", async () => {
    render(<LogSearch monitors={[{ id: "h", target: "heimdall" }, { id: "r", target: "ragnarok" }]} show_host default_limit={500} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "heimdall" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "ragnarok" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Pick at least one host")).toBeTruthy();
    expect(mocked.search_logs).not.toHaveBeenCalled();
  });

  it("groups entries under one row per value", () => {
    const rows = [
      { key: "1", monitor_id: "h", epoch: 3, time: "", host: "h", unit: "nginx", priority: 6, priority_name: "info", priority_badge: "", message: "a" },
      { key: "2", monitor_id: "h", epoch: 2, time: "", host: "h", unit: "sshd", priority: 3, priority_name: "err", priority_badge: "bad", message: "b" },
    ];
    expect(grouped_rows(rows, "priority").filter((row) => row.parent === null).map((row) => row.group)).toEqual(["err (1)", "info (1)"]);
  });

  it("says when there is nothing to search", async () => {
    mocked.logs.mockResolvedValue({ monitors: [], default_limit: 500 });
    render(<LogsView />);
    await waitFor(() => expect(screen.getByText(/No journal monitors are configured/)).toBeTruthy());
  });
});
