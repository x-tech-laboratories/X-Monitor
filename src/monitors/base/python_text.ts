// Text the Python app wrote with repr(), str() of a list or dict, and json.dumps, so log lines, settings and shell
// commands built from them stay byte-for-byte the same.

// ── repr ─────────────────────────────────────────────────────────────────────

// A string as Python's repr() writes it: single quotes unless the text holds one and no double quote.
export function py_str_repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\\") body += "\\\\";
    else if (character === quote) body += `\\${quote}`;
    else if (character === "\n") body += "\\n";
    else if (character === "\r") body += "\\r";
    else if (character === "\t") body += "\\t";
    else if (code < 0x20 || code === 0x7f) body += `\\x${code.toString(16).padStart(2, "0")}`;
    else body += character;
  }
  return quote + body + quote;
}

// A float as Python's str() writes it, keeping ".0" on a whole number.
export function py_float(value: number): string {
  if (Number.isInteger(value)) return `${value}.0`;
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  return String(value);
}

// Any JSON-like value as Python's repr() writes it; numbers print as JavaScript does, so whole floats lose ".0".
export function py_repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return py_str_repr(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(py_repr).join(", ")}]`;
  if (value instanceof Set) return value.size === 0 ? "set()" : `{${[...value].map(py_repr).join(", ")}}`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${py_str_repr(key)}: ${py_repr(item)}`).join(", ")}}`;
  }
  return String(value);
}

// ── json.dumps ───────────────────────────────────────────────────────────────

function json_string(text: string): string {
  let body = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === '"') body += '\\"';
    else if (character === "\\") body += "\\\\";
    else if (character === "\n") body += "\\n";
    else if (character === "\r") body += "\\r";
    else if (character === "\t") body += "\\t";
    else if (character === "\b") body += "\\b";
    else if (character === "\f") body += "\\f";
    else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const offset = code - 0x10000;
        body += `\\u${(0xd800 + (offset >> 10)).toString(16).padStart(4, "0")}\\u${(0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, "0")}`;
      } else {
        body += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else body += character;
  }
  return `"${body}"`;
}

// A value as Python's json.dumps() writes it by default: ", " and ": " separators and non-ASCII escaped.
export function json_dumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return json_string(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : value > 0 ? "Infinity" : Number.isNaN(value) ? "NaN" : "-Infinity";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(json_dumps).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries.map(([key, item]) => `${json_string(key)}: ${json_dumps(item)}`).join(", ")}}`;
  }
  return "null";
}
