// Named API tokens declared in config, one bearer credential per client, each with a scope:
//
// - read: reads the API and /metrics, as the viewer role.
// - control: everything read allows plus the API's write routes (poll now, run an action, send a test notification),
//   as the operator role.
// - push: the push endpoint, for every push monitor or only those listed under `monitors`; it signs nothing else in.
//
// A client sends `Authorization: Bearer <token>`. Only a SHA-256 digest of each token is kept; the tokens are 256-bit
// random values, so a fast unsalted hash is enough. Tokens made on the account page work beside these.

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  bearer_of, match_declared_token, new_declared_token, read_declared_tokens, token_hash, type DeclaredToken, type ScopeSpec,
} from "@x-tech-laboratories/x-libs/server/declared_tokens";

import { create_logger_for } from "../core/logging.ts";

const log = create_logger_for("x_monitor.core.ui.tokens");

// ── Scopes ───────────────────────────────────────────────────────────────────

export const SCOPES = ["read", "control", "push"] as const;
export type Scope = (typeof SCOPES)[number];

// The account roles, least able first; viewer is the read scope's and operator the control scope's.
export const ROLES = ["viewer", "operator", "admin"] as const;

export const SCOPE_SPECS: Record<Scope, ScopeSpec> = {
  read: { role: "viewer", read_only: true },
  control: { role: "operator", read_only: false },
  push: { role: null, read_only: false, limitable: true },
};

export const TOKEN_PREFIX = "vgl_";

export type ApiToken = DeclaredToken;

// ── Tokens ───────────────────────────────────────────────────────────────────

// A fresh random token, prefixed so a secret scanner can recognise a leaked one.
export function new_token(): string {
  return new_declared_token(TOKEN_PREFIX);
}

// The `token_hash` value to put in config for this token.
export function hash_token(token: string): string {
  return token_hash(token);
}

// The token in an `Authorization: Bearer` header, or null for any other header.
export function bearer_token(header_value: string | null | undefined): string | null {
  return bearer_of(header_value ?? undefined);
}

// Resolves `auth.tokens`, skipping and logging any entry that is not usable.
export function build_tokens(auth_settings: Record<string, unknown> | null | undefined): ApiToken[] {
  return read_declared_tokens((auth_settings ?? {}).tokens ?? [], {
    scopes: SCOPE_SPECS, limit_key: "monitors", new_token_command: "x-monitor token new",
    warn: (message) => log.warn(`auth: ${message}`),
    error: (message) => log.error(`auth: ${message.replace("the token list", "auth.tokens")}`),
  });
}

// The token whose digest matches the presented one, checking all of them so timing reveals nothing.
export function match_token(tokens: readonly ApiToken[], presented: string | null | undefined): ApiToken | null {
  return match_declared_token(tokens, presented);
}

// Whether this token may push heartbeats for this monitor.
export function covers_monitor(token: ApiToken, monitor_id: string): boolean {
  if (token.scope !== "push") return false;
  return token.limited_to === null || token.limited_to.includes(monitor_id);
}

// ── Config ───────────────────────────────────────────────────────────────────

// The `auth.tokens` entry to paste into config.yaml for a minted token; JSON strings and lists are valid YAML.
export function config_snippet(name: string, hash: string, scope: string, monitors: string[] | null = null): string {
  const lines = [
    "auth:",
    "  tokens:",
    `    - name: ${JSON.stringify(name)}`,
    `      scope: ${scope}`,
    `      token_hash: ${JSON.stringify(hash)}`,
  ];
  if (monitors && monitors.length > 0) lines.push(`      monitors: ${JSON.stringify(monitors)}`);
  return lines.join("\n");
}
