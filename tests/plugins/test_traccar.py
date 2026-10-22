import json
from datetime import datetime, timedelta, timezone

import pytest

from x_monitor.plugins.traccar import Traccar, _age_hours
from x_monitor.core.connectors.types import HttpRequest, HttpResult
from x_monitor.core.database.database import db, StatusHistory, Metric

pytestmark = pytest.mark.asyncio


BASE_CFG = {
    "name": "test-traccar",
    "id":   "test-traccar",
    "api_url": "http://traccar.test:8082",
    "username": "x-monitor",
    "password": "hunter2",
    "stale_warning": 24,
    "stale_threshold": 72,
    "ssh_config": {"host": "test.host"},
}


def _iso(hours_ago: float) -> str:
    ts = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    return ts.isoformat().replace('+00:00', 'Z')


def _device(name="Phone", hours_ago=1.0, disabled=False):
    return {"name": name, "disabled": disabled, "lastUpdate": _iso(hours_ago)}


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Traccar, BASE_CFG)


def _run(plugin, run_requests, devices=None):
    payload = json.dumps(devices if devices is not None else [_device()])
    run_requests(plugin, lambda r: HttpResult(status_code=200, text=payload))


def _latest_status(plugin_id: str = "test-traccar") -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == plugin_id
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str, name: str = "test-traccar") -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


class TestAgeHours:
    def test_recent_timestamp(self):
        age = _age_hours(_iso(2.0))
        assert age == pytest.approx(2.0, abs=0.1)

    def test_none_returns_none(self):
        assert _age_hours(None) is None

    def test_unparseable_returns_none(self):
        assert _age_hours("not-a-date") is None


class TestRequests:
    def test_targets_devices_with_basic_auth(self, plugin):
        reqs = plugin.requests()
        assert len(reqs) == 1
        assert isinstance(reqs[0], HttpRequest)
        assert reqs[0].url == "http://traccar.test:8082/api/devices"
        assert reqs[0].auth == ("x-monitor", "hunter2")

    def test_no_url_yields_no_requests(self, make_plugin):
        p = make_plugin(Traccar, {"name": "t", "id": "t", "username": "x-monitor",
                                  "ssh_config": {"host": "h"}})
        assert p.requests() == []

    def test_no_username_yields_no_requests(self, make_plugin):
        cfg = {k: v for k, v in BASE_CFG.items() if k != "username"}
        p = make_plugin(Traccar, cfg)
        assert p.requests() == []


class TestTraccarCollection:
    async def test_fresh_device_sets_online(self, plugin, run_requests):
        _run(plugin, run_requests, [_device(hours_ago=1.0)])
        assert _latest_status() == "online"

    async def test_stale_device_sets_warning(self, plugin, run_requests):
        _run(plugin, run_requests, [_device(hours_ago=30.0)])
        assert _latest_status() == "warning"

    async def test_very_stale_device_sets_failed(self, plugin, run_requests):
        _run(plugin, run_requests, [_device(hours_ago=100.0)])
        assert _latest_status() == "failed"

    async def test_disabled_devices_excluded(self, plugin, run_requests):
        _run(plugin, run_requests, [_device(hours_ago=200.0, disabled=True)])
        assert _latest_status() == "warning"

    async def test_auth_failure_sets_unavailable(self, plugin, run_requests):
        run_requests(plugin, lambda r: HttpResult(status_code=401, text=""))
        assert _latest_status() == "unavailable"

    async def test_http_error_sets_unavailable(self, plugin, run_requests):
        run_requests(plugin, lambda r: HttpResult(
            status_code=None, text="", error="connection refused"))
        assert _latest_status() == "unavailable"

    async def test_malformed_payload_sets_unavailable(self, plugin, run_requests):
        run_requests(plugin, lambda r: HttpResult(status_code=200, text="<html>not json"))
        assert _latest_status() == "unavailable"
        assert _latest_metric("devices_total") is None

    async def test_missing_username_sets_unavailable(self, make_plugin, run_requests):
        cfg = {k: v for k, v in BASE_CFG.items() if k != "username"}
        p = make_plugin(Traccar, cfg)
        run_requests(p, lambda r: HttpResult(status_code=200, text="[]"))
        assert _latest_status("test-traccar") == "unavailable"

    async def test_never_reported_counts_as_stale(self, plugin, run_requests):
        _run(plugin, run_requests, [{"name": "NoFix", "disabled": False, "lastUpdate": None}])
        assert _latest_status() == "failed"

    async def test_device_filter_excludes_others(self, make_plugin, run_requests):
        p = make_plugin(Traccar, {**BASE_CFG, "devices": ["Phone"]})
        _run(p, run_requests, [_device(name="Phone", hours_ago=1.0),
                               _device(name="OldTablet", hours_ago=500.0)])
        assert _latest_status("test-traccar") == "online"


class TestTraccarActions:
    async def test_on_action_always_returns_false(self, plugin):
        assert plugin.plan_action("anything") is None


class TestDeviceSnapshot:
    async def test_each_watched_device_is_one_item_with_its_age(self, plugin, run_requests):
        _run(plugin, run_requests, [_device(name="Tablet", hours_ago=30.0),
                                    _device(name="Phone", hours_ago=0.2),
                                    _device(name="Old", hours_ago=900.0, disabled=True)])
        items = plugin.data.latest_snapshot()
        assert [item["label"] for item in items] == ["Phone", "Tablet"]
        assert items[0]["age_hours"] == pytest.approx(0.2, abs=0.01)
        assert items[0]["state"] == "online"
        assert items[1]["state"] == "warning"

    async def test_device_past_the_stale_threshold_or_never_reporting_is_failed(
            self, plugin, run_requests):
        _run(plugin, run_requests, [_device(name="Lost", hours_ago=100.0),
                                    {"name": "NoFix", "disabled": False, "lastUpdate": None}])
        items = {item["label"]: item for item in plugin.data.latest_snapshot()}
        assert items["Lost"]["state"] == "failed"
        assert items["NoFix"]["state"] == "failed"
        assert items["NoFix"]["age_hours"] is None


class TestDeviceBars:
    async def test_device_bars_fill_to_twice_the_stale_threshold(self, plugin):
        spec = plugin.UI_SPEC
        repeat = spec['cards']['device_bars']['repeat']
        assert repeat['source'] == 'snapshot'
        assert repeat['container'] == 'bars'
        assert repeat['bar_value'] == 'age_hours'
        assert repeat['bar_max'] == 144.0
        assert repeat['bar_marker'] == 50.0
        assert repeat['item_color_by']({"state": "warning"}) == "warning"
        assert any('device_bars' in row for row in spec['layout'])

    async def test_device_age_reads_in_minutes_then_hours(self, plugin):
        format_item = plugin.UI_SPEC['cards']['device_bars']['repeat']['item_format_fn']
        assert format_item({"age_hours": 0.2}) == "12 min"
        assert format_item({"age_hours": 8.44}) == "8.4 h"
        assert format_item({"age_hours": None}) == "never"
