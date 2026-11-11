import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

// The packages only the server or the page install: the dashboard, its web stack and the server's extras. The X-Libs
// agent hub is plain Node, and the engine the agent runs its monitors with holds one.
const SERVER_ONLY = [/^react(-dom)?(\/|$)/, /^fastify(\/|$)/, /^@fastify\//, /^@x-tech-laboratories\/x-libs\/(server\/(?!agents\/(hub|connection|agent)$)|web\/)/, /^@x-tech-laboratories\/halon/];

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Every module specifier a file imports, statically or by a literal dynamic import.
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const pattern = /(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

// Every file the agent reaches through relative imports, with each package it names.
function reach(entries: string[]): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (existsSync(target)) queue.push(target);
      } else {
        packages.set(specifier, relative(ROOT, file));
      }
    }
  }
  return { files, packages };
}

describe("the agent", () => {
  it("imports nothing from the server, the page, React or Fastify", () => {
    const { files, packages } = reach(sources(join(ROOT, "src/agent")));
    const reached = [...files].map((file) => relative(ROOT, file));
    expect(reached.filter((file) => file.startsWith("src/server/") || file.startsWith("src/web/"))).toEqual([]);
    expect([...packages].filter(([name]) => SERVER_ONLY.some((each) => each.test(name)))).toEqual([]);
    expect(reached).toContain("src/agent/main.ts");
  });
});
