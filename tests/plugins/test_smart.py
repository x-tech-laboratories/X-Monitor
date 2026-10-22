import pytest

pytestmark = pytest.mark.asyncio
from x_monitor.plugins.smart import Smart
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-smart", "id": "test-smart", "ssh_config": {"host": "test.host"}}

def _run(plugin, run_cycle, body, code=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(code, body, stderr))



def _latest_status() -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-smart"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str) -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-smart") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Smart, CFG)


from x_monitor.plugins.smart import _SMART_SCRIPT


class TestCollection:
    async def test_all_pass_is_online(self, plugin, run_cycle):
        _run(plugin, run_cycle, "PASS /dev/sda\nPASS /dev/sdb")
        assert _latest_status() == "online"

    async def test_one_fail_sets_failed(self, plugin, run_cycle):
        _run(plugin, run_cycle, "PASS /dev/sda\nFAIL /dev/sdb\nFAIL /dev/sdc")
        assert _latest_status() == "failed"
        assert _latest_metric("disks_total") == 3
        assert _latest_metric("disks_ok") == 1
        assert _latest_metric("disks_failed") == 2

    async def test_no_disks_sets_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "")
        assert _latest_status() == "unavailable"

    async def test_malformed_lines_skipped(self, plugin, run_cycle):
        _run(plugin, run_cycle, "PASS /dev/sda\nsome random noise\nFAIL /dev/sdb")
        assert _latest_metric("disks_total") == 2

    async def test_ssh_failure_sets_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", code=-1, stderr="SSH timeout")
        assert _latest_status() == "unavailable"

    async def test_missing_smartctl_sets_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "ERROR smartctl not found", code=1)
        assert _latest_status() == "unavailable"


class TestBlindChecksAreNotHealthy:
    """The failure that matters most: when smartctl cannot run, the monitor
    must not report healthy disks. Found in production, where a missing sudo
    right made a host report 4 OK disks while reading none of them."""

    def test_a_privilege_error_is_not_a_passing_disk(self, plugin):
        result = plugin.parse([CmdResult(
            0, "UNKNOWN /dev/sda sudo: must be owned by uid 0 and have the setuid bit set", "")])
        assert result.status == 'unavailable'
        assert result.metrics['disks_ok'] == 0

    def test_a_healthy_disk_still_passes(self, plugin):
        result = plugin.parse([CmdResult(0, "PASS /dev/sda\nPASS /dev/sdb", "")])
        assert result.status == 'online'
        assert result.metrics['disks_ok'] == 2

    def test_one_unreadable_disk_makes_the_monitor_unavailable(self, plugin):
        result = plugin.parse([CmdResult(0, "PASS /dev/sda\nUNKNOWN /dev/sdb Permission denied", "")])
        assert result.status == 'unavailable'

    def test_a_failing_disk_outranks_an_unreadable_one(self, plugin):
        result = plugin.parse([CmdResult(0, "FAIL /dev/sda\nUNKNOWN /dev/sdb Permission denied", "")])
        assert result.status == 'failed'

    def test_the_script_classifies_by_positive_assertion(self):
        assert "test result: *PASSED" in _SMART_SCRIPT


class TestNonPhysicalDevices:
    """zram, ZFS zvols and loop/md/dm nodes are reported as type "disk" by
    lsblk but have no SMART data of their own."""

    def test_virtual_devices_are_filtered_before_probing(self):
        assert "grep -Ev '^(zram|zd|loop|md|dm-|sr|fd|ram)'" in _SMART_SCRIPT

    def test_an_unsupported_device_is_skipped_not_counted(self, plugin):
        result = plugin.parse([CmdResult(0, "PASS /dev/sda\nSKIP /dev/zd0", "")])
        assert result.status == 'online'
        assert result.metrics['disks_total'] == 1

    def test_skips_alone_look_like_no_disks(self, plugin):
        assert plugin.parse([CmdResult(0, "SKIP /dev/zram0\nSKIP /dev/zd0", "")]).status == 'unavailable'


class TestUiSpec:
    async def test_healthy_failed_and_unreadable_disks_share_one_bar(self, plugin):
        health = plugin.UI_SPEC['cards']['smart_failed_card']
        assert health['kind'] == 'share'
        assert [(p['metric'], p['color']) for p in health['parts']] == [
            ('disks_ok', 'online'), ('disks_failed', 'failed'), ('disks_unknown', 'neutral')]

    async def test_the_share_replaces_the_healthy_count_card(self, plugin):
        assert set(plugin.UI_SPEC['cards']) == {
            'smart_total_card', 'smart_failed_card', 'smart_disk_tiles'}


class TestDiskTiles:
    def test_each_disk_is_recorded_with_its_verdict_and_readings(self, plugin):
        result = plugin.parse([CmdResult(0, (
            "PASS /dev/sda temp=34 hours=12345\n"
            "FAIL /dev/sdb temp=51\n"
            "UNKNOWN /dev/sdc Permission denied\n"
            "SKIP /dev/zd0\n"), "")])
        assert result.snapshot == [
            {'label': 'sda', 'health': 'PASSED', 'temperature': 34.0, 'power_on_hours': 12345.0},
            {'label': 'sdb', 'health': 'FAILED', 'temperature': 51.0, 'power_on_hours': None},
            {'label': 'sdc', 'health': 'unknown', 'temperature': None, 'power_on_hours': None},
        ]

    def test_the_old_output_shape_still_parses(self, plugin):
        result = plugin.parse([CmdResult(0, "PASS /dev/sda\nFAIL /dev/sdb", "")])
        assert result.metrics['disks_ok'] == 1
        assert result.snapshot == [
            {'label': 'sda', 'health': 'PASSED', 'temperature': None, 'power_on_hours': None},
            {'label': 'sdb', 'health': 'FAILED', 'temperature': None, 'power_on_hours': None},
        ]

    def test_an_unreadable_reading_is_left_out(self, plugin):
        result = plugin.parse([CmdResult(0, "PASS /dev/sda temp=hot hours=", "")])
        assert result.snapshot[0]['temperature'] is None
        assert result.snapshot[0]['power_on_hours'] is None

    def test_no_disks_clears_the_tiles(self, plugin):
        assert plugin.parse([CmdResult(0, "SKIP /dev/zd0", "")]).snapshot == []

    def test_the_script_reads_attributes_in_the_same_smartctl_call(self):
        assert "smartctl -H -A" in _SMART_SCRIPT
        assert "temp=" in _SMART_SCRIPT and "hours=" in _SMART_SCRIPT

    def test_the_tiles_are_their_own_row(self, plugin):
        assert ['smart_disk_tiles'] in plugin.UI_SPEC['layout']
        assert plugin.card_row() == ['smart_total_card', 'smart_failed_card']

    def test_the_tiles_repeat_over_the_snapshot(self, plugin):
        repeat = plugin.UI_SPEC['cards']['smart_disk_tiles']['repeat']
        assert repeat['source'] == 'snapshot'
        assert repeat['container'] == 'tiles'

    @pytest.mark.parametrize("item,caption", [
        ({'health': 'PASSED', 'temperature': 34.0, 'power_on_hours': 12345.0},
         'PASSED · 34°C · 12,345 h'),
        ({'health': 'FAILED', 'temperature': 51.0, 'power_on_hours': None}, 'FAILED · 51°C'),
        ({'health': 'unknown', 'temperature': None, 'power_on_hours': None}, 'unknown'),
    ])
    def test_the_caption_adds_the_readings_it_has(self, plugin, item, caption):
        repeat = plugin.UI_SPEC['cards']['smart_disk_tiles']['repeat']
        assert repeat['item_format_fn'](item) == caption

    @pytest.mark.parametrize("health,color", [
        ('PASSED', 'online'), ('FAILED', 'failed'), ('unknown', 'unavailable')])
    def test_the_tile_color_follows_the_verdict(self, plugin, health, color):
        repeat = plugin.UI_SPEC['cards']['smart_disk_tiles']['repeat']
        assert repeat['item_color_by']({'health': health}) == color
