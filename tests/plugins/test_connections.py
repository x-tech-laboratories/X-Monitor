import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.connections import Connections
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-connections", "id": "test-connections", "ssh_config": {"host": "test.host"}}

TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"


def _make_tcp(states: list) -> str:
    lines = [TCP_HEADER]
    for i, st in enumerate(states):
        lines.append(f"   {i}: 0100007F:0050 00000000:0000 {st} 00000000:00000000 00:00000000 00000000     0        0 0\n")
    return "".join(lines)



def _latest_status() -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-connections"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str) -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-connections") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Connections, CFG)


from x_monitor.plugins.connections import _parse_states


class TestParseStates:
    def test_counts_established_and_listen(self):
        counts = _parse_states(_make_tcp(["01", "01", "0A"]))
        assert counts["ESTABLISHED"] == 2 and counts["LISTEN"] == 1

    def test_ignores_header(self):
        assert sum(_parse_states(_make_tcp(["01"])).values()) == 1

    def test_handles_lowercase_hex(self):
        assert _parse_states(_make_tcp(["0a"]))["LISTEN"] == 1

    def test_unknown_state_ignored(self):
        assert sum(_parse_states(_make_tcp(["FF"])).values()) == 0


class TestCollection:
    async def test_totals_are_recorded(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _make_tcp(["01", "0A", "06"]), ""))
        assert _latest_status() == "online"
        assert _latest_metric("conn_total") == pytest.approx(3.0)

    async def test_warning_on_high_total(self, make_plugin, run_cycle):
        p = make_plugin(Connections, dict(CFG, warning=2, threshold=10))
        run_cycle(p, lambda c: CmdResult(0, _make_tcp(["01", "01", "01"]), ""))
        assert _latest_status() == "warning"

    async def test_failed_on_flood(self, make_plugin, run_cycle):
        p = make_plugin(Connections, dict(CFG, warning=2, threshold=3))
        run_cycle(p, lambda c: CmdResult(0, _make_tcp(["01", "01", "01", "01"]), ""))
        assert _latest_status() == "failed"

    async def test_unreadable_table_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(-1, "", "Agent 'h' is not connected"))
        assert _latest_status() == "unavailable"

    async def test_zero_connections_records_zero(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _make_tcp([]), ""))
        assert _latest_metric("conn_total") == pytest.approx(0.0)
        assert _latest_status() == "online"


class TestUiSpec:
    STATES = ['conn_established', 'conn_listen', 'conn_time_wait']

    def test_the_total_card_keeps_its_thresholds(self, make_plugin):
        p = make_plugin(Connections, dict(CFG, warning=100, threshold=200))
        card = p.UI_SPEC['cards']['conn_total_card']
        assert card['color'] == {'warning': 100.0, 'threshold': 200.0}

    def test_the_states_share_one_bar(self, plugin):
        card = plugin.UI_SPEC['cards']['conn_states_card']
        assert card['kind'] == 'share'
        assert [p['metric'] for p in card['parts']] == self.STATES

    def test_one_chart_stacks_the_states(self, plugin):
        charts = plugin.UI_SPEC['charts']
        assert list(charts) == ['conn_total_chart']
        assert charts['conn_total_chart']['style'] == 'stack'
        assert [s['metric'] for s in charts['conn_total_chart']['series']] == self.STATES


class TestOptionalLimits:
    async def test_warning_only_never_fails(self, make_plugin, run_cycle):
        p = make_plugin(Connections, dict(CFG, warning=2, threshold=None))
        run_cycle(p, lambda c: CmdResult(0, _make_tcp(["01"] * 50), ""))
        assert _latest_status() == "warning"

    async def test_failure_only_never_warns(self, make_plugin, run_cycle):
        p = make_plugin(Connections, dict(CFG, warning=None, threshold=3))
        run_cycle(p, lambda c: CmdResult(0, _make_tcp(["01", "01"]), ""))
        assert _latest_status() == "online"
        run_cycle(p, lambda c: CmdResult(0, _make_tcp(["01", "01", "01"]), ""))
        assert _latest_status() == "failed"
