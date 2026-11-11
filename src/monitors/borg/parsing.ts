// Pure readers for borg's JSON and text output.

import { shell_quote } from "../../core/shell.ts";
import { splitlines } from "./shell.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// One archive as the monitor caches it: the name and start time, plus the sizes `borg info` adds.
export interface ArchiveEntry {
  name: string;
  epoch: number;
  original?: number;
  compressed?: number;
  deduplicated?: number;
  nfiles?: number;
}

export type RepositoryInfo = Record<string, string>;

// One child of a folder in an archive listing.
export interface ListingEntry {
  name: string;
  path: string;
  dir: boolean;
  type: string;
  size: number | null;
  mtime: string;
}

// A line of `borg prune --list`: a kept archive with its rule, or one that would be pruned.
export const PRUNE_LINE = /^(?:Keeping archive \(rule: (?<rule>[^)]+)\)|(?<prune>Would prune)):\s+(?<name>\S+)\s+(?<date>.+?)\s+\[[0-9a-f]+\]\s*$/;

// ── Sizes and times ──────────────────────────────────────────────────────────

// A raw byte count as text, unlike plugin_helpers.format_bytes which reads GB.
export function format_size(size: number): string {
  let value = size;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (Math.abs(value) < 1024.0 || unit === "TB") return unit !== "B" ? `${value.toFixed(1)} ${unit}` : `${Math.trunc(value)} B`;
    value /= 1024.0;
  }
  return `${value.toFixed(1)} TB`;
}

// An archive's start time as epoch seconds, read as Python's datetime.fromisoformat does (naive times are local); 0 when
// it is not a time.
export function parse_archive_time(value: string | null | undefined): number {
  if (!value) return 0;
  let text = value.trim();
  if (text.endsWith("Z")) text = text.slice(0, -1) + "+00:00";
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?([+-]\d{2}:?\d{2}(?::?\d{2})?)?)?$/.exec(text);
  if (match === null) return 0;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0)] as const;
  const milliseconds = fraction ? Number(fraction.padEnd(6, "0")) / 1000 : 0;
  let moment: number;
  if (offset) {
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replaceAll(":", "");
    const offset_seconds = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4)) * 60 + Number(digits.slice(4, 6) || 0);
    moment = Date.UTC(...parts, 0) + milliseconds - sign * offset_seconds * 1000;
  } else {
    moment = new Date(...parts, 0).getTime() + milliseconds;
  }
  return Number.isFinite(moment) ? Math.trunc(moment / 1000) : 0;
}

export function is_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Decodes a borg --json payload, returning {} when it is not a JSON object.
export function decode_json(stdout: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(stdout);
    return is_object(data) ? data : {};
  } catch {
    return {};
  }
}

// ── Repository view ──────────────────────────────────────────────────────────

// Decoded `borg list --json` output shared by the parse helpers.
export class RepoView {
  readonly valid: boolean;
  readonly raw_count: number;
  readonly newest_epoch: number;
  readonly archives: ArchiveEntry[];
  readonly info: RepositoryInfo;

  constructor(fields: { valid?: boolean; raw_count?: number; newest_epoch?: number; archives?: ArchiveEntry[]; info?: RepositoryInfo } = {}) {
    this.valid = fields.valid ?? false;
    this.raw_count = fields.raw_count ?? 0;
    this.newest_epoch = fields.newest_epoch ?? 0;
    this.archives = fields.archives ?? [];
    this.info = fields.info ?? {};
  }

  // Parses the payload once, returning an invalid view on malformed output.
  static from_stdout(stdout: string): RepoView {
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      return new RepoView();
    }
    if (!is_object(data)) return new RepoView();
    const raw = data.archives || [];
    if (!Array.isArray(raw)) return new RepoView();

    const archives: ArchiveEntry[] = [];
    for (const archive of raw) {
      if (!is_object(archive)) continue;
      archives.push({
        name: String(archive.name || archive.archive || "?"),
        epoch: parse_archive_time(String(archive.start || (archive.time ?? ""))),
      });
    }
    archives.sort((first, second) => second.epoch - first.epoch);
    const positive = archives.map((archive) => archive.epoch).filter((epoch) => epoch > 0);
    const newest = positive.length > 0 ? Math.max(...positive) : 0;

    const info: RepositoryInfo = {};
    const repo = data.repository;
    if (is_object(repo)) {
      info.location = String(repo.location || "");
      info.last_modified = String(repo.last_modified || "");
    }
    const encryption = data.encryption;
    if (is_object(encryption)) info.encryption = String(encryption.mode || "");

    return new RepoView({ valid: true, raw_count: raw.length, newest_epoch: newest, archives, info });
  }
}

// ── Archive listings ─────────────────────────────────────────────────────────

// Tab-separated with the path last, so a path containing a tab still reads back whole.
export const LIST_FORMAT = "{type}\t{size}\t{isomtime}\t{path}{NL}";

// Keeps a folder's direct children and stands in one folder line for anything deeper, since borg stores no item for a parent it was not asked to back up.
const children_awk = `BEGIN { FS = "\\t"; n = length(p) }
{
    path = $0
    for (k = 0; k < 3; k++) path = substr(path, index(path, "\\t") + 1)
    if (substr(path, 1, n) != p) next
    rest = substr(path, n + 1)
    if (rest == "") next
    i = index(rest, "/")
    if (i == 0) { print; next }
    d = substr(rest, 1, i - 1)
    if (!(d in seen)) { seen[d] = 1; print "d\\t\\t\\t" p d }
}`;

// A shell filter reducing a `borg list` of `member` to that folder's direct children.
export function children_filter(member: string): string {
  const prefix = member ? `${member}/` : "";
  return `awk -v p=${shell_quote(prefix)} ${shell_quote(children_awk)}`;
}

// One entry per child, folders first, where a real item wins over a folder made up from a deeper path.
export function parse_listing(stdout: string): ListingEntry[] {
  const entries = new Map<string, ListingEntry>();
  for (const line of splitlines(stdout || "")) {
    const fields = split_max(line, "\t", 3);
    if (fields.length !== 4 || !fields[3]) continue;
    const [kind, size, mtime, path] = fields;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (entries.has(name) && !size) continue;
    entries.set(name, { name, path, dir: kind === "d", type: kind, size: /^\d+$/.test(size) ? Number(size) : null, mtime: mtime.replace("T", " ").slice(0, 16) });
  }
  return [...entries.values()].sort((first, second) => {
    if (first.dir !== second.dir) return first.dir ? -1 : 1;
    const [left, right] = [first.name.toLowerCase(), second.name.toLowerCase()];
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

// Splits on a separator at most `limit` times, as Python's str.split(sep, limit) does.
function split_max(text: string, separator: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < limit) {
    const at = rest.indexOf(separator);
    if (at === -1) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  parts.push(rest);
  return parts;
}
