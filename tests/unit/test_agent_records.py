"""An agent's records: encoding them, keeping them in the agent's outbox, and running commands locally."""

from datetime import datetime, timedelta

import pytest

from x_monitor.core.connectors.local_connector import LocalConnection
from x_monitor.core.connectors.types import CollectResult
from x_monitor.core.database.agent_database import AgentDatabase
from x_monitor.core.database.models import db
from x_monitor.core.sync import records


@pytest.fixture
def agent_db(tmp_path):
    if not db.is_closed():
        db.close()
    manager = AgentDatabase(str(tmp_path / "agent.db"))
    yield manager
    if not db.is_closed():
        db.close()


class TestEncoding:
    def test_a_result_survives_the_round_trip_with_its_time(self):
        when = datetime(2026, 10, 23, 2, 10)
        result = CollectResult(metrics={"used_pct": 41.5}, metadata={"used_pct": "x"},
                               logs=[("hi", "INFO")], log_lines=[("WARNING", "boom", "02:09")],
                               status="failed", snapshot=[{"pid": 1}], settings={"k": "v"}, timestamp=when)
        kind, payload = records.encode_result("odin", "disk", "Disk", result)
        target, plugin_id, name, back = records.decode_result(payload)
        assert (kind, target, plugin_id, name) == (records.RESULT, "odin", "disk", "Disk")
        assert back == result

    def test_a_result_without_a_time_is_stamped_when_recorded(self):
        now = datetime(2026, 10, 23, 3, 0)
        _, payload = records.encode_result("odin", "disk", "Disk", CollectResult(status="online"), now=now)
        assert records.decode_result(payload)[3].timestamp == now


class TestOutbox:
    def test_every_kind_of_write_becomes_a_record_in_order(self, agent_db):
        agent_db.apply_result("odin", "borg", "Borg", CollectResult(status="online"))
        job_id = agent_db.create_job("borg", "odin", "backup", "borg create")
        agent_db.set_job_pid(job_id, 42)
        agent_db.append_job_output(job_id, ["line"])
        agent_db.finish_job(job_id, "succeeded", exit_code=0)
        agent_db.set_setting("schedule-result:borg", "{}")
        kinds = [(kind, payload.get("step")) for _, kind, payload in agent_db.pending()]
        assert kinds == [("result", None), ("job", "create"), ("job", "pid"), ("job", "output"),
                         ("job", "finish"), ("setting", None)]

    def test_the_writes_still_reach_the_agents_own_store(self, agent_db):
        agent_db.apply_result("odin", "borg", "Borg", CollectResult(metrics={"archives": 3.0}))
        assert agent_db.store.latest_metric("borg", "archives").value == 3.0

    def test_acknowledged_records_are_forgotten(self, agent_db):
        for value in range(3):
            agent_db.apply_result("odin", "p", "P", CollectResult(metrics={"v": float(value)}))
        seqs = [seq for seq, _, _ in agent_db.pending()]
        agent_db.acknowledge(seqs[1])
        assert [seq for seq, _, _ in agent_db.pending()] == seqs[2:]

    def test_pending_reads_past_a_sequence_number(self, agent_db):
        for value in range(3):
            agent_db.apply_result("odin", "p", "P", CollectResult(metrics={"v": float(value)}))
        first = agent_db.pending()[0][0]
        assert len(agent_db.pending(after=first)) == 2

    def test_numbering_carries_on_after_a_restart(self, tmp_path):
        path = str(tmp_path / "agent.db")
        first = AgentDatabase(path)
        first.apply_result("odin", "p", "P", CollectResult(status="online"))
        last = first.pending()[-1][0]
        db.close()
        second = AgentDatabase(path, hydrate=False)
        second.apply_result("odin", "p", "P", CollectResult(status="online"))
        assert second.pending()[-1][0] == last + 1
        db.close()

    def test_trimming_drops_the_oldest_results_and_keeps_job_records(self, tmp_path):
        manager = AgentDatabase(str(tmp_path / "agent.db"), outbox_limit=2)
        manager.create_job("borg", "odin", "backup", "borg create")
        for value in range(3):
            manager.apply_result("odin", "p", "P", CollectResult(metrics={"v": float(value)},
                                                                 timestamp=datetime.now() - timedelta(minutes=3 - value)))
        assert manager.trim() == 2
        kinds = [kind for _, kind, _ in manager.pending()]
        assert kinds == ["job", "result"]
        db.close()


class TestLocalConnection:
    async def test_runs_a_command_here(self):
        assert await LocalConnection("odin").execute("echo hi; echo err >&2; exit 3") == (3, "hi\n", "err\n")

    async def test_a_timeout_maps_to_the_shared_failure_shape(self):
        code, out, err = await LocalConnection("odin").execute("sleep 5", timeout=0.2)
        assert code == -1 and out == "" and "Timed out" in err
