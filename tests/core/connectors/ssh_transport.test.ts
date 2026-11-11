import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECT_FAILED, MAX_CONCURRENT_PER_HOST, measure_channel_wait, set_ssh_state_dir, SSHConnection, SshError, TofuVerifier,
  type ProcessResult, type SshClientConnection, type SshDialer, type SshProcess,
} from "../../../src/core/connectors/ssh_connector.ts";
import { set_log_sink } from "../../../src/core/logging.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeProcess implements SshProcess {
  exit_status: number | null = null;
  closing = false;
  terminated = 0;
  killed = 0;
  // How many wait_closed calls time out before one succeeds.
  closes_after = 0;
  private readonly result: ProcessResult | null;
  private readonly gate: Promise<void> | null;

  constructor(result: ProcessResult | null, gate: Promise<void> | null = null) {
    this.result = result;
    this.gate = gate;
  }

  is_closing(): boolean {
    return this.closing;
  }

  async wait(): Promise<ProcessResult | null> {
    if (this.gate) await this.gate;
    if (this.result === null) return null;
    this.exit_status = this.result.exit_status;
    return this.result;
  }

  terminate(): void {
    this.terminated++;
  }

  kill(): void {
    this.killed++;
  }

  async wait_closed(): Promise<boolean> {
    if (this.closes_after > 0) {
      this.closes_after--;
      return false;
    }
    return true;
  }
}

class FakeConnection implements SshClientConnection {
  closed = false;
  close_calls = 0;
  commands: string[] = [];
  next: (command: string) => Promise<SshProcess>;

  constructor(next: (command: string) => Promise<SshProcess>) {
    this.next = next;
  }

  is_closed(): boolean {
    return this.closed;
  }

  create_process(command: string): Promise<SshProcess> {
    this.commands.push(command);
    return this.next(command);
  }

  close(): void {
    this.close_calls++;
    this.closed = true;
  }
}

function answering(exit_status: number, stdout = "", stderr = ""): FakeConnection {
  return new FakeConnection(async () => new FakeProcess({ exit_status, stdout, stderr }));
}

function dialing(...connections: (SshClientConnection | Error)[]): SshDialer & { calls: number } {
  const dialer = (async () => {
    dialer.calls++;
    const next = connections.shift();
    if (next === undefined) throw new Error("no more connections");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as SshDialer & { calls: number };
  dialer.calls = 0;
  return dialer;
}

function with_conn(conn: SshClientConnection | Error, host = "h"): SSHConnection {
  return new SSHConnection(host, { dialer: dialing(conn) });
}

beforeEach(() => set_log_sink(() => {}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("from_config", () => {
  it("reads the host from ssh_config", () => {
    expect(SSHConnection.from_config({ ssh_config: { host: "myhost" } }).host).toBe("myhost");
  });

  it("falls back to target_host", () => {
    expect(SSHConnection.from_config({ target_host: "fallback.host" }).host).toBe("fallback.host");
  });

  it("defaults to localhost", () => {
    expect(SSHConnection.from_config({}).host).toBe("localhost");
  });

  it("reads the username", () => {
    expect(SSHConnection.from_config({ ssh_config: { host: "h", username: "admin" } }).username).toBe("admin");
  });

  it("defaults to port 22", () => {
    expect(SSHConnection.from_config({ ssh_config: { host: "h" } }).port).toBe(22);
  });

  it("reads a custom port", () => {
    expect(SSHConnection.from_config({ ssh_config: { host: "h", port: 2222 } }).port).toBe(2222);
  });

  it("makes a new instance each call", () => {
    const config = { ssh_config: { host: "h", username: "u" } };
    expect(SSHConnection.from_config(config)).not.toBe(SSHConnection.from_config(config));
  });
});

describe("execute", () => {
  it("returns the exit code, stdout and stderr", async () => {
    expect(await with_conn(answering(0, "hello", "")).execute("echo hello")).toEqual([0, "hello", ""]);
  });

  it("returns a nonzero exit code", async () => {
    const [code, , error] = await with_conn(answering(1, "", "not found")).execute("bad_cmd");
    expect(code).toBe(1);
    expect(error).toBe("not found");
  });

  it("keeps stdout and stderr apart and trims them", async () => {
    const [, out, error] = await with_conn(answering(0, "out-only\n", "  err-only\n")).execute("cmd");
    expect(out).toBe("out-only");
    expect(error).toBe("err-only");
  });

  it("reads an exit with no status as -1", async () => {
    expect((await with_conn(new FakeConnection(async () => new FakeProcess({ exit_status: null, stdout: "", stderr: "" }))).execute("cmd"))[0]).toBe(-1);
  });

  it("kills a timed-out process", async () => {
    const process = new FakeProcess(null);
    const [code, , error] = await with_conn(new FakeConnection(async () => process)).execute("sleep 999", 0.05);
    expect(code).toBe(-1);
    expect(error).toBe("Timed out after 0.05s");
    expect(process.terminated).toBe(1);
  });

  it("writes a whole-second timeout as Python did", async () => {
    const [, , error] = await with_conn(new FakeConnection(async () => new FakeProcess(null))).execute("sleep 999", 30);
    expect(error).toBe("Timed out after 30.0s");
  });

  it("returns a sentinel on a connection error", async () => {
    const [code, , error] = await with_conn(new Error("no route to host")).execute("cmd");
    expect(code).toBe(-1);
    expect(error).toContain("no route to host");
  });
});

describe("kill_process", () => {
  it("does not kill once terminate closes it", async () => {
    const process = new FakeProcess(null);
    await SSHConnection.kill_process(process);
    expect(process.terminated).toBe(1);
    expect(process.killed).toBe(0);
  });

  it("escalates to kill when terminate does not close it", async () => {
    const process = new FakeProcess(null);
    process.closes_after = 1;
    await SSHConnection.kill_process(process);
    expect(process.terminated).toBe(1);
    expect(process.killed).toBe(1);
  });

  it("does nothing to a finished process", async () => {
    const process = new FakeProcess(null);
    process.exit_status = 0;
    await SSHConnection.kill_process(process);
    expect(process.terminated + process.killed).toBe(0);
  });

  it("does nothing to a closing process", async () => {
    const process = new FakeProcess(null);
    process.closing = true;
    await SSHConnection.kill_process(process);
    expect(process.terminated).toBe(0);
  });
});

describe("concurrency", () => {
  it("bounds the channels open to one host", async () => {
    const conn = new SSHConnection("h");
    expect(conn.channel_semaphore.value).toBe(MAX_CONCURRENT_PER_HOST);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    conn.dialer = dialing(new FakeConnection(async () => {
      started++;
      return new FakeProcess({ exit_status: 0, stdout: "", stderr: "" }, gate);
    }));
    const runs = Array.from({ length: MAX_CONCURRENT_PER_HOST + 2 }, () => conn.execute("cmd"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(MAX_CONCURRENT_PER_HOST);
    release();
    await Promise.all(runs);
    expect(started).toBe(MAX_CONCURRENT_PER_HOST + 2);
  });

  it("measures how long commands queued for a channel", async () => {
    const conn = new SSHConnection("h");
    conn.channel_semaphore.value = 1;
    conn.dialer = dialing(new FakeConnection(async () => new FakeProcess({ exit_status: 0, stdout: "", stderr: "" }, new Promise((resolve) => setTimeout(resolve, 30)))));
    const seconds = await measure_channel_wait(async (tally) => {
      await Promise.all([conn.execute("a"), conn.execute("b")]);
      return tally.seconds;
    });
    expect(seconds).toBeGreaterThan(0.02);
  });
});

describe("trust on first use", () => {
  let folder: string;
  const blob = (type: string, body: string): Buffer => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length);
    return Buffer.concat([length, name, Buffer.from(body)]);
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "x-monitor-ssh-"));
    set_ssh_state_dir(folder);
  });

  afterEach(() => set_ssh_state_dir(join(tmpdir(), "x-monitor-ssh")));

  it("trusts and stores a key when none is stored", () => {
    const verifier = new TofuVerifier("myhost", "user@myhost:22");
    expect(verifier.validate_host_public_key(blob("ssh-ed25519", "first"))).toBe(true);
    const known_hosts = join(folder, "known_hosts");
    expect(existsSync(known_hosts)).toBe(true);
    expect(readFileSync(known_hosts, "utf8")).toMatch(/^user@myhost:22 ssh-ed25519 \S+\n$/);
  });

  it("accepts the stored key", () => {
    const key = blob("ssh-ed25519", "same");
    writeFileSync(join(folder, "known_hosts"), `user@myhost:22 ssh-ed25519 ${key.toString("base64")}\n`);
    expect(new TofuVerifier("myhost", "user@myhost:22").validate_host_public_key(key)).toBe(true);
  });

  it("rejects a key other than the stored one", () => {
    writeFileSync(join(folder, "known_hosts"), `user@myhost:22 ssh-ed25519 ${blob("ssh-ed25519", "original").toString("base64")}\n`);
    expect(new TofuVerifier("myhost", "user@myhost:22").validate_host_public_key(blob("ssh-ed25519", "different"))).toBe(false);
  });

  it("keeps one alias's key apart from another's", () => {
    writeFileSync(join(folder, "known_hosts"), `user@other:22 ssh-ed25519 ${blob("ssh-ed25519", "theirs").toString("base64")}\n`);
    expect(new TofuVerifier("myhost", "user@myhost:22").validate_host_public_key(blob("ssh-ed25519", "mine"))).toBe(true);
  });
});

describe("close", () => {
  it("closes the cached connection", async () => {
    const fake = answering(0);
    const conn = with_conn(fake);
    await conn.execute("cmd");
    conn.close();
    expect(fake.close_calls).toBe(1);
    expect(conn.conn).toBeNull();
  });

  it("does not throw with no connection", () => {
    new SSHConnection("h").close();
  });

  it("swallows errors", () => {
    const conn = new SSHConnection("h");
    conn.conn = { is_closed: () => false, create_process: async () => new FakeProcess(null), close: () => { throw new Error("boom"); } };
    conn.close();
    expect(conn.conn).toBeNull();
  });
});

describe("connection loss", () => {
  it("marks a connect failure as never sent", async () => {
    const [code, , error] = await with_conn(new Error("no route to host")).execute("cmd");
    expect(code).toBe(-1);
    expect(error.startsWith(CONNECT_FAILED)).toBe(true);
  });

  it("names a connect timeout", async () => {
    const timeout = new Error("");
    timeout.name = "TimeoutError";
    expect((await with_conn(timeout).execute("cmd"))[2]).toBe(`${CONNECT_FAILED}: TimeoutError`);
  });

  it("dials a lost connection again on the next command", async () => {
    const lost = new FakeConnection(async () => {
      throw new SshError("Connection lost", true);
    });
    const fresh = answering(0, "back", "");
    const dialer = dialing(lost, fresh);
    const conn = new SSHConnection("h", { dialer });
    const [code, , error] = await conn.execute("sudo -n systemctl reboot");
    expect([code, error]).toEqual([-1, "Connection lost"]);
    expect(lost.close_calls).toBe(1);
    const [again, out] = await conn.execute("uptime");
    expect([again, out]).toEqual([0, "back"]);
    expect(dialer.calls).toBe(2);
  });

  it("dials once for commands that arrive together", async () => {
    const dialer = dialing(answering(0, "x"));
    const conn = new SSHConnection("h", { dialer });
    await Promise.all([conn.execute("a"), conn.execute("b")]);
    expect(dialer.calls).toBe(1);
  });
});
