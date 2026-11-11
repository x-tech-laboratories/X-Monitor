// Signing in to the dashboard and API through the standard accounts: users and sessions in the state database, the
// accounts file's users and config's `auth.username` as admins, tokens made on the account page or declared in
// `auth.tokens`, and optional single sign-on or a trusted proxy. With no user anywhere, X-Monitor stays open as it
// always has, and only push tokens mean anything.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { register_accounts, type Need, type ProxySignIn, type Viewer } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import type { OidcClient } from "@x-tech-laboratories/x-libs/server/oidc";
import { account_name_pattern, hash_password, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { create_logger_for } from "../core/logging.ts";
import { api, is_read_only } from "./api_spec.ts";
import { ROLES, build_tokens, type ApiToken } from "./tokens.ts";

const log = create_logger_for("x_monitor.core.ui.auth");

// ── Settings ─────────────────────────────────────────────────────────────────

export const COOKIE_NAME = "x_monitor_session";
export const DEFAULT_SESSION_HOURS = 12;
export const DEFAULT_REMEMBER_DAYS = 30;

// Reached without signing in: the push routes check their own per-monitor or push token.
export const OPEN_PREFIXES = ["/api/push/"];
// The agent socket authenticates itself, and the page's icon draws on the sign-in page.
export const OPEN_PATHS = ["/api/agent/ws", "/icon.svg", "/favicon.ico"];

// The resolved `auth:` block: one admin from config, and the session policy.
export interface AuthConfig {
  username: string | null;
  password: string | null;
  session_seconds: number;
  remember_seconds: number;
}

// ── Reading the auth block ───────────────────────────────────────────────────

// The key from the auth block, or its `<key>_file`'s trimmed contents.
function read_value(settings: Record<string, unknown>, key: string): string | null {
  if (settings[key] !== undefined && settings[key] !== null) return String(settings[key]);
  const path = settings[`${key}_file`];
  if (!path) return null;
  try {
    return readFileSync(String(path), "utf8").trim();
  } catch (error) {
    log.error(`auth: could not read ${key}_file ${String(path)}: ${(error as Error).message}`);
    return null;
  }
}

function read_int(settings: Record<string, unknown>, key: string, fallback: number): number {
  const raw = settings[key] ?? fallback;
  const value = typeof raw === "number" ? Math.trunc(raw) : /^\s*[-+]?\d+\s*$/.test(String(raw)) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) {
    log.warn(`auth: invalid ${key}=${JSON.stringify(raw)}; falling back to ${fallback}`);
    return fallback;
  }
  if (value <= 0) {
    log.warn(`auth: ${key} must be positive (got ${value}); falling back to ${fallback}`);
    return fallback;
  }
  return value;
}

// The auth block resolved; a half-configured account is reported and left out.
export function build_config(auth_settings: Record<string, unknown> | null | undefined): AuthConfig {
  const settings = auth_settings ?? {};
  let username = read_value(settings, "username");
  let password = read_value(settings, "password");
  if ((username || password) && !(username && password)) {
    log.error("auth: both 'username' and 'password'/'password_file' must be set — that account is NOT enabled.");
    username = null;
    password = null;
  }
  if (settings.session_secret !== undefined || settings.session_secret_file !== undefined) {
    log.info("auth: session_secret is no longer used; sessions are kept in the state database.");
  }
  return {
    username: username || null,
    password: password || null,
    session_seconds: read_int(settings, "session_hours", DEFAULT_SESSION_HOURS) * 3600,
    remember_seconds: read_int(settings, "remember_days", DEFAULT_REMEMBER_DAYS) * 86400,
  };
}

// The admins: the accounts file's, plus config's username with its password hashed, which keeps a lowercase name.
export function declared_admins(config: AuthConfig, accounts_file: Accounts): Accounts {
  const declared = new Map(accounts_file);
  if (config.username && config.password) {
    const name = config.username.trim().toLowerCase();
    if (!account_name_pattern.test(name)) {
      log.error(`auth: username ${JSON.stringify(config.username)} must be lowercase letters, digits, '.', '_' or '-'; that account is NOT enabled.`);
    } else if (!declared.has(name)) {
      declared.set(name, hash_password(config.password));
    }
  }
  return declared;
}

// ── Who is asking ────────────────────────────────────────────────────────────

// Who made a request, for the audit trail: an account name, `token '<name>'`, or null when sign-in is off.
export function acting_client(request: FastifyRequest): string | null {
  const viewer = (request as FastifyRequest & { viewer?: Viewer | null }).viewer ?? null;
  if (viewer === null) return null;
  if (viewer.declared) return `token '${viewer.name}'`;
  if (viewer.via === "token") return `${viewer.name}'s token`;
  return viewer.name;
}

// ── Registration ─────────────────────────────────────────────────────────────

export interface AuthOptions {
  database: SqlDatabase;
  auth_settings: Record<string, unknown> | null | undefined;
  // The accounts file's users, from X_MONITOR_PASSWORD_HASH_FILE.
  accounts_file?: Accounts;
  oidc?: OidcClient | null;
  proxy?: ProxySignIn | null;
  // Paths beside OPEN_PATHS reached without signing in.
  open_paths?: string[];
}

export interface Auth {
  // The account store, or null when sign-in is off.
  accounts: AccountStore | null;
  tokens: ApiToken[];
  // Replaces the declared tokens after a config reload.
  reload(auth_settings: Record<string, unknown> | null | undefined): void;
}

// What an app route needs: reads anyone signed in, state backups and their schedule an admin, any other write an operator.
export function needed(method: string, path: string): Need {
  if (path.startsWith("/api/ui-settings")) return "any";
  // The MCP route checks each tool against the caller's role itself.
  if (path === "/api/mcp") return "any";
  if (path.startsWith("/api/call/") && is_read_only(path.slice("/api/call/".length))) return "any";
  if (path.startsWith("/api/state-backups") && method !== "GET") return { role: "admin" };
  if (method === "GET" || method === "HEAD") return "any";
  return { role: "operator" };
}

export async function register_auth(app: FastifyInstance, options: AuthOptions): Promise<Auth> {
  const config = build_config(options.auth_settings);
  const declared = declared_admins(config, options.accounts_file ?? new Map());
  const tokens = build_tokens(options.auth_settings);
  const accounts = new AccountStore({
    database: options.database, app_name: "X-Monitor", roles: ROLES, declared, token_prefix: "xm",
    declared_tokens: tokens.filter((token) => token.role !== null),
  });
  const reload = (auth_settings: Record<string, unknown> | null | undefined) => {
    const fresh = build_tokens(auth_settings);
    result.tokens = fresh;
    accounts.set_declared_tokens(fresh.filter((token) => token.role !== null));
  };
  const result: Auth = { accounts, tokens, reload };

  // Nobody to sign in as: the dashboard and API stay open, as they were before any auth was configured.
  if (accounts.users().length === 0 && options.oidc == null && options.proxy == null) {
    if (tokens.some((token) => token.scope !== "push")) {
      log.warn("auth: read and control tokens have no effect without a user (auth.username and auth.password, or the accounts file) — the dashboard and API are open to anyone.");
    }
    register_open_routes(app);
    result.accounts = null;
    return result;
  }

  await register_accounts(app, {
    accounts, cookie_name: COOKIE_NAME, oidc: options.oidc ?? null, proxy: options.proxy ?? null,
    open_paths: [...OPEN_PATHS, ...(options.open_paths ?? [])], open_prefixes: OPEN_PREFIXES,
    guarded_paths: ["/metrics"], read_only_paths: ["/api/mcp", ...Object.keys(api).filter(is_read_only).map((method) => `/api/call/${method}`)], needed,
    session_seconds: config.session_seconds, remembered_seconds: config.remember_seconds,
  });

  // Reads are logged quietly, since a scraper makes one every few seconds.
  app.addHook("onRequest", async (request) => {
    const viewer = request.viewer;
    if (viewer?.via !== "token") return;
    const line = `auth: ${acting_client(request)} ${request.method} ${request.url.split("?")[0]}`;
    if (request.method === "GET" || request.method === "HEAD") log.debug(line);
    else log.info(line);
  });
  log.info(`auth: sign-in enabled for the dashboard and API, with ${tokens.length} API token(s) from config`);
  return result;
}

// Without sign-in, the page still learns who it is: everyone, as an admin.
function register_open_routes(app: FastifyInstance): void {
  app.get("/api/auth/info", async () => ({ app_name: "X-Monitor", oidc: null, open: true }));
  app.get("/api/me", async () => ({
    name: "", role: "admin", access: null, via: "open", read_only: false, roles: ROLES, totp_enabled: false, source: "open", has_password: false,
  }));
}
