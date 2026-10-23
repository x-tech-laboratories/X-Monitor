import pytest

from x_monitor.plugins.reboot_required import RebootRequired, _parse_probe, _probe_script
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-reboot", "id": "test-reboot", "ssh_config": {"host": "test.host"}}

KERNEL = "/nix/store/aaaa-linux-6.18.46"
NEW_KERNEL = "/nix/store/bbbb-linux-6.19.1"


def _latest_status():
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-reboot"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-reboot") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _nixos(booted=KERNEL, current=KERNEL) -> str:
    lines = ["kernel=6.18.46", "nixos=1"]
    for part in ("initrd", "kernel", "kernel-modules", "systemd"):
        changed = current if part in ("kernel", "kernel-modules") else KERNEL
        lines.append(f"booted_part={booted if part in ('kernel', 'kernel-modules') else KERNEL}/{part}")
        lines.append(f"current_part={changed}/{part}")
    return "\n".join(lines) + "\n"


DEBIAN_CLEAN = "kernel=6.1.0-25-amd64\ndebian=1\nmodules=present\n"
DEBIAN_FLAGGED = ("kernel=6.1.0-25-amd64\ndebian=1\ndebian_flag=1\n"
                  "debian_pkg=linux-image-6.1.0-26-amd64\ndebian_pkg=libc6\n"
                  "debian_pkg=libc6\nmodules=present\n")
RHEL_REBOOT = (
    "kernel=5.14.0-427.el9.x86_64\nrhel_rc=1\n"
    "rhel_out=Core libraries or services have been updated since boot-up:\n"
    "rhel_out=  * kernel\nrhel_out=  * glibc\nrhel_out=\n"
    "rhel_out=Reboot is required to fully utilize these updates.\n"
    "rhel_out=More information: https://access.redhat.com/solutions/27943\n"
    "modules=present\n"
)
RHEL_CLEAN = (
    "kernel=5.14.0-427.el9.x86_64\nrhel_rc=0\n"
    "rhel_out=No core libraries or services have been updated since boot-up.\n"
    "rhel_out=Reboot should not be necessary.\nmodules=present\n"
)


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(RebootRequired, CFG)


def _run(plugin, run_cycle, stdout, rc=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(rc, stdout, stderr))


class TestProbeScript:
    def test_runs_every_check(self):
        script = _probe_script()
        for needle in ("uname -r", "/run/booted-system", "/var/run/reboot-required",
                       "needs-restarting -r", "/usr/lib/modules"):
            assert needle in script

    def test_is_one_sampled_command(self, plugin):
        assert plugin.SAMPLED
        assert len(plugin.commands()) == 1

    def test_parse_collects_repeated_keys(self):
        fields = _parse_probe("kernel=6.1\ndebian_pkg=a\ndebian_pkg=b\nnoise\n")
        assert fields["kernel"] == "6.1"
        assert fields["debian_pkg"] == ["a", "b"]


class TestDebian:
    def test_no_flag_is_online(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, DEBIAN_CLEAN)
        assert _latest_status() == "online"
        assert _latest_metric("reboot_required") == 0.0
        assert result.snapshot["checks"] == ["debian", "kernel"]

    def test_flag_is_warning_with_packages(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, DEBIAN_FLAGGED)
        assert _latest_status() == "warning"
        assert _latest_metric("reboot_required") == 1.0
        assert result.snapshot["packages"] == ["linux-image-6.1.0-26-amd64", "libc6"]
        assert "linux-image-6.1.0-26-amd64" in result.logs[0][0]

    def test_reboot_status_is_configurable(self, make_plugin, run_cycle):
        p = make_plugin(RebootRequired, {**CFG, "reboot_status": "failed"})
        _run(p, run_cycle, DEBIAN_FLAGGED)
        assert _latest_status() == "failed"

    def test_unknown_reboot_status_falls_back_to_warning(self, make_plugin):
        assert make_plugin(RebootRequired, {**CFG, "reboot_status": "bogus"}).reboot_status == "warning"


class TestRhel:
    def test_needs_restarting_exit_1_requires_reboot(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, RHEL_REBOOT)
        assert _latest_status() == "warning"
        assert result.snapshot["packages"] == ["kernel", "glibc"]

    def test_needs_restarting_exit_0_is_online(self, plugin, run_cycle):
        _run(plugin, run_cycle, RHEL_CLEAN)
        assert _latest_status() == "online"

    def test_dnf_without_the_command_is_not_a_reboot(self, plugin, run_cycle):
        stdout = "kernel=6.9\nrhel_rc=1\nrhel_out=No such command: needs-restarting.\nmodules=present\n"
        result = _run(plugin, run_cycle, stdout)
        assert _latest_status() == "online"
        assert result.snapshot["checks"] == ["kernel"]


class TestGenericKernel:
    def test_missing_module_dir_requires_reboot(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, "kernel=6.10.1-arch1-1\nmodules=missing\n")
        assert _latest_status() == "warning"
        assert "6.10.1-arch1-1" in result.snapshot["reasons"][0]

    def test_present_module_dir_is_online(self, plugin, run_cycle):
        _run(plugin, run_cycle, "kernel=6.10.1-arch1-1\nmodules=present\n")
        assert _latest_status() == "online"


class TestNixos:
    def test_same_boot_parts_is_online(self, plugin, run_cycle):
        _run(plugin, run_cycle, _nixos())
        assert _latest_status() == "online"
        assert _latest_metric("reboot_required") == 0.0

    def test_changed_kernel_requires_reboot_and_names_parts(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _nixos(current=NEW_KERNEL))
        assert _latest_status() == "warning"
        assert result.snapshot["packages"] == ["kernel", "kernel-modules"]

    def test_module_check_is_skipped_on_nixos(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _nixos() + "modules=missing\n")
        assert _latest_status() == "online"
        assert result.snapshot["checks"] == ["nixos"]


class TestUnavailable:
    def test_no_applicable_check_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "kernel=6.1\n")
        assert _latest_status() == "unavailable"
        assert _latest_metric("reboot_required") is None

    def test_unreachable_host_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", rc=-1, stderr="connection refused")
        assert _latest_status() == "unavailable"


class TestCards:
    def test_card_text_follows_the_metric(self, plugin, run_cycle):
        assert plugin._reboot_text == "--"
        _run(plugin, run_cycle, DEBIAN_FLAGGED)
        assert plugin._reboot_text == "REQUIRED"
        assert plugin._reboot_color == "warning"
        assert plugin._kernel_text == "6.1.0-25-amd64"
        kinds = [row["kind"] for row in plugin._reason_rows]
        assert kinds == ["Reason", "Package", "Package"]
        _run(plugin, run_cycle, DEBIAN_CLEAN)
        assert plugin._reboot_text == "NOT NEEDED"
        assert plugin._reboot_color == "online"

    def test_ui_spec_places_the_table(self, plugin):
        spec = plugin.UI_SPEC
        placed = {name for row in spec["layout"] for name in row}
        assert "details" in placed and "details" in spec["tables"]
