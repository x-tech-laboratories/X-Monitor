// Text parsing that behaves as the Python builtins the monitors were written against: str.splitlines(), str.split(),
// int() and float(), each throwing where Python raised ValueError, so a parser keeps its error branches.

// ── Splitting ────────────────────────────────────────────────────────────────

// Lines as Python's str.splitlines() gives them: no line endings, and no empty last line after a final newline.
export function split_lines(text: string): string[] {
  if (text === "") return [];
  // oxlint-disable-next-line no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Words as Python's str.split() with no separator gives them; with `max_split`, the rest stays whole in the last word.
export function split_words(text: string, max_split = -1): string[] {
  if (max_split < 0) return text.split(/\s+/).filter((word) => word !== "");
  const words: string[] = [];
  let rest = text.replace(/^\s+/, "");
  while (rest !== "" && words.length < max_split) {
    const match = /\s+/.exec(rest);
    if (match === null) break;
    words.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest !== "") words.push(words.length < max_split ? rest.replace(/\s+$/, "") : rest);
  return words;
}

// Python's str.partition: the text before the first separator, the separator, and the rest.
export function partition(text: string, separator: string): [before: string, found: string, after: string] {
  const index = text.indexOf(separator);
  if (index === -1) return [text, "", ""];
  return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

// ── Numbers ──────────────────────────────────────────────────────────────────

// A whole number as Python's int() reads text, throwing on anything else.
export function parse_int(text: unknown): number {
  if (typeof text === "number") {
    if (!Number.isFinite(text)) throw new Error(`cannot convert float ${text} to integer`);
    return Math.trunc(text);
  }
  const value = String(text);
  if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) throw new Error(`invalid literal for int() with base 10: '${value}'`);
  return Number(value.trim().replaceAll("_", ""));
}

// A number as Python's float() reads text, throwing on anything else.
export function parse_float(text: unknown): number {
  if (typeof text === "number") return text;
  const value = String(text);
  const trimmed = value.trim();
  if (/^[+-]?(inf|infinity)$/i.test(trimmed)) return trimmed.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(trimmed)) return Number.NaN;
  if (!/^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+)?$/.test(trimmed)) {
    throw new Error(`could not convert string to float: '${value}'`);
  }
  return Number(trimmed.replaceAll("_", ""));
}

// Python's int(), or null where it would raise.
export function int_or_null(text: unknown): number | null {
  try {
    return parse_int(text);
  } catch {
    return null;
  }
}

// Python's float(), or null where it would raise.
export function float_or_null(text: unknown): number | null {
  try {
    return parse_float(text);
  } catch {
    return null;
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

// A number with fixed decimals as Python's "{:.Nf}" writes it, rounding an exact tie to even where toFixed rounds up.
export function format_fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "inf" : value < 0 ? "-inf" : "nan";
  const exact = Math.abs(value).toFixed(Math.min(100, digits + 40));
  const point = exact.indexOf(".");
  const tail = exact.slice(point + 1 + digits);
  if (!/^50*$/.test(tail)) return value.toFixed(digits);
  const kept = exact.slice(0, point + 1 + digits).replace(/\.$/, "");
  const last_digit = Number(kept.replace(".", "").slice(-1));
  if (last_digit % 2 === 0) return (value < 0 ? "-" : "") + kept;
  return value.toFixed(digits);
}

// A number as Python's "{:,.Nf}" writes it: fixed decimals with commas between thousands.
export function format_grouped(value: number, digits: number): string {
  const text = format_fixed(value, digits);
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

// ── Globs ────────────────────────────────────────────────────────────────────

// Whether a name matches a shell-style pattern as Python's fnmatch.fnmatch does on POSIX: *, ?, [seq] and [!seq],
// case-sensitive, the whole name.
export function fnmatch(name: string, pattern: string): boolean {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index++];
    if (character === "*") source += "[\\s\\S]*";
    else if (character === "?") source += "[\\s\\S]";
    else if (character === "[") {
      let end = index;
      if (end < pattern.length && pattern[end] === "!") end++;
      if (end < pattern.length && pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end >= pattern.length) {
        source += "\\[";
      } else {
        let set = pattern.slice(index, end).replaceAll("\\", "\\\\");
        index = end + 1;
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        else if (set.startsWith("^")) set = `\\${set}`;
        source += `[${set}]`;
      }
    } else source += character.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${source})$`).test(name);
}

// A number rounded as Python's round(value, digits) does, an exact tie going to even.
export function round_half_even(value: number, digits = 0): number {
  return Number(format_fixed(value, digits));
}
