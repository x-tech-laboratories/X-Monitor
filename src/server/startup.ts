// The answer every HTTP request gets while the engine is still loading its saved state, in place of a proxy's Bad
// Gateway: a page that reloads itself for browsers, and JSON for the API and exporters.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { FastifyInstance } from "fastify";

// ── Settings ─────────────────────────────────────────────────────────────────

// Seconds a browser or client waits before asking again.
export const RETRY_AFTER = 5;

const PASS_THROUGH = ["/icon.svg", "/favicon.ico"];
const MACHINE_PATHS = ["/api/", "/metrics"];

function tokens_css(): string {
  try {
    return readFileSync(createRequire(import.meta.url).resolve("@x-tech-laboratories/halon/halon-tokens.css"), "utf8");
  } catch {
    return "";
  }
}

// Plain HTML, since nothing behind the dashboard is up yet; the colors come from the same Halon token sheet.
export const STARTING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_AFTER}">
<title>X-Monitor starting</title>
<link rel="icon" href="/icon.svg">
<style>
${tokens_css()}
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: var(--space-6);
         background: var(--surface-root); color: var(--text-body);
         font-family: var(--font-family-interface); font-size: var(--text-prose); line-height: var(--line-height-body); }
  main { max-width: 28rem; text-align: center; }
  img { display: block; margin: 0 auto var(--space-5); }
  h1 { font-size: var(--text-h2); font-weight: 600; color: var(--text-heading); margin: 0 0 var(--space-4); }
  p { margin: 0; color: var(--text-secondary); }
</style>
</head>
<body>
<main>
<img src="/icon.svg" alt="" width="64" height="64">
<h1>X-Monitor is starting</h1>
<p>Loading saved history. This page reloads by itself.</p>
</main>
</body>
</html>
`;

// ── Hook ─────────────────────────────────────────────────────────────────────

// Answers 503 until `is_ready()`, ahead of every other hook, sign-in included.
export function register_starting_page(app: FastifyInstance, is_ready: () => boolean): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (is_ready() || PASS_THROUGH.some((prefix) => path.startsWith(prefix))) return;
    reply.header("Retry-After", String(RETRY_AFTER));
    if (MACHINE_PATHS.some((prefix) => path.startsWith(prefix))) return reply.code(503).send({ status: "starting" });
    return reply.code(503).type("text/html; charset=utf-8").send(STARTING_PAGE);
  });
}
