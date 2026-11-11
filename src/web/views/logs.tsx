// The log search: journal entries from one or many hosts, read live from each host's journal monitor, in one table
// that sorts, filters and groups; and the Logs page, which searches every host that has a journal monitor.

import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { useState } from "react";

import { filter_rows, tree_rows } from "../../shared/table_rows.ts";
import { calls, type EntryRow } from "../api.ts";
import { notify_error } from "../ui.tsx";

// ── Choices ──────────────────────────────────────────────────────────────────

export const SINCE_OPTIONS: [string, string][] = [
  ["15m", "Last 15 minutes"], ["1h", "Last hour"], ["6h", "Last 6 hours"], ["24h", "Last day"], ["7d", "Last week"], ["boot", "This boot"], ["", "Everything kept"],
];

export const PRIORITY_OPTIONS: [number, string][] = [[3, "Errors and worse"], [4, "Warnings and worse"], [5, "Notices and worse"], [6, "Info and worse"], [7, "Everything"]];

const LIMIT_OPTIONS: [number, string][] = [[100, "100 per host"], [500, "500 per host"], [1000, "1000 per host"], [5000, "5000 per host"]];

const GROUP_OPTIONS: [string, string][] = [["", "No grouping"], ["host", "Group by host"], ["unit", "Group by unit"], ["priority", "Group by priority"]];

const PRIORITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

const FILTER_FIELDS = ["time", "host", "unit", "priority_name", "message"];

// ── Grouping ─────────────────────────────────────────────────────────────────

// The rows under one parent row per value of the grouping field, the most recently active group first.
export function grouped_rows(rows: EntryRow[], group_by: string): EntryRow[] {
  if (!group_by) return rows;
  const groups = new Map<string, EntryRow[]>();
  for (const row of rows) {
    const value = group_by === "priority" ? row.priority_name : String((row as unknown as Record<string, unknown>)[group_by] || "(none)");
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  let order = [...groups.keys()];
  if (group_by === "priority") order = order.sort((left, right) => PRIORITY_NAMES.indexOf(left) - PRIORITY_NAMES.indexOf(right));
  return order.flatMap((value) => {
    const members = groups.get(value)!;
    const parent = `group:${value}`;
    const head: EntryRow = { key: parent, monitor_id: "", parent: null, group: `${value} (${members.length})`, epoch: members[0].epoch, time: members[0].time, host: "", unit: "", priority: Math.min(...members.map((member) => member.priority)), priority_name: "", priority_badge: "", message: "" };
    return [head, ...members.map((member) => ({ ...member, parent, group: "" }))];
  });
}

// ── Search ───────────────────────────────────────────────────────────────────

export function LogSearch({ monitors, show_host, default_limit }: { monitors: { id: string; target: string }[]; show_host: boolean; default_limit: number }) {
  const [hosts, set_hosts] = useState<string[]>(monitors.map((monitor) => monitor.id));
  const [since, set_since] = useState("1h");
  const [priority, set_priority] = useState(6);
  const [unit, set_unit] = useState("");
  const [text, set_text] = useState("");
  const [limit, set_limit] = useState(default_limit);
  const [group, set_group] = useState("");
  const [term, set_term] = useState("");
  const [rows, set_rows] = useState<EntryRow[]>([]);
  const [summary, set_summary] = useState("Pick filters and press Search");
  const [busy, set_busy] = useState(false);
  const [collapsed, set_collapsed] = useState<Set<unknown> | null>(null);

  const search = async () => {
    const chosen = show_host && monitors.length > 1 ? hosts : null;
    if (chosen !== null && chosen.length === 0) {
      set_rows([]);
      set_summary("Pick at least one host");
      return;
    }
    set_busy(true);
    try {
      const result = await calls.search_logs({ monitor_ids: chosen ?? monitors.map((monitor) => monitor.id), since, priority, unit: unit.trim(), text: text.trim(), limit });
      set_rows(result.rows);
      set_summary(result.summary);
      set_collapsed(null);
    } catch (error) {
      notify_error(error);
    } finally {
      set_busy(false);
    }
  };

  const grouped = Boolean(group);
  const shown_rows = grouped_rows(rows, group);
  // A grouped search opens with every group shut.
  const shut = collapsed ?? new Set(shown_rows.filter((row) => row.parent === null).map((row) => row.key));
  const visible = grouped ? tree_rows(shown_rows, "key", "parent", [], [], shut, term, FILTER_FIELDS) : filter_rows(shown_rows, term, FILTER_FIELDS);
  const limit_options: [number, string][] = LIMIT_OPTIONS.some(([value]) => value === default_limit) ? LIMIT_OPTIONS : [...LIMIT_OPTIONS, [default_limit, `${default_limit} per host`]];
  const group_options = show_host ? GROUP_OPTIONS : GROUP_OPTIONS.filter(([value]) => value !== "host");

  const columns: TableColumn<EntryRow & { _depth?: number; _has_children?: boolean; _expanded?: boolean }>[] = [
    ...(grouped ? [{
      label: "Group",
      sortable: false,
      cell: (row: EntryRow & { _has_children?: boolean; _expanded?: boolean }) => (row._has_children
        ? <button type="button" className="flat" aria-expanded={Boolean(row._expanded)} onClick={() => set_collapsed(() => { const after = new Set(shut); if (after.has(row.key)) after.delete(row.key); else after.add(row.key); return after; })}>{row._expanded ? "▾" : "▸"} {row.group}</button>
        : null),
    }] : []),
    { label: "Time", cell: (row) => row.time, sort: (row) => row.epoch },
    ...(show_host ? [{ label: "Host", cell: (row: EntryRow) => row.host, sort: (row: EntryRow) => row.host }] : []),
    { label: "Unit", cell: (row) => row.unit, sort: (row) => row.unit },
    { label: "Priority", cell: (row) => (row.priority_name ? <Badge tone={(row.priority_badge || "none") as "bad"}>{row.priority_name}</Badge> : null), sort: (row) => row.priority },
    { label: "Message", sortable: false, cell: (row) => <span className="mono pre-wrap">{row.message}</span> },
  ];

  return (
    <Section title="Log search" tools={<SearchBox label="Filter" value={term} on_input={set_term} />}>
      <form className="search-bar" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        {show_host && monitors.length > 1 && (
          <fieldset className="host-picks">
            <legend>Hosts</legend>
            {monitors.map((monitor) => (
              <label key={monitor.id} className="check">
                <input type="checkbox" checked={hosts.includes(monitor.id)} onChange={(event) => { const checked = event.currentTarget.checked; set_hosts((before) => (checked ? [...before, monitor.id] : before.filter((id) => id !== monitor.id))); }} />
                {monitor.target}
              </label>
            ))}
          </fieldset>
        )}
        <Select label="Since" options={SINCE_OPTIONS} value={since} on_change={set_since} />
        <Select label="Priority" options={PRIORITY_OPTIONS} value={priority} on_change={set_priority} />
        <label className="field"><span className="field-label">Unit</span><input type="text" value={unit} placeholder="Unit, e.g. nginx.service" onChange={(event) => set_unit(event.currentTarget.value)} /></label>
        <label className="field"><span className="field-label">Text</span><input type="text" value={text} placeholder="Text in the entry" onChange={(event) => set_text(event.currentTarget.value)} /></label>
        <Select label="Limit" options={limit_options} value={limit} on_change={set_limit} />
        <Select label="Grouping" options={group_options} value={group} on_change={(value) => { set_group(value); set_collapsed(null); }} />
        <button type="submit" className="accent solid" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>
      <p className="muted" role="status">{summary}</p>
      <DataTable caption="Journal entries" rows={visible} row_key={(row) => row.key} columns={columns} manual_sorting={grouped} />
    </Section>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function LogsView() {
  const view = use_resource(() => calls.logs(), []);
  return (
    <div className="page">
      <PageHeading title="Logs" subtitle="Search every host's journal at once; each search reads the hosts live" />
      <Loaded resource={view}>
        {(found) => (found.monitors.length === 0
          ? <p className="muted">No journal monitors are configured. Add a monitor of type "journal" for each host to search.</p>
          : <LogSearch monitors={found.monitors} show_host default_limit={found.default_limit} />)}
      </Loaded>
    </div>
  );
}
