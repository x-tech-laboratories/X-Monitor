"""An agent that runs its host's monitors itself, end to end: a real server engine and endpoint, and a real agent process.

The agent runs as its own process, as it does in production, because the database handle is
process-wide and the server and the agent each need their own."""

import asyncio
import contextlib
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest
import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from x_monitor.core.coordination.engine import XMonitorEngine
from x_monitor.core.database.database import db

pytest.importorskip("uvicorn")
pytest.importorskip("fastapi")

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def close_db():
    yield
    if not db.is_closed():
        db.close()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@contextlib.asynccontextmanager
async def _endpoint(engine: XMonitorEngine, port: int):
    """The agent endpoint the dashboard serves, alone, on `port`."""
    import uvicorn
    from fastapi import FastAPI
    from x_monitor.core.ui.agent_endpoint import register_agent_endpoint

    app = FastAPI()
    register_agent_endpoint(app, engine.connectors.agents)
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='error'))
    task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    try:
        yield
    finally:
        server.should_exit = True
        await task


async def _until(condition, timeout: float = 30.0, what: str = "the condition"):
    for _ in range(int(timeout / 0.2)):
        if condition():
            return
        await asyncio.sleep(0.2)
    pytest.fail(f"timed out waiting for {what}")


@pytest.fixture
def fleet(tmp_path):
    """A server config with one agent set to run its monitors, and that agent's own config and key."""
    key = Ed25519PrivateKey.generate()
    key_file = tmp_path / "agent.key"
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                           serialization.NoEncryption()))
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH,
                                           serialization.PublicFormat.OpenSSH).decode()
    port = _free_port()
    server_config = tmp_path / "config.yaml"
    server_config.write_text(yaml.dump({
        "database": {"path": str(tmp_path / "server.db")},
        "agents": [{"id": "node-a", "public_key": public, "run_monitors": True}],
        "plugins": [{"name": "Answer", "id": "answer", "type": "command", "command": "echo 42",
                     "pattern": r"(\d+)", "agent": "node-a", "interval": 2,
                     "actions": [{"name": "Hello", "command": "echo hello"}]}],
    }))
    agent_config = tmp_path / "agent.yaml"
    agent_config.write_text(yaml.dump({
        "url": f"ws://127.0.0.1:{port}/api/agent/ws", "id": "node-a",
        "key_file": str(key_file), "state_dir": str(tmp_path / "agent-state"),
    }))
    return server_config, agent_config, port


@contextlib.contextmanager
def _agent_process(agent_config: Path):
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    process = subprocess.Popen([sys.executable, "-m", "x_monitor_agent", "--config", str(agent_config)],
                               env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        yield process
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


async def test_an_agent_takes_its_monitors_runs_them_and_syncs_back_what_it_did_offline(fleet):
    server_config, agent_config, port = fleet
    engine = XMonitorEngine(str(server_config))
    engine.setup_modules()
    plugin = engine.plugins[0]
    await engine.run()
    try:
        with _agent_process(agent_config):
            async with _endpoint(engine, port):
                await _until(lambda: engine.agent_plans.runs(plugin), what="the agent to take the monitor")
                await _until(lambda: (engine.db.latest_metric("answer", "value") or None) is not None,
                             what="a synced result")
                assert engine.db.latest_metric("answer", "value").value == 42.0

                success, metadata = await engine.dispatch_action(plugin, "custom:hello")
                assert success, metadata

            # The server is unreachable now; the agent keeps collecting on its own.
            gap_start = engine.db.latest_metric("answer", "value").timestamp
            await asyncio.sleep(6)

            async with _endpoint(engine, port):
                await _until(lambda: engine.db.latest_metric("answer", "value").timestamp > gap_start,
                             what="the offline records to sync")
                history = engine.db.store.metric_history("answer", "value", limit=0)
                assert sum(1 for m in history if m.timestamp > gap_start) >= 2
    finally:
        engine.shutdown()
