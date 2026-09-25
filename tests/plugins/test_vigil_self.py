import time
from unittest.mock import MagicMock, patch

import pytest

from vigil.plugins.vigil_self import (
    VigilSelfPlugin,
    _format_uptime,
    _read_rss_mb,
    _read_cpu_seconds,
)
from vigil.core.coordination.cycle_stats import CycleTiming
from vigil.core.database.database import db, StatusHistory, Metric


BASE_CFG = {
    "name": "test-self",
    "id":   "test-self",
    "memory_warning":   256,
    "memory_threshold": 512,
    "stale_warning":     3,
    "stale_threshold":  10,
}


def _make_engine(plugins, last_collected=None, timings=None):
    collected = last_collected or {}
    timed = timings or {}
    return MagicMock(plugins=plugins,
                     last_collected=lambda pid: collected.get(pid, 0.0),
                     cycle_timing=lambda pid: timed.get(pid))


def _timing(avg, last=None, peak=None, wait=0.0):
    return CycleTiming(last_seconds=avg if last is None else last, avg_seconds=avg,
                       max_seconds=avg if peak is None else peak,
                       last_wait_seconds=wait, avg_wait_seconds=wait, cycles=3)


@pytest.fixture
def plugin(make_plugin):
    p = make_plugin(VigilSelfPlugin, BASE_CFG)
    p.engine = _make_engine([])
    yield p
    VigilSelfPlugin.engine = None


def _latest_status(plugin_id: str = "test-self") -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == plugin_id
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str, name: str = "test-self") -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _fake_monitor(monitor_id: str, interval: float, children=None):
    m = MagicMock()
    m.id = monitor_id
    m.name = monitor_id
    m.interval = interval
    m.children = children or []
    return m


def _run(plugin, run_io_cycle):
    return run_io_cycle(plugin)


class TestFormatUptime:
    def test_minutes_only(self):
        assert _format_uptime(300) == "5m"

    def test_hours_and_minutes(self):
        assert _format_uptime(3900) == "1h 5m"

    def test_days_and_hours(self):
        assert _format_uptime(280800) == "3d 6h"


class TestProcReaders:
    def test_rss_is_positive(self):
        assert _read_rss_mb() > 0

    def test_cpu_seconds_is_non_negative(self):
        assert _read_cpu_seconds() >= 0

    def test_rss_returns_none_when_proc_unreadable(self):
        with patch("builtins.open", side_effect=OSError("no /proc")):
            assert _read_rss_mb() is None

    def test_cpu_returns_none_when_proc_unreadable(self):
        with patch("builtins.open", side_effect=OSError("no /proc")):
            assert _read_cpu_seconds() is None


class TestSelfCollection:
    async def test_healthy_process_sets_online(self, plugin, run_io_cycle):
        _run(plugin, run_io_cycle)
        assert _latest_status() == "online"

    async def test_uptime_metric_recorded(self, plugin, run_io_cycle):
        _run(plugin, run_io_cycle)
        assert _latest_metric("uptime_seconds") is not None

    async def test_memory_metric_recorded(self, plugin, run_io_cycle):
        _run(plugin, run_io_cycle)
        assert _latest_metric("memory_mb") > 0

    async def test_sample_that_raises_is_unavailable(self, plugin, run_io_cycle):
        with patch("vigil.plugins.vigil_self._read_rss_mb", side_effect=RuntimeError("boom")):
            _run(plugin, run_io_cycle)
        assert _latest_status() == "unavailable"
        assert _latest_metric("uptime_seconds") is None

    async def test_memory_above_threshold_sets_failed(self, plugin, run_io_cycle):
        with patch("vigil.plugins.vigil_self._read_rss_mb", return_value=600.0):
            _run(plugin, run_io_cycle)
        assert _latest_status() == "failed"

    async def test_memory_above_warning_sets_warning(self, plugin, run_io_cycle):
        with patch("vigil.plugins.vigil_self._read_rss_mb", return_value=300.0):
            _run(plugin, run_io_cycle)
        assert _latest_status() == "warning"

    async def test_unreadable_memory_does_not_fail(self, plugin, run_io_cycle):
        with patch("vigil.plugins.vigil_self._read_rss_mb", return_value=None):
            _run(plugin, run_io_cycle)
        assert _latest_status() == "online"

    async def test_first_collection_records_no_cpu(self, plugin, run_io_cycle):
        _run(plugin, run_io_cycle)
        assert _latest_metric("cpu_pct") is None

    async def test_second_collection_records_cpu(self, plugin, run_io_cycle):
        _run(plugin, run_io_cycle)
        _run(plugin, run_io_cycle)
        assert _latest_metric("cpu_pct") is not None


class TestCollectionHealth:
    async def test_counts_only_leaf_monitors(self, plugin, run_io_cycle):
        now = time.monotonic()
        leaf = _fake_monitor("leaf", 60)
        group = _fake_monitor("group", 60, children=[leaf])
        plugin.engine = _make_engine([group], {"leaf": now, "group": now})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_total") == 1.0

    async def test_fresh_monitors_are_not_late(self, plugin, run_io_cycle):
        now = time.monotonic()
        m = _fake_monitor("fresh", 60)
        plugin.engine = _make_engine([m], {"fresh": now})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_late") == 0.0
        assert _latest_status() == "online"

    async def test_late_monitor_sets_warning(self, plugin, run_io_cycle):
        stale = time.monotonic() - (60 * 4)
        m = _fake_monitor("late", 60)
        plugin.engine = _make_engine([m], {"late": stale})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_late") == 1.0
        assert _latest_status() == "warning"

    async def test_stalled_monitor_sets_failed(self, plugin, run_io_cycle):
        stale = time.monotonic() - (60 * 12)
        m = _fake_monitor("stalled", 60)
        plugin.engine = _make_engine([m], {"stalled": stale})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_stalled") == 1.0
        assert _latest_status() == "failed"

    async def test_the_default_late_bound_clears_the_quiet_window(self, make_plugin,
                                                                  run_io_cycle):
        """A pushed monitor is only guaranteed an event every
        SAMPLE_MAX_QUIET_INTERVALS, so the default must not read that silence
        as late."""
        from vigil.plugins.base.plugin_base import Plugin
        cfg = {k: v for k, v in BASE_CFG.items() if k != "stale_warning"}
        p = make_plugin(VigilSelfPlugin, cfg)
        quiet = time.monotonic() - (60 * Plugin.SAMPLE_MAX_QUIET_INTERVALS)
        m = _fake_monitor("quiet", 60)
        p.engine = _make_engine([m], {"quiet": quiet})
        try:
            _run(p, run_io_cycle)
            assert _latest_metric("monitors_late") == 0.0
            assert _latest_status() == "online"
        finally:
            VigilSelfPlugin.engine = None

    async def test_never_collected_monitor_is_not_stalled(self, plugin, run_io_cycle):
        m = _fake_monitor("new", 3600)
        plugin.engine = _make_engine([m], {"new": 0.0})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_stalled") == 0.0
        assert _latest_status() == "online"

    async def test_staleness_is_relative_to_each_interval(self, plugin, run_io_cycle):
        ten_min_ago = time.monotonic() - 600
        hourly = _fake_monitor("hourly", 3600)
        frequent = _fake_monitor("frequent", 30)
        plugin.engine = _make_engine([hourly, frequent], {"hourly": ten_min_ago, "frequent": ten_min_ago})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_total") == 2.0
        assert _latest_metric("monitors_stalled") == 1.0

    async def test_stalled_outranks_healthy_memory(self, plugin, run_io_cycle):
        stale = time.monotonic() - (60 * 12)
        m = _fake_monitor("stalled", 60)
        plugin.engine = _make_engine([m], {"stalled": stale})
        with patch("vigil.plugins.vigil_self._read_rss_mb", return_value=10.0):
            _run(plugin, run_io_cycle)
        assert _latest_status() == "failed"

    async def test_no_engine_reports_zero_monitors(self, plugin, run_io_cycle):
        plugin.engine = None
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_total") == 0.0
        assert _latest_status() == "online"

    async def test_excludes_itself_from_the_count(self, plugin, run_io_cycle):
        plugin.engine = _make_engine([plugin])
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_total") == 0.0


class TestCycleTimings:
    async def test_rows_are_sorted_slowest_first(self, plugin, run_io_cycle):
        fast, slow = _fake_monitor("fast", 60), _fake_monitor("slow", 60)
        plugin.engine = _make_engine([fast, slow], timings={"fast": _timing(0.2), "slow": _timing(4.0)})
        _run(plugin, run_io_cycle)
        rows = plugin.data.latest_snapshot()
        assert [r["id"] for r in rows] == ["slow", "fast"]

    async def test_row_carries_last_avg_max_wait_and_share(self, plugin, run_io_cycle):
        m = _fake_monitor("host-cpu", 20)
        plugin.engine = _make_engine([m], timings={"host-cpu": _timing(2.0, last=1.0, peak=5.0, wait=0.5)})
        _run(plugin, run_io_cycle)
        row = plugin.data.latest_snapshot()[0]
        assert (row["last"], row["avg"], row["max"], row["wait"]) == (1.0, 2.0, 5.0, 0.5)
        assert row["share"] == 10.0
        assert row["slow"] is False

    async def test_monitor_without_a_timed_cycle_is_left_out(self, plugin, run_io_cycle):
        m = _fake_monitor("pushed", 60)
        plugin.engine = _make_engine([m])
        _run(plugin, run_io_cycle)
        assert plugin.data.latest_snapshot() == []
        assert _latest_metric("slowest_cycle_seconds") is None

    async def test_groups_are_left_out(self, plugin, run_io_cycle):
        leaf = _fake_monitor("leaf", 60)
        group = _fake_monitor("group", 60, children=[leaf])
        plugin.engine = _make_engine([group], timings={"leaf": _timing(1.0), "group": _timing(1.0)})
        _run(plugin, run_io_cycle)
        assert [r["id"] for r in plugin.data.latest_snapshot()] == ["leaf"]

    async def test_cycle_past_half_the_interval_is_slow(self, plugin, run_io_cycle):
        m = _fake_monitor("crawl", 10)
        plugin.engine = _make_engine([m], timings={"crawl": _timing(6.0)})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_slow") == 1.0
        assert _latest_metric("slowest_cycle_seconds") == 6.0
        assert _latest_status() == "warning"

    async def test_slow_fraction_is_configurable(self, make_plugin, run_io_cycle):
        p = make_plugin(VigilSelfPlugin, {**BASE_CFG, "slow_cycle_fraction": 0.9})
        m = _fake_monitor("crawl", 10)
        p.engine = _make_engine([m], timings={"crawl": _timing(6.0)})
        try:
            _run(p, run_io_cycle)
            assert _latest_metric("monitors_slow") == 0.0
            assert _latest_status() == "online"
        finally:
            VigilSelfPlugin.engine = None

    async def test_slow_seconds_flags_a_long_cycle_on_a_long_interval(self, make_plugin, run_io_cycle):
        p = make_plugin(VigilSelfPlugin, {**BASE_CFG, "slow_cycle_seconds": 5})
        m = _fake_monitor("hourly", 3600)
        p.engine = _make_engine([m], timings={"hourly": _timing(8.0)})
        try:
            _run(p, run_io_cycle)
            assert _latest_metric("monitors_slow") == 1.0
            assert p.data.latest_snapshot()[0]["slow"] is True
        finally:
            VigilSelfPlugin.engine = None

    async def test_slow_seconds_is_off_by_default(self, plugin, run_io_cycle):
        m = _fake_monitor("hourly", 3600)
        plugin.engine = _make_engine([m], timings={"hourly": _timing(60.0)})
        _run(plugin, run_io_cycle)
        assert _latest_metric("monitors_slow") == 0.0

    async def test_slow_monitor_is_named_in_the_log(self, plugin, run_io_cycle):
        m = _fake_monitor("crawl", 10)
        plugin.engine = _make_engine([m], timings={"crawl": _timing(6.0)})
        result = _run(plugin, run_io_cycle)
        assert "slow: crawl (6.0s of 10s)" in result.logs[0][0]

    async def test_stalled_outranks_slow(self, plugin, run_io_cycle):
        stale = time.monotonic() - (60 * 12)
        m = _fake_monitor("both", 60)
        plugin.engine = _make_engine([m], {"both": stale}, timings={"both": _timing(50.0)})
        _run(plugin, run_io_cycle)
        assert _latest_status() == "failed"

    def test_slow_row_is_colored_warning(self, plugin):
        assert plugin._slow_row_color({"slow": True}) == "warning"
        assert plugin._slow_row_color({"slow": False}) is None

    def test_spec_lays_out_the_timings_table(self, plugin):
        spec = plugin.UI_SPEC
        assert ["timings"] in spec["layout"]
        assert [c["field"] for c in spec["tables"]["timings"]["columns"]] == [
            "name", "interval", "last", "avg", "max", "wait", "share"]


class TestSelfActions:
    async def test_on_action_always_returns_false(self, plugin):
        assert plugin.plan_action("anything") is None
