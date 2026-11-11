// The borg monitor's archive browser without its widgets: an archive picker, a breadcrumb trail, the current folder's
// entries with tick boxes, and a restore of the ticked paths. The page draws it into the "browser" cell of the monitor's
// declarative layout from custom_view()'s data, and BorgBrowser holds one viewer's state through the same steps the
// page takes, so a page or a test drives it without borg.

import { format_size, type ArchiveEntry, type ListingEntry, type RepositoryInfo } from "./parsing.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// One row of the browser's table.
export interface BrowserRow {
  name: string;
  path: string;
  dir: boolean;
  size: string;
  size_bytes: number | null;
  mtime: string;
}

// One step of the breadcrumb trail: its button label and the folder it opens.
export interface Crumb {
  label: string;
  path: string;
}

// The part of the borg monitor the browser reads and calls.
export interface BrowserHost {
  readonly browse_limit: number;
  readonly restore_dir: string;
  listing(archive: string, path: string): ListingEntry[] | null;
  cached_archives(): [ArchiveEntry[], RepositoryInfo];
  run_action(action_id: string, args?: Record<string, unknown>): Promise<[success: boolean, content: string]>;
}

// What custom_view() hands the page: the cell to draw into, the archives to pick from and the limits it shows.
export interface BorgBrowserData {
  cell: "browser";
  archives: string[];
  browse_limit: number;
  restore_dir: string;
}

// The table's columns, with size sorting by its byte count.
export const BROWSER_COLUMNS = [
  { name: "name", label: "Name", field: "name", align: "left", sortable: true },
  { name: "size", label: "Size", field: "size", align: "right", sort_field: "size_bytes" },
  { name: "mtime", label: "Modified", field: "mtime", align: "left", sortable: true },
];

export const PICK_TEXT = "Pick an archive to browse its files.";
export const LISTING_TEXT = "Listing… borg reads the whole archive to list a folder, so a large one takes a while.";
export const GONE_TEXT = "That archive is gone from the list. Pick another.";

// ── Pure helpers ─────────────────────────────────────────────────────────────

// A folder's entries as table rows, at most `limit` of them.
export function browser_rows(entries: ListingEntry[], limit: number): BrowserRow[] {
  return entries.slice(0, limit).map((entry) => ({
    name: entry.name,
    path: entry.path,
    dir: entry.dir,
    size: entry.dir || entry.size === null ? "" : format_size(entry.size),
    size_bytes: entry.dir ? null : entry.size,
    mtime: entry.mtime,
  }));
}

// The line under the trail once a folder is listed.
export function folder_status(entries: ListingEntry[], limit: number): string {
  if (entries.length === 0) return "Nothing at this path.";
  if (entries.length > limit) return `Showing the first ${limit} entries — raise browse_limit to see more.`;
  return `${entries.length} entries`;
}

// The breadcrumb trail of a folder: "/" for the archive's top, then one step per folder down to `path`.
export function crumb_trail(path: string): Crumb[] {
  const parts = path.split("/").filter((part) => part);
  return [{ label: "/", path: "" }, ...parts.map((part, depth) => ({ label: part, path: parts.slice(0, depth + 1).join("/") }))];
}

export function restore_button_label(count: number): string {
  return count ? `Restore ${count} selected` : "Restore selected";
}

// The question asked before a restore, naming up to ten of the paths.
export function restore_prompt(archive: string, restore_dir: string, paths: string[]): string {
  let shown = paths.slice(0, 10).map((path) => `  /${path}`).join("\n");
  if (paths.length > 10) shown += `\n  … and ${paths.length - 10} more`;
  return `Restore from ${archive} into a new folder under ${restore_dir}? Live files are not touched.\n\n${shown}`;
}

// The archives the monitor last listed, newest first.
export function archive_names(host: Pick<BrowserHost, "cached_archives">): string[] {
  return host.cached_archives()[0].map((archive) => archive.name).filter((name) => name);
}

export function browser_view_data(host: BrowserHost): BorgBrowserData {
  return { cell: "browser", archives: archive_names(host), browse_limit: host.browse_limit, restore_dir: host.restore_dir };
}

// ── Viewer state ─────────────────────────────────────────────────────────────

// One viewer's browser: what is open, its rows, the status line, the ticked rows and the archive options.
export class BorgBrowser {
  private readonly host: BrowserHost;
  archive: string | null = null;
  path = "";
  rows: BrowserRow[] = [];
  status = PICK_TEXT;
  selected: BrowserRow[] = [];
  options: string[] = [];
  crumbs: Crumb[] = [];

  constructor(host: BrowserHost) {
    this.host = host;
    this.update_archives();
  }

  get restore_label(): string {
    return restore_button_label(this.selected.length);
  }

  get restore_enabled(): boolean {
    return this.selected.length > 0;
  }

  // Opens a folder, listing it through the monitor's browse action unless it was listed before.
  async open_folder(archive: string | null, path: string): Promise<void> {
    if (!archive) return;
    this.archive = archive;
    this.path = path;
    this.crumbs = crumb_trail(path);
    this.selected = [];
    let entries = this.host.listing(archive, path);
    if (entries === null) {
      this.status = LISTING_TEXT;
      this.rows = [];
      const [ok, content] = await this.host.run_action("browse_archive", { archive, path });
      // The viewer may have opened another folder while this one was being listed.
      if (this.archive !== archive || this.path !== path) return;
      entries = this.host.listing(archive, path);
      if (!ok || entries === null) {
        this.status = content || "Listing failed";
        return;
      }
    }
    this.status = folder_status(entries, this.host.browse_limit);
    this.rows = browser_rows(entries, this.host.browse_limit);
  }

  // Opens a row the viewer clicked when it is a folder.
  async open_row(row: Partial<BrowserRow> | null): Promise<void> {
    if (row?.dir) await this.open_folder(this.archive, row.path ?? "");
  }

  select(rows: BrowserRow[]): void {
    this.selected = [...rows];
  }

  // Restores the ticked paths once `confirm` agrees, returning the notice to show, or null when nothing was asked.
  async restore(confirm: (question: string) => Promise<boolean>): Promise<{ text: string; type: "positive" | "negative" } | null> {
    const paths = this.selected.map((row) => row.path);
    if (paths.length === 0 || !this.archive) return null;
    if (!(await confirm(restore_prompt(this.archive, this.host.restore_dir, paths)))) return null;
    const [ok, content] = await this.host.run_action("restore_archive", { archive: this.archive, paths });
    if (ok) this.selected = [];
    return { text: content || (ok ? "Restore started" : "Restore failed"), type: ok ? "positive" : "negative" };
  }

  // Refreshes the archive options after a poll, closing an archive that is gone from the list.
  update_archives(): void {
    const names = archive_names(this.host);
    if (JSON.stringify(names) !== JSON.stringify(this.options)) this.options = names;
    if (this.archive && !names.includes(this.archive)) {
      this.archive = null;
      this.path = "";
      this.crumbs = [];
      this.rows = [];
      this.status = GONE_TEXT;
    }
  }
}
