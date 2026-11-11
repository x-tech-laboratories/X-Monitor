// A monitor's body, drawn from the view the server built: its layout rows of cards, charts, tables, buttons and the job
// panel, a group's grid or child cards, and the widgets custom pages add (the log search and the archive browser).

import { Badge, Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Gauge, LineChart, Meters, ShareBar, Strip } from "@x-tech-laboratories/x-libs/web/react/charts";
import { SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Section, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { createContext, useContext, useState, type CSSProperties } from "react";

import { filter_rows, tree_rows, type TableRow } from "@x-tech-laboratories/x-libs/web/tables";

import { color_for } from "../../shared/charts.ts";
import type {
  BodyView, ButtonsView, ButtonView, ChartView, ChildCardView, CellView, DialogView, FeedView, JobPanelView, RepeatView, RowActionView, ShareView, StripView, TableView, WidgetView,
} from "../../shared/page_view.ts";
import { row_params, substitute, title_words } from "../../shared/page_view.ts";
import { calls } from "../api.ts";
import { confirmed, notify, notify_error, StateValue, status_color, StatusDot, tone_of } from "../ui.tsx";
import { ArchiveBrowser } from "./browser.tsx";
import { open_job_log, open_spec_dialog } from "./dialogs.tsx";
import { LogSearch } from "./logs.tsx";

// ── Context ──────────────────────────────────────────────────────────────────

// What the widgets of one page share: every dialog by monitor and name, and how to load the page again.
export interface PageContext {
  dialogs: Record<string, Record<string, DialogView>>;
  reload: () => void;
}

export const Page = createContext<PageContext>({ dialogs: {}, reload: () => undefined });

// Runs one of a monitor's actions, says how it went, and opens the live log of a detached job it started.
async function run_and_report(monitor_id: string, action_id: string, args: Record<string, unknown>, label: string, notify_outcome: boolean, reload: () => void): Promise<void> {
  try {
    const reply = await calls.run_action(monitor_id, action_id, args, label);
    if (notify_outcome) notify(reply);
    if (reply.job_id !== null) await open_job_log(monitor_id, reply.job_id);
  } catch (error) {
    notify_error(error);
  }
  reload();
}

// ── Cards ────────────────────────────────────────────────────────────────────

function ValueCard({ title, text, state }: { title: string; text: string; state: string | null }) {
  return <Tile label={title} value={<StateValue text={text} state={state} />} />;
}

function ShareCard({ widget }: { widget: ShareView }) {
  return <div className="tile"><ShareBar label={widget.title} parts={widget.parts.map((part) => ({ label: part.label, value_text: part.text, percent: part.percent, color: color_for(part.color, color_for("series-1")) }))} /></div>;
}

const STRIP_OK: Record<string, boolean | null> = { online: true, info: true, failed: false, unavailable: null };

function StripCard({ widget }: { widget: StripView }) {
  return (
    <Section title={widget.title}>
      {widget.rows.map((row, index) => (
        <div key={index} className="strip-row">
          <Strip title={row.label ?? ""} cells={row.states.map((state, cell) => ({ label: `Check ${cell + 1}`, ok: STRIP_OK[state] ?? null }))} />
          <span className="muted small" aria-label={`${row.share_text} over the last ${widget.cells} checks`}>{row.share_text}</span>
        </div>
      ))}
    </Section>
  );
}

function RepeatCard({ widget }: { widget: RepeatView }) {
  const empty = widget.items.length === 0 ? <p className="muted small">{widget.empty_text}</p> : null;
  if (widget.container === "bars") {
    return (
      <Section title={widget.title ?? ""}>
        <Meters
          message={widget.empty_text}
          rows={widget.items.map((item) => ({ label: item.label || "--", href: null, value_text: item.value, percent: item.percent, color: item.state ? status_color(item.state) : color_for(null), marks: widget.marker === null ? [] : [widget.marker], title: null }))}
        />
      </Section>
    );
  }
  if (widget.container === "tiles") {
    return <Section title={widget.title ?? ""}>{empty ?? <Tiles>{widget.items.map((item, index) => <Tile key={index} label={item.label || "--"} value={<><StatusDot state={item.state ?? "unavailable"} /> {item.value}</>} tone={tone_of(item.state)} />)}</Tiles>}</Section>;
  }
  if (widget.container === "chips") {
    return empty ?? <Chips>{widget.items.map((item, index) => <Chip key={index} color={item.state ? status_color(item.state) : undefined}>{item.label ? `${item.label}: ${item.value}` : item.value}</Chip>)}</Chips>;
  }
  return empty ?? <Tiles>{widget.items.map((item, index) => <Tile key={index} label={item.label || "--"} value={item.value} />)}</Tiles>;
}

// ── Charts ───────────────────────────────────────────────────────────────────

function ChartCard({ widget }: { widget: ChartView }) {
  // A stack piles each series on those before it, so its top line is the total.
  const totals = widget.times.map(() => 0);
  const series = widget.series.map((each, index) => {
    const values = widget.style === "stack" ? each.values.map((value, point) => (totals[point] += value ?? 0)) : each.values;
    return { label: each.label, color: color_for(`series-${(index % 3) + 1}`), points: widget.times.map((time, point): [number, number | null] => [time, values[point] ?? null]) };
  });
  const format = widget.style === "mirror" ? (value: number) => String(Math.abs(Math.round(value * 100) / 100)) : (value: number) => String(Math.round(value * 100) / 100);
  return <LineChart title={widget.title} series={series} format={format} scale={widget.style === "mirror" ? "fit" : "zero"} format_time={(epoch) => new Date(epoch * 1000).toLocaleTimeString()} />;
}

// ── Feeds ────────────────────────────────────────────────────────────────────

const LEVEL_TONES: Record<string, "bad" | "warn" | "none"> = { ERROR: "bad", CRITICAL: "bad", WARNING: "warn" };

export function LevelBadge({ level }: { level: string }) {
  return <Badge tone={LEVEL_TONES[level] ?? "none"}>{level.charAt(0) + level.slice(1).toLowerCase()}</Badge>;
}

export function FeedTable({ widget }: { widget: FeedView }) {
  const [term, set_term] = useState("");
  const rows = filter_rows(widget.rows, term, ["timestamp", "level", "message"]);
  return (
    <Section title={widget.title} tools={<SearchBox label="Filter" value={term} on_input={set_term} />}>
      <DataTable
        caption={widget.title}
        rows={rows}
        row_key={(row) => `${row.timestamp}|${row.message}`}
        columns={[
          { label: "Time", cell: (row) => row.timestamp, sort: (row) => row.timestamp },
          { label: "Level", cell: (row) => <LevelBadge level={row.level} /> },
          { label: "Message", cell: (row) => <span className={widget.full_height ? "mono" : undefined}>{row.message}</span> },
        ]}
      />
    </Section>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

function cell_text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function SpecTable({ widget }: { widget: TableView }) {
  const { dialogs, reload } = useContext(Page);
  const [term, set_term] = useState("");
  const [busy, set_busy] = useState<Set<string>>(new Set());
  const [collapsed, set_collapsed] = useState<Set<unknown>>(new Set());
  const key_of = (row: TableRow) => cell_text(row[widget.row_key]);

  const row_action = async (action: RowActionView, row: TableRow) => {
    if (action.kind === "dialog") {
      await open_spec_dialog(widget.monitor_id, dialogs[widget.monitor_id], String(action.dialog), row);
      return;
    }
    if (action.confirm && !(await confirmed(substitute(action.confirm, row)))) return;
    await run_and_report(widget.monitor_id, action.action_id, row_params(action.params, row), title_words(action.tooltip || action.action_id), action.notify, reload);
  };

  const flip = async (column: TableView["columns"][number], row: TableRow) => {
    const toggle = column.toggle!;
    const busy_key = `${column.name}|${key_of(row)}`;
    if (busy.has(busy_key)) return;
    set_busy((before) => new Set(before).add(busy_key));
    const wanted = !row[`_toggle_${column.name}`];
    try {
      notify(await calls.toggle(widget.monitor_id, { label: column.label || column.name, row_key: row[widget.row_key], action_id: wanted ? toggle.on_action_id : toggle.off_action_id, args: row_params(toggle.params, row), wanted }));
    } catch (error) {
      notify_error(error);
    }
    set_busy((before) => {
      const after = new Set(before);
      after.delete(busy_key);
      return after;
    });
    reload();
  };

  const columns: TableColumn<TableRow>[] = widget.columns.map((column) => {
    if (column.name === "actions") {
      return {
        label: "Actions",
        header: <span className="visually-hidden">Actions</span>,
        sortable: false,
        class: "actions-cell",
        cell: (row) => (
          <span className="row-actions">
            {widget.row_actions.map((action) => (
              <button key={action.id} type="button" className={action.danger ? "flat danger" : "flat"} title={action.tooltip || undefined} onClick={() => void row_action(action, row)}>
                {action.tooltip || title_words(action.id)}
              </button>
            ))}
          </span>
        ),
      };
    }
    const tree_column = widget.tree?.column === column.name;
    return {
      label: column.label || column.name,
      id: column.name,
      sortable: column.sortable,
      sort: column.sortable ? (row: TableRow) => {
        const value = row[column.sort_field ?? column.field];
        return typeof value === "number" ? value : value === null || value === undefined ? null : String(value);
      } : undefined,
      class: column.align === "right" ? "number" : undefined,
      cell: (row) => {
        const value = row[column.field];
        let shown = <>{cell_text(value)}</>;
        if (column.toggle && row[`_toggle_${column.name}`] !== null && row[`_toggle_${column.name}`] !== undefined) {
          const pressed = Boolean(row[`_toggle_${column.name}`]);
          shown = <button type="button" className={pressed ? "active" : undefined} aria-pressed={pressed} disabled={busy.has(`${column.name}|${key_of(row)}`)} onClick={() => void flip(column, row)}>{cell_text(value)}</button>;
        } else if (column.colored) {
          shown = <StateValue text={cell_text(value)} state={String(row[`_color_${column.name}`] ?? "online")} />;
        }
        if (!tree_column || !widget.tree) return shown;
        const depth = Number(row._depth ?? 0);
        return (
          <span className="tree-cell" style={{ paddingLeft: `${depth * 1.25}rem` }}>
            {row._has_children
              ? <button type="button" className="icon tree-toggle" aria-expanded={Boolean(row._expanded)} aria-label={row._expanded ? "Collapse" : "Expand"} onClick={() => set_collapsed((before) => { const after = new Set(before); if (after.has(row[widget.row_key])) after.delete(row[widget.row_key]); else after.add(row[widget.row_key]); return after; })}>{row._expanded ? "▾" : "▸"}</button>
              : <span className="tree-leaf" />}
            {shown}
          </span>
        );
      },
    };
  });

  const rows = widget.tree
    ? tree_rows(widget.rows, widget.row_key, widget.tree.parent_field, [], widget.columns, collapsed, term, widget.filter_fields)
    : filter_rows(widget.rows, term, widget.filter_fields);

  return (
    <Section title={widget.title ?? ""} tools={<SearchBox label={widget.filter_placeholder} value={term} on_input={set_term} />}>
      <DataTable caption={widget.title ?? "Table"} rows={rows} row_key={key_of} columns={columns} manual_sorting={widget.tree !== null} />
    </Section>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

export function SpecButton({ monitor_id, button }: { monitor_id: string; button: ButtonView }) {
  const { dialogs, reload } = useContext(Page);
  const click = async () => {
    if (button.kind === "dialog") {
      await open_spec_dialog(monitor_id, dialogs[monitor_id], String(button.dialog));
      return;
    }
    if (button.confirm && !(await confirmed(substitute(button.confirm, null)))) return;
    await run_and_report(monitor_id, button.id, {}, button.label, button.notify, reload);
  };
  const classes = [button.flat ? "flat" : null, button.danger ? "danger" : null].filter(Boolean).join(" ") || undefined;
  return <button type="button" className={classes} onClick={() => void click()}>{button.label}</button>;
}

function ButtonRow({ widget }: { widget: ButtonsView }) {
  const row = <div className="button-row">{widget.buttons.map((button) => <SpecButton key={button.id} monitor_id={widget.monitor_id} button={button} />)}</div>;
  return widget.title ? <Section title={widget.title}>{row}</Section> : row;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

function JobPanel({ widget }: { widget: JobPanelView }) {
  const { reload } = useContext(Page);
  const act = async (call: () => Promise<{ notice: string; tone: "positive" | "negative" | "warning" | "info" }>) => {
    try {
      notify(await call());
    } catch (error) {
      notify_error(error);
    }
    reload();
  };
  const tools = widget.run && (
    <span className="button-row">
      <button type="button" className="accent solid" disabled={!widget.run.enabled} onClick={() => void act(() => calls.start_job(widget.monitor_id, widget.run!.action_id, widget.run!.label))}>{widget.run.label}</button>
      {widget.cancel?.visible && <button type="button" className="danger" onClick={() => void act(() => calls.cancel(widget.monitor_id))}>{widget.cancel.label}</button>}
    </span>
  );
  return (
    <Section title={widget.title} tools={tools}>
      {widget.progress.text && <p className={`mono small tone-${tone_of(widget.progress.state)}`}>{widget.progress.text}</p>}
      <DataTable
        caption={widget.title}
        rows={widget.rows}
        row_key={(row) => row.id}
        columns={[
          { label: "Started", cell: (row) => row.started, sort: (row) => row.started },
          { label: "Kind", cell: (row) => row.kind, sort: (row) => row.kind },
          { label: "State", cell: (row) => row.state, sort: (row) => row.state },
          { label: "Duration", cell: (row) => row.duration, sort: (row) => row.duration_seconds },
          { label: "Log", header: <span className="visually-hidden">Log</span>, sortable: false, cell: (row) => <button type="button" className="flat" onClick={() => void open_job_log(widget.monitor_id, row.id)}>Log</button> },
        ]}
      />
    </Section>
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export function Widget({ widget }: { widget: WidgetView }) {
  switch (widget.type) {
    case "value": return <ValueCard title={widget.title} text={widget.text} state={widget.state} />;
    case "gauge": return <Gauge label={widget.title} value_text={widget.text} percent={widget.percent} color={widget.state ? status_color(widget.state) : color_for(null)} caption={widget.caption} />;
    case "share": return <ShareCard widget={widget} />;
    case "strip": return <StripCard widget={widget} />;
    case "repeat": return <RepeatCard widget={widget} />;
    case "chart": return <ChartCard widget={widget} />;
    case "feed": return <FeedTable widget={widget} />;
    case "table": return <SpecTable widget={widget} />;
    case "buttons": return <ButtonRow widget={widget} />;
    case "jobs": return <JobPanel widget={widget} />;
    case "section": return <h3 className="section-title">{widget.title}</h3>;
    case "body": return <Body body={widget.body} />;
    case "log_search": return <LogSearch monitors={widget.monitors} show_host={widget.show_host} default_limit={widget.default_limit} />;
    case "browser": return <ArchiveBrowser widget={widget} />;
    case "slot": return null;
  }
}

function cell_style(cell: CellView): CSSProperties {
  return { flex: `${cell.flex} 1 ${cell.min_width}`, minWidth: 0, ...(cell.height ? { height: cell.height, overflowY: "auto" } : {}) };
}

// ── Children ─────────────────────────────────────────────────────────────────

function ChildCard({ parent_id, card }: { parent_id: string; card: ChildCardView }) {
  const { reload } = useContext(Page);
  const toggle = async () => {
    try {
      await calls.open_child(parent_id, card.id, !card.open);
    } catch (error) {
      notify_error(error);
    }
    reload();
  };
  const style: CSSProperties = { flex: `${card.col_span} 1 calc(${card.col_span} * ${card.min_width})`, minWidth: card.min_width, ...(card.height ? { height: card.height, overflowY: "auto" } : {}) };
  return (
    <div className="panel child-card" style={style}>
      <button type="button" className="panel-head child-head" aria-expanded={card.open} onClick={() => void toggle()}>
        <span aria-hidden="true">{card.open ? "▾" : "▸"}</span>
        <StatusDot state={card.state} />
        <span>{card.label}</span>
      </button>
      {card.open && card.body && <div className="child-body"><Body body={card.body} /></div>}
    </div>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────

export function Body({ body }: { body: BodyView }) {
  return (
    <div className="body-layout">
      {body.rows.filter((row) => !row.hidden).map((row, index) => (
        <div key={index} className="layout-row">
          {row.cells.filter((cell) => cell.visible).map((cell) => (
            <div key={cell.widget} className="layout-cell" style={cell_style(cell)} data-widget={cell.widget}>
              {cell.content.map((widget, position) => <Widget key={position} widget={widget} />)}
            </div>
          ))}
        </div>
      ))}
      {body.custom && <p className="muted">This monitor draws a page of its own ({body.custom.kind}) that this dashboard does not know.</p>}
      {body.children.length > 0 && <div className="child-cards">{body.children.map((card) => <ChildCard key={card.id} parent_id={body.monitor_id} card={card} />)}</div>}
    </div>
  );
}
