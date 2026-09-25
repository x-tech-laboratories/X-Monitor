import json

import pytest

pytestmark = pytest.mark.asyncio
from vigil.plugins.gpu import Gpu, _intel_gpu_top_sample
from vigil.core.connectors.types import CmdResult
from vigil.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-gpu", "id": "test-gpu", "ssh_config": {"host": "test.host"}}

NVIDIA, AMD, INTEL = "0x10de", "0x1002", "0x8086"


def _nvidia_rows(util=10.0, mem_used=1000, mem_total=8000, temp=50.0, count=1,
                 power="75.5", clock="1500"):
    return "".join(
        f"{idx}, {util}, {mem_used}, {mem_total}, {temp}, {power}, {clock}\n" for idx in range(count))


def _nvidia(rows=None, exit_code=0, **kwargs) -> str:
    """The nvidia-smi section of the probe's output."""
    body = _nvidia_rows(**kwargs) if rows is None else rows
    return f"@@NVIDIA\n{body}@@NVIDIA_EXIT {exit_code}\n"


def _pci(*vendors) -> str:
    return "".join(f"@@PCI {v}\n" for v in vendors)


def _card(name, vendor, files=None, asleep=False, igt=None) -> str:
    """One sysfs card section, `files` mapping a path under the card to its lines."""
    out = f"@@CARD {name} {vendor}\n"
    if asleep:
        return out + "@@ASLEEP\n"
    for path, value in (files or {}).items():
        for line in str(value).splitlines():
            out += f"/sys/class/drm/{name}/{path}:{line}\n"
    if igt is not None:
        out += f"@@IGT\n{igt}\n@@IGT_END\n"
    return out


def _amd_files(busy=30, vram_used=2 * 1024**3, vram_total=8 * 1024**3, edge=55000,
               junction=70000, mem=60000, power_uw=120_000_000):
    return {
        "device/gpu_busy_percent": busy,
        "device/mem_busy_percent": 12,
        "device/mem_info_vram_used": vram_used,
        "device/mem_info_vram_total": vram_total,
        "device/pp_dpm_sclk": "0: 500Mhz\n1: 1800Mhz *\n2: 2400Mhz",
        "device/hwmon/hwmon4/temp1_input": edge,
        "device/hwmon/hwmon4/temp1_label": "edge",
        "device/hwmon/hwmon4/temp2_input": junction,
        "device/hwmon/hwmon4/temp2_label": "junction",
        "device/hwmon/hwmon4/temp3_input": mem,
        "device/hwmon/hwmon4/temp3_label": "mem",
        "device/hwmon/hwmon4/power1_average": power_uw,
    }


def _igt_json(render=20.0, video=45.0, power=6.5, actual=1100.0) -> str:
    """intel_gpu_top -J output cut off mid-array, the way a timed-out run leaves it."""
    sample = {
        "period": {"duration": 500.2, "unit": "ms"},
        "frequency": {"requested": 1150.0, "actual": actual, "unit": "MHz"},
        "power": {"GPU": power, "Package": 14.2, "unit": "W"},
        "engines": {
            "Render/3D": {"busy": render, "sema": 0.0, "wait": 0.0, "unit": "%"},
            "Video": {"busy": video, "sema": 0.0, "wait": 0.0, "unit": "%"},
        },
    }
    return "[\n" + json.dumps(sample, indent=1) + ",\n" + json.dumps(sample)[:40]


def _latest_status() -> str | None:
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-gpu"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str) -> float | None:
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-gpu") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _ok(stdout):
    return lambda c: CmdResult(0, stdout, "")


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Gpu, CFG)


class TestNvidia:
    async def test_peak_across_cards_is_reported(self, plugin, run_cycle):
        run_cycle(plugin, _ok(_pci(NVIDIA, NVIDIA) + _nvidia(util=40.0, temp=60.0, count=2)))
        assert _latest_status() == "online"
        assert _latest_metric("gpu_util") == pytest.approx(40.0)
        assert _latest_metric("gpu1_util") == pytest.approx(40.0)
        assert _latest_metric("gpu_temp") == pytest.approx(60.0)
        assert _latest_metric("gpu0_mem_pct") == pytest.approx(12.5)

    async def test_power_and_clock_are_kept(self, plugin, run_cycle):
        run_cycle(plugin, _ok(_pci(NVIDIA) + _nvidia()))
        assert _latest_metric("gpu0_power_w") == pytest.approx(75.5)
        assert _latest_metric("gpu0_clock_mhz") == pytest.approx(1500.0)

    async def test_power_reported_as_not_available_is_left_out(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_pci(NVIDIA) + _nvidia(power="[N/A]", clock="[N/A]")))
        assert "gpu0_power_w" not in result.metrics
        assert result.metrics["gpu0_util"] == pytest.approx(10.0)

    async def test_the_older_five_column_output_still_parses(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_nvidia(rows="0, 10, 1000, 8000, 50\n")))
        assert result.metrics["gpu0_temp"] == pytest.approx(50.0)

    async def test_hot_gpu_fails(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, temp_threshold=55))
        run_cycle(p, _ok(_pci(NVIDIA) + _nvidia(temp=60.0)))
        assert _latest_status() == "failed"

    async def test_missing_nvidia_smi_and_no_other_gpu_is_unavailable(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_pci(NVIDIA) + "@@NVIDIA_MISSING\n"))
        assert _latest_status() == "unavailable"
        assert "nvidia-smi is not installed" in result.logs[0][0]

    async def test_no_gpu_at_all_is_unavailable(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok("@@NVIDIA_MISSING\n"))
        assert _latest_status() == "unavailable"
        assert "no NVIDIA, AMD, Intel GPU found" in result.logs[0][0]

    async def test_nvidia_smi_that_cannot_reach_the_driver_is_unavailable(self, plugin, run_cycle):
        stdout = _pci(NVIDIA) + _nvidia(rows="NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n", exit_code=9)
        run_cycle(plugin, _ok(stdout))
        assert _latest_status() == "unavailable"

    async def test_nvidia_smi_reporting_an_error_fails(self, plugin, run_cycle):
        stdout = _pci(NVIDIA) + _nvidia(rows="Unable to determine the device handle for GPU 0000:01:00.0: GPU is lost\n", exit_code=15)
        result = run_cycle(plugin, _ok(stdout))
        assert _latest_status() == "failed"
        assert "GPU is lost" in result.logs[0][0]

    async def test_empty_output_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, _ok(""))
        assert _latest_status() == "unavailable"

    async def test_a_failed_probe_is_unavailable(self, plugin, run_cycle):
        run_cycle(plugin, lambda c: CmdResult(-1, "", "Agent 'h' is not connected"))
        assert _latest_status() == "unavailable"


class TestAmd:
    async def test_sysfs_readings_map_onto_the_shared_names(self, plugin, run_cycle):
        run_cycle(plugin, _ok(_pci(AMD) + _card("card0", AMD, _amd_files()) + "@@NVIDIA_MISSING\n"))
        assert _latest_status() == "online"
        assert _latest_metric("gpu0_util") == pytest.approx(30.0)
        assert _latest_metric("gpu0_mem_pct") == pytest.approx(25.0)
        assert _latest_metric("gpu0_mem_busy_pct") == pytest.approx(12.0)
        assert _latest_metric("gpu0_temp") == pytest.approx(55.0)
        assert _latest_metric("gpu0_temp_junction") == pytest.approx(70.0)
        assert _latest_metric("gpu0_temp_mem") == pytest.approx(60.0)
        assert _latest_metric("gpu0_power_w") == pytest.approx(120.0)
        assert _latest_metric("gpu0_clock_mhz") == pytest.approx(1800.0)
        assert _latest_metric("gpu_util") == pytest.approx(30.0)

    async def test_busy_amd_card_crosses_the_util_threshold(self, plugin, run_cycle):
        run_cycle(plugin, _ok(_card("card0", AMD, _amd_files(busy=97))))
        assert _latest_status() == "failed"

    async def test_edge_not_junction_temperature_sets_the_status(self, plugin, run_cycle):
        run_cycle(plugin, _ok(_card("card0", AMD, _amd_files(edge=60000, junction=95000))))
        assert _latest_status() == "online"

    async def test_an_unlabelled_sensor_is_the_card_temperature(self, plugin, run_cycle):
        files = {"device/gpu_busy_percent": 5, "device/hwmon/hwmon1/temp1_input": 48000}
        result = run_cycle(plugin, _ok(_card("card0", AMD, files)))
        assert result.metrics["gpu0_temp"] == pytest.approx(48.0)

    async def test_power_falls_back_to_the_instant_reading(self, plugin, run_cycle):
        files = {"device/gpu_busy_percent": 5, "device/hwmon/hwmon1/power1_input": 16_000_000}
        result = run_cycle(plugin, _ok(_card("card1", AMD, files)))
        assert result.metrics["gpu0_power_w"] == pytest.approx(16.0)

    async def test_a_suspended_card_is_idle_and_not_read(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_card("card0", AMD, asleep=True)))
        assert _latest_status() == "online"
        assert result.metrics["gpu0_util"] == 0.0
        assert "gpu0_temp" not in result.metrics
        assert plugin._item_text(result.snapshot[0]) == "asleep"

    def test_a_suspended_card_is_skipped_before_anything_is_read(self, plugin):
        text = plugin.commands()[0].text
        assert text.index("@@ASLEEP") < text.index("grep -Hs")


class TestIntel:
    async def test_utilization_is_unknown_without_intel_gpu_top(self, plugin, run_cycle):
        files = {"gt_act_freq_mhz": 300}
        result = run_cycle(plugin, _ok(_card("card0", INTEL, files)))
        assert _latest_status() == "online"
        assert result.metrics["gpu0_clock_mhz"] == pytest.approx(300.0)
        assert "gpu0_util" not in result.metrics
        assert "gpu_util" not in result.metrics
        assert "utilization unknown for Intel GPU 0" in result.logs[0][0]
        assert plugin._item_text(result.snapshot[0]).startswith("util ?")

    async def test_an_idle_clock_of_zero_is_kept(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_card("card0", INTEL, {"gt_act_freq_mhz": 0})))
        assert result.metrics["gpu0_clock_mhz"] == 0.0

    async def test_xe_frequency_and_temperatures_are_read(self, plugin, run_cycle):
        files = {"device/tile0/gt0/freqs/act_freq": 1650,
                 "device/hwmon/hwmon5/temp2_input": 52000, "device/hwmon/hwmon5/temp2_label": "pkg",
                 "device/hwmon/hwmon5/temp3_input": 58000, "device/hwmon/hwmon5/temp3_label": "vram"}
        result = run_cycle(plugin, _ok(_card("card0", INTEL, files)))
        assert result.metrics["gpu0_clock_mhz"] == pytest.approx(1650.0)
        assert result.metrics["gpu0_temp"] == pytest.approx(52.0)
        assert result.metrics["gpu0_temp_mem"] == pytest.approx(58.0)

    async def test_intel_gpu_top_gives_utilization_as_the_busiest_engine(self, plugin, run_cycle):
        stdout = _card("card0", INTEL, {"gt_act_freq_mhz": 900}, igt=_igt_json())
        result = run_cycle(plugin, _ok(stdout))
        assert result.metrics["gpu0_util"] == pytest.approx(45.0)
        assert result.metrics["gpu0_power_w"] == pytest.approx(6.5)
        assert result.metrics["gpu0_clock_mhz"] == pytest.approx(900.0)
        assert "utilization unknown" not in result.logs[0][0]

    async def test_intel_gpu_top_clock_fills_in_when_sysfs_has_none(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_card("card0", INTEL, {}, igt=_igt_json(actual=1234.0))))
        assert result.metrics["gpu0_clock_mhz"] == pytest.approx(1234.0)

    async def test_intel_gpu_top_without_permission_leaves_utilization_unknown(self, plugin, run_cycle):
        result = run_cycle(plugin, _ok(_card("card0", INTEL, {"gt_act_freq_mhz": 300}, igt="")))
        assert "gpu0_util" not in result.metrics
        assert "CAP_PERFMON" in result.logs[0][0]

    def test_intel_gpu_top_is_bounded_and_can_be_turned_off(self, make_plugin):
        text = make_plugin(Gpu, CFG).commands()[0].text
        assert "timeout -s INT 2 intel_gpu_top -J" in text
        assert "intel_gpu_top" not in make_plugin(Gpu, dict(CFG, intel_gpu_top=False)).commands()[0].text

    def test_the_sample_parser_takes_the_last_complete_object(self):
        sample = _intel_gpu_top_sample('[{"engines": {"a": {"busy": 1}}}, {"engines": {"a": {"busy": 2}}}, {"eng')
        assert sample["engines"]["a"]["busy"] == 2
        assert _intel_gpu_top_sample("") is None
        assert _intel_gpu_top_sample("Failed to initialize PMU!") is None


class TestMixedVendors:
    async def test_every_card_is_reported_and_numbered_after_the_nvidia_ones(self, plugin, run_cycle):
        stdout = (_pci(INTEL, NVIDIA)
                  + _card("card1", INTEL, {"gt_act_freq_mhz": 300})
                  + _nvidia(util=20.0, temp=50.0))
        result = run_cycle(plugin, _ok(stdout))
        assert result.metrics["gpu0_util"] == pytest.approx(20.0)
        assert result.metrics["gpu1_clock_mhz"] == pytest.approx(300.0)
        assert [item["label"] for item in result.snapshot] == ["GPU 0 NVIDIA", "GPU 1 Intel"]

    async def test_numbering_holds_when_nvidia_smi_is_missing(self, plugin, run_cycle):
        stdout = _pci(NVIDIA, AMD) + _card("card1", AMD, _amd_files()) + "@@NVIDIA_MISSING\n"
        result = run_cycle(plugin, _ok(stdout))
        assert "gpu1_util" in result.metrics
        assert "nvidia-smi is not installed" in result.logs[0][0]

    async def test_sysfs_cards_follow_drm_card_order(self, plugin, run_cycle):
        stdout = (_card("card10", AMD, _amd_files(busy=10))
                  + _card("card2", AMD, _amd_files(busy=2)))
        result = run_cycle(plugin, _ok(stdout))
        assert result.metrics["gpu0_util"] == pytest.approx(2.0)
        assert result.metrics["gpu1_util"] == pytest.approx(10.0)

    async def test_the_worst_card_sets_the_status(self, plugin, run_cycle):
        stdout = (_pci(NVIDIA, AMD) + _card("card1", AMD, _amd_files(edge=85000))
                  + _nvidia(util=5.0, temp=40.0))
        result = run_cycle(plugin, _ok(stdout))
        assert _latest_status() == "warning"
        assert [item["level"] for item in result.snapshot] == ["online", "warning"]

    async def test_an_nvidia_error_fails_the_monitor_but_other_cards_still_report(self, plugin, run_cycle):
        stdout = (_pci(NVIDIA, AMD) + _card("card1", AMD, _amd_files())
                  + _nvidia(rows="Unknown Error\n", exit_code=15))
        result = run_cycle(plugin, _ok(stdout))
        assert _latest_status() == "failed"
        assert result.metrics["gpu1_util"] == pytest.approx(30.0)


class TestVendorOverride:
    def test_auto_probes_every_vendor(self, plugin):
        text = plugin.commands()[0].text
        assert "nvidia-smi" in text and "0x1002|0x8086" in text

    def test_one_vendor_probes_only_that_vendor(self, make_plugin):
        text = make_plugin(Gpu, dict(CFG, vendor="amd")).commands()[0].text
        assert "nvidia-smi" not in text
        assert "0x1002)" in text and "0x8086" not in text

    def test_nvidia_alone_skips_the_sysfs_scan(self, make_plugin):
        text = make_plugin(Gpu, dict(CFG, vendor="nvidia")).commands()[0].text
        assert "/sys/class/drm" not in text and "nvidia-smi" in text

    def test_a_list_of_vendors_is_accepted(self, make_plugin):
        assert make_plugin(Gpu, dict(CFG, vendor=["intel", "NVIDIA"])).vendors == ["nvidia", "intel"]

    async def test_an_unknown_vendor_is_ignored_and_named(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, vendor="matrox"))
        assert p.vendors == ["nvidia", "amd", "intel"]
        result = run_cycle(p, _ok(_pci(NVIDIA) + _nvidia()))
        assert "ignored unknown vendor matrox" in result.logs[0][0]

    async def test_no_card_of_the_chosen_vendor_is_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, vendor="intel"))
        result = run_cycle(p, _ok(_pci(NVIDIA)))
        assert _latest_status() == "unavailable"
        assert "no Intel GPU found" in result.logs[0][0]


class TestTimeoutBreaker:
    async def test_repeated_timeouts_suspend_nvidia_smi_only(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, timeout_trip=2, suspend_seconds=600))
        timed_out = lambda c: CmdResult(1, "", "Command timed out after 15s")
        run_cycle(p, timed_out)
        assert _latest_status() == "unavailable"
        run_cycle(p, timed_out)
        assert _latest_status() == "unavailable"
        text = p.commands()[0].text
        assert "nvidia-smi" not in text     # breaker open: the wedged probe is not issued
        assert "/sys/class/drm" in text

    async def test_other_cards_keep_reporting_while_suspended(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, timeout_trip=1, suspend_seconds=600))
        run_cycle(p, lambda c: CmdResult(1, "", "Command timed out after 15s"))
        result = run_cycle(p, _ok(_pci(NVIDIA, AMD) + _card("card1", AMD, _amd_files())))
        assert _latest_status() == "online"
        assert result.metrics["gpu1_util"] == pytest.approx(30.0)
        assert "probe suspended" in result.logs[0][0]

    async def test_a_suspended_nvidia_only_host_is_unavailable(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, timeout_trip=1, suspend_seconds=600))
        run_cycle(p, lambda c: CmdResult(1, "", "Command timed out after 15s"))
        result = run_cycle(p, _ok(_pci(NVIDIA)))
        assert _latest_status() == "unavailable"
        assert "driver is wedged" in result.logs[0][0]

    async def test_timeouts_without_nvidia_never_trip_the_breaker(self, make_plugin, run_cycle):
        p = make_plugin(Gpu, dict(CFG, vendor="amd", timeout_trip=1))
        run_cycle(p, lambda c: CmdResult(1, "", "Command timed out after 15s"))
        assert not p._suspended()


class TestUiSpec:
    def test_per_card_repeat_gets_its_own_row(self, plugin):
        spec = plugin.UI_SPEC
        assert 'gpus' not in spec['layout'][0]
        assert ['gpus'] in spec['layout']

    def test_a_card_chip_reads_every_known_value(self, plugin):
        item = {"util": 42.4, "mem_pct": 25.0, "temp": 61.2, "power_w": 120.4, "clock_mhz": 1800.0}
        assert plugin._item_text(item) == "42%  ·  VRAM 25%  ·  61°C  ·  120 W  ·  1800 MHz"

    def test_a_card_chip_is_colored_by_its_own_level(self, plugin):
        assert plugin._item_level({"level": "warning"}) == "warning"
