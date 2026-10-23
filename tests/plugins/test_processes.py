import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.processes import Processes, _parse_ps_output, _process_tree
from x_monitor.plugins.base.plugin_helpers import level_for
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric


BASE_CFG = {
    "name": "test-procs",
    "id":   "test-procs",
    "max_processes": 5,
    "ssh_config": {"host": "test.host"},
}

CFG_WITH_THRESHOLDS = {
    **BASE_CFG,
    "name": "test-procs-thresh",
    "id":   "test-procs-thresh",
    "cpu_warning":   50.0,
    "cpu_threshold": 80.0,
}

_PS_HEADER = "  PID  PPID USER     %CPU %MEM COMMAND"
_PS_ROWS = [
    "  123     1 root      45.2  2.1 python3",
    " 4567     1 alice      3.0  0.5 bash",
    "   89     1 www-data   0.1  0.3 nginx",
]

_PS_OUTPUT_OK = "\n".join([_PS_HEADER] + _PS_ROWS) + "\n"
_PS_OUTPUT_HEADER_ONLY = _PS_HEADER + "\n"
_PS_OUTPUT_EMPTY = ""

_PS_OUTPUT_HIGH_CPU = "\n".join([
    _PS_HEADER,
    "  999     1 root      85.0  1.0 stress",
]) + "\n"

_PS_OUTPUT_WARN_CPU = "\n".join([
    _PS_HEADER,
    "  999     1 root      60.0  1.0 stress",
]) + "\n"


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Processes, BASE_CFG)


@pytest.fixture
def thresh_plugin(make_plugin):
    return make_plugin(Processes, CFG_WITH_THRESHOLDS)


def _latest_status(plugin_id: str = "test-procs") -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == plugin_id
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str, name: str = "test-procs") -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


class TestParsePsOutput:
    def test_parses_pid(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert procs[0]['pid'] == 123

    def test_parses_ppid(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert procs[0]['ppid'] == 1

    def test_parses_user(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert procs[0]['user'] == 'root'

    def test_parses_cpu(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert procs[0]['cpu'] == pytest.approx(45.2)

    def test_parses_mem(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert procs[0]['mem'] == pytest.approx(2.1)

    def test_parses_command(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert procs[0]['command'] == 'python3'

    def test_returns_all_rows(self):
        procs = _parse_ps_output(_PS_OUTPUT_OK)
        assert len(procs) == 3

    def test_header_only_returns_empty(self):
        procs = _parse_ps_output(_PS_OUTPUT_HEADER_ONLY)
        assert procs == []

    def test_empty_output_returns_empty(self):
        procs = _parse_ps_output(_PS_OUTPUT_EMPTY)
        assert procs == []

    def test_command_with_spaces_preserved(self):
        output = _PS_HEADER + "\n  1 0 root 0.0 0.0 my command with spaces\n"
        procs = _parse_ps_output(output)
        assert procs[0]['command'] == 'my command with spaces'

    def test_skips_malformed_lines(self):
        output = _PS_HEADER + "\nbadline\n  123 1 root 0.1 0.2 bash\n"
        procs = _parse_ps_output(output)
        assert len(procs) == 1
        assert procs[0]['pid'] == 123


def _proc(pid, ppid, cpu, mem=0.0, command='x'):
    return {'pid': pid, 'ppid': ppid, 'user': 'root', 'cpu': cpu, 'mem': mem, 'command': command}


class TestProcessTree:
    # systemd(1) -> firefox(10) -> two content processes (11, 12); sshd(20) stands alone under 1.
    PROCS = [
        _proc(1, 0, 0.5, 0.1, 'systemd'),
        _proc(10, 1, 5.0, 4.0, 'firefox'),
        _proc(11, 10, 20.0, 2.0, 'Web Content'),
        _proc(12, 10, 1.0, 1.0, 'Web Content'),
        _proc(20, 1, 0.0, 0.2, 'sshd'),
    ]

    def _rows(self, max_processes=20):
        return {row['pid']: row for row in _process_tree(self.PROCS, max_processes)}

    def test_a_parent_totals_its_whole_branch(self):
        rows = self._rows()
        assert rows[10]['cpu'] == pytest.approx(26.0)
        assert rows[10]['mem'] == pytest.approx(7.0)
        assert rows[10]['procs'] == 3
        assert rows[1]['cpu'] == pytest.approx(26.5)
        assert rows[1]['procs'] == 5

    def test_a_row_keeps_its_own_share_beside_the_total(self):
        rows = self._rows()
        assert (rows[10]['own_cpu'], rows[10]['own_mem']) == (5.0, 4.0)
        assert (rows[11]['cpu'], rows[11]['own_cpu'], rows[11]['procs']) == (20.0, 20.0, 1)

    def test_a_root_has_no_parent_row(self):
        rows = self._rows()
        assert rows[1]['ppid'] is None
        assert rows[11]['ppid'] == 10

    def test_rows_come_busiest_branch_first(self):
        assert [row['pid'] for row in _process_tree(self.PROCS, 20)][:3] == [1, 10, 11]

    def test_the_limit_keeps_the_busiest_with_their_ancestors_and_totals_still_count_all(self):
        rows = self._rows(max_processes=1)
        assert set(rows) == {1, 10, 11}
        assert rows[1]['cpu'] == pytest.approx(26.5)
        assert rows[1]['procs'] == 5

    def test_a_parent_loop_does_not_hang(self):
        rows = {row['pid']: row for row in _process_tree([_proc(5, 6, 1.0), _proc(6, 5, 2.0)], 20)}
        assert rows[5]['cpu'] == pytest.approx(3.0)
        assert rows[6]['cpu'] == pytest.approx(3.0)


class TestLevelFor:
    def test_below_warning_is_online(self):
        assert level_for(30.0, 50.0, 80.0) == 'online'

    def test_at_warning_is_warning(self):
        assert level_for(50.0, 50.0, 80.0) == 'warning'

    def test_between_thresholds_is_warning(self):
        assert level_for(60.0, 50.0, 80.0) == 'warning'

    def test_at_failed_is_failed(self):
        assert level_for(80.0, 50.0, 80.0) == 'failed'


class TestProcessesCollection:
    async def test_successful_collection_sets_online(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _PS_OUTPUT_OK, ""))
        assert _latest_status() == "online"

    async def test_process_list_populated(self, plugin, run_cycle):
        result = run_cycle(plugin, lambda c: CmdResult(0, _PS_OUTPUT_OK, ""))
        assert len(result.snapshot) == 3
        assert result.snapshot[0]['pid'] == 123

    async def test_process_count_metric_recorded(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _PS_OUTPUT_OK, ""))
        assert _latest_metric("process_count") == pytest.approx(3.0)

    async def test_process_count_counts_every_process_beyond_the_limit(self, plugin, run_cycle):
        output = _PS_HEADER + "\n" + "\n".join(f"  {pid} 1 root 0.0 0.0 p" for pid in range(10, 20)) + "\n"
        result = run_cycle(plugin, lambda c: CmdResult(0, output, ""))
        assert _latest_metric("process_count") == pytest.approx(10.0)
        assert len(result.snapshot) == 5

    async def test_top_cpu_metric_recorded(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _PS_OUTPUT_OK, ""))
        assert _latest_metric("top_cpu_pct") == pytest.approx(45.2)

    async def test_empty_process_list_sets_online(self, plugin, run_cycle):
        result = run_cycle(plugin, lambda c: CmdResult(0, _PS_OUTPUT_HEADER_ONLY, ""))
        assert _latest_status() == "online"
        assert result.snapshot == []

    async def test_unparseable_output_sets_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, "complete garbage\n!!!\n", ""))
        assert _latest_status() == "unavailable"

    async def test_ssh_failure_sets_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(-1, "", "timeout"))
        assert _latest_status() == "unavailable"

    async def test_missing_ps_sets_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(127, "", "sh: ps: not found"))
        assert _latest_status() == "unavailable"

    async def test_no_thresholds_always_online(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(0, _PS_OUTPUT_HIGH_CPU, ""))
        assert _latest_status() == "online"

    async def test_top_cpu_above_warning_sets_warning(self, thresh_plugin, run_cycle):
        run_cycle(thresh_plugin, lambda c: CmdResult(0, _PS_OUTPUT_WARN_CPU, ""))
        assert _latest_status("test-procs-thresh") == "warning"

    async def test_top_cpu_above_threshold_sets_failed(self, thresh_plugin, run_cycle):
        run_cycle(thresh_plugin, lambda c: CmdResult(0, _PS_OUTPUT_HIGH_CPU, ""))
        assert _latest_status("test-procs-thresh") == "failed"


class TestUiSpec:
    def test_process_table_has_a_title(self, plugin):
        assert plugin.UI_SPEC['tables']['table']['title'] == 'PROCESSES'


class TestProcessesKillAction:
    async def test_kill_term_sends_correct_command(self, plugin):
        plan = plugin.plan_action('kill_term', pid=123)
        assert plan.command == "kill -TERM 123"
        outcome = plugin.interpret_action('kill_term', CmdResult(0, "", ""), pid=123)
        assert outcome.success is True

    async def test_kill_kill_sends_correct_command(self, plugin):
        plan = plugin.plan_action('kill_kill', pid=456)
        assert plan.command == "kill -KILL 456"

    async def test_kill_with_sudo(self, make_plugin):
        cfg = {**BASE_CFG, "name": "test-sudo", "id": "test-sudo", "require_sudo": True}
        p = make_plugin(Processes, cfg)
        plan = p.plan_action('kill_term', pid=99)
        assert plan.command == "sudo -n kill -TERM 99"

    async def test_kill_failure_returns_false(self, plugin):
        outcome = plugin.interpret_action(
            'kill_term', CmdResult(1, "", "Operation not permitted"), pid=1)
        assert outcome.success is False

    async def test_kill_missing_pid_returns_false(self, plugin):
        plan = plugin.plan_action('kill_term')
        assert plan.success is False

    async def test_unknown_action_returns_false(self, plugin):
        assert plugin.plan_action('reboot') is None


class TestOptionalLimits:
    async def test_warning_only_never_fails(self, make_plugin, run_cycle):
        p = make_plugin(Processes, dict(BASE_CFG, cpu_warning=50.0))
        run_cycle(p, lambda c: CmdResult(0, _PS_OUTPUT_HIGH_CPU, ""))
        assert _latest_status() == "warning"
        assert p.UI_SPEC['cards']['top_cpu_card']['color'] == {'warning': 50.0, 'threshold': None}

    async def test_failure_only_never_warns(self, make_plugin, run_cycle):
        p = make_plugin(Processes, dict(BASE_CFG, cpu_threshold=80.0))
        run_cycle(p, lambda c: CmdResult(0, _PS_OUTPUT_WARN_CPU, ""))
        assert _latest_status() == "online"
        run_cycle(p, lambda c: CmdResult(0, _PS_OUTPUT_HIGH_CPU, ""))
        assert _latest_status() == "failed"
