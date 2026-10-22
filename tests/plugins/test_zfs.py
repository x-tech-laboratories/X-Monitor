import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.zfs import Zfs
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-zfs", "id": "test-zfs", "ssh_config": {"host": "test.host"}}

def _make_zpool(pools: dict) -> str:
    return "".join(f"{name}\t{health}\t{capacity}%\n"
                   for name, (health, capacity) in pools.items())


def _run(plugin, run_cycle, body, code=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(code, body, stderr))



def _latest_status() -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-zfs"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str) -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-zfs") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Zfs, CFG)


from x_monitor.plugins.zfs import _sanitize_pool


class TestSanitizePool:
    def test_lowercases_and_replaces_separators(self):
        assert _sanitize_pool("Tank-Fast.01") == "tank_fast_01"


class TestCollection:
    async def test_all_online_is_ok(self, plugin, run_cycle):
        _run(plugin, run_cycle, _make_zpool({"pool1": ("ONLINE", 10), "pool2": ("ONLINE", 20)}))
        assert _latest_status() == "online"
        assert _latest_metric("pools_total") == 2
        assert _latest_metric("pools_ok") == 2
        assert _latest_metric("pools_degraded") == 0

    async def test_per_pool_usage_recorded(self, plugin, run_cycle):
        _run(plugin, run_cycle, _make_zpool({"tank": ("ONLINE", 10), "back-up": ("ONLINE", 55)}))
        assert _latest_metric("pool_usage_tank") == pytest.approx(10.0)
        assert _latest_metric("pool_usage_back_up") == pytest.approx(55.0)
        assert _latest_metric("zfs_usage_max") == pytest.approx(55.0)

    @pytest.mark.parametrize("bad_state", ["DEGRADED", "FAULTED", "OFFLINE", "UNAVAIL", "REMOVED"])
    async def test_all_unhealthy_states_trigger_failed(self, plugin, run_cycle, bad_state):
        _run(plugin, run_cycle, _make_zpool({"pool1": (bad_state, 10)}))
        assert _latest_status() == "failed", f"Expected failed for state {bad_state}"
        assert _latest_metric("pools_degraded") == 1

    async def test_usage_over_warning_warns(self, plugin, run_cycle):
        _run(plugin, run_cycle, _make_zpool({"tank": ("ONLINE", 85)}))
        assert _latest_status() == "warning"

    async def test_usage_at_threshold_fails(self, plugin, run_cycle):
        _run(plugin, run_cycle, _make_zpool({"tank": ("ONLINE", 90)}))
        assert _latest_status() == "failed"

    async def test_custom_thresholds_apply(self, make_plugin, run_cycle):
        p = make_plugin(Zfs, dict(CFG, warning=60, threshold=75))
        _run(p, run_cycle, _make_zpool({"tank": ("ONLINE", 80)}))
        assert _latest_status() == "failed"

    async def test_named_pools_narrow_the_query(self, make_plugin):
        p = make_plugin(Zfs, dict(CFG, pools=['tank', 'backup']))
        assert "name,health,capacity tank backup" in p.commands()[0].text

    async def test_no_pools_sets_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "")
        assert _latest_status() == "unavailable"

    async def test_malformed_lines_skipped(self, plugin, run_cycle):
        _run(plugin, run_cycle, "pool1\tONLINE\t10%\njust_one_word\npool2\tONLINE\t20%\n")
        assert _latest_metric("pools_total") == 2

    async def test_ssh_failure_sets_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", code=-1, stderr="timeout")
        assert _latest_status() == "unavailable"

    async def test_missing_zpool_sets_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", code=127, stderr="zpool: command not found")
        assert _latest_status() == "unavailable"
        assert _latest_metric("pools_total") is None


class TestUiSpec:
    def test_per_pool_repeat_card_is_its_own_row(self, plugin):
        assert ['zfs_pools'] in plugin.UI_SPEC['layout']

    def test_pools_are_meters_ticked_at_the_warning_level(self, plugin):
        repeat = plugin.UI_SPEC['cards']['zfs_pools']['repeat']
        assert repeat['container'] == 'bars'
        assert repeat['bar_marker'] == plugin.warning
        assert repeat['item_color_by'] == plugin._item_level

    def test_healthy_and_degraded_pools_share_one_bar(self, plugin):
        health = plugin.UI_SPEC['cards']['zfs_degraded_card']
        assert health['kind'] == 'share'
        assert [(p['metric'], p['color']) for p in health['parts']] == [
            ('pools_ok', 'online'), ('pools_degraded', 'failed')]

    def test_the_count_cards_the_meters_replace_are_gone(self, plugin):
        cards = plugin.UI_SPEC['cards']
        assert not {'zfs_ok_card', 'zfs_usage_card'} & set(cards)
        assert plugin.card_row() == ['zfs_total_card', 'zfs_degraded_card']


class TestPoolTiles:
    def test_each_pool_is_recorded_with_its_health_and_usage(self, plugin):
        result = plugin.parse([CmdResult(0, _make_zpool(
            {"tank": ("ONLINE", 78), "back-up": ("DEGRADED", 12)}), "")])
        assert result.snapshot == [
            {'label': 'tank', 'health': 'ONLINE', 'usage': 78.0},
            {'label': 'back-up', 'health': 'DEGRADED', 'usage': 12.0},
        ]

    def test_no_pools_clears_the_tiles(self, plugin):
        assert plugin.parse([CmdResult(0, "", "")]).snapshot == []

    def test_the_tiles_are_their_own_row_above_the_meters(self, plugin):
        layout = plugin.UI_SPEC['layout']
        assert layout.index(['zfs_pool_tiles']) < layout.index(['zfs_pools'])

    def test_the_tiles_repeat_over_the_snapshot(self, plugin):
        repeat = plugin.UI_SPEC['cards']['zfs_pool_tiles']['repeat']
        assert repeat['source'] == 'snapshot'
        assert repeat['container'] == 'tiles'

    def test_the_caption_is_health_and_usage(self, plugin):
        repeat = plugin.UI_SPEC['cards']['zfs_pool_tiles']['repeat']
        assert repeat['item_format_fn']({'health': 'ONLINE', 'usage': 78.0}) == 'ONLINE · 78%'

    @pytest.mark.parametrize("health,usage,state", [
        ("ONLINE", 10, 'online'), ("ONLINE", 85, 'warning'), ("ONLINE", 95, 'failed'),
        ("DEGRADED", 10, 'failed'), ("FAULTED", 10, 'failed'), ("UNAVAIL", 10, 'failed'),
    ])
    def test_the_tile_color_follows_health_then_usage(self, plugin, health, usage, state):
        repeat = plugin.UI_SPEC['cards']['zfs_pool_tiles']['repeat']
        assert repeat['item_color_by']({'health': health, 'usage': float(usage)}) == state
