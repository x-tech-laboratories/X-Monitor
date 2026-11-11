// A fingerprint of the X-Monitor code a process runs, so the server and an agent can tell whether they run the same
// monitors: a short hash over every source file an agent carries, equal on two hosts exactly when that code is.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The folders under src/ an agent carries; the server's own and the page's code do not change what an agent runs.
const packages = ["agent", "core", "monitors", "shared"];

let cached: string | null = null;

function source_files(folder: string): string[] {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return source_files(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

export function code_version(): string {
  if (cached !== null) return cached;
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const digest = createHash("sha256");
  for (const name of packages) {
    for (const path of source_files(join(root, name)).sort()) {
      digest.update(relative(dirname(root), path).split("\\").join("/"));
      digest.update("\0");
      digest.update(readFileSync(path));
      digest.update("\0");
    }
  }
  cached = digest.digest("hex").slice(0, 16);
  return cached;
}
