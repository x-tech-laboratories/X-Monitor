"""The engine an agent runs: its plan's monitors collect through local processes and every write lands in the outbox."""

import yaml
import pytest

from x_monitor.core.connectors.local_connector import LocalConnection
from x_monitor.core.coordination.local_engine import LocalEngine
from x_monitor.core.database.agent_database import AgentDatabase
from x_monitor.core.database.database import db
from x_monitor_agent.local import plan_path, start_local_engine, stop_local_engine


@pytest.fixture(autouse=True)
def close_db():
    yield
    if not db.is_closed():
        db.close()


def _plan(state_dir, command="echo 42", schedule=None):
    monitor = {"name": "Answer", "id": "answer", "type": "command", "command": command,
               "pattern": r"(\d+)", "agent": "odin", "interval": 3600}
    if schedule:
        monitor["schedule"] = schedule
    plan_path(str(state_dir)).write_text(yaml.dump({"plugins": [monitor]}))


def _engine(tmp_path):
    _plan(tmp_path)
    engine = LocalEngine("odin", str(plan_path(str(tmp_path))), str(tmp_path / "agent.db"))
    engine.setup_modules()
    return engine


class TestLocalEngine:
    def test_its_own_agents_monitors_run_through_a_local_connection(self, tmp_path):
        engine = _engine(tmp_path)
        assert isinstance(engine._exec_context_for(engine.plugins[0]).conn, LocalConnection)
        assert isinstance(engine.db, AgentDatabase)

    def test_another_agents_monitor_still_goes_through_that_agents_socket(self, tmp_path):
        engine = _engine(tmp_path)
        assert not isinstance(engine.connectors.agent_connection("thor"), LocalConnection)

    async def test_a_cycle_collects_locally_and_lands_in_the_outbox(self, tmp_path):
        engine = _engine(tmp_path)
        engine.load_state()
        engine.ready = True
        await engine.run_cycle_now(engine.plugins[0])
        engine.db.flush()
        results = [payload for _, kind, payload in engine.db.pending() if kind == "result"]
        assert any(p["plugin_id"] == "answer" and p["metrics"].get("value") == 42.0 for p in results)
        assert engine.db.latest_status("answer") == "online"
        engine.shutdown()


class TestAgentStartup:
    async def test_no_plan_starts_no_engine(self, tmp_path):
        assert await start_local_engine("odin", str(tmp_path)) is None

    async def test_a_plan_starts_the_engine_over_its_monitors(self, tmp_path):
        _plan(tmp_path)
        engine = await start_local_engine("odin", str(tmp_path))
        try:
            assert [p.id for p in engine.all_monitors()] == ["answer"]
        finally:
            stop_local_engine(engine)
