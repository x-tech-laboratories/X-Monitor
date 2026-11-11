// Text as the Python app wrote it, where a spec carries a Python format template such as "{:.1f} GB" or
// "Reboot {plugin.target} into {row[entry]}?", and str() of a value is what a cell shows.

import { format_fixed } from "./numbers.ts";

// ── str() ────────────────────────────────────────────────────────────────────

// A value as Python's str() writes it: None, True and False by name, lists and dicts as JSON.
export function python_str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ── format() ─────────────────────────────────────────────────────────────────

// Looks one field up: a positional index, a keyword, then `.attr` and `[key]` steps.
export type FieldLookup = (name: string) => unknown;

function step_into(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "function") return (value as (key: string) => unknown)(key);
  const found = (value as Record<string, unknown>)[key];
  return found;
}

function resolve_field(field: string, lookup: FieldLookup): unknown {
  const match = /^([^.[]*)(.*)$/.exec(field)!;
  let value = lookup(match[1]);
  const steps = match[2].matchAll(/\.([^.[]+)|\[([^\]]*)\]/g);
  for (const step of steps) value = step_into(value, step[1] ?? step[2]);
  return value;
}

function group_thousands(text: string): string {
  const [whole, fraction] = text.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = whole.replace(/^-/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + digits + (fraction !== undefined ? `.${fraction}` : "");
}

// Applies a format spec such as ".1f", ",", ">8" or "d" to one value.
export function apply_format_spec(value: unknown, spec: string): string {
  const match = /^(?:(.)?([<>^]))?(0)?(\d+)?(,)?(?:\.(\d+))?([sdfFeg%])?$/.exec(spec);
  if (spec === "" || match === null) return python_str(value);
  const [, fill = " ", align, zero, width, comma, precision, kind] = match;
  let text: string;
  if (typeof value === "number" && kind !== "s") {
    if (kind === "f" || kind === "F") text = format_fixed(value, Number(precision ?? 6));
    else if (kind === "%") text = `${format_fixed(value * 100, Number(precision ?? 6))}%`;
    else if (kind === "d") text = String(Math.trunc(value));
    else if (kind === "e") text = value.toExponential(Number(precision ?? 6)).replace(/e([+-])(\d)$/, "e$10$2");
    else if (precision !== undefined) text = format_fixed(value, Number(precision));
    else text = String(value);
    if (comma) text = group_thousands(text);
  } else {
    text = python_str(value);
    if (precision !== undefined) text = text.slice(0, Number(precision));
  }
  const size = Number(width ?? 0);
  if (text.length >= size) return text;
  const padding = (zero ? "0" : fill).repeat(size - text.length);
  const side = align ?? (typeof value === "number" ? ">" : "<");
  if (side === "<") return text + padding;
  if (side === "^") return padding.slice(0, Math.floor(padding.length / 2)) + text + padding.slice(Math.floor(padding.length / 2));
  return padding + text;
}

// Fills a Python str.format template: "{}" and "{0}" take positional arguments, "{name}" keywords, with ".attr" and
// "[key]" steps and a ":spec"; "{{" and "}}" are literal braces.
export function python_format(template: string, positional: readonly unknown[] = [], keywords: Record<string, unknown> = {}): string {
  let auto_index = 0;
  const lookup: FieldLookup = (name) => {
    if (name === "") return positional[auto_index++];
    if (/^\d+$/.test(name)) return positional[Number(name)];
    return keywords[name];
  };
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (whole, inner: string | undefined) => {
    if (whole === "{{") return "{";
    if (whole === "}}") return "}";
    const body = inner ?? "";
    const colon = body.indexOf(":");
    const field = colon === -1 ? body : body.slice(0, colon);
    const spec = colon === -1 ? "" : body.slice(colon + 1);
    const conversion = /!([rs])$/.exec(field);
    const value = resolve_field(conversion ? field.slice(0, -2) : field, lookup);
    if (conversion?.[1] === "r") return JSON.stringify(value);
    return apply_format_spec(value, spec);
  });
}
