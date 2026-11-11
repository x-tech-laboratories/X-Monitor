import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generate_agent_key } from "@x-tech-laboratories/x-libs/agent/keys";
import { describe, expect, it } from "vitest";

import { load_config } from "../../src/agent/config.ts";
import { load_public_key, new_nonce, sign, verify } from "../../src/agent/keys.ts";

// The OpenSSH key library X-Libs uses, for making a key of another type.
const sshpk = createRequire(import.meta.url)("sshpk") as { generatePrivateKey(type: string): { toString(format: string): string } };

function folder(): string {
  return mkdtempSync(join(tmpdir(), "x-monitor-agent-"));
}

function key_file(where: string): [path: string, public_line: string] {
  const key = generate_agent_key("node-a");
  const path = join(where, "key");
  writeFileSync(path, key.private_text);
  return [path, key.public_line];
}

function config_file(where: string, text: string): string {
  const path = join(where, "agent.yaml");
  writeFileSync(path, text);
  return path;
}

describe("the agent's config", () => {
  it("loads its key file", () => {
    const where = folder();
    const [path, public_line] = key_file(where);
    const config = load_config(config_file(where, `url: ws://localhost/api/agent/ws\nid: node-a\nkey_file: ${path}\n`), {});
    const nonce = new_nonce();
    expect(verify(load_public_key(public_line), "node-a", nonce, sign(config.key, "node-a", nonce))).toBe(true);
  });

  it("fails loudly on an unreadable key file", () => {
    const where = folder();
    expect(() => load_config(config_file(where, `url: ws://localhost/api/agent/ws\nid: node-a\nkey_file: ${where}/missing\n`), {})).toThrow(/key_file/);
  });

  it("fails loudly on a key that is not ed25519", () => {
    const where = folder();
    const path = join(where, "key");
    writeFileSync(path, sshpk.generatePrivateKey("ecdsa").toString("ssh"));
    expect(() => load_config(config_file(where, `url: ws://localhost/api/agent/ws\nid: node-a\nkey_file: ${path}\n`), {})).toThrow(/ed25519/);
  });

  it("takes the key file from the environment", () => {
    const where = folder();
    const [path] = key_file(where);
    expect(load_config(config_file(where, "url: ws://localhost/api/agent/ws\nid: node-a\n"), { XMONITOR_AGENT_KEY_FILE: path }).key).toBeTruthy();
  });

  it("names every missing setting", () => {
    const where = folder();
    expect(() => load_config(config_file(where, "url: ws://localhost\n"), {})).toThrow("missing required setting(s): id, key_file");
  });

  it("refuses a config file named but not there", () => {
    expect(() => load_config(join(folder(), "nope.yaml"), {})).toThrow(/config file not found/);
  });

  it("reads notify_only from the file and the environment", () => {
    const where = folder();
    const [path] = key_file(where);
    const file = config_file(where, `url: ws://v\nid: desk\nkey_file: ${path}\nnotify_only: true\n`);
    expect(load_config(file, {}).notify_only).toBe(true);
    expect(load_config(file, { XMONITOR_AGENT_NOTIFY_ONLY: "false" }).notify_only).toBe(false);
  });
});

describe("the login signature", () => {
  it("verifies against its own nonce", () => {
    const key = generate_agent_key("a");
    const where = folder();
    writeFileSync(join(where, "k"), key.private_text);
    const config = load_config(config_file(where, `url: ws://v\nid: node-a\nkey_file: ${join(where, "k")}\n`), {});
    const nonce = new_nonce();
    const signature = sign(config.key, "node-a", nonce);
    expect(verify(load_public_key(key.public_line), "node-a", nonce, signature)).toBe(true);
    expect(verify(load_public_key(key.public_line), "node-a", new_nonce(), signature)).toBe(false);
    expect(verify(load_public_key(key.public_line), "node-b", nonce, signature)).toBe(false);
    expect(verify(load_public_key(key.public_line), "node-a", nonce, "not base64!")).toBe(false);
    expect(verify(null, "node-a", nonce, "AAAA")).toBe(false);
  });
});
