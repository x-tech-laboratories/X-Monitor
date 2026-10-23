"""The engine an agent runs: its plan's monitors collect through local processes and every write lands in the outbox."""

import yaml
import pytest

from x_monitor.core.connectors.local_connector import LocalConnection
from x_monitor.core.coordination.local_engine import LocalEngine
from x_monitor.core.database.agent_database import AgentDatabase
from x_monitor.core.database.database import db
from x_monitor_agent.local import LocalRunner, plan_path


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


class TestLocalRunner:
    async def test_no_plan_starts_no_engine(self, tmp_path):
        runner = LocalRunner("odin", str(tmp_path))
        await runner.start()
        assert runner.engine is None and runner.pending(0) == []

    async def test_a_stored_plan_starts_the_engine_over_its_monitors(self, tmp_path):
        _plan(tmp_path)
        runner = LocalRunner("odin", str(tmp_path))
        await runner.start()
        try:
            assert [p.id for p in runner.engine.all_monitors()] == ["answer"]
        finally:
            runner.stop()

    async def test_a_plan_from_the_server_is_stored_and_run(self, tmp_path):
        runner = LocalRunner("odin", str(tmp_path / "state"))
        config = {"plugins": [{"name": "Answer", "id": "answer", "type": "command",
                               "command": "echo 1", "agent": "odin", "interval": 3600}]}
        await runner.apply_plan("v1", config)
        try:
            assert runner.plan_version == "v1"
            assert [p.id for p in runner.engine.all_monitors()] == ["answer"]
        finally:
            runner.stop()

    async def test_a_new_plan_reloads_the_running_engine_in_place(self, tmp_path):
        runner = LocalRunner("odin", str(tmp_path / "state"))
        monitor = {"name": "Answer", "id": "answer", "type": "command", "command": "echo 1",
                   "agent": "odin", "interval": 3600}
        await runner.apply_plan("v1", {"plugins": [monitor]})
        engine = runner.engine
        await runner.apply_plan("v2", {"plugins": [monitor, {**monitor, "id": "second", "name": "Second"}]})
        try:
            assert runner.engine is engine
            assert sorted(p.id for p in engine.all_monitors()) == ["answer", "second"]
        finally:
            runner.stop()

    async def test_records_are_served_and_acknowledged(self, tmp_path):
        _plan(tmp_path)
        runner = LocalRunner("odin", str(tmp_path))
        await runner.start()
        try:
            await runner.poll_now("answer")
            runner.engine.db.flush()
            batch = runner.pending(0)
            assert batch and batch[0][1] in ("result", "setting")
            runner.acknowledge(batch[-1][0])
            runner.engine.db.flush()
            assert runner.pending(0) == []
        finally:
            runner.stop()

    async def test_an_action_resent_after_a_reconnect_runs_once(self, tmp_path):
        _plan(tmp_path)
        runner = LocalRunner("odin", str(tmp_path))
        await runner.start()
        calls = []

        async def dispatch(plugin, action_id, **kwargs):
            calls.append(action_id)
            return True, {"content": "done"}

        runner.engine.dispatch_action = dispatch
        try:
            first = await runner.run_action("r1", "answer", "custom:x", {})
            again = await runner.run_action("r1", "answer", "custom:x", {})
            assert first == again == (True, "done") and calls == ["custom:x"]
        finally:
            runner.stop()

    async def test_an_action_on_a_monitor_it_does_not_run_is_refused(self, tmp_path):
        _plan(tmp_path)
        runner = LocalRunner("odin", str(tmp_path))
        await runner.start()
        try:
            success, content = await runner.run_action("r2", "nope", "run", {})
            assert not success and "nope" in content
        finally:
            runner.stop()
