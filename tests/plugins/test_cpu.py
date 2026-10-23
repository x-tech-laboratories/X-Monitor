import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.cpu import Cpu
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-cpu", "id": "test-cpu", "ssh_config": {"host": "test.host"}}


def _proc_stat(idle_delta=500, total_delta=1000, cores=()):
    """Two /proc/stat samples, the second `total_delta` jiffies later with
    `idle_delta` of them idle; each entry of `cores` is one core's idle delta
    out of the same total."""
    def sample(later: bool) -> str:
        def line(name, idle):
            busy = total_delta - idle if later else 0
            return f"{name} {1000 + busy} 0 0 {1000 + (idle if later else 0)} 0 0 0 0\n"
        return line('cpu ', idle_delta) + ''.join(
            line(f'cpu{i}', idle) for i, idle in enumerate(cores))
    return sample(False) + sample(True)


def _latest_status() -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-cpu"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str) -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-cpu") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Cpu, CFG)


class TestCollection:
    async def test_busy_cpu_crosses_thresholds(self, make_plugin, run_cycle):
        p = make_plugin(Cpu, dict(CFG, warning=70, threshold=85))
        run_cycle(p, lambda c: CmdResult(0, _proc_stat(idle_delta=100), ""))
        assert _latest_status() == "failed"
        assert _latest_metric("cpu_pct") == pytest.approx(90.0)

    async def test_idle_cpu_is_online(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _proc_stat(idle_delta=1000), ""))
        assert _latest_status() == "online"
        assert _latest_metric("cpu_pct") == pytest.approx(0.0)

    async def test_a_failed_command_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(1, "", "boom"))
        assert _latest_status() == "unavailable"

    async def test_incomplete_output_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, "cpu  1 2 3 4 0 0 0 0\n", ""))
        assert _latest_status() == "unavailable"

    async def test_garbled_output_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, "cpu  x\ncpu  y\n", ""))
        assert _latest_status() == "unavailable"

    async def test_unreachable_host_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(-1, "", "Agent 'h' is not connected"))
        assert _latest_status() == "unavailable"

    def test_one_command_per_cycle(self, plugin):
        assert len(plugin.commands()) == 1

    def test_every_core_is_read_in_the_same_two_samples(self, plugin):
        assert plugin.commands()[0].text.count("grep '^cpu' /proc/stat") == 2


class TestPerCore:
    async def test_each_core_is_in_the_snapshot_in_core_order(self, plugin, run_cycle):
        cores = [1000] * 12
        cores[10] = 250
        result = run_cycle(plugin, lambda c: CmdResult(0, _proc_stat(cores=cores), ""))
        assert [item['label'] for item in result.snapshot] == [str(i) for i in range(12)]
        assert result.snapshot[10]['value'] == pytest.approx(75.0)
        assert result.snapshot[0]['value'] == pytest.approx(0.0)

    async def test_per_core_metrics_are_off_by_default(self, plugin, run_cycle):
        result = run_cycle(plugin, lambda c: CmdResult(0, _proc_stat(cores=[500, 900]), ""))
        assert set(result.metrics) == {'cpu_pct', 'cpu_core_max_pct'}
        assert _latest_metric("cpu_core_max_pct") == pytest.approx(50.0)

    async def test_per_core_metrics_can_be_turned_on(self, make_plugin, run_cycle):
        p = make_plugin(Cpu, dict(CFG, per_core_metrics=True))
        run_cycle(p, lambda c: CmdResult(0, _proc_stat(cores=[500, 900]), ""))
        assert _latest_metric("cpu0_pct") == pytest.approx(50.0)
        assert _latest_metric("cpu1_pct") == pytest.approx(10.0)

    async def test_a_core_that_went_offline_is_skipped(self, plugin, run_cycle):
        stdout = _proc_stat(cores=[500, 900]).replace("cpu1 1000 0 0 1000 0 0 0 0\n", "", 1)
        result = run_cycle(plugin, lambda c: CmdResult(0, stdout, ""))
        assert [item['label'] for item in result.snapshot] == ['0']

    async def test_a_pinned_core_does_not_change_the_status_by_default(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _proc_stat(idle_delta=900, cores=[0, 1000, 1000, 1000]), ""))
        assert _latest_status() == "online"

    async def test_a_pinned_core_fails_when_the_core_rule_is_set(self, make_plugin, run_cycle):
        p = make_plugin(Cpu, dict(CFG, core_warning=90, core_threshold=99))
        result = run_cycle(p, lambda c: CmdResult(0, _proc_stat(idle_delta=900, cores=[0, 1000]), ""))
        assert _latest_status() == "failed"
        assert "busiest core 0 at 100%" in result.logs[0][0]

    async def test_a_core_failure_limit_alone_is_enough(self, make_plugin, run_cycle):
        p = make_plugin(Cpu, dict(CFG, core_threshold=99))
        run_cycle(p, lambda c: CmdResult(0, _proc_stat(idle_delta=900, cores=[0, 1000]), ""))
        assert _latest_status() == "failed"

    async def test_output_without_core_lines_still_reports_the_total(self, plugin, run_cycle):
        result = run_cycle(plugin, lambda c: CmdResult(0, _proc_stat(idle_delta=400), ""))
        assert result.metrics == {'cpu_pct': pytest.approx(60.0)}
        assert result.snapshot == []


class TestUiSpec:
    def test_core_bars_get_their_own_row(self, plugin):
        spec = plugin.UI_SPEC
        assert spec['layout'][0] == ['host_card', 'cpu_card']
        assert ['cores'] in spec['layout']
        assert spec['cards']['cores']['repeat']['container'] == 'bars'

    def test_bars_color_by_the_core_rule_when_set(self, make_plugin):
        p = make_plugin(Cpu, dict(CFG, core_warning=90, core_threshold=99))
        assert p._core_level({'value': 95.0}) == 'warning'
        assert p._core_level({'value': 80.0}) == 'online'

    def test_bars_color_by_the_overall_thresholds_otherwise(self, plugin):
        assert plugin._core_level({'value': 75.0}) == 'warning'

    def test_the_cpu_card_is_a_gauge_banded_by_the_thresholds(self, make_plugin):
        p = make_plugin(Cpu, dict(CFG, warning=60, threshold=85))
        card = p.UI_SPEC['cards']['cpu_card']
        assert card['kind'] == 'gauge'
        assert card['metric'] == 'cpu_pct'
        assert card['color'] == {'warning': 60.0, 'threshold': 85.0}

    def test_the_history_chart_stays(self, plugin):
        assert plugin.UI_SPEC['charts']['cpu_chart']['metric'] == 'cpu_pct'


class TestOptionalLimits:
    async def test_warning_only_never_fails(self, make_plugin, run_cycle):
        p = make_plugin(Cpu, dict(CFG, warning=70, threshold=None))
        run_cycle(p, lambda c: CmdResult(0, _proc_stat(idle_delta=0), ""))
        assert _latest_status() == "warning"
        assert p.UI_SPEC['cards']['cpu_card']['color'] == {'warning': 70.0, 'threshold': None}

    async def test_failure_only_never_warns(self, make_plugin, run_cycle):
        p = make_plugin(Cpu, dict(CFG, warning=None, threshold=85))
        run_cycle(p, lambda c: CmdResult(0, _proc_stat(idle_delta=200), ""))
        assert _latest_status() == "online"
        run_cycle(p, lambda c: CmdResult(0, _proc_stat(idle_delta=100), ""))
        assert _latest_status() == "failed"
