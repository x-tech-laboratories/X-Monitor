"""Wake-on-LAN: the magic packet as a pure function, the one-line sender that
puts it on the X-Monitor server's own network, and the shell command that sends
the same bytes from another host, for a sleeping machine on a subnet only
that host can reach."""

import re
import shlex
import socket
from typing import Optional

DEFAULT_BROADCAST = '255.255.255.255'
DEFAULT_PORT = 9

_SEPARATORS = re.compile(r'[:\-.\s]')

# Sends argv[1] (hex) to argv[2]:argv[3] as one broadcast UDP datagram.
_PYTHON_SENDER = (
    "import socket,sys;"
    "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);"
    "s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);"
    "s.sendto(bytes.fromhex(sys.argv[1]),(sys.argv[2],int(sys.argv[3])))"
)


def parse_mac(mac: str) -> bytes:
    """A MAC address's six bytes, written with colons, dashes, dots or no separators at all."""
    digits = _SEPARATORS.sub('', str(mac or ''))
    if not re.fullmatch(r'[0-9A-Fa-f]{12}', digits):
        raise ValueError(f"not a MAC address: {mac!r}")
    return bytes.fromhex(digits)


def parse_password(password: str) -> bytes:
    """A SecureOn password's bytes: six written like a MAC address, or four written like an IPv4 address."""
    text = str(password).strip()
    if re.fullmatch(r'\d{1,3}(\.\d{1,3}){3}', text):
        parts = [int(p) for p in text.split('.')]
        if all(p <= 255 for p in parts):
            return bytes(parts)
    try:
        return parse_mac(text)
    except ValueError:
        raise ValueError(f"not a SecureOn password (six hex bytes or a dotted quad): {password!r}") from None


def magic_packet(mac: str, password: Optional[str] = None) -> bytes:
    """Six 0xFF bytes, then the MAC address sixteen times, then the SecureOn password when there is one."""
    packet = b'\xff' * 6 + parse_mac(mac) * 16
    if password:
        packet += parse_password(password)
    return packet


def send_magic_packet(packet: bytes, address: str = DEFAULT_BROADCAST, port: int = DEFAULT_PORT) -> None:
    """Sends the packet as one UDP datagram from this machine, raising OSError when the network refuses it."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(packet, (address, int(port)))


def remote_send_command(packet: bytes, address: str = DEFAULT_BROADCAST, port: int = DEFAULT_PORT) -> str:
    """A shell command that sends the packet from whichever host runs it, with python3 or else socat."""
    target = shlex.quote(address)
    port = int(port)
    octal = ''.join(f'\\{b:03o}' for b in packet)
    return (
        f"if command -v python3 >/dev/null 2>&1; then "
        f"python3 -c {shlex.quote(_PYTHON_SENDER)} {packet.hex()} {target} {port}; "
        f"elif command -v socat >/dev/null 2>&1; then "
        f"printf '{octal}' | socat -u - UDP-DATAGRAM:{target}:{port},broadcast; "
        "else echo 'sending a wake packet needs python3 or socat on this host, or a wake_command' >&2; "
        "exit 127; fi"
    )
