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
