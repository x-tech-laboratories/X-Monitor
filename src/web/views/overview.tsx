// The overview: a tile per host, reachability strips, backup ages, deployments and vulnerability findings, the status
// donut and type treemap whose clicks filter the monitor table, and the recent metrics and events.

import { Donut, Meters, ShareBar, Strip, Treemap } from "@x-tech-laboratories/x-libs/web/react/charts";
import { SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Section, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState } from "react";

import { filter_rows } from "@x-tech-laboratories/x-libs/web/tables";

import { color_for, TRACK_COLOR } from "../../shared/charts.ts";
import { calls, live, type FleetView, type MonitorRow, type OverviewView } from "../api.ts";
import { status_color, StatusBadge, StatusDot, tone_of } from "../ui.tsx";
import { LevelBadge } from "./body.tsx";

export const STATUS_ORDER = ["online", "info", "failed", "warning", "unavailable"] as const;

const HOST_ORDER = ["online", "info", "warning", "failed", "unavailable"] as const;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export interface ChartFilter {
  field: "status" | "type" | null;
  value: string | null;
}

// The chart filter after a click on a slice or tile: the same one again clears it.
export function next_chart_filter(filter: ChartFilter, field: "status" | "type", raw_value: string): ChartFilter {
  const value = raw_value.toLowerCase();
  return filter.field === field && filter.value === value ? { field: null, value: null } : { field, value };
}

// The monitor table's rows under the chart filter.
export function filtered_monitors(rows: readonly MonitorRow[], filter: ChartFilter): MonitorRow[] {
  if (filter.field === "status") return rows.filter((row) => row.status_key === filter.value);
  if (filter.field === "type") return rows.filter((row) => row.type.toLowerCase() === filter.value);
  return [...rows];
}

// ── Fleet ────────────────────────────────────────────────────────────────────

function FleetSections({ fleet }: { fleet: FleetView }) {
  const finding_colors = [status_color("failed"), status_color("warning"), color_for("neutral")];
  return (
    <>
      <div className="host-tiles">
        {fleet.hosts.map((host) => (
          <a key={host.id} className={`tile host-tile tile-${tone_of(host.state)}`} href={link(["monitor", host.id])}>
            <span className="tile-label"><StatusDot state={host.state} /> {host.name}</span>
            <span className="muted small">{host.caption}</span>
            <span className="share-bar" aria-hidden="true">
              {HOST_ORDER.filter((name) => host.counts[name]).map((name) => <span key={name} className="share-part" style={{ flexGrow: host.counts[name], background: name === "unavailable" ? TRACK_COLOR : status_color(name) }} />)}
            </span>
          </a>
        ))}
      </div>
      {fleet.reachability.length > 0 && (
        <Section title="Reachability">
          {[...new Set(fleet.reachability.map((row) => row.host))].map((host) => (
            <div key={host} className="strip-group">
              <h4 className="tile-label">{host}</h4>
              {fleet.reachability.filter((row) => row.host === host).map((row) => (
                <div key={row.id} className="strip-row">
                  <Strip title={row.name} cells={row.states.map((state, index) => ({ label: `Check ${index + 1}`, ok: state === "unavailable" ? null : state !== "failed" }))} />
                  <span className="muted small">{row.share_text}</span>
                </div>
              ))}
            </div>
          ))}
        </Section>
      )}
      {(fleet.backups || fleet.deploys) && (
        <div className="grid-row">
          {fleet.backups && (
            <Section title="Backups · time since newest archive">
              <Meters message="No backups yet." rows={fleet.backups.map((row) => ({ label: row.label, href: link(["monitor", row.id]), value_text: row.value_text, percent: row.percent, color: row.state === "warning" || row.state === "failed" ? status_color(row.state) : color_for(null), marks: [50], title: null }))} />
              <p className="muted small">A bar is half full at its max age and full at twice it.</p>
            </Section>
          )}
          {fleet.deploys && (
            <Section title="NixOS deployments">
              <Tiles>{fleet.deploys.map((tile) => <Tile key={tile.id} label={tile.name} value={<><StatusDot state={tile.state} /> {tile.caption}</>} tone={tone_of(tile.state)} href={link(["monitor", tile.id])} />)}</Tiles>
            </Section>
          )}
        </div>
      )}
      {fleet.findings && (
        <Section title="Vulnerability findings">
          {fleet.findings.map((row) => (
            <div key={row.id} className="strip-row">
              <ShareBar label={row.name} show_values={false} parts={[
                { label: "Vulnerable", value_text: String(row.vulnerable), percent: row.vulnerable, color: finding_colors[0] },
                { label: "Likely", value_text: String(row.suspected), percent: row.suspected, color: finding_colors[1] },
                { label: "Noted", value_text: String(row.noted), percent: row.noted, color: finding_colors[2] },
                ...(row.vulnerable + row.suspected + row.noted === 0 ? [{ label: "Clean", value_text: "0", percent: 1, color: status_color("online") }] : []),
              ]} />
              <span className="muted small">{row.text}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

// ── Charts and the monitor table ─────────────────────────────────────────────

function MonitorCharts({ view, filter, on_filter }: { view: OverviewView; filter: ChartFilter; on_filter: (field: "status" | "type", value: string) => void }) {
  return (
    <div className="grid-row">
      <Section title="Monitors by status">
        <Donut
          title="Monitors by status"
          center={String(view.monitor_count)}
          center_label="monitors"
          message="No monitors yet."
          parts={STATUS_ORDER.map((name) => ({ label: capitalize(name), value: view.status_counts[name] ?? 0, color: status_color(name) }))}
        />
        <div className="button-row" role="group" aria-label="Filter by status">
          {STATUS_ORDER.map((name) => (
            <button key={name} type="button" className="flat" aria-pressed={filter.field === "status" && filter.value === name} onClick={() => on_filter("status", name)}>
              <StatusDot state={name} /> {capitalize(name)} {view.status_counts[name] ?? 0}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Monitors by type">
        <Treemap
          label="Monitors by type"
          selected={filter.field === "type" ? filter.value?.toUpperCase() ?? null : null}
          tiles={view.type_tiles.map((tile) => ({ name: tile.name, value: tile.value, color: status_color(tile.status), title: `${tile.name}: ${tile.value} monitor${tile.value === 1 ? "" : "s"} — ${tile.breakdown}` }))}
          on_select={(tile) => on_filter("type", tile.name)}
        />
      </Section>
    </div>
  );
}

function MonitorTable({ rows, filter, clear }: { rows: MonitorRow[]; filter: ChartFilter; clear: () => void }) {
  const [term, set_term] = useState("");
  const shown = filter_rows(filtered_monitors(rows, filter), term, ["name", "type", "host", "status"]);
  return (
    <Section
      title="Monitors"
      tools={<>
        {filter.field && <span className="muted small">Showing: {filter.value?.toUpperCase()} — click again to clear <button type="button" className="flat" onClick={clear}>Clear filter</button></span>}
        <SearchBox label="Filter" value={term} on_input={set_term} />
      </>}
    >
      <DataTable
        caption="Monitors"
        rows={shown}
        row_key={(row) => row.id}
        columns={[
          { label: "Monitor", sort: (row) => row.name, cell: (row) => <a href={link(["monitor", row.id])}>{row.name}</a> },
          { label: "Type", sort: (row) => row.type, cell: (row) => row.type },
          { label: "Host", sort: (row) => row.host, cell: (row) => row.host },
          { label: "Status", sort: (row) => row.status, cell: (row) => <StatusBadge state={row.status_key} /> },
        ]}
      />
    </Section>
  );
}

function RecentTables({ view }: { view: OverviewView }) {
  return (
    <div className="grid-row">
      <Section title="Recent metrics">
        <DataTable
          caption="Recent metrics"
          rows={view.recent_metrics}
          row_key={(row) => `${String(row.timestamp)}|${String(row.plugin_id)}|${String(row.metric_name)}`}
          columns={[
            { label: "Time", cell: (row) => String(row.timestamp ?? "") },
            { label: "Host", cell: (row) => String(row.target ?? "") },
            { label: "Plugin", cell: (row) => String(row.plugin_id ?? "") },
            { label: "Metric", cell: (row) => String(row.metric_name ?? "") },
            { label: "Value", cell: (row) => String(row.value ?? "") },
          ]}
        />
      </Section>
      <Section title="Recent events">
        <DataTable
          caption="Recent events"
          rows={view.recent_events}
          row_key={(row) => `${String(row.timestamp)}|${String(row.message)}`}
          columns={[
            { label: "Time", cell: (row) => String(row.timestamp ?? "") },
            { label: "Level", cell: (row) => <LevelBadge level={String(row.level ?? "")} /> },
            { label: "Host", cell: (row) => String(row.target ?? "") },
            // The message truncates so the table fits its half-width column; the full text is its tooltip.
            { label: "Message", cell: (row) => <span className="truncate" title={String(row.message ?? "")}>{String(row.message ?? "")}</span> },
          ]}
        />
      </Section>
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function OverviewPage({ view }: { view: OverviewView }) {
  const [filter, set_filter] = useState<ChartFilter>({ field: null, value: null });
  return (
    <div className="page">
      <PageHeading title="All Monitors" subtitle={view.lede} />
      {view.fleet && <FleetSections fleet={view.fleet} />}
      <MonitorCharts view={view} filter={filter} on_filter={(field, value) => set_filter((before) => next_chart_filter(before, field, value))} />
      <MonitorTable rows={view.monitors} filter={filter} clear={() => set_filter({ field: null, value: null })} />
      <RecentTables view={view} />
    </div>
  );
}

export function OverviewView() {
  const view = use_resource(() => calls.overview(), [], live);
  return <Loaded resource={view}>{(found) => <OverviewPage view={found} />}</Loaded>;
}

