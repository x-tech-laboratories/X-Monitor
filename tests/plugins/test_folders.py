import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.folders import Folders
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

_GB = 1024 ** 3


def _latest_status(pid="test-folders"):
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == pid
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric, name="test-folders"):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _cfg(**extra):
    base = {"name": "test-folders", "id": "test-folders", "ssh_config": {"host": "test.host"}}
    base.update(extra)
    return base


class TestFoldersCollection:
    async def test_under_thresholds_online(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[
            {"path": "/var/log", "warning": 5, "threshold": 10},
        ]))
        run_cycle(p, lambda c: CmdResult(0, f"{2 * _GB}\t/var/log", ""))
        assert _latest_status() == "online"
        assert _latest_metric("folder_var_log_gb") == pytest.approx(2.0)

    async def test_over_warning(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[
            {"path": "/data", "warning": 5, "threshold": 10},
        ]))
        run_cycle(p, lambda c: CmdResult(0, f"{7 * _GB}\t/data", ""))
        assert _latest_status() == "warning"

    async def test_over_threshold_failed(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[
            {"path": "/data", "warning": 5, "threshold": 10},
        ]))
        run_cycle(p, lambda c: CmdResult(0, f"{12 * _GB}\t/data", ""))
        assert _latest_status() == "failed"

    async def test_worst_across_folders(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[
            {"path": "/a", "warning": 5, "threshold": 10},
            {"path": "/b", "warning": 5, "threshold": 10},
        ]))
        outputs = [
            CmdResult(0, f"{2 * _GB}\t/a", ""),
            CmdResult(0, f"{12 * _GB}\t/b", ""),
        ]
        run_cycle(p, lambda c, _it=iter(outputs): next(_it))
        assert _latest_status() == "failed"

    async def test_size_only_no_thresholds_online(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[{"path": "/media"}]))
        run_cycle(p, lambda c: CmdResult(0, f"{999 * _GB}\t/media", ""))
        assert _latest_status() == "online"

    async def test_du_timeout_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[{"path": "/huge"}], timeout=1))
        run_cycle(p, lambda c: CmdResult(124, "", ""))
        assert _latest_status() == "unavailable"

    async def test_missing_folder_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[{"path": "/nope"}]))
        run_cycle(p, lambda c: CmdResult(1, "", "du: cannot access"))
        assert _latest_status() == "unavailable"

    async def test_measured_breach_outranks_an_unmeasured_folder(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[
            {"path": "/a", "warning": 5, "threshold": 10},
            {"path": "/b"},
        ]))
        outputs = [
            CmdResult(0, f"{12 * _GB}\t/a", ""),
            CmdResult(1, "", "du: cannot access"),
        ]
        run_cycle(p, lambda c, _it=iter(outputs): next(_it))
        assert _latest_status() == "failed"

    async def test_no_folders_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg())
        run_cycle(p, lambda c: CmdResult(0, "", ""))
        assert _latest_status() == "unavailable"


class TestFoldersActions:
    async def test_on_action_returns_false(self, make_plugin):
        p = make_plugin(Folders, _cfg(folders=[{"path": "/x"}]))
        assert p.plan_action("anything") is None


class TestUiSpec:
    async def test_folders_are_meters_filled_against_the_largest_folder(self, make_plugin, run_cycle):
        p = make_plugin(Folders, _cfg(folders=[{"path": "/a"}, {"path": "/b"}]))
        run_cycle(p, lambda c: CmdResult(0, f"{8 * _GB if '/b' in c.text else 2 * _GB}\t/x", ""))
        repeat = p.UI_SPEC['cards']['folders']['repeat']
        assert repeat['container'] == 'bars'
        assert repeat['bar_max'] == pytest.approx(8.0)
        assert repeat['item_color_by'] == p._item_color

    async def test_meters_are_empty_before_any_reading(self, make_plugin):
        p = make_plugin(Folders, _cfg(folders=[{"path": "/a"}]))
        assert p.UI_SPEC['cards']['folders']['repeat']['bar_max'] == 0.0

    async def test_the_meters_make_the_largest_card_redundant(self, make_plugin):
        spec = make_plugin(Folders, _cfg(folders=[{"path": "/a"}])).UI_SPEC
        assert 'worst_card' not in spec['cards']
        assert 'worst_card' not in {cell for row in spec['layout'] for cell in row}
