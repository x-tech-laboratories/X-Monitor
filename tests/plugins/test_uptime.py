import pytest

pytestmark = pytest.mark.asyncio
from vigil.plugins.uptime import Uptime
from vigil.core.connectors.types import PingResult
from vigil.core.database.database import db, StatusHistory, Metric


UPTIME_CFG = {
    "name": "test-uptime",
    "id":   "test-uptime",
    "target_host": "example.host",
    "interval": 30,
}


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Uptime, UPTIME_CFG)


def _ping(returncode, stdout="", stderr="", exception=None):
    """Build the PingResult the IcmpConnector would hand parse_results()."""
    return lambda _req: PingResult(
        exception=exception, returncode=returncode, stdout=stdout, stderr=stderr,
    )


def _latest_status(plugin_id: str):
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == plugin_id
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(plugin_name: str, metric: str):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == plugin_name) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


class TestUptimeCollection:
    async def test_successful_ping_sets_online(self, plugin, run_requests):
        stdout = "64 bytes from example.host: icmp_seq=1 ttl=64 time=5.2 ms\n"
        run_requests(plugin, _ping(0, stdout))
        assert _latest_status("test-uptime") == "online"

    async def test_successful_ping_records_latency(self, plugin, run_requests):
        stdout = "64 bytes from 1.2.3.4: icmp_seq=1 ttl=64 time=12.5 ms\n"
        run_requests(plugin, _ping(0, stdout))
        latency = _latest_metric("test-uptime", "latency_ms")
        assert latency == pytest.approx(12.5)

    async def test_successful_ping_records_up_metric(self, plugin, run_requests):
        stdout = "1 packets transmitted, 1 received, time=1.0 ms\n"
        run_requests(plugin, _ping(0, stdout))
        assert _latest_metric("test-uptime", "up") == pytest.approx(1.0)

    async def test_failed_ping_sets_failed(self, plugin, run_requests):
        run_requests(plugin, _ping(1, stderr="Request timed out"))
        assert _latest_status("test-uptime") == "failed"

    async def test_failed_ping_records_up_zero(self, plugin, run_requests):
        run_requests(plugin, _ping(1, stderr="Network unreachable"))
        assert _latest_metric("test-uptime", "up") == pytest.approx(0.0)

    async def test_subprocess_exception_sets_failed(self, plugin, run_requests):
        run_requests(plugin, _ping(None, exception="ping not found"))
        assert _latest_status("test-uptime") == "failed"

    async def test_no_latency_recorded_on_failure(self, plugin, run_requests):
        run_requests(plugin, _ping(1))
        assert _latest_metric("test-uptime", "latency_ms") is None

    async def test_missing_latency_in_output_not_recorded(self, plugin, run_requests):
        run_requests(plugin, _ping(0, "1 packets transmitted, 1 received\n"))
        assert _latest_status("test-uptime") == "online"
        assert _latest_metric("test-uptime", "latency_ms") is None


class TestUptimeActions:
    async def test_on_action_always_returns_false(self, plugin):
        assert plugin.plan_action("restart") is None
        assert plugin.plan_action("anything") is None

    async def test_no_wake_without_a_mac(self, plugin):
        assert plugin.plan_action("wake") is None
        assert 'buttons' not in plugin.UI_SPEC
        assert plugin.on_status('failed', 0.0) is None


MAC = '00:11:22:33:44:55'


def _waker(make_plugin, **extra):
    return make_plugin(Uptime, {**UPTIME_CFG, 'mac': MAC, **extra})


class TestWake:
    async def test_sends_from_the_vigil_server_by_default(self, make_plugin):
        from unittest.mock import patch
        from vigil.core.connectors.types import IoActionPlan
        from vigil.core.connectors.wol import magic_packet
        plugin = _waker(make_plugin)
        plan = plugin.plan_action('wake')
        assert isinstance(plan, IoActionPlan)
        with patch('vigil.plugins.uptime.send_magic_packet') as send:
            assert plan.call() is None
        send.assert_called_once_with(magic_packet(MAC), '255.255.255.255', 9)

    async def test_broadcast_port_and_password_are_configurable(self, make_plugin):
        from unittest.mock import patch
        from vigil.core.connectors.wol import magic_packet
        plugin = _waker(make_plugin, wol_broadcast='192.168.1.255', wol_port=7,
                        wol_password='01:02:03:04:05:06')
        with patch('vigil.plugins.uptime.send_magic_packet') as send:
            plugin.plan_action('wake').call()
        send.assert_called_once_with(magic_packet(MAC, '01:02:03:04:05:06'), '192.168.1.255', 7)

    async def test_a_refused_send_is_reported(self, make_plugin):
        from unittest.mock import patch
        plugin = _waker(make_plugin)
        with patch('vigil.plugins.uptime.send_magic_packet', side_effect=OSError('Network is unreachable')):
            error = plugin.plan_action('wake').call()
        outcome = plugin.interpret_action('wake', error)
        assert outcome.success is False
        assert outcome.status is None
        assert 'Network is unreachable' in outcome.logs[0][0]

    async def test_success_is_logged(self, make_plugin):
        outcome = _waker(make_plugin).interpret_action('wake', None)
        assert outcome.success is True
        assert outcome.logs == [(f"Wake-on-LAN packet for {MAC} sent to 255.255.255.255:9", "INFO")]

    async def test_bad_mac_is_reported_not_raised(self, make_plugin):
        outcome = make_plugin(Uptime, {**UPTIME_CFG, 'mac': 'not-a-mac'}).plan_action('wake')
        assert outcome.success is False
        assert 'not a MAC address' in outcome.logs[0][0]

    async def test_wake_via_another_monitor(self, make_plugin):
        from vigil.core.connectors.types import ActionPlan
        plan = _waker(make_plugin, wake_via='host1-ssh', wol_broadcast='10.0.2.255').plan_action('wake')
        assert isinstance(plan, ActionPlan)
        assert plan.via == 'host1-ssh'
        assert 'python3 -c' in plan.command and '10.0.2.255' in plan.command

    async def test_wake_command_override(self, make_plugin):
        plan = _waker(make_plugin, wake_via='host1-ssh',
                      wake_command='wakeonlan -i {broadcast} -p {port} {mac}').plan_action('wake')
        assert plan.command == f"wakeonlan -i 255.255.255.255 -p 9 {MAC}"

    async def test_bad_wake_command_is_reported(self, make_plugin):
        outcome = _waker(make_plugin, wake_via='host1-ssh', wake_command='etherwake {iface}').plan_action('wake')
        assert outcome.success is False
        assert 'bad wake_command' in outcome.logs[0][0]

    async def test_remote_outcomes(self, make_plugin):
        from vigil.core.connectors.types import CmdResult
        plugin = _waker(make_plugin, wake_via='host1-ssh')
        ok = plugin.interpret_action('wake', CmdResult(0, '', ''))
        assert ok.success is True and 'from monitor host1-ssh' in ok.logs[0][0]
        failed = plugin.interpret_action('wake', CmdResult(127, '', 'needs python3 or socat'))
        assert failed.success is False and 'needs python3 or socat' in failed.logs[0][0]

    async def test_button_confirms_with_the_host(self, make_plugin):
        from vigil.core.ui.components import _substitute
        plugin = _waker(make_plugin)
        spec = plugin.UI_SPEC
        assert ['wake'] in spec['layout']
        button = spec['buttons']['wake'][0]
        assert _substitute(button['confirm'], None, plugin) == \
            f"Send a Wake-on-LAN packet to {plugin.target} ({MAC})?"


class TestWakeOnDown:
    async def test_off_by_default(self, make_plugin):
        assert _waker(make_plugin).on_status('failed', 0.0) is None

    async def test_wakes_when_down_then_waits_for_the_retry(self, make_plugin):
        plugin = _waker(make_plugin, wake_on_down=True, wake_retry='10m')
        assert plugin.on_status('failed', 1000.0) == ('wake', {'automatic': True, 'attempt': 1})
        assert plugin.on_status('failed', 1000.0 + 599) is None
        assert plugin.on_status('failed', 1000.0 + 600) == ('wake', {'automatic': True, 'attempt': 2})

    async def test_gives_up_after_the_max_until_seen_up(self, make_plugin):
        plugin = _waker(make_plugin, wake_on_down=True, wake_retry=60, wake_max_attempts=2)
        assert plugin.on_status('failed', 0.0)[1]['attempt'] == 1
        assert plugin.on_status('failed', 60.0)[1]['attempt'] == 2
        assert plugin.on_status('failed', 120.0) is None
        assert plugin.on_status('failed', 10_000.0) is None
        assert plugin.on_status('online', 10_060.0) is None
        assert plugin.on_status('failed', 10_120.0) == ('wake', {'automatic': True, 'attempt': 1})

    async def test_only_failed_triggers_a_wake(self, make_plugin):
        plugin = _waker(make_plugin, wake_on_down=True)
        assert plugin.on_status('online', 0.0) is None
        assert plugin.on_status('unavailable', 0.0) is None

    async def test_automatic_attempts_are_logged_and_the_last_says_so(self, make_plugin):
        plugin = _waker(make_plugin, wake_on_down=True, wake_max_attempts=2)
        first = plugin.interpret_action('wake', None, automatic=True, attempt=1)
        assert first.logs[0][0].startswith('Automatic wake 1 of 2: Wake-on-LAN packet')
        last = plugin.interpret_action('wake', None, automatic=True, attempt=2)
        assert last.logs[0][0].endswith('no more automatic wakes until test-uptime is seen up again')

    async def test_confirm_mentions_the_automatic_wake(self, make_plugin):
        plugin = _waker(make_plugin, wake_on_down=True)
        assert 'every 10 Minutes, up to 3 times' in plugin.UI_SPEC['buttons']['wake'][0]['confirm']
