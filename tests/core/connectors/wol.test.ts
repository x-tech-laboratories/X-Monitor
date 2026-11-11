import { spawnSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { magic_packet, parse_mac, parse_password, remote_send_command, send_magic_packet } from "../../../src/core/connectors/wol.ts";

const MAC = "00:11:22:33:44:55";
const MAC_BYTES = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);

function which(name: string): string | null {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

describe("parse_mac", () => {
  it.each(["00:11:22:33:44:55", "00-11-22-33-44-55", "0011.2233.4455", "001122334455", "00:11:22:33:44:55 "])("reads the separators in %s", (text) => {
    expect(parse_mac(text)).toEqual(MAC_BYTES);
  });

  it("reads upper and lower case", () => {
    expect(parse_mac("AA:bb:CC:dd:EE:ff")).toEqual(Buffer.from("aabbccddeeff", "hex"));
  });

  it.each(["", "00:11:22:33:44", "00:11:22:33:44:55:66", "zz:11:22:33:44:55", null])("rejects %j", (text) => {
    expect(() => parse_mac(text)).toThrow();
  });
});

describe("magic packet", () => {
  it("is six ff bytes then the mac sixteen times", () => {
    const packet = magic_packet(MAC);
    expect(packet).toHaveLength(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(packet.subarray(6)).toEqual(Buffer.concat(Array.from({ length: 16 }, () => MAC_BYTES)));
  });

  it("takes a SecureOn password written like a mac", () => {
    const packet = magic_packet(MAC, "01:02:03:04:05:06");
    expect(packet).toHaveLength(108);
    expect(packet.subarray(-6)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("takes a SecureOn password as a dotted quad", () => {
    expect(parse_password("192.168.1.10")).toEqual(Buffer.from([192, 168, 1, 10]));
    expect(magic_packet(MAC, "192.168.1.10").subarray(-4)).toEqual(Buffer.from([192, 168, 1, 10]));
  });

  it.each(["secret", "1.2.3.400", "01:02:03"])("rejects the bad password %s", (password) => {
    expect(() => magic_packet(MAC, password)).toThrow();
  });
});

describe("senders", () => {
  let receiver: Socket;
  let port: number;
  let received: Promise<Buffer>;

  // A socket on the loopback interface only, so nothing reaches a real network.
  beforeEach(async () => {
    receiver = createSocket("udp4");
    received = new Promise((resolve) => receiver.once("message", (message) => resolve(message)));
    await new Promise<void>((resolve) => receiver.bind(0, "127.0.0.1", () => resolve()));
    port = receiver.address().port;
  });

  afterEach(() => receiver.close());

  it("sends the packet", async () => {
    const packet = magic_packet(MAC);
    await send_magic_packet(packet, "127.0.0.1", port);
    expect(await received).toEqual(packet);
  });

  it.skipIf(which("python3") === null)("sends from a remote command with python3", async () => {
    const packet = magic_packet(MAC, "01:02:03:04:05:06");
    expect(spawnSync("sh", ["-c", remote_send_command(packet, "127.0.0.1", port)], { timeout: 10_000 }).status).toBe(0);
    expect(await received).toEqual(packet);
  });

  it.skipIf(which("socat") === null)("sends from a remote command with socat", async () => {
    const folder = mkdtempSync(join(tmpdir(), "x-monitor-wol-"));
    symlinkSync(which("socat")!, join(folder, "socat"));
    const packet = magic_packet(MAC);
    expect(spawnSync(which("sh")!, ["-c", remote_send_command(packet, "127.0.0.1", port)], { timeout: 10_000, env: { PATH: folder } }).status).toBe(0);
    expect(await received).toEqual(packet);
  });

  it("fails a remote command without either tool", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-monitor-wol-"));
    const done = spawnSync(which("sh")!, ["-c", remote_send_command(magic_packet(MAC), "127.0.0.1", 9)], { encoding: "utf8", env: { PATH: folder } });
    expect(done.status).toBe(127);
    expect(done.stderr).toContain("needs python3 or socat");
  });

  it("quotes the address in a remote command", () => {
    const command = remote_send_command(magic_packet(MAC), "10.0.0.255; rm -rf /", 9);
    expect(command).toContain("'10.0.0.255; rm -rf /'");
    expect(spawnSync("sh", ["-n", "-c", command]).status).toBe(0);
  });
});
