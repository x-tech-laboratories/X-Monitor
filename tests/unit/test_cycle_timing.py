"""Per-monitor cycle timing: the engine's rolling window and the SSH channel wait it records."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml

from vigil.core.connectors.ssh_connector import SSHConnection, measure_channel_wait
from vigil.core.connectors.types import CmdResult, CollectResult, Command
from vigil.core.coordination.cycle_stats import CycleStats
from vigil.core.coordination.engine import VigilEngine
from vigil.core.database.database import db
from tests.unit.test_ssh_transport import _mock_conn_and_proc


@pytest.fixture(autouse=True)
def close_db():
    yield
    if not db.is_closed():
        db.close()


class TestCycleStats:
    def test_nothing_recorded_is_none(self):
        assert CycleStats().get("cpu") is None

    def test_last_avg_and_max(self):
        stats = CycleStats()
        for seconds in (1.0, 3.0, 2.0):
            stats.record("cpu", seconds, wait_seconds=seconds / 10)
        timing = stats.get("cpu")
        assert timing.last_seconds == 2.0
        assert timing.avg_seconds == pytest.approx(2.0)
        assert timing.max_seconds == 3.0
        assert timing.last_wait_seconds == pytest.approx(0.2)
        assert timing.avg_wait_seconds == pytest.approx(0.2)
        assert timing.cycles == 3

    def test_window_drops_the_oldest(self):
        stats = CycleStats(window=2)
        for seconds in (10.0, 1.0, 1.0):
            stats.record("cpu", seconds)
        assert stats.get("cpu").max_seconds == 1.0

    def test_forget(self):
        stats = CycleStats()
        stats.record("cpu", 1.0)
        stats.forget("cpu")
        assert stats.get("cpu") is None


class TestChannelWait:
    async def test_nothing_is_measured_outside_the_block(self):
        conn = SSHConnection("host")
        mock_conn, _ = _mock_conn_and_proc(0, "ok")
        with patch.object(conn, "_get_connection", AsyncMock(return_value=mock_conn)):
            assert (await conn.execute("true"))[0] == 0

    async def test_a_free_channel_waits_almost_nothing(self):
        conn = SSHConnection("host")
        mock_conn, _ = _mock_conn_and_proc(0, "ok")
        with patch.object(conn, "_get_connection", AsyncMock(return_value=mock_conn)):
            with measure_channel_wait() as wait:
                await conn.execute("true")
        assert 0 <= wait.seconds < 0.05

    async def test_a_command_queued_behind_a_full_host_is_measured(self):
        conn = SSHConnection("host")
        conn._channel_semaphore = asyncio.Semaphore(1)
        mock_conn, _ = _mock_conn_and_proc(0, "ok")
        with patch.object(conn, "_get_connection", AsyncMock(return_value=mock_conn)):
            await conn._channel_semaphore.acquire()
            asyncio.get_running_loop().call_later(0.1, conn._channel_semaphore.release)
            with measure_channel_wait() as wait:
                await conn.execute("true")
        assert wait.seconds >= 0.09

    async def test_commands_in_child_tasks_report_to_the_block(self):
        conn = SSHConnection("host")
        conn._channel_semaphore = asyncio.Semaphore(1)
        mock_conn, _ = _mock_conn_and_proc(0, "ok")
        with patch.object(conn, "_get_connection", AsyncMock(return_value=mock_conn)):
            await conn._channel_semaphore.acquire()
            asyncio.get_running_loop().call_later(0.1, conn._channel_semaphore.release)
            with measure_channel_wait() as wait:
                await asyncio.gather(conn.execute("a"), conn.execute("b"))
        assert wait.seconds >= 0.09


class _Probe:
    """A minimal pure plugin with one SSH command."""
    AVAILABILITY = False
    children = []

    def __init__(self, plugin_id="probe", requests=True):
        self.id = self.name = plugin_id
        self.target = "host"
        self._requests = requests

    def io_call(self):
        return None

    def requests(self):
        return [Command("true")] if self._requests else []

    def parse_results(self, results):
        return CollectResult(status="online")


def _engine(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.dump({"database": {"path": str(tmp_path / "t.db")}, "plugins": []}))
    with patch("vigil.core.connectors.engine.SSHConnection"):
        return VigilEngine(str(cfg))


class TestEngineRecordsCycles:
    async def test_a_cycle_with_io_is_timed(self, tmp_path):
        engine = _engine(tmp_path)
        engine.connectors.dispatch = AsyncMock(return_value=[CmdResult(0, "", "")])
        plugin = _Probe()
        await engine._run_cycle(plugin)
        timing = engine.cycle_timing("probe")
        assert timing is not None and timing.cycles == 1
        assert timing.last_seconds >= 0

    async def test_a_cycle_without_io_is_not_timed(self, tmp_path):
        engine = _engine(tmp_path)
        await engine._run_cycle(_Probe(requests=False))
        assert engine.cycle_timing("probe") is None

    async def test_timing_is_kept_when_the_timing_metrics_are_off(self, tmp_path):
        engine = _engine(tmp_path)
        engine._cycle_timings = False
        engine.connectors.dispatch = AsyncMock(return_value=[CmdResult(0, "", "")])
        await engine._run_cycle(_Probe())
        assert engine.cycle_timing("probe") is not None
        assert engine.db.latest_metric("probe", "cycle_collect_seconds") is None

    async def test_channel_wait_reaches_the_timing(self, tmp_path):
        engine = _engine(tmp_path)
        conn = SSHConnection("host")
        conn._channel_semaphore = asyncio.Semaphore(1)
        mock_conn, _ = _mock_conn_and_proc(0, "ok")
        engine._exec_contexts["probe"] = MagicMock(conn=conn, collect_timeout=30.0)
        with patch.object(conn, "_get_connection", AsyncMock(return_value=mock_conn)):
            await conn._channel_semaphore.acquire()
            asyncio.get_running_loop().call_later(0.1, conn._channel_semaphore.release)
            await engine._run_cycle(_Probe())
        assert engine.cycle_timing("probe").last_wait_seconds >= 0.09
