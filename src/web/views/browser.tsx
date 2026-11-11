// The borg monitor's archive browser: an archive picker, a breadcrumb trail, the current folder's entries with tick
// boxes, and a restore of the ticked paths into a new folder.

import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { useEffect, useRef, useState } from "react";

import type { BrowserView } from "../../shared/page_view.ts";
import { calls, type BrowseFolder } from "../api.ts";
import { confirmed, notify, notify_error } from "../ui.tsx";

// The question asked before a restore, listing up to ten of the ticked paths.
export function restore_question(archive: string, restore_dir: string, paths: readonly string[]): string {
  let shown = paths.slice(0, 10).map((path) => `  /${path}`).join("\n");
  if (paths.length > 10) shown += `\n  … and ${paths.length - 10} more`;
  return `Restore from ${archive} into a new folder under ${restore_dir}? Live files are not touched.\n\n${shown}`;
}

export function ArchiveBrowser({ widget }: { widget: BrowserView }) {
  const [archive, set_archive] = useState("");
  const [path, set_path] = useState("");
  const [status, set_status] = useState("Pick an archive to browse its files.");
  const [rows, set_rows] = useState<BrowseFolder["rows"]>([]);
  const [ticked, set_ticked] = useState<Set<string>>(new Set());
  const asked = useRef("");

  const open_folder = async (next_archive: string, next_path: string) => {
    if (!next_archive) return;
    set_archive(next_archive);
    set_path(next_path);
    set_ticked(new Set());
    set_rows([]);
    set_status("Listing… borg reads the whole archive to list a folder, so a large one takes a while.");
    const wanted = `${next_archive}:${next_path}`;
    asked.current = wanted;
    try {
      const folder = await calls.browse(widget.monitor_id, next_archive, next_path);
      // Another folder may have been opened while this one was being listed.
      if (asked.current !== wanted) return;
      set_status(folder.status);
      set_rows(folder.rows);
    } catch (error) {
      if (asked.current === wanted) set_status(error instanceof Error ? error.message : "Listing failed");
    }
  };

  // An archive pruned away since it was opened leaves the browser.
  useEffect(() => {
    if (archive && !widget.archives.includes(archive)) {
      set_archive("");
      set_path("");
      set_rows([]);
      set_status("That archive is gone from the list. Pick another.");
    }
  }, [widget.archives.join("\n")]);

  const restore = async () => {
    const paths = rows.filter((row) => ticked.has(row.path)).map((row) => row.path);
    if (paths.length === 0 || !archive) return;
    if (!(await confirmed(restore_question(archive, widget.restore_dir, paths)))) return;
    try {
      const reply = await calls.run_action(widget.monitor_id, "restore_archive", { archive, paths }, "Restore");
      notify({ notice: reply.content || (reply.success ? "Restore started" : "Restore failed"), tone: reply.success ? "positive" : "negative" });
      if (reply.success) set_ticked(new Set());
    } catch (error) {
      notify_error(error);
    }
  };

  const parts = path.split("/").filter(Boolean);
  const count = ticked.size;
  return (
    <Section title="Browse archive" tools={<Select label="Archive" options={[["", "Pick an archive"], ...widget.archives.map((name): [string, string] => [name, name])]} value={archive} on_change={(value) => void open_folder(value, "")} />}>
      <div className="crumbs-row">
        <nav className="crumbs" aria-label="Folder">
          <button type="button" className="flat" disabled={!archive} onClick={() => void open_folder(archive, "")}>/</button>
          {parts.map((part, depth) => (
            <span key={depth}>
              <span className="muted"> › </span>
              <button type="button" className="flat" onClick={() => void open_folder(archive, parts.slice(0, depth + 1).join("/"))}>{part}</button>
            </span>
          ))}
        </nav>
        <span className="muted small" role="status">{status}</span>
      </div>
      <DataTable
        caption="Archive entries"
        rows={rows}
        row_key={(row) => row.path}
        columns={[
          { label: "Pick", header: <span className="visually-hidden">Pick</span>, sortable: false, cell: (row) => <input type="checkbox" aria-label={`Pick ${row.name}`} checked={ticked.has(row.path)} onChange={(event) => { const on = event.currentTarget.checked; set_ticked((before) => { const after = new Set(before); if (on) after.add(row.path); else after.delete(row.path); return after; }); }} /> },
          { label: "Name", sort: (row) => row.name, cell: (row) => (row.dir ? <button type="button" className="flat" onClick={() => void open_folder(archive, row.path)}>📁 {row.name}</button> : <span>{row.name}</span>) },
          { label: "Size", class: "number", sort: (row) => row.size_bytes, cell: (row) => row.size },
          { label: "Modified", sort: (row) => row.mtime, cell: (row) => row.mtime },
        ]}
      />
      <div className="button-row end">
        <button type="button" className="accent solid" disabled={count === 0} onClick={() => void restore()}>{count ? `Restore ${count} selected` : "Restore selected"}</button>
      </div>
    </Section>
  );
}
