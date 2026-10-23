"""The server's side of agents that run their monitors: what goes in a plan, who runs what, and an agent going quiet."""

import time

import pytest
import yaml

from x_monitor.core.coordination.engine import XMonitorEngine
from x_monitor.core.database.database import db


@pytest.fixture(autouse=True)
def close_db():
    yield
    if not db.is_closed():
        db.close()


def _engine(tmp_path, run_monitors=True):
    config = tmp_path / "config.yaml"
    config.write_text(yaml.dump({
        "database": {"path": str(tmp_path / "server.db")},
        "agents": [{"id": "node-a", "run_monitors": run_monitors}, {"id": "node-b"}],
        "plugins": [
            {"name": "Disk", "id": "disk", "type": "disk_space", "path": "/", "agent": "node-a"},
            {"name": "Site", "id": "site", "type": "http", "url": "http://127.0.0.1:1", "agent": "node-a"},
            {"name": "Other", "id": "other", "type": "disk_space", "path": "/", "agent": "node-b"},
            {"name": "Host", "id": "host", "type": "group", "agent": "node-a", "children": [
                {"name": "Load", "id": "load", "type": "load"}]},
        ],
    }))
    engine = XMonitorEngine(str(config))
    engine.setup_modules()
    engine.load_state()
    engine.ready = True
    return engine


def _monitor(engine, monitor_id):
    return next(p for p in engine.all_monitors() if p.id == monitor_id)


def _take(engine, agent_id, monitor_ids):
    engine.agent_plans._acked[agent_id] = ("v", set(monitor_ids))


class TestPlans:
    def test_a_plan_holds_the_agents_host_local_monitors_including_inherited_ones(self, tmp_path):
        _, config, ids = _engine(tmp_path).agent_plans.compile("node-a")
        assert sorted(ids) == ["disk", "load"]
        assert {p["id"] for p in config["plugins"]} == {"disk", "load"}

    def test_the_version_follows_the_content(self, tmp_path):
        engine = _engine(tmp_path)
        assert engine.agent_plans.compile("node-a")[0] == engine.agent_plans.compile("node-a")[0]
        assert engine.agent_plans.compile("node-a")[0] != engine.agent_plans.compile("node-b")[0]


class TestWhoRunsWhat:
    def test_the_server_runs_everything_until_an_agent_acknowledges_a_plan(self, tmp_path):
        engine = _engine(tmp_path)
        assert not engine.agent_plans.runs(_monitor(engine, "disk"))

    def test_an_acknowledged_monitor_is_the_agents(self, tmp_path):
        engine = _engine(tmp_path)
        _take(engine, "node-a", ["disk"])
        assert engine.agent_plans.runs(_monitor(engine, "disk"))
        assert not engine.agent_plans.runs(_monitor(engine, "site"))

    def test_turning_run_monitors_off_gives_the_monitors_back_to_the_server(self, tmp_path):
        engine = _engine(tmp_path, run_monitors=False)
        _take(engine, "node-a", ["disk"])
        assert not engine.agent_plans.runs(_monitor(engine, "disk"))

    def test_the_server_does_not_run_an_agent_run_monitors_schedule(self, tmp_path):
        engine = _engine(tmp_path)
        _take(engine, "node-a", ["disk"])
        engine.agent_plans._acked["node-a"] = ("v", {"disk"})
        plugin = _monitor(engine, "disk")
        plugin.scheduled_actions = [object()]
        engine._start_due_schedules(time.time())
        assert not engine._scheduled_running


class TestSilence:
    def test_a_quiet_agent_marks_its_monitor_unavailable_once(self, tmp_path):
        engine = _engine(tmp_path)
        _take(engine, "node-a", ["disk"])
        plugin = _monitor(engine, "disk")
        engine.agent_plans._last_record["disk"] = time.monotonic() - 3600
        engine.agent_plans.check_silence(plugin)
        engine.agent_plans.check_silence(plugin)
        assert engine.db.latest_status("disk") == "unavailable"
        assert len([e for e in engine.db.store.recent_events() if "has sent nothing" in e.message]) == 1

    def test_a_recent_record_keeps_the_monitor_as_it_is(self, tmp_path):
        engine = _engine(tmp_path)
        _take(engine, "node-a", ["disk"])
        engine.agent_plans._last_record["disk"] = time.monotonic()
        engine.agent_plans.check_silence(_monitor(engine, "disk"))
        assert "disk" not in engine.agent_plans._silent
