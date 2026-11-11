// The df and du commands the filesystem monitors (filesystems, disk_space, folders) run, and the pure parsers for
// their output: one df builder and parser for any --output column list, one du builder and parser, and the metric key
// a path is stored under.

import { parse_float, parse_int, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import type { CmdResult } from "../../core/connectors/types.ts";
import { shell_quote } from "../../core/shell.ts";

// ── Constants ────────────────────────────────────────────────────────────────

// Pseudo and in-memory filesystem types a listing of real filesystems leaves out.
export const PSEUDO_FS_TYPES: readonly string[] = [
  "tmpfs", "devtmpfs", "squashfs", "overlay", "proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue", "debugfs",
  "tracefs", "ramfs", "efivarfs", "configfs", "fusectl", "securityfs", "pstore", "autofs", "binfmt_misc", "nsfs",
];

// df columns printed as a percentage, which parse to a float.
const percent_columns = new Set(["pcent", "ipcent"]);

// One parsed df row: numeric columns by name, plus the mount point under "target" when listed.
export type DfRow = Record<string, number> & { target?: string };

// ── Paths ────────────────────────────────────────────────────────────────────

// The metric-name fragment for a path: "root" for /, otherwise non-alphanumerics become underscores.
export function path_key(path: string): string {
  const stripped = path.replace(/^\/+|\/+$/g, "");
  if (!stripped) return "root";
  return [...stripped].map((character) => (/^[\p{L}\p{N}]$/u.test(character) ? character : "_")).join("");
}

// ── df ───────────────────────────────────────────────────────────────────────

// A df command printing the given --output columns, for one path or for every filesystem.
export function df_command(columns: readonly string[], options: { path?: string | null; byte_blocks?: boolean; exclude_types?: readonly string[] } = {}): string {
  const parts = ["df"];
  if (options.byte_blocks) parts.push("-B1");
  for (const type of options.exclude_types ?? []) parts.push(`-x ${type}`);
  parts.push(`--output=${columns.join(",")}`);
  if (options.path !== null && options.path !== undefined) parts.push(shell_quote(options.path));
  return parts.join(" ");
}

// df --output rows as records keyed by column, skipping any row that does not parse; only a leading "target" column
// may hold spaces, so the other columns are read from the right and what is left over is the mount point.
export function parse_df(block: string, columns: readonly string[], header = true): DfRow[] {
  const has_target = columns[0] === "target";
  const values = has_target ? columns.slice(1) : columns;
  const lines = header ? split_lines(block).slice(1) : split_lines(block);
  const rows: DfRow[] = [];
  for (const line of lines) {
    const fields = split_words(line);
    if (fields.length < values.length + (has_target ? 1 : 0)) continue;
    const tail = fields.slice(fields.length - values.length);
    const row: Record<string, number | string> = {};
    try {
      values.forEach((column, index) => {
        const raw = tail[index];
        row[column] = percent_columns.has(column) ? parse_float(raw.replace(/%+$/, "")) : parse_int(raw);
      });
    } catch {
      continue;
    }
    if (has_target) row.target = fields.slice(0, fields.length - values.length).join(" ");
    rows.push(row as DfRow);
  }
  return rows;
}

// ── du ───────────────────────────────────────────────────────────────────────

// A du command printing the apparent size in bytes of everything under path, cut off after `timeout` seconds.
export function du_command(path: string, timeout: number): string {
  return `timeout ${timeout} du -sb ${shell_quote(path)}`;
}

// The size in bytes from one du_command result, or the error that stopped it.
export function parse_du(result: CmdResult, timeout: number): [size_bytes: number | null, error: string | null] {
  if (result.exit_code === 124) return [null, `du timed out after ${timeout}s`];
  if (result.exit_code !== 0) return [null, `du failed: ${result.stderr.trim()}`];
  try {
    const first = split_words(result.stdout)[0];
    if (first === undefined) throw new Error("list index out of range");
    return [parse_int(first), null];
  } catch {
    return [null, `could not parse du output ${JSON.stringify(result.stdout.trim())}`];
  }
}
