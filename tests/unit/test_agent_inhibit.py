"""Holding a monitored host awake while a task runs: the agent's idle inhibitor and the server's holds."""

import asyncio
from types import SimpleNamespace

import pytest

from x_monitor.core.connectors.agent_connector import AgentConnection, AgentRegistry
from x_monitor.core.coordination import engine as engine_module
from x_monitor_agent import inhibit, protocol as proto
from x_monitor_agent.client import AgentClient


@pytest.fixture
def fake_inhibit(tmp_path, monkeypatch):
    """A stand-in systemd-inhibit that skips its four options and runs the command, counting each start."""
    starts = tmp_path / "starts"
    script = tmp_path / "systemd-inhibit"
    script.write_text(f'#!/bin/sh\necho start >> {starts}\nshift 4\nexec "$@"\n')
    script.chmod(0o755)
    monkeypatch.setattr(inhibit.shutil, "which", lambda name: str(script))
    return lambda: len(starts.read_text().splitlines()) if starts.exists() else 0


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, raw):
        self.sent.append(proto.decode(raw))


class TestIdleInhibitor:
    async def test_holders_share_one_lock_released_after_the_linger(self, fake_inhibit):
        lock = inhibit.IdleInhibitor(linger=0.05)
        await lock.acquire()
        await lock.acquire()
        assert lock.is_locked
        lock.release()
        lock.release()
        assert lock.is_locked
        await asyncio.sleep(0.3)
        assert not lock.is_locked
        assert fake_inhibit() == 1

    async def test_a_hold_within_the_linger_keeps_the_same_lock(self, fake_inhibit):
        lock = inhibit.IdleInhibitor(linger=0.2)
        async with lock.held():
            pass
        async with lock.held():
            await asyncio.sleep(0.3)
            assert lock.is_locked
        await lock.close()
        assert not lock.is_locked
        assert fake_inhibit() == 1

    async def test_without_systemd_inhibit_a_hold_is_a_no_op(self, monkeypatch):
        monkeypatch.setattr(inhibit.shutil, "which", lambda name: None)
        lock = inhibit.IdleInhibitor(linger=0)
        async with lock.held():
            assert not lock.is_locked


class TestAgentHolds:
    async def test_a_command_runs_with_the_host_held_awake(self, monkeypatch):
        client = AgentClient("ws://unused", "test", None)
        seen = []

        async def fake_run(command, timeout):
            seen.append(client._inhibitor.holders)
            return 0, "", ""

        async def fake_send(frame):
            pass

        async def fake_acquire():
            client._inhibitor._holders += 1

        monkeypatch.setattr("x_monitor_agent.executor.run", fake_run)
        monkeypatch.setattr(client, "_send", fake_send)
        monkeypatch.setattr(client._inhibitor, "acquire", fake_acquire)
        monkeypatch.setattr(client._inhibitor, "release", lambda: setattr(client._inhibitor, "_holders", client._inhibitor._holders - 1))

        await client._handle_exec({'id': 1, 'cmd': 'true'})
        assert seen == [1]
        assert client._inhibitor.holders == 0

    async def test_server_holds_are_keyed_and_dropped_with_the_connection(self, fake_inhibit):
        client = AgentClient("ws://unused", "test", None)
        client._inhibitor = inhibit.IdleInhibitor(linger=0)

        await client._apply_server_hold(proto.inhibit("scan:1", True))
        await client._apply_server_hold(proto.inhibit("scan:1", True))
        await client._apply_server_hold(proto.inhibit("scan:2", True))
        assert client._inhibitor.holders == 2

        await client._apply_server_hold(proto.inhibit("scan:1", False))
        await client._apply_server_hold(proto.inhibit("scan:1", False))
        assert client._inhibitor.holders == 1

        client._release_server_holds()
        assert client._inhibitor.holders == 0
        await client._inhibitor.close()


class TestServerHolds:
    def test_bare_host_strips_the_user_and_port(self):
        assert engine_module.bare_host("deploy@Thor.technet") == "thor.technet"
        assert engine_module.bare_host("thor.technet:22") == "thor.technet"
        assert engine_module.bare_host("") == ""

    async def test_inhibit_skips_an_agent_without_the_capability(self):
        conn = AgentConnection("old", host="old.lan")
        socket = FakeSocket()
        conn.attach(socket, {'caps': [proto.NOTIFY]})
        await conn.inhibit("k", True)
        assert socket.sent == []

    async def test_a_cycle_holds_the_scanned_host_awake_and_releases_it(self):
        registry = AgentRegistry()
        registry.configure([{'id': name, 'host': f"{name}.technet"} for name in ("heimdall", "thor", "odin")])
        scanner, target, bystander = (registry.get(name) for name in ("heimdall", "thor", "odin"))
        sockets = {}
        for conn in (scanner, target, bystander):
            sockets[conn.agent_id] = FakeSocket()
            conn.attach(sockets[conn.agent_id], {'caps': [proto.INHIBIT]})

        engine = object.__new__(engine_module.XMonitorEngine)
        engine.connectors = SimpleNamespace(agents=registry)
        engine._exec_context_for = lambda plugin: SimpleNamespace(conn=scanner)
        plugin = SimpleNamespace(id="thor-vuln-scan", config={'scan_host': 'thor.technet'})

        async with engine._targets_held_awake(plugin):
            assert [f['hold'] for f in sockets["thor"].sent] == [True]

        frames = sockets["thor"].sent
        assert [f['hold'] for f in frames] == [True, False]
        assert frames[0]['key'] == frames[1]['key']
        assert sockets["heimdall"].sent == [] and sockets["odin"].sent == []
