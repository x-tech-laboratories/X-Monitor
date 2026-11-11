// Wake-on-LAN: the magic packet with an optional SecureOn password, the sender that puts it on the X-Monitor server's
// own network as one datagram, and the shell command that sends the same bytes from another host, for a sleeping
// machine on a subnet only that host can reach. The packet itself comes from X-Libs' agent/wake.

import { createSocket } from "node:dgram";

import { magic_packet as xlibs_magic_packet } from "@x-tech-laboratories/x-libs/agent/wake";

import { shell_quote } from "../../core/shell.ts";

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_BROADCAST = "255.255.255.255";
export const DEFAULT_PORT = 9;

// Sends argv[1] (hex) to argv[2]:argv[3] as one broadcast UDP datagram.
const python_sender =
  "import socket,sys;" +
  "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);" +
  "s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);" +
  "s.sendto(bytes.fromhex(sys.argv[1]),(sys.argv[2],int(sys.argv[3])))";

// ── Parsing ──────────────────────────────────────────────────────────────────

// Python's repr() of the value a caller passed, for error text.
function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  return quote + text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`) + quote;
}

// The twelve hex digits of a MAC address written with colons, dashes, dots, spaces or no separators at all.
function mac_digits(mac: unknown): string {
  const digits = String(mac ?? "").replace(/[:\-.\s]/g, "");
  if (!/^[0-9A-Fa-f]{12}$/.test(digits)) throw new Error(`not a MAC address: ${repr(mac)}`);
  return digits;
}

// A MAC address's six bytes.
export function parse_mac(mac: unknown): Buffer {
  return Buffer.from(mac_digits(mac), "hex");
}

// A SecureOn password's bytes: six written like a MAC address, or four written like an IPv4 address.
export function parse_password(password: unknown): Buffer {
  const text = String(password).trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split(".").map(Number);
    if (parts.every((part) => part <= 255)) return Buffer.from(parts);
  }
  try {
    return parse_mac(text);
  } catch {
    throw new Error(`not a SecureOn password (six hex bytes or a dotted quad): ${repr(password)}`);
  }
}

// Six 0xFF bytes, then the MAC address sixteen times, then the SecureOn password when there is one.
export function magic_packet(mac: unknown, password: string | null = null): Buffer {
  const packet = xlibs_magic_packet(mac_digits(mac));
  return password ? Buffer.concat([packet, parse_password(password)]) : packet;
}

// ── Sending ──────────────────────────────────────────────────────────────────

// Sends the packet as one UDP datagram from this machine, rejecting when the network refuses it.
export async function send_magic_packet(packet: Buffer, address: string = DEFAULT_BROADCAST, port: number = DEFAULT_PORT): Promise<void> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.setBroadcast(true);
    await new Promise<void>((resolve, reject) => socket.send(packet, Math.trunc(port), address, (error) => (error ? reject(error) : resolve())));
  } finally {
    socket.close();
  }
}

// A shell command that sends the packet from whichever host runs it, with python3 or else socat.
export function remote_send_command(packet: Buffer, address: string = DEFAULT_BROADCAST, port: number = DEFAULT_PORT): string {
  const target = shell_quote(address);
  const number = Math.trunc(port);
  const octal = [...packet].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
  return (
    "if command -v python3 >/dev/null 2>&1; then " +
    `python3 -c ${shell_quote(python_sender)} ${packet.toString("hex")} ${target} ${number}; ` +
    "elif command -v socat >/dev/null 2>&1; then " +
    `printf '${octal}' | socat -u - UDP-DATAGRAM:${target}:${number},broadcast; ` +
    "else echo 'sending a wake packet needs python3 or socat on this host, or a wake_command' >&2; " +
    "exit 127; fi"
  );
}
