import { describe, expect, it } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { parse_schedule } from "../../src/core/coordination/schedule.ts";
import { parse_triggers } from "../../src/core/coordination/triggers.ts";
import { events_view } from "../../src/server/views/feeds.ts";
import * as fleet from "../../src/server/views/fleet.ts";
import type { FleetMonitor } from "../../src/server/views/fleet.ts";
import {
  build_chart_counts, build_table_rows, collect_leaf_monitors, metric_rows, next_chart_filter, RECENT_EVENT_COLUMNS, treemap_tiles, type_worst_status, type OverviewMonitor,
} from "../../src/server/views/overview.ts";
import { schedule_rows, type ScheduledMonitor } from "../../src/server/views/schedules.ts";
import { branch_ids, build_tree_nodes, failed_branch_ids, monitor_for_key, selected_key, sidebar_settings } from "../../src/server/views/sidebar.ts";
import type { GraphView as GraphNode } from "../../src/core/coordination/monitor_graph.ts";
import { STRIP_CELLS } from "../../src/shared/charts.ts";
import { filter_rows } from "../../src/shared/table_rows.ts";

// ── Sidebar ──────────────────────────────────────────────────────────────────

function node(id: string, ...children: GraphNode[]): GraphNode {
  return { id, name: id.replace(/(^|-)([a-z])/g, (_whole, dash: string, letter: string) => dash + letter.toUpperCase()), children, links: new Map() };
}

// One monitor under its host and again under a domain through a link with its own label, and the host linked whole.
function linked_tree(): GraphNode[] {
  const cpu = node("a-cpu");
  const host = node("a", cpu);
  const domain: GraphNode = { ...node("compute", cpu, host), links: new Map([["a-cpu", "Host A"], ["a", null]]) };
  return [host, domain];
}

function keys(nodes: ReturnType<typeof build_tree_nodes>): string[] {
  return nodes.flatMap((each) => [each.id, ...keys(each.children ?? [])]);
}

describe("the sidebar tree", () => {
  it("gives a monitor in two places a distinct key in each", () => {
    expect(keys(build_tree_nodes(linked_tree(), { "a-cpu": "failed" }))).toEqual(["a", "a/a-cpu", "compute", "compute/a-cpu", "compute/a", "compute/a/a-cpu"]);
  });

  it("shows each place's own label and the shared status", () => {
    const [host, domain] = build_tree_nodes(linked_tree(), { "a-cpu": "failed" });
    expect(host.children![0].label).toBe("A-Cpu");
    expect(domain.children![0].label).toBe("Host A");
    expect(host.children![0].state).toBe(domain.children![0].state);
  });

  it("leads a key back to its monitor", () => {
    const nodes = build_tree_nodes(linked_tree(), {});
    expect(monitor_for_key(nodes, "compute/a/a-cpu")).toBe("a-cpu");
    expect(monitor_for_key(nodes, "missing")).toBeNull();
  });

  it("covers every place in its branch keys", () => {
    expect(branch_ids(build_tree_nodes(linked_tree(), {}))).toEqual(["a", "compute", "compute/a"]);
  });

  it("opens every branch above a failed monitor", () => {
    expect(failed_branch_ids(build_tree_nodes(linked_tree(), { "a-cpu": "failed" }))).toEqual(["a", "compute", "compute/a"]);
  });

  it("keeps the clicked place marked and lets go on a fixed view", () => {
    const nodes = build_tree_nodes(linked_tree(), {});
    expect(selected_key(nodes, "plugin", "a-cpu", "compute/a-cpu")).toBe("compute/a-cpu");
    expect(selected_key(nodes, "plugin", "a-cpu", null)).toBe("a/a-cpu");
    expect(selected_key(nodes, "events", null, "a")).toBeNull();
  });

  it("reads its settings with defaults for missing or broken ones", () => {
    const db = new DatabaseManager();
    expect(sidebar_settings(db)).toEqual({ drawer_width: 248, expanded: [], accordion: false });
    db.set_setting("drawer_width", "wide");
    db.set_setting("tree_expanded", "[\"a\"]");
    db.set_setting("tree_accordion", "1");
    expect(sidebar_settings(db)).toEqual({ drawer_width: 248, expanded: ["a"], accordion: true });
  });
});

// ── Overview charts ──────────────────────────────────────────────────────────

function monitor(id: string, type: string, children: OverviewMonitor[] = []): OverviewMonitor {
  return { id, name: id, target: "host", config: { type }, children, restates_children: type === "group" };
}

describe("chart counts", () => {
  it("tally status totals", () => {
    const [status_counts] = build_chart_counts([monitor("a", "cpu"), monitor("b", "cpu"), monitor("c", "zfs")], { a: "online", b: "failed", c: "online" });
    expect(status_counts).toEqual({ online: 2, info: 0, failed: 1, warning: 0, unavailable: 0 });
  });

  it("break each type down by status", () => {
    const [, type_counts] = build_chart_counts([monitor("a", "cpu"), monitor("b", "cpu"), monitor("c", "zfs")], { a: "online", b: "failed", c: "warning" });
    expect(type_counts).toEqual({ cpu: { online: 1, failed: 1 }, zfs: { warning: 1 } });
  });

  it("count an unknown monitor as unavailable", () => {
    const [status_counts, type_counts] = build_chart_counts([monitor("a", "cpu")], {});
    expect(status_counts.unavailable).toBe(1);
    expect(type_counts).toEqual({ cpu: { unavailable: 1 } });
  });

  it("group a monitor without a type as unknown", () => {
    const [, type_counts] = build_chart_counts([{ id: "a", name: "a", config: {}, children: [] }], { a: "online" });
    expect(type_counts).toEqual({ unknown: { online: 1 } });
  });
});

describe("a type's worst status", () => {
  it("is failed above everything", () => expect(type_worst_status({ online: 9, warning: 2, unavailable: 1, failed: 1 })).toBe("failed"));
  it("is warning above unavailable and online", () => expect(type_worst_status({ online: 9, unavailable: 3, warning: 1 })).toBe("warning"));
  it("is unavailable above online", () => expect(type_worst_status({ online: 9, unavailable: 1 })).toBe("unavailable"));
  it("is online for an all-healthy type", () => expect(type_worst_status({ online: 4 })).toBe("online"));
  it("ignores a zero count", () => expect(type_worst_status({ failed: 0, online: 2 })).toBe("online"));
  it("falls back to unavailable for an empty tally", () => expect(type_worst_status({})).toBe("unavailable"));
});

describe("treemap tiles", () => {
  it("size a tile by its monitor count and colour it by the worst status", () => {
    const [tile] = treemap_tiles({ cpu: { online: 3, failed: 1 } });
    expect(tile).toEqual({ name: "CPU", value: 4, status: "failed", breakdown: "3 online, 1 failed" });
  });

  it("take the online status for a healthy type", () => expect(treemap_tiles({ cpu: { online: 2 } })[0].status).toBe("online"));
  it("label a tile with the type in capitals", () => expect(treemap_tiles({ systemd_service: { online: 1 } })[0].name).toBe("SYSTEMD_SERVICE"));
  it("put the largest type first", () => expect(treemap_tiles({ zfs: { online: 1 }, cpu: { online: 5 }, md: { online: 3 } }).map((tile) => tile.name)).toEqual(["CPU", "MD", "ZFS"]));
  it("fall back to name order for a stable layout", () => expect(treemap_tiles({ zfs: { online: 1 }, cpu: { online: 1 }, md: { online: 1 } }).map((tile) => tile.name)).toEqual(["CPU", "MD", "ZFS"]));
  it("are none with no types", () => expect(treemap_tiles({})).toEqual([]));
});

describe("leaf monitors", () => {
  it("flatten groups to their leaves", () => {
    expect(collect_leaf_monitors([monitor("g", "group", [monitor("a", "cpu"), monitor("b", "zfs")])]).map((each) => each.id)).toEqual(["a", "b"]);
  });

  it("leave a group out of the type counts", () => {
    const [, type_counts] = build_chart_counts(collect_leaf_monitors([monitor("g", "group", [monitor("a", "cpu")])]), { a: "online" });
    expect(type_counts).not.toHaveProperty("group");
  });

  it("list a monitor with children of its own with them", () => {
    expect(collect_leaf_monitors([monitor("h", "http", [monitor("a", "cpu")])]).map((each) => each.id)).toEqual(["h", "a"]);
  });
});

describe("the monitor table", () => {
  const monitors = [monitor("a", "cpu"), monitor("b", "zfs")];

  it("shows every monitor with its status badge", () => {
    expect(build_table_rows(monitors, { a: "failed" })).toEqual([
      { id: "a", name: "a", type: "CPU", host: "host", status: "Failed", status_key: "failed", status_badge: "bad" },
      { id: "b", name: "b", type: "ZFS", host: "host", status: "Unavailable", status_key: "unavailable", status_badge: "" },
    ]);
  });

  it("narrows to a clicked slice or tile, and a second click clears it", () => {
    const by_status = next_chart_filter({ field: null, value: null }, "status", "Failed");
    expect(build_table_rows(monitors, { a: "failed" }, by_status).map((row) => row.id)).toEqual(["a"]);
    const by_type = next_chart_filter(by_status, "type", "ZFS");
    expect(build_table_rows(monitors, {}, by_type).map((row) => row.id)).toEqual(["b"]);
    expect(next_chart_filter(by_type, "type", "ZFS")).toEqual({ field: null, value: null });
  });
});

describe("the recent tables", () => {
  it("cut a metric value to two decimals with no trailing zeros", () => {
    expect(metric_rows([{ timestamp: "2026-10-21T22:35:13.509105", value: 27.257606506347656 }])[0].value).toBe("27.26");
    expect(metric_rows([{ timestamp: "", value: 20.0 }])[0].value).toBe("20");
    expect(metric_rows([{ timestamp: "", value: 105 }])[0].value).toBe("105");
    expect(metric_rows([{ timestamp: "", value: null }])[0].value).toBeNull();
  });

  it("cut the timestamp to the second", () => {
    expect(metric_rows([{ timestamp: "2026-10-21T22:35:13.509105", value: 1 }])[0].timestamp).toBe("2026-10-21 22:35:13");
  });

  it("truncate the event message so the table fits its half-width column", () => {
    expect(RECENT_EVENT_COLUMNS.find((column) => column.name === "message")!.classes).toContain("halon-cell-truncate");
  });
});

// ── Events ───────────────────────────────────────────────────────────────────

describe("the events view", () => {
  it("lists recent events and filters them across every column", () => {
    const db = new DatabaseManager();
    db.insert_event("ERROR", "disk full", "odin");
    db.insert_event("INFO", "backup done", "thor");
    const { rows } = events_view(db);
    expect(rows).toHaveLength(2);
    expect(filter_rows(rows, "thor", ["timestamp", "level", "target", "message"]).map((row) => row.target)).toEqual(["thor"]);
  });

  it("passes its level, target and search on", () => {
    const asked: unknown[] = [];
    events_view({ recent_events: (...args: unknown[]) => { asked.push(args); return []; } }, { level: "ERROR", target: " odin ", search: "" });
    expect(asked).toEqual([[500, "ERROR", "odin", null]]);
  });
});

// ── Fleet ────────────────────────────────────────────────────────────────────

function fm(id: string, name: string = id, kind = "group", children: FleetMonitor[] = [], extra: Partial<FleetMonitor> = {}): FleetMonitor {
  return { id, name, config: { type: kind }, children, restates_children: kind === "group", ...extra };
}

function readings(values: Record<string, number>): fleet.LatestMetric {
  return (monitor_id, name) => values[`${monitor_id}/${name}`] ?? null;
}

function roots(): FleetMonitor[] {
  const heimdall = fm("heimdall", "Heimdall", "group", [
    fm("heimdall-up", "Availability", "uptime"),
    fm("heimdall-cpu", "CPU", "cpu"),
    fm("backups", "Backups", "group", [fm("borgmatic", "Borgmatic", "group", [fm("heimdall-disk", "On Disk", "borg", [], { max_age: 86400 })])]),
    fm("heimdall-scan", "Vulnerability Scan", "vuln_scan"),
    fm("heimdall-nixos", "Heimdall", "nixos_upgrade"),
  ]);
  const odin = fm("odin", "Odin", "group", [fm("odin-up", "Availability", "uptime"), fm("odin-http", "Web", "http")]);
  return [heimdall, odin];
}

describe("the fleet's roots and leaves", () => {
  it("take every root of the tree as a host", () => {
    expect(fleet.primary_roots({ plugins: [fm("a"), fm("b")] }).map((root) => root.id)).toEqual(["a", "b"]);
  });

  it("carry the groups between each leaf and its root", () => {
    const paths = new Map(fleet.leaves_with_paths(roots()[0]).map(([leaf, path]) => [leaf.id, path]));
    expect(paths.get("heimdall-disk")).toEqual(["Backups", "Borgmatic"]);
    expect(paths.get("heimdall-cpu")).toEqual([]);
  });

  it("list a leaf held by two groups once", () => {
    const shared = fm("shared", "shared", "cpu");
    const root = fm("root", "root", "group", [fm("a", "a", "group", [shared]), fm("b", "b", "group", [shared])]);
    expect(fleet.leaves_with_paths(root).map(([leaf]) => leaf.id)).toEqual(["shared"]);
  });

  it("list a monitor with children of its own before them", () => {
    const root = fm("root", "root", "group", [fm("web", "Web", "http", [fm("cert", "cert", "command")])]);
    expect(fleet.leaves_with_paths(root).map(([leaf, path]) => [leaf.id, path])).toEqual([["web", []], ["cert", ["Web"]]]);
  });

  it("make a root with no children its own leaf", () => {
    expect(fleet.leaves_with_paths(fm("lone", "lone", "uptime")).map(([leaf]) => leaf.id)).toEqual(["lone"]);
  });
});

describe("host tiles", () => {
  it("take the worst monitor's state", () => {
    expect(fleet.build_host_tiles(roots(), { "heimdall-cpu": "warning", "heimdall-up": "failed" })[0].state).toBe("failed");
  });

  it("count monitors and name only the trouble", () => {
    const statuses = Object.fromEntries(["heimdall-up", "heimdall-cpu", "heimdall-disk", "heimdall-scan", "heimdall-nixos"].map((id) => [id, "online"]));
    statuses["heimdall-cpu"] = "warning";
    expect(fleet.build_host_tiles(roots(), statuses)[0].caption).toBe("5 monitors · 1 warning");
  });

  it("count a monitor with no status yet as unavailable", () => {
    expect(fleet.build_host_tiles(roots(), { "odin-up": "online" })[1].counts).toEqual({ online: 1, info: 0, warning: 0, failed: 0, unavailable: 1 });
  });
});

describe("the other fleet sections", () => {
  it("give every reachability monitor a strip of its up metric", () => {
    expect(fleet.build_strip_rows(roots()).map((row) => [row.host, row.name, row.metric])).toEqual([["Heimdall", "Availability", "up"], ["Odin", "Availability", "up"], ["Odin", "Web", "probe_ok"]]);
  });

  it("fill a backup at its max age half way", () => {
    const [row] = fleet.build_backup_rows(roots(), { "heimdall-disk": "online" }, readings({ "heimdall-disk/last_backup_epoch": 1000 }), 1000 + 86400);
    expect(row.percent).toBeCloseTo(50);
    expect(row.value_text).toBe("1 Day ago");
  });

  it("label a backup by its host and the tool that owns the repository", () => {
    expect(fleet.build_backup_rows(roots(), {}, readings({}), 0)[0].label).toBe("Heimdall · Borgmatic › On Disk");
  });

  it("say so for a repository with no archive yet", () => {
    const [row] = fleet.build_backup_rows(roots(), {}, readings({}), 0);
    expect([row.value_text, row.percent, row.state]).toEqual(["No archive yet", 0, "unavailable"]);
  });

  it("show a deployment's generation, sync, reboot and drift", () => {
    const [tile] = fleet.build_deploy_tiles(roots(), { "heimdall-nixos": "online" }, readings({ "heimdall-nixos/generation": 812, "heimdall-nixos/up_to_date": 1 }));
    expect([tile.name, tile.state, tile.caption]).toEqual(["Heimdall", "online", "gen 812 · in sync"]);
    expect(fleet.build_deploy_tiles(roots(), {}, readings({ "heimdall-nixos/reboot_required": 1, "heimdall-nixos/up_to_date": 0 }))[0].caption).toBe("reboot pending · drift");
    expect(fleet.build_deploy_tiles(roots(), {}, readings({}))[0].caption).toBe("not checked yet");
  });

  it("split a scan's findings and count its open ports", () => {
    const [row] = fleet.build_finding_rows(roots(), readings({ "heimdall-scan/vulnerable": 1, "heimdall-scan/suspected": 2, "heimdall-scan/noted": 9, "heimdall-scan/open_ports": 14 }));
    expect([row.name, row.vulnerable, row.suspected, row.noted]).toEqual(["Heimdall", 1, 2, 9]);
    expect(row.text).toBe("1 · 2 · 9 · 14 open ports");
    expect(fleet.build_finding_rows(roots(), readings({}))[0].text).toBe("0 · 0 · 0");
  });
});

describe("reading the fleet", () => {
  const empty_db = { latest_statuses: () => ({}), latest_metric: () => null, metric_history: () => [] };

  it("builds only the sections on the page", () => {
    const [model] = fleet.read_fleet({ db: empty_db as never }, roots(), new Set(["hosts", "findings"]), []);
    expect(Object.keys(model).sort()).toEqual(["findings", "hosts"]);
  });

  it("reads each strip's up metric", () => {
    const asked: unknown[] = [];
    const db = { ...empty_db, metric_history: (monitor_id: string, metric: string, limit: number) => { asked.push([monitor_id, metric, limit]); return [{ value: 1 }]; } };
    const [, histories] = fleet.read_fleet({ db: db as never }, roots(), new Set(), fleet.build_strip_rows(roots()));
    expect(histories).toEqual([[1], [1], [1]]);
    expect(asked[2]).toEqual(["odin-http", "probe_ok", STRIP_CELLS]);
  });

  it("offers the sections the fleet has monitors for", () => {
    const view = fleet.fleet_view({ plugins: roots(), db: empty_db as never }, 0)!;
    expect(view.hosts.map((host) => host.name)).toEqual(["Heimdall", "Odin"]);
    expect(view.reachability).toHaveLength(3);
    expect(view.backups).toHaveLength(1);
    expect(view.deploys).toHaveLength(1);
    expect(view.findings).toHaveLength(1);
    expect(fleet.fleet_view({ plugins: [fm("solo", "Solo", "cpu")], db: empty_db as never }, 0)!.backups).toBeNull();
  });
});

// ── Schedules ────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 9, 22, 18, 30);

function scheduled(id: string, name: string, schedule: unknown[], actions: { name: string; action_id: string }[] = [], children: ScheduledMonitor[] = []): ScheduledMonitor {
  return { id, name, children, scheduled_actions: parse_schedule(schedule), all_actions: () => actions };
}

const BORG = scheduled("borg", "On Disk", [{ action: "run_backup", cron: "0 */3 * * *" }, { action: "check_repo", cron: "0 4 15 * *", args: { kind: "data" } }], [{ name: "Run Backup", action_id: "run_backup" }]);
const FRIGATE = scheduled("frigate", "Frigate", [{ action: "sync_recordings", cron: "@weekly" }]);
const PLAIN = scheduled("cpu", "CPU", []);

describe("the schedules view", () => {
  it("lists one row per scheduled action, soonest first", () => {
    const host = scheduled("heimdall", "Heimdall", [], [], [BORG]);
    expect(schedule_rows([PLAIN, FRIGATE, host], () => null, NOW).map((row) => [row.monitor, row.action, row.next])).toEqual([
      ["Heimdall › On Disk", "Run Backup", "Thu 22 Oct 21:00"],
      ["Frigate", "Sync recordings", "Sun 25 Oct 00:00"],
      ["Heimdall › On Disk", "Check repo (kind: data)", "Sun 15 Nov 04:00"],
    ]);
  });

  it("lists a monitor linked into two groups once", () => {
    expect(schedule_rows([scheduled("g1", "G1", [], [], [BORG]), scheduled("g2", "G2", [], [], [BORG])], () => null, NOW)).toHaveLength(2);
  });

  it("says when a schedule has not run", () => {
    const [row] = schedule_rows([BORG], () => null, NOW);
    expect([row.last, row.outcome]).toEqual(["not yet", ""]);
  });

  it("reads the last run and its outcome from the stored record", () => {
    const entry = BORG.scheduled_actions![0];
    const stored = { [entry.result_key("borg")]: JSON.stringify({ at: new Date(2026, 9, 22, 18, 0).getTime() / 1000, ok: false, message: "Scheduled run_backup (0 */3 * * *) failed" }) };
    const [row] = schedule_rows([BORG], (key) => stored[key], NOW);
    expect([row.last, row.outcome, row.outcome_badge]).toEqual(["Thu 22 Oct 18:00", "Failed", "bad"]);
  });

  it("reads an unreadable record as not run", () => {
    const entry = BORG.scheduled_actions![0];
    expect(schedule_rows([BORG], (key) => (key === entry.result_key("borg") ? "garbage" : null), NOW)[0].last).toBe("not yet");
  });

  it("lists a triggered action after the scheduled ones", () => {
    const nixos: ScheduledMonitor = { id: "nixos", name: "NixOS", scheduled_actions: [], triggered_actions: parse_triggers([{ action: "switch", metric: "up_to_date", below: 1 }]), all_actions: () => [{ name: "Rebuild & Switch", action_id: "switch" }] };
    expect(schedule_rows([nixos, FRIGATE], () => null, NOW).map((row) => [row.action, row.cron, row.next])).toEqual([
      ["Sync recordings", "@weekly", "Sun 25 Oct 00:00"],
      ["Rebuild & Switch", "When up_to_date < 1", "on that event"],
    ]);
  });

  it("shows a triggered action's last run", () => {
    const [entry] = parse_triggers([{ action: "switch", status: "warning" }]);
    const nixos: ScheduledMonitor = { id: "nixos", name: "NixOS", scheduled_actions: [], triggered_actions: [entry], all_actions: () => [] };
    const stored = { [entry.result_key("nixos")]: JSON.stringify({ at: new Date(2026, 9, 22, 18, 0).getTime() / 1000, ok: true }) };
    const [row] = schedule_rows([nixos], (key) => stored[key], NOW);
    expect([row.last, row.outcome]).toEqual(["Thu 22 Oct 18:00", "Started"]);
  });
});
