// Rows the way every dashboard table orders, filters and keys them: by several columns at once, on a typed term, and as
// a tree, the same on the server building a view and in the page showing it.

import { python_str } from "./python_text.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type TableRow = Record<string, unknown>;

export interface SortColumn {
  name: string;
  field?: string;
  sort_field?: string;
}

// One column of a sort and whether it runs descending.
export type SortKey = [column_name: string, descending: boolean];

// ── Sorting and filtering ────────────────────────────────────────────────────

type NaturalPart = [rank: number, number: number, word: string];

// Splits text into words and numbers so "host10" sorts after "host9".
function natural_key(text: string): NaturalPart[] {
  return text.toLowerCase().split(/(\d+)/).filter((part) => part !== "").map((part): NaturalPart => (/^\d+$/.test(part) ? [0, Number(part), ""] : [1, 0, part]));
}

function compare_tuples(first: readonly (string | number)[], second: readonly (string | number)[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    if (first[index] < second[index]) return -1;
    if (first[index] > second[index]) return 1;
  }
  return first.length - second.length;
}

function compare_natural(first: NaturalPart[], second: NaturalPart[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const order = compare_tuples(first[index], second[index]);
    if (order !== 0) return order;
  }
  return first.length - second.length;
}

// One cell of a row of any shape.
function cell(row: object, field: string): unknown {
  return (row as TableRow)[field];
}

function is_blank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

// Orders numbers before text, whatever mix a column holds.
function compare_values(first: unknown, second: unknown): number {
  const first_number = typeof first === "number" || typeof first === "boolean";
  const second_number = typeof second === "number" || typeof second === "boolean";
  if (first_number && second_number) return Number(first) - Number(second);
  if (first_number) return -1;
  if (second_number) return 1;
  return compare_natural(natural_key(String(first)), natural_key(String(second)));
}

// Orders rows by each (column name, descending) pair in turn, the first pair deciding most, with empty cells last.
export function sort_rows<Row extends object>(rows: readonly Row[], sort_keys: readonly SortKey[], columns: readonly SortColumn[]): Row[] {
  const field_by_name = new Map(columns.map((column) => [column.name, column.sort_field ?? column.field ?? column.name]));
  let ordered = [...rows];
  // The sort is stable, so sorting by the last key first leaves the first key in charge.
  for (const [column_name, descending] of [...sort_keys].reverse()) {
    const field = field_by_name.get(column_name) ?? column_name;
    const empty_rows = ordered.filter((row) => is_blank(cell(row, field)));
    const filled_rows = ordered.filter((row) => !is_blank(cell(row, field)));
    filled_rows.sort((left, right) => (descending ? -1 : 1) * compare_values(cell(left, field), cell(right, field)));
    ordered = [...filled_rows, ...empty_rows];
  }
  return ordered;
}

// Keeps the rows where every word of the term appears in one of the given fields.
export function filter_rows<Row extends object>(rows: readonly Row[], term: string, fields: readonly string[]): Row[] {
  const words = term.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = fields.map((field) => cell_text(cell(row, field))).join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

// A cell as the filter reads it, an absent one as empty.
function cell_text(value: unknown): string {
  return value === undefined ? "" : python_str(value);
}

// The sort after a header click: a plain click sorts by that column alone, a shift-click adds it to the others, and
// clicking the same column again steps it from ascending to descending to unsorted.
export function next_sort_keys(sort_keys: readonly SortKey[], column_name: string, add: boolean): SortKey[] {
  const current = new Map(sort_keys);
  if (!add) {
    if (current.size === 1 && current.has(column_name)) return current.get(column_name) ? [] : [[column_name, true]];
    return [[column_name, false]];
  }
  if (!current.has(column_name)) return [...sort_keys, [column_name, false]];
  if (!current.get(column_name)) return sort_keys.map(([name, descending]) => [name, name === column_name ? true : descending]);
  return sort_keys.filter(([name]) => name !== column_name);
}

// ── Keying rows ──────────────────────────────────────────────────────────────

// A short stable digest of text, so equal contents always get equal keys.
function digest(text: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
}

// Gives each row that has no key one made from its contents, so the browser keeps a row it has already drawn.
export function keyed_rows<Row extends object>(rows: readonly Row[], row_key: string): (Row & TableRow)[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (cell(row, row_key) !== null && cell(row, row_key) !== undefined) return row as Row & TableRow;
    const contents = JSON.stringify(Object.keys(row).sort().map((key) => [key, cell(row, key)]));
    const hash = digest(contents);
    // Identical rows, such as one message logged twice in a second, each need their own key.
    const count = (seen.get(hash) ?? -1) + 1;
    seen.set(hash, count);
    return { ...row, [row_key]: `${hash}-${count}` } as Row & TableRow;
  });
}

// ── Trees ────────────────────────────────────────────────────────────────────

export type TreeMarked<Row> = Row & { _depth: number; _has_children: boolean; _expanded: boolean };

// Flattens rows into tree order, each under its parent and sorted among its siblings. A row whose parent is absent is
// a root. Rows under a collapsed key are left out, unless a filter term is set, which keeps every match and the
// ancestors leading to it. Each returned row is a copy marked with `_depth`, `_has_children` and `_expanded`.
export function tree_rows<Row extends object>(rows: readonly Row[], row_key: string, parent_field: string, sort_keys: readonly SortKey[], columns: readonly SortColumn[], collapsed: ReadonlySet<unknown>, term = "", filter_fields: readonly string[] = []): TreeMarked<Row>[] {
  const by_key = new Map<unknown, Row>(rows.map((row) => [cell(row, row_key), row]));
  const children = new Map<unknown, Row[]>();
  const roots: Row[] = [];
  for (const row of rows) {
    const parent = cell(row, parent_field);
    if (parent !== null && parent !== undefined && by_key.has(parent) && parent !== cell(row, row_key)) {
      children.set(parent, [...(children.get(parent) ?? []), row]);
    } else {
      roots.push(row);
    }
  }

  let shown: Set<unknown> | null = null;
  if (term.trim()) {
    shown = new Set();
    for (const row of filter_rows(rows, term, filter_fields)) {
      let key = cell(row, row_key);
      while (by_key.has(key) && !shown.has(key)) {
        shown.add(key);
        key = cell(by_key.get(key)!, parent_field);
      }
    }
  }

  const flat: TreeMarked<Row>[] = [];
  const add_level = (level: Row[], depth: number): void => {
    for (const row of sort_rows(level, sort_keys, columns)) {
      const key = cell(row, row_key);
      if (shown !== null && !shown.has(key)) continue;
      const below = children.get(key) ?? [];
      const expanded = shown !== null || !collapsed.has(key);
      flat.push({ ...row, _depth: depth, _has_children: below.length > 0, _expanded: expanded });
      if (below.length > 0 && expanded) add_level(below, depth + 1);
    }
  };
  add_level(roots, 0);
  return flat;
}
