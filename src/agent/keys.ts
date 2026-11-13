// Agent authentication by ed25519 key. The agent holds a private key and the server only the matching public key, so
// the server keeps no secret that could impersonate an agent. On each connection the server sends a fresh nonce and the
// agent signs it; X-Libs' challenge binds the signature to X-Monitor and the agent's id, so a signature made for
// anything else never verifies here.

import { randomBytes, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import { parse_private_key, parse_public_key, sign_challenge, verify_challenge } from "@x-tech-laboratories/x-libs/agent/keys";

import { agent_app } from "../shared/agent_protocol.ts";

export const NONCE_BYTES = 32;

// A fresh random nonce, base64-encoded for the challenge.
export function new_nonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64");
}

// Reads an unencrypted OpenSSH ed25519 private key, as `ssh-keygen -t ed25519 -N ""` writes; throws naming what is wrong.
export function load_private_key(path: string): KeyObject {
  return parse_private_key(readFileSync(path, "utf8"));
}

// Parses a one-line OpenSSH ed25519 public key, such as `ssh-ed25519 AAAA... comment`.
export function load_public_key(line: string): KeyObject {
  return parse_public_key(line);
}

// The agent's base64 signature over one challenge.
export function sign(key: KeyObject, agent_id: string, nonce: string): string {
  return sign_challenge(key, agent_app.name, agent_id, nonce);
}

// Whether `signature` is this agent's signature over `nonce`.
export function verify(key: KeyObject | null, agent_id: string, nonce: string, signature: string): boolean {
  if (key === null || !signature) return false;
  return verify_challenge(key, agent_app.name, agent_id, nonce, signature);
}
