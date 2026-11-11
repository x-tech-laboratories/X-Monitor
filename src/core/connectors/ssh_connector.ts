// The SSH transport: one lazily dialled, reused connection per target, trust-on-first-use host keys, a bound on the
// channels open to one host, and commands that map every failure to (-1, "", message) instead of throwing.
//
// The client is ssh2, the maintained pure-JavaScript SSH2 implementation most Node projects use: it needs no native
// build, exposes host key verification and keepalives, and runs each command on a channel of one connection. The
// connection reaches it through SshDialer, so a test fakes the client without a network.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import type { AgentAuthMethod, ClientChannel, ConnectConfig, PublicKeyAuthMethod } from "ssh2";

import type { PluginConfig } from "../../monitors/base/plugin_helpers.ts";
import { create_logger_for } from "../logging.ts";
import { CONNECT_FAILED, COLLECT_TIMEOUT } from "./types.ts";

export { CONNECT_FAILED, COLLECT_TIMEOUT, CONTROL_TIMEOUT } from "./types.ts";
export * from "./job_commands.ts";

const log = create_logger_for("x_monitor.core.connectors.ssh_connector");

// ── Settings ─────────────────────────────────────────────────────────────────

export const KILL_GRACE_SECONDS = 5.0;
export const CONNECT_TIMEOUT = 5.0;
export const MAX_CONCURRENT_PER_HOST = 8;

let state_dir = process.env.XMONITOR_SSH_CONTROL_DIR || join(tmpdir(), "x-monitor-ssh");

// Points the known_hosts file somewhere else, as a test does.
export function set_ssh_state_dir(path: string): void {
  state_dir = path;
}

function known_hosts_path(): string {
  mkdirSync(state_dir, { recursive: true });
  return join(state_dir, "known_hosts");
}

// Seconds as Python writes a float, so a timeout reads "Timed out after 30.0s" as it always did.
function seconds_text(seconds: number): string {
  return Number.isInteger(seconds) ? seconds.toFixed(1) : String(seconds);
}

// ── Channel wait ─────────────────────────────────────────────────────────────

// The longest any one command queued for a free channel while a caller was measuring.
export class ChannelWait {
  seconds = 0;

  add(seconds: number): void {
    this.seconds = Math.max(this.seconds, seconds);
  }
}

const channel_wait = new AsyncLocalStorage<ChannelWait>();

// Measures how long the commands started inside `body`, and anything it starts, queue for a channel.
export async function measure_channel_wait<Value>(body: (tally: ChannelWait) => Promise<Value>): Promise<Value> {
  const tally = new ChannelWait();
  return channel_wait.run(tally, () => body(tally));
}

// ── Semaphore ────────────────────────────────────────────────────────────────

// Lets at most `limit` holders in at once, the rest waiting in arrival order.
export class Semaphore {
  value: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.value = limit;
  }

  async acquire(): Promise<void> {
    if (this.value > 0) {
      this.value--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.value++;
  }
}

// ── Host keys ────────────────────────────────────────────────────────────────

// The key type named at the front of an SSH public key blob, such as "ssh-ed25519".
function key_type(blob: Buffer): string {
  if (blob.length < 4) return "unknown";
  const length = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + length).toString("latin1");
}

function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

// Trust on first use: the first key seen for a target is stored, and every later connection must show that same key.
// known_hosts lines read "<alias> <key type> <base64 key>", as the Python app wrote them.
export class TofuVerifier {
  readonly host: string;
  readonly alias: string;

  constructor(host: string, host_key_alias: string) {
    this.host = host;
    this.alias = host_key_alias;
  }

  private stored_fingerprints(): Set<string> {
    const path = known_hosts_path();
    if (!existsSync(path)) return new Set();
    // A corrupt known_hosts reads as no stored key.
    try {
      const found = new Set<string>();
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 3 || fields[0].startsWith("#")) continue;
        if (!fields[0].split(",").includes(this.alias)) continue;
        found.add(fingerprint(Buffer.from(fields[2], "base64")));
      }
      return found;
    } catch (error) {
      log.warn(`ssh: could not read known_hosts for ${this.alias}: ${(error as Error).message}`);
      return new Set();
    }
  }

  validate_host_public_key(key: Buffer): boolean {
    const known = this.stored_fingerprints();
    if (known.size > 0) {
      if (known.has(fingerprint(key))) return true;
      log.error(`ssh: host key for ${this.alias} does NOT match the stored key — refusing to connect (possible MITM or reinstalled host)`);
      return false;
    }
    try {
      appendFileSync(known_hosts_path(), `${this.alias} ${key_type(key)} ${key.toString("base64")}\n`);
      log.info(`ssh: trusting and storing new host key for ${this.alias}`);
      return true;
    } catch (error) {
      log.error(`ssh: could not persist host key for ${this.alias}: ${(error as Error).message}`);
      return false;
    }
  }
}

// ── Client seam ──────────────────────────────────────────────────────────────

export interface SshDialOptions {
  host: string;
  port: number;
  username: string;
  key_path: string | null;
  verifier: TofuVerifier;
  connect_timeout: number;
}

export interface ProcessResult {
  exit_status: number | null;
  stdout: string;
  stderr: string;
}

// One remote command, shaped as asyncssh's process so the connection reads the same as the Python app's.
export interface SshProcess {
  exit_status: number | null;
  is_closing(): boolean;
  // Resolves once the command ends, or null when `timeout` seconds pass first.
  wait(timeout: number): Promise<ProcessResult | null>;
  terminate(): void;
  kill(): void;
  // Resolves true once the channel has closed, false when `timeout` seconds pass first.
  wait_closed(timeout: number): Promise<boolean>;
}

export interface SshClientConnection {
  is_closed(): boolean;
  create_process(command: string): Promise<SshProcess>;
  close(): void;
}

// Opens one connection; rejects when the host cannot be reached, refuses the login, or shows the wrong key.
export type SshDialer = (options: SshDialOptions) => Promise<SshClientConnection>;

// A transport error, whose message says what failed and whether the connection is gone.
export class SshError extends Error {
  readonly connection_lost: boolean;

  constructor(message: string, connection_lost = false) {
    super(message);
    this.name = "SshError";
    this.connection_lost = connection_lost;
  }
}

// ── ssh2 ─────────────────────────────────────────────────────────────────────

function default_key_files(): string[] {
  const folder = join(homedir(), ".ssh");
  return ["id_ed25519", "id_ecdsa", "id_rsa"].map((name) => join(folder, name)).filter((path) => existsSync(path));
}

// The login methods tried in order: only the configured key when there is one, else the agent and the default keys.
function auth_methods(options: SshDialOptions): (PublicKeyAuthMethod | AgentAuthMethod)[] {
  const username = options.username;
  if (options.key_path) return [{ type: "publickey", username, key: readFileSync(options.key_path) }];
  const methods: (PublicKeyAuthMethod | AgentAuthMethod)[] = [];
  if (process.env.SSH_AUTH_SOCK) methods.push({ type: "agent", username, agent: process.env.SSH_AUTH_SOCK });
  for (const path of default_key_files()) {
    try {
      methods.push({ type: "publickey", username, key: readFileSync(path) });
    } catch {
      continue;
    }
  }
  return methods;
}

class Ssh2Process implements SshProcess {
  exit_status: number | null = null;
  private closed = false;
  private stdout = "";
  private stderr = "";
  private readonly channel: ClientChannel;
  private readonly ended: Promise<void>;

  constructor(channel: ClientChannel) {
    this.channel = channel;
    channel.setEncoding("utf8");
    channel.stderr.setEncoding("utf8");
    channel.on("data", (chunk: string) => {
      this.stdout += chunk;
    });
    channel.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.ended = new Promise((resolve) => {
      channel.on("exit", (code: number | null) => {
        if (typeof code === "number") this.exit_status = code;
      });
      channel.on("close", (code: number | null) => {
        if (typeof code === "number") this.exit_status = code;
        this.closed = true;
        resolve();
      });
    });
  }

  is_closing(): boolean {
    return this.closed;
  }

  async wait(timeout: number): Promise<ProcessResult | null> {
    const done = await within(this.ended, timeout);
    return done ? { exit_status: this.exit_status, stdout: this.stdout, stderr: this.stderr } : null;
  }

  terminate(): void {
    this.channel.signal("TERM");
  }

  kill(): void {
    this.channel.signal("KILL");
  }

  wait_closed(timeout: number): Promise<boolean> {
    return within(this.ended, timeout);
  }

  // Frees the channel whatever the remote side does.
  abandon(): void {
    if (!this.closed) this.channel.close();
  }
}

// Whether `promise` settles within `seconds`.
function within(promise: Promise<unknown>, seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), seconds * 1000);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Dials with ssh2, keeping the connection alive with keepalives every 5 seconds and dropping it after two missed.
export const ssh2_dialer: SshDialer = async (options) => {
  const { Client } = await import("ssh2");
  const client = new Client();
  let closed = false;
  const config: ConnectConfig = {
    host: options.host,
    port: options.port,
    username: options.username,
    readyTimeout: options.connect_timeout * 1000,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
    hostVerifier: (key: Buffer) => options.verifier.validate_host_public_key(key),
    authHandler: auth_methods(options),
  };
  await new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (error) => reject(new SshError(error.message || "Connection failed")));
    client.connect(config);
  });
  client.on("error", (error) => log.debug(`ssh: connection to ${options.host} failed: ${error.message}`));
  client.on("close", () => {
    closed = true;
  });
  return {
    is_closed: () => closed,
    close: () => client.end(),
    create_process: (command) =>
      new Promise((resolve, reject) => {
        client.exec(command, (error, channel) => {
          if (error) reject(new SshError(error.message || "Connection lost", closed));
          else resolve(new Ssh2Process(channel));
        });
      }),
  };
};

// ── Connection ───────────────────────────────────────────────────────────────

// The host a monitor's config points at, which both the pool key and the dialled connection use.
export function resolve_host(config: PluginConfig): string {
  const ssh_config = (config.ssh_config ?? {}) as Record<string, unknown>;
  return String(ssh_config.host ?? config.target_host ?? "localhost");
}

// One lazily opened, reused connection to one target, dialled on first use and dialled again if it drops.
export class SSHConnection {
  readonly host: string;
  readonly username: string | null;
  readonly key_path: string | null;
  readonly port: number;
  conn: SshClientConnection | null = null;
  private connecting: Promise<SshClientConnection> | null = null;
  readonly channel_semaphore = new Semaphore(MAX_CONCURRENT_PER_HOST);
  dialer: SshDialer;

  static from_config(config: PluginConfig, dialer: SshDialer = ssh2_dialer): SSHConnection {
    const ssh_config = (config.ssh_config ?? {}) as Record<string, unknown>;
    return new SSHConnection(resolve_host(config), {
      username: (ssh_config.username as string | undefined) ?? null,
      key_path: (ssh_config.key_path as string | undefined) ?? null,
      port: (ssh_config.port as number | undefined) ?? null,
      dialer,
    });
  }

  constructor(host: string, options: { username?: string | null; key_path?: string | null; port?: number | null; dialer?: SshDialer } = {}) {
    this.host = host;
    this.username = options.username ?? null;
    this.key_path = options.key_path ?? null;
    this.port = options.port ?? 22;
    this.dialer = options.dialer ?? ssh2_dialer;
  }

  private host_key_alias(): string {
    const user = this.username || process.env.USER || "";
    return `${user}@${this.host}:${this.port}`;
  }

  async get_connection(): Promise<SshClientConnection> {
    if (this.conn !== null && !this.conn.is_closed()) return this.conn;
    if (this.connecting !== null) return this.connecting;
    const alias = this.host_key_alias();
    this.connecting = this.dialer({
      host: this.host,
      port: this.port,
      username: this.username || userInfo().username,
      key_path: this.key_path,
      verifier: new TofuVerifier(this.host, alias),
      connect_timeout: CONNECT_TIMEOUT,
    });
    try {
      this.conn = await this.connecting;
      return this.conn;
    } finally {
      this.connecting = null;
    }
  }

  // Runs one command; any transport failure or timeout maps to (-1, "", message), and a timed-out command is killed.
  async execute(command: string, timeout: number | null = COLLECT_TIMEOUT): Promise<[number, string, string]> {
    const seconds = timeout ?? COLLECT_TIMEOUT;
    let conn: SshClientConnection;
    try {
      conn = await this.get_connection();
    } catch (error) {
      const reason = (error as Error).message || (error as Error).name || "Error";
      log.error(`SSH connect failed on ${this.host}: ${reason}`);
      return [-1, "", `${CONNECT_FAILED}: ${reason}`];
    }
    let remote: SshProcess | null = null;
    const queued = performance.now();
    await this.channel_semaphore.acquire();
    try {
      channel_wait.getStore()?.add((performance.now() - queued) / 1000);
      remote = await conn.create_process(command);
      const result = await remote.wait(seconds);
      if (result === null) {
        await SSHConnection.kill_process(remote);
        return [-1, "", `Timed out after ${seconds_text(seconds)}s`];
      }
      return [result.exit_status ?? -1, result.stdout.trim(), result.stderr.trim()];
    } catch (error) {
      const message = (error as Error).message;
      log.error(`SSH execution failed on ${this.host}: ${message}`);
      if (remote !== null) await SSHConnection.kill_process(remote);
      // A host that rebooted or went down leaves a dead connection; forgetting it makes the next command dial afresh.
      if (conn.is_closed() || (error instanceof SshError && error.connection_lost)) this.forget(conn);
      return [-1, "", message || "Connection lost"];
    } finally {
      if (remote instanceof Ssh2Process) remote.abandon();
      this.channel_semaphore.release();
    }
  }

  // Terminates a still-running remote command, then kills it if it has not closed within the grace.
  static async kill_process(remote: SshProcess): Promise<void> {
    if (remote.exit_status !== null || remote.is_closing()) return;
    for (const stop of [() => remote.terminate(), () => remote.kill()]) {
      try {
        stop();
        if (await remote.wait_closed(KILL_GRACE_SECONDS)) return;
      } catch {
        continue;
      }
    }
  }

  // Closes and drops `conn` if it is still the pooled one, leaving a newer connection alone.
  private forget(conn: SshClientConnection): void {
    if (this.conn === conn) this.close();
  }

  close(): void {
    if (this.conn !== null) {
      // Closing an already broken connection must not fail teardown.
      try {
        this.conn.close();
      } catch {
        // Nothing more to do with a connection that will not close.
      }
      this.conn = null;
    }
  }
}
