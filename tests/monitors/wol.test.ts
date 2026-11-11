import { spawnSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { magic_packet, parse_mac, parse_password, remote_send_command, send_magic_packet } from "../../src/monitors/base/wol.ts";

const mac = "00:11:22:33:44:55";
const mac_bytes = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);

function which(program: string): string | null {
  const found = spawnSync("sh", ["-c", `command -v ${program}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

describe("parse mac", () => {
  it.each(["00:11:22:33:44:55", "00-11-22-33-44-55", "0011.2233.4455", "001122334455", "00:11:22:33:44:55 "])("reads %j", (text) => {
    expect(parse_mac(text)).toEqual(mac_bytes);
  });

  it("reads upper and lower case", () => {
    expect(parse_mac("AA:bb:CC:dd:EE:ff")).toEqual(Buffer.from("aabbccddeeff", "hex"));
  });

  it.each(["", "00:11:22:33:44", "00:11:22:33:44:55:66", "zz:11:22:33:44:55", null])("rejects %j", (text) => {
    expect(() => parse_mac(text)).toThrow(/not a MAC address/);
  });
});

describe("magic packet", () => {
  it("is six ff bytes then the mac sixteen times", () => {
    const packet = magic_packet(mac);
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(packet.subarray(6)).toEqual(Buffer.concat(Array.from({ length: 16 }, () => mac_bytes)));
  });

  it("adds a SecureOn password written like a mac", () => {
    const packet = magic_packet(mac, "01:02:03:04:05:06");
    expect(packet.length).toBe(108);
    expect(packet.subarray(-6)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("adds a SecureOn password written as a dotted quad", () => {
    expect(parse_password("192.168.1.10")).toEqual(Buffer.from([192, 168, 1, 10]));
    expect(magic_packet(mac, "192.168.1.10").subarray(-4)).toEqual(Buffer.from([192, 168, 1, 10]));
  });

  it.each(["secret", "1.2.3.400", "01:02:03"])("rejects the password %j", (password) => {
    expect(() => magic_packet(mac, password)).toThrow(/not a SecureOn password/);
  });
});

describe("senders", () => {
  let receiver: Socket | null = null;

  // A UDP socket on the loopback interface, so nothing reaches a real network.
  async function listen(): Promise<{ port: number; next: Promise<Buffer> }> {
    const socket = createSocket("udp4");
    receiver = socket;
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    const next = new Promise<Buffer>((resolve) => socket.once("message", (message) => resolve(message)));
    return { port: socket.address().port, next };
  }

  afterEach(() => {
    receiver?.close();
    receiver = null;
  });

  it("sends a packet", async () => {
    const { port, next } = await listen();
    const packet = magic_packet(mac);
    await send_magic_packet(packet, "127.0.0.1", port);
    expect(await next).toEqual(packet);
  });

  it.skipIf(which("python3") === null)("sends from a remote command with python3", async () => {
    const { port, next } = await listen();
    const packet = magic_packet(mac, "01:02:03:04:05:06");
    const done = spawnSync("sh", ["-c", remote_send_command(packet, "127.0.0.1", port)], { timeout: 10_000 });
    expect(done.status).toBe(0);
    expect(await next).toEqual(packet);
  });

  it.skipIf(which("socat") === null)("sends from a remote command with socat", async () => {
    const { port, next } = await listen();
    const folder = mkdtempSync(join(tmpdir(), "wol-"));
    symlinkSync(which("socat")!, join(folder, "socat"));
    const packet = magic_packet(mac);
    const done = spawnSync(which("sh")!, ["-c", remote_send_command(packet, "127.0.0.1", port)], { timeout: 10_000, env: { ...process.env, PATH: folder } });
    expect(done.status).toBe(0);
    expect(await next).toEqual(packet);
  });

  it("fails a remote command without either tool", () => {
    const folder = mkdtempSync(join(tmpdir(), "wol-"));
    const done = spawnSync(which("sh")!, ["-c", remote_send_command(magic_packet(mac), "127.0.0.1", 9)], { encoding: "utf8", env: { ...process.env, PATH: folder } });
    expect(done.status).toBe(127);
    expect(done.stderr).toContain("needs python3 or socat");
  });

  it("quotes the address in a remote command", () => {
    const text = remote_send_command(magic_packet(mac), "10.0.0.255; rm -rf /", 9);
    expect(text).toContain("'10.0.0.255; rm -rf /'");
    expect(spawnSync("sh", ["-n", "-c", text]).status).toBe(0);
  });
});
