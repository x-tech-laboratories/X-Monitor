// Python's conversions and text forms where X-Monitor's messages and config parsing depend on them: int() and float()
// of a config value, repr() and type names in warnings, and difflib's close matches for a mistyped section.

// ── Conversions ──────────────────────────────────────────────────────────────

const float_text = /^[+-]?(?:(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*\.|inf|infinity|nan)$/i;

// The value as Python's float() reads it, throwing where float() raises.
export function python_float(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const text = value.trim();
    if (float_text.test(text)) {
      const lowered = text.toLowerCase().replace(/^[+]/, "");
      if (lowered.endsWith("nan")) return Number.NaN;
      if (lowered.endsWith("inf") || lowered.endsWith("infinity")) return lowered.startsWith("-") ? -Infinity : Infinity;
      return Number(text.replaceAll("_", ""));
    }
  }
  throw new TypeError(`could not convert ${python_repr(value)} to float`);
}

// The value as Python's int() reads it, throwing where int() raises.
export function python_int(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`cannot convert ${python_repr(value)} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^[+-]?\d[\d_]*$/.test(value.trim())) return Number(value.trim().replaceAll("_", ""));
  throw new TypeError(`invalid literal for int(): ${python_repr(value)}`);
}

// ── Text forms ───────────────────────────────────────────────────────────────

// The name Python's type(value).__name__ gives the value parsed from YAML.
export function python_type_name(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  if (value instanceof Date) return "datetime";
  return "dict";
}

// The value as Python's repr() writes it.
export function python_repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\r", "\\r");
    return quote + (quote === "'" ? escaped.replaceAll("'", "\\'") : escaped) + quote;
  }
  if (Array.isArray(value)) return `[${value.map(python_repr).join(", ")}]`;
  if (value instanceof Date) return `datetime(${value.toISOString()})`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, entry]) => `${python_repr(key)}: ${python_repr(entry)}`).join(", ")}}`;
  }
  return String(value);
}

// ── Close matches ────────────────────────────────────────────────────────────

// The characters two strings share in order, as difflib's SequenceMatcher counts them through its matching blocks.
function matching_characters(first: string, second: string): number {
  let total = 0;
  const pending: [number, number, number, number][] = [[0, first.length, 0, second.length]];
  while (pending.length > 0) {
    const [first_low, first_high, second_low, second_high] = pending.pop()!;
    let best_first = first_low;
    let best_second = second_low;
    let best_size = 0;
    for (let first_index = first_low; first_index < first_high; first_index++) {
      for (let second_index = second_low; second_index < second_high; second_index++) {
        let size = 0;
        while (first_index + size < first_high && second_index + size < second_high && first[first_index + size] === second[second_index + size]) size++;
        if (size > best_size) {
          best_first = first_index;
          best_second = second_index;
          best_size = size;
        }
      }
    }
    if (best_size === 0) continue;
    total += best_size;
    pending.push([first_low, best_first, second_low, best_second]);
    pending.push([best_first + best_size, first_high, best_second + best_size, second_high]);
  }
  return total;
}

// SequenceMatcher(None, first, second).ratio().
export function similarity_ratio(first: string, second: string): number {
  const length = first.length + second.length;
  return length === 0 ? 1 : (2 * matching_characters(first, second)) / length;
}

// difflib.get_close_matches: the best `count` candidates scoring at least `cutoff`, best first.
export function close_matches(word: string, candidates: Iterable<string>, count = 3, cutoff = 0.6): string[] {
  const scored: [number, string][] = [];
  for (const candidate of candidates) {
    const score = similarity_ratio(candidate, word);
    if (score >= cutoff) scored.push([score, candidate]);
  }
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  return scored.slice(0, count).map(([, candidate]) => candidate);
}
