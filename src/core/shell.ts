// Shell quoting for the command lines monitors build, matching Python's shlex.quote and shlex.split.

const safe_word = /^[\w@%+=:,./-]+$/;

// The text as one shell word.
export function shell_quote(text: string): string {
  if (text === "") return "''";
  if (safe_word.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function shell_join(words: readonly string[]): string {
  return words.map(shell_quote).join(" ");
}

// Splits a command line into words as a POSIX shell would, without expanding anything.
export function shell_split(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let in_word = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) throw new Error("No closing quotation");
      word += text.slice(index + 1, end);
      in_word = true;
      index = end + 1;
    } else if (character === '"') {
      index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length && '"\\$`\n'.includes(text[index + 1])) index++;
        word += text[index++];
      }
      if (index >= text.length) throw new Error("No closing quotation");
      in_word = true;
      index++;
    } else if (character === "\\") {
      if (index + 1 < text.length) word += text[index + 1];
      in_word = true;
      index += 2;
    } else if (/\s/.test(character)) {
      if (in_word) words.push(word);
      word = "";
      in_word = false;
      index++;
    } else {
      word += character;
      in_word = true;
      index++;
    }
  }
  if (in_word) words.push(word);
  return words;
}
