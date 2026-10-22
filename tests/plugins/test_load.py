import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.load import Load
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-load", "id": "test-load", "ssh_config": {"host": "test.host"}}

def _loadavg(one, five=0.5, fifteen=0.5, cpus=4):
    return f"LOAD:{one} {five} {fifteen} 1/500 12345\nCPUS:{cpus}\n"



def _latest_status() -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-load"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str) -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-load") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Load, CFG)


class TestCollection:
    async def test_load_is_scaled_by_core_count(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _loadavg(1.0, cpus=4), ""))
        assert _latest_status() == "online"
        assert _latest_metric("load_pct_1m") == pytest.approx(25.0)

    async def test_without_thresholds_any_load_stays_online(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _loadavg(16.0, cpus=4), ""))
        assert _latest_status() == "online"
        assert _latest_metric("load_pct_1m") == pytest.approx(400.0)

    async def test_thresholds_are_configurable(self, make_plugin, run_cycle):
        p = make_plugin(Load, dict(CFG, warning=100, threshold=200))
        run_cycle(p, lambda c: CmdResult(0, _loadavg(12.0, cpus=4), ""))
        assert _latest_status() == "failed"

    async def test_a_failed_command_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(1, "", "boom"))
        assert _latest_status() == "unavailable"

    async def test_unparseable_output_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, "LOAD:garbage\nCPUS:4\n", ""))
        assert _latest_status() == "unavailable"


class TestUiSpec:
    def test_the_1m_load_is_a_gauge_banded_by_the_thresholds(self, make_plugin):
        p = make_plugin(Load, dict(CFG, warning=70, threshold=90))
        cards = p.UI_SPEC['cards']
        assert list(cards) == ['load_1m_card']
        assert cards['load_1m_card']['kind'] == 'gauge'
        assert cards['load_1m_card']['color'] == {'warning': 70.0, 'threshold': 90.0}

    def test_one_chart_draws_all_three_averages_as_lines(self, plugin):
        chart = plugin.UI_SPEC['charts']['load_chart']
        assert chart['style'] == 'lines'
        assert [s['metric'] for s in chart['series']] == ['load_pct_1m', 'load_pct_5m', 'load_pct_15m']
