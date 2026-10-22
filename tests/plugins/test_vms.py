import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.vms import Vms, _parse_row
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric


def _latest_status(pid="test-vms"):
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == pid
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric, name="test-vms"):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _cfg(**extra):
    base = {"name": "test-vms", "id": "test-vms", "ssh_config": {"host": "test.host"}}
    base.update(extra)
    return base


_LIST = """ Id   Name       State
----------------------------------
 1    web        running
 2    cache      running
 -    db         shut off
"""

_LIST_PAUSED = """ Id   Name       State
----------------------------------
 1    web        running
 3    stuck      paused
"""


class TestParseRow:
    def test_header_ignored(self):
        assert _parse_row(" Id   Name       State") == (None, None)

    def test_separator_ignored(self):
        assert _parse_row("---------------------------") == (None, None)

    def test_running_row(self):
        assert _parse_row(" 1    web        running") == ("web", "running")

    def test_two_word_state(self):
        assert _parse_row(" -    db         shut off") == ("db", "shut off")


class TestVmsCollection:
    async def test_running_and_off_online(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _LIST, ""))
        assert _latest_status() == "online"
        assert _latest_metric("vms_running") == pytest.approx(2.0)
        assert _latest_metric("vms_total") == pytest.approx(3.0)

    async def test_paused_is_warning(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg())
        run_cycle(p, lambda c: CmdResult(0, _LIST_PAUSED, ""))
        assert _latest_status() == "warning"

    async def test_expected_off_failed(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg(expect_running=["db"]))
        run_cycle(p, lambda c: CmdResult(0, _LIST, ""))
        assert _latest_status() == "failed"

    async def test_expected_running_online(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg(expect_running=["web", "cache"]))
        run_cycle(p, lambda c: CmdResult(0, _LIST, ""))
        assert _latest_status() == "online"

    async def test_virsh_missing_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg())
        run_cycle(p, lambda c: CmdResult(127, "", "bash: virsh: command not found"))
        assert _latest_status() == "unavailable"

    async def test_libvirt_unreachable_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg())
        run_cycle(p, lambda c: CmdResult(1, "", "error: failed to connect to the hypervisor"))
        assert _latest_status() == "unavailable"

    async def test_virsh_list_error_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg(expect_running=["web"]))
        run_cycle(p, lambda c: CmdResult(1, "", "error: authentication failed"))
        assert _latest_status() == "unavailable"
        assert _latest_metric("vms_total") is None


class TestVmsActions:
    async def test_start_listed_vm(self, make_plugin):
        p = make_plugin(Vms, _cfg(expect_running=["web"]))
        plan = p.plan_action("start:web")
        assert "start" in plan.command and "web" in plan.command
        assert p.interpret_action("start:web", CmdResult(0, "", "")) is True

    async def test_refuse_unlisted_vm(self, make_plugin):
        p = make_plugin(Vms, _cfg(expect_running=["web"]))
        plan = p.plan_action("start:evil")
        assert plan.success is False

    async def test_each_expected_vm_gets_a_running_switch(self, make_plugin):
        p = make_plugin(Vms, _cfg(expect_running=["web", "db"]))
        assert p.get_actions() == [
            {"name": "db", "kind": "toggle", "metric": "vm_running_db", "icon": "computer",
             "on_action_id": "start:db", "off_action_id": "shutdown:db"},
            {"name": "web", "kind": "toggle", "metric": "vm_running_web", "icon": "computer",
             "on_action_id": "start:web", "off_action_id": "shutdown:web"},
        ]

    async def test_running_metric_per_expected_vm(self, make_plugin, run_cycle):
        p = make_plugin(Vms, _cfg(expect_running=["web", "db"]))
        run_cycle(p, lambda c: CmdResult(0, _LIST, ""))
        assert _latest_metric("vm_running_web") == 1.0
        assert _latest_metric("vm_running_db") == 0.0
        assert _latest_metric("vm_running_cache") is None


class TestUiSpec:
    async def test_running_and_stopped_vms_are_one_share(self, make_plugin):
        spec = make_plugin(Vms, _cfg()).UI_SPEC
        card = spec['cards']['running_card']
        assert card['kind'] == 'share'
        assert [(p['metric'], p['color']) for p in card['parts']] == [
            ('vms_running', 'online'), ('vms_stopped', 'neutral')]
        assert 'stopped_card' not in spec['cards']
        assert ['vms'] in spec['layout']
