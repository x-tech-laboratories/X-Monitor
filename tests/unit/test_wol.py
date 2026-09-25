"""The Wake-on-LAN packet builder, and both senders proven against a socket on the loopback interface only."""

import os
import shutil
import socket
import subprocess

import pytest

from vigil.core.connectors.wol import (
    magic_packet, parse_mac, parse_password, remote_send_command, send_magic_packet,
)

MAC = '00:11:22:33:44:55'
MAC_BYTES = bytes([0x00, 0x11, 0x22, 0x33, 0x44, 0x55])


class TestParseMac:
    @pytest.mark.parametrize('text', ['00:11:22:33:44:55', '00-11-22-33-44-55', '0011.2233.4455',
                                      '001122334455', '00:11:22:33:44:55 '])
    def test_separators(self, text):
        assert parse_mac(text) == MAC_BYTES

    def test_upper_and_lower_case(self):
        assert parse_mac('AA:bb:CC:dd:EE:ff') == bytes.fromhex('aabbccddeeff')

    @pytest.mark.parametrize('text', ['', '00:11:22:33:44', '00:11:22:33:44:55:66', 'zz:11:22:33:44:55', None])
    def test_rejects_what_is_not_a_mac(self, text):
        with pytest.raises(ValueError):
            parse_mac(text)


class TestMagicPacket:
    def test_six_ff_bytes_then_the_mac_sixteen_times(self):
        packet = magic_packet(MAC)
        assert len(packet) == 102
        assert packet[:6] == b'\xff' * 6
        assert packet[6:] == MAC_BYTES * 16

    def test_secureon_password_like_a_mac(self):
        packet = magic_packet(MAC, '01:02:03:04:05:06')
        assert len(packet) == 108
        assert packet[-6:] == bytes([1, 2, 3, 4, 5, 6])

    def test_secureon_password_as_a_dotted_quad(self):
        assert parse_password('192.168.1.10') == bytes([192, 168, 1, 10])
        assert magic_packet(MAC, '192.168.1.10')[-4:] == bytes([192, 168, 1, 10])

    @pytest.mark.parametrize('password', ['secret', '1.2.3.400', '01:02:03'])
    def test_rejects_a_bad_password(self, password):
        with pytest.raises(ValueError):
            magic_packet(MAC, password)


@pytest.fixture
def receiver():
    """A UDP socket on the loopback interface, so nothing reaches a real network."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', 0))
    sock.settimeout(5)
    yield sock
    sock.close()


class TestSenders:
    def test_send_magic_packet(self, receiver):
        packet = magic_packet(MAC)
        send_magic_packet(packet, '127.0.0.1', receiver.getsockname()[1])
        assert receiver.recv(200) == packet

    @pytest.mark.skipif(shutil.which('python3') is None, reason='needs python3 on PATH')
    def test_remote_command_with_python3(self, receiver):
        packet = magic_packet(MAC, '01:02:03:04:05:06')
        command = remote_send_command(packet, '127.0.0.1', receiver.getsockname()[1])
        subprocess.run(['sh', '-c', command], check=True, timeout=10)
        assert receiver.recv(200) == packet

    @pytest.mark.skipif(shutil.which('socat') is None, reason='needs socat on PATH')
    def test_remote_command_with_socat(self, receiver, tmp_path):
        (tmp_path / 'socat').symlink_to(shutil.which('socat'))
        packet = magic_packet(MAC)
        command = remote_send_command(packet, '127.0.0.1', receiver.getsockname()[1])
        subprocess.run([shutil.which('sh'), '-c', command], check=True, timeout=10, env={**os.environ, 'PATH': str(tmp_path)})
        assert receiver.recv(200) == packet

    def test_remote_command_without_either_tool(self, tmp_path):
        command = remote_send_command(magic_packet(MAC), '127.0.0.1', 9)
        done = subprocess.run([shutil.which('sh'), '-c', command], capture_output=True, text=True,
                              env={**os.environ, 'PATH': str(tmp_path)})
        assert done.returncode == 127
        assert 'needs python3 or socat' in done.stderr

    def test_remote_command_quotes_the_address(self):
        command = remote_send_command(magic_packet(MAC), "10.0.0.255; rm -rf /", 9)
        assert "'10.0.0.255; rm -rf /'" in command
        subprocess.run(['sh', '-n', '-c', command], check=True)
