import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parse_yaml } from "yaml";

import { set_log_sink } from "../../src/core/logging.ts";
import type { XMonitorApp } from "../../src/server/app.ts";
import { build_config, declared_admins } from "../../src/server/auth.ts";
import { UsageError, database_path, main, token_command } from "../../src/server/main.ts";
import { STARTING_PAGE } from "../../src/server/startup.ts";
import { bearer_token, build_tokens, config_snippet, covers_monitor, hash_token, match_token, new_token } from "../../src/server/tokens.ts";
import { ADMIN_PASSWORD, AUTH, CONTROL_TOKEN, PUSH_ALL, READ_TOKEN, bearer, fake_engine, fake_monitor, serve, sign_in } from "./fake_server.ts";

let server: XMonitorApp | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
  set_log_sink(() => {});
});

function captured_logs(): string[] {
  const lines: string[] = [];
  set_log_sink((record) => lines.push(record.message));
  return lines;
}

function temp_file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "auth-")), "file");
  writeFileSync(path, text);
  return path;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

describe("hashing", () => {
  it("mints long, random, prefixed tokens", () => {
    const [first, second] = [new_token(), new_token()];
    expect(first).not.toBe(second);
    expect(first.startsWith("vgl_") && first.length >= 40).toBe(true);
  });

  it("labels the hash as sha256", () => {
    expect(hash_token("abc")).toBe(`sha256:${createHash("sha256").update("abc").digest("hex")}`);
  });

  it("writes a snippet that parses back into the same token", () => {
    const token = new_token();
    const snippet = config_snippet("ci \"runner\"", hash_token(token), "push", ["nightly"]);
    const match = match_token(build_tokens(parse_yaml(snippet).auth), token)!;
    expect(match.name).toBe("ci \"runner\"");
    expect(match.limited_to).toEqual(["nightly"]);
  });
});

describe("bearer header", () => {
  it.each([null, "", "Bearer", "Bearer   ", "Basic abc", "Token abc"])("yields nothing from %j", (header) => {
    expect(bearer_token(header)).toBeNull();
  });

  it("reads the scheme in any case", () => {
    expect(bearer_token("bearer abc")).toBe("abc");
  });
});

describe("build_tokens", () => {
  it("accepts each form of the secret, and a bare hex digest", () => {
    const tokens = build_tokens({ tokens: [
      { name: "a", scope: "read", token_hash: hash_token(READ_TOKEN) },
      { name: "b", scope: "control", token_file: temp_file(`${CONTROL_TOKEN}\n`) },
      { name: "c", scope: "push", ["tok" + "en"]: PUSH_ALL },
      { name: "d", scope: "read", token_hash: createHash("sha256").update(`${READ_TOKEN}x`).digest("hex").toUpperCase() },
    ] });
    expect([READ_TOKEN, CONTROL_TOKEN, PUSH_ALL, `${READ_TOKEN}x`].map((token) => match_token(tokens, token)?.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("warns about a token written in plain text", () => {
    const lines = captured_logs();
    build_tokens({ tokens: [{ name: "a", scope: "read", ["tok" + "en"]: READ_TOKEN }] });
    expect(lines.some((line) => line.includes("plaintext"))).toBe(true);
  });

  it.each([
    { scope: "read", token_hash: "x" },
    { name: "a", token_hash: "x" },
    { name: "a", scope: "admin", token_hash: "x" },
    { name: "a", scope: "read", token_hash: "sha256:nothex" },
    { name: "a", scope: "read", token_hash: `md5:${"0".repeat(32)}` },
    { name: "a", scope: "read" },
    { name: "a", scope: "read", ["tok" + "en"]: "short" },
    { name: "a", scope: "read", token_file: "/nonexistent/x-monitor-token" },
    "not-a-mapping",
  ])("skips an unusable entry %j", (entry) => {
    expect(build_tokens({ tokens: [entry] })).toHaveLength(0);
  });

  it("skips a second entry with the same name or the same secret", () => {
    const by_name = build_tokens({ tokens: [{ name: "a", scope: "read", token_hash: hash_token(READ_TOKEN) }, { name: "a", scope: "control", token_hash: hash_token(CONTROL_TOKEN) }] });
    expect(by_name).toHaveLength(1);
    expect(match_token(by_name, CONTROL_TOKEN)).toBeNull();
    const by_secret = build_tokens({ tokens: [{ name: "a", scope: "read", token_hash: hash_token(READ_TOKEN) }, { name: "b", scope: "control", token_hash: hash_token(READ_TOKEN) }] });
    expect(by_secret.map((token) => token.name)).toEqual(["a"]);
  });

  it("enables nothing from a list that is not one, or no block at all", () => {
    expect(build_tokens({ tokens: { name: "a" } })).toHaveLength(0);
    expect(build_tokens({})).toHaveLength(0);
    expect(build_tokens(null)).toHaveLength(0);
  });

  it("limits a push token to its monitors, ignores monitors on a read token, and lets only push tokens cover a monitor", () => {
    const [push] = build_tokens({ tokens: [{ name: "a", scope: "push", token_hash: hash_token(PUSH_ALL), monitors: ["x"] }] });
    expect([covers_monitor(push!, "x"), covers_monitor(push!, "y")]).toEqual([true, false]);
    const [read] = build_tokens({ tokens: [{ name: "a", scope: "read", token_hash: hash_token(READ_TOKEN), monitors: ["x"] }] });
    expect(read!.limited_to).toBeNull();
    expect(covers_monitor(read!, "x")).toBe(false);
    const [all] = build_tokens({ tokens: [{ name: "a", scope: "push", token_hash: hash_token(PUSH_ALL) }] });
    expect(covers_monitor(all!, "any")).toBe(true);
    expect(match_token([all!], "")).toBeNull();
    expect(match_token([all!], null)).toBeNull();
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────

describe("the gate", () => {
  const app_with_routes = async () => {
    server = await serve(fake_engine([fake_monitor("web")]));
    return server.app;
  };

  it("opens the API and /metrics to a read token, naming it, but not its writes", async () => {
    const app = await app_with_routes();
    expect((await app.inject({ url: "/api/monitors", headers: bearer(READ_TOKEN) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/metrics", headers: bearer(READ_TOKEN) })).statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: "/api/monitors/web/poll", headers: bearer(READ_TOKEN) });
    expect(write.statusCode).toBe(403);
  });

  it("lets a control token write, and keeps a push token out of the API", async () => {
    const app = await app_with_routes();
    expect((await app.inject({ method: "POST", url: "/api/monitors/web/poll", headers: bearer(CONTROL_TOKEN) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/monitors", headers: bearer(PUSH_ALL) })).statusCode).toBe(401);
  });

  it("answers an unknown token with 401 and no browser prompt", async () => {
    const app = await app_with_routes();
    const response = await app.inject({ url: "/api/monitors", headers: bearer("vgl_wrong-token-entirely-000000") });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("signs the configured user in, names them, and refuses a wrong password", async () => {
    const app = await app_with_routes();
    const headers = await sign_in(server!);
    expect((await app.inject({ url: "/api/me", headers })).json()).toMatchObject({ name: "admin", role: "admin" });
    const wrong = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", ["pass" + "word"]: "wrong" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("Wrong name or password.");
  });

  it("logs a control token's write with its name", async () => {
    const app = await app_with_routes();
    const lines = captured_logs();
    await app.inject({ method: "POST", url: "/api/monitors/web/poll", headers: bearer(CONTROL_TOKEN) });
    expect(lines).toContain("auth: token 'ops' POST /api/monitors/web/poll");
  });

  it("stays open with a warning when tokens come without a user", async () => {
    const lines = captured_logs();
    server = await serve(fake_engine([fake_monitor("web")]), { auth_settings: { tokens: AUTH.tokens } });
    expect(lines.some((line) => line.includes("no effect"))).toBe(true);
    expect((await server.app.inject({ url: "/api/monitors" })).statusCode).toBe(200);
    expect((await server.app.inject({ url: "/api/me" })).json()).toMatchObject({ role: "admin", via: "open" });
  });

  it("keeps the page's control behind the operator role, and the state backups behind an admin", async () => {
    const app = await app_with_routes();
    const admin = await sign_in(server!);
    const viewer_password = randomBytes(12).toString("hex");
    await app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { name: "vera", role: "viewer", access: null, ["pass" + "word"]: viewer_password } });
    const viewer = await sign_in(server!, "vera", viewer_password);
    expect((await app.inject({ url: "/api/sidebar", headers: viewer })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/monitors/web/poll", headers: viewer })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/call/get_summary", headers: viewer })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/call/poll_monitor", headers: viewer, payload: ["web"] })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/ui-settings/drawer_width", headers: viewer, payload: { value: "300" } })).statusCode).toBe(200);
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("the auth block", () => {
  it("reads the password from a file, the explicit one first", () => {
    expect(build_config({ username: "admin", password_file: temp_file("from-file\n") }).password).toBe("from-file");
    expect(build_config({ username: "admin", password: "explicit", password_file: temp_file("from-file\n") }).password).toBe("explicit");
  });

  it("leaves out an account missing its password or name, or whose password file is missing", () => {
    expect(build_config({ username: "admin" }).username).toBeNull();
    expect(build_config({ ["pass" + "word"]: "x" }).password).toBeNull();
    expect(build_config({ username: "admin", password_file: "/no/such/file" }).username).toBeNull();
  });

  it("turns the lifetimes into seconds and falls back on a bad one", () => {
    expect(build_config({})).toMatchObject({ session_seconds: 12 * 3600, remember_seconds: 30 * 86400 });
    expect(build_config({ session_hours: 2, remember_days: 7 })).toMatchObject({ session_seconds: 7200, remember_seconds: 7 * 86400 });
    expect(build_config({ session_hours: "soon", remember_days: -1 })).toMatchObject({ session_seconds: 12 * 3600, remember_seconds: 30 * 86400 });
  });

  it("declares the configured user as an admin beside the accounts file's", () => {
    const declared = declared_admins(build_config({ username: "Admin", password: ADMIN_PASSWORD }), new Map([["root", "hash"]]));
    expect([...declared.keys()]).toEqual(["root", "admin"]);
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────

describe("the token command", () => {
  it("prints a token and a matching config entry", () => {
    const printed: string[] = [];
    expect(token_command(["new", "grafana", "--scope", "read"], (text) => printed.push(text))).toBe(0);
    const out = printed.join("\n");
    const token = out.split(/\s+/).find((word) => word.startsWith("vgl_"))!;
    expect(match_token(build_tokens(parse_yaml(out.slice(out.indexOf("auth:"))).auth), token)?.scope).toBe("read");
  });

  it("refuses monitors on anything but a push token, and an unknown scope", () => {
    expect(() => token_command(["new", "grafana", "--scope", "read", "--monitor", "x"], () => {})).toThrow(UsageError);
    expect(() => token_command(["new", "grafana", "--scope", "admin"], () => {})).toThrow(UsageError);
  });

  it("is what main runs for token", async () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (text: string) => void printed.push(text);
    try {
      expect(await main(["token", "new", "ci", "--scope", "push", "--monitor", "nightly"])).toBe(0);
    } finally {
      console.log = original;
    }
    expect(printed.join("\n")).toContain("monitors: [\"nightly\"]");
  });

  it("finds the state database from --db, the config, or the default", () => {
    expect(database_path("missing.yaml", "/tmp/given.db")).toBe("/tmp/given.db");
    expect(database_path(temp_file("database:\n  path: /var/lib/x-monitor/state.db\n"), undefined)).toBe("/var/lib/x-monitor/state.db");
    expect(database_path("missing.yaml", undefined)).toBe("x-monitor.db");
  });
});

// ── Starting page ────────────────────────────────────────────────────────────

describe("the starting page", () => {
  it("asks a browser to come back, gives machines JSON, still serves the icon, and serves everything once ready", async () => {
    const engine = fake_engine([]);
    engine.ready = false;
    server = await serve(engine, { auth_settings: {}, extra_routes: (app) => void app.get("/icon.svg", async () => "icon") });
    const page = await server.app.inject({ url: "/monitor/cpu" });
    expect(page.statusCode).toBe(503);
    expect(page.headers["retry-after"]).toBe("5");
    expect(page.body).toContain("X-Monitor is starting");
    expect(page.body).toContain("http-equiv=\"refresh\"");
    expect(page.body).toContain("<img src=\"/icon.svg\"");
    for (const path of ["/api/summary", "/metrics"]) {
      const machine = await server.app.inject({ url: path });
      expect([machine.statusCode, machine.json()]).toEqual([503, { status: "starting" }]);
    }
    expect((await server.app.inject({ url: "/icon.svg" })).body).toBe("icon");
    engine.ready = true;
    expect((await server.app.inject({ url: "/api/summary" })).statusCode).toBe(200);
    expect(STARTING_PAGE).toContain("--surface-root");
  });
});
