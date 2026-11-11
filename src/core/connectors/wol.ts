// Wake-on-LAN: the magic packet as a pure function, the sender that puts it on X-Monitor's own network, and the shell
// command that sends the same bytes from another host, for a sleeping machine on a subnet only that host reaches.

import { createSocket } from "node:dgram";

import { python_repr } from "../python.ts";
import { shell_quote } from "../shell.ts";

export const DEFAULT_BROADCAST = "255.255.255.255";
export const DEFAULT_PORT = 9;

// Sends argv[1] (hex) to argv[2]:argv[3] as one broadcast UDP datagram.
const python_sender =
  "import socket,sys;" +
  "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);" +
  "s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);" +
  "s.sendto(bytes.fromhex(sys.argv[1]),(sys.argv[2],int(sys.argv[3])))";

// ── Packet ───────────────────────────────────────────────────────────────────

// A MAC address's six bytes, written with colons, dashes, dots or no separators at all.
export function parse_mac(mac: unknown): Buffer {
  const digits = String(mac ?? "").replace(/[:\-.\s]/g, "");
  if (!/^[0-9A-Fa-f]{12}$/.test(digits)) throw new Error(`not a MAC address: ${python_repr(mac)}`);
  return Buffer.from(digits, "hex");
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
    throw new Error(`not a SecureOn password (six hex bytes or a dotted quad): ${python_repr(password)}`);
  }
}

// Six 0xFF bytes, then the MAC address sixteen times, then the SecureOn password when there is one.
export function magic_packet(mac: unknown, password: string | null = null): Buffer {
  const address = parse_mac(mac);
  const parts = [Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)];
  if (password) parts.push(parse_password(password));
  return Buffer.concat(parts);
}

// ── Sending ──────────────────────────────────────────────────────────────────

// Sends the packet as one UDP datagram from this machine, rejecting when the network refuses it.
export async function send_magic_packet(packet: Buffer, address = DEFAULT_BROADCAST, port = DEFAULT_PORT): Promise<void> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => resolve());
    });
    socket.setBroadcast(true);
    await new Promise<void>((resolve, reject) => socket.send(packet, Math.trunc(port), address, (error) => (error ? reject(error) : resolve())));
  } finally {
    socket.close();
  }
}

// A shell command that sends the packet from whichever host runs it, with python3 or else socat.
export function remote_send_command(packet: Buffer, address = DEFAULT_BROADCAST, port = DEFAULT_PORT): string {
  const target = shell_quote(address);
  const port_number = Math.trunc(port);
  const octal = [...packet].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
  return (
    "if command -v python3 >/dev/null 2>&1; then " +
    `python3 -c ${shell_quote(python_sender)} ${packet.toString("hex")} ${target} ${port_number}; ` +
    "elif command -v socat >/dev/null 2>&1; then " +
    `printf '${octal}' | socat -u - UDP-DATAGRAM:${target}:${port_number},broadcast; ` +
    "else echo 'sending a wake packet needs python3 or socat on this host, or a wake_command' >&2; " +
    "exit 127; fi"
  );
}
