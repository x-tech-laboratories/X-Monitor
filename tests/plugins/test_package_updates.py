import os
import shutil
import subprocess

import pytest

from x_monitor.plugins.package_updates import (
    PackageUpdates, _probe_script, parse_apt, parse_dnf, parse_pacman,
)
from x_monitor.plugins.base.plugin_helpers import SCRIPT_SEP
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-updates", "id": "test-updates", "ssh_config": {"host": "test.host"}}

APT_LIST = """Listing... Done
bash/jammy-updates 5.1-6ubuntu1.1 amd64 [upgradable from: 5.1-6ubuntu1]
libssl3/jammy-updates,jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.15]
openssl/stable-security 3.0.14-1~deb12u2 amd64 [upgradable from: 3.0.13-1~deb12u1]
"""

APT_SIM = """NOTE: This is only a simulation!
Inst libc6 [2.36-9+deb12u7] (2.36-9+deb12u8 Debian-Security:12/stable-security [amd64])
Inst linux-image-6.1.0-26-amd64 (6.1.112-1 Debian:12.7/stable [amd64])
Conf libc6 (2.36-9+deb12u8 Debian-Security:12/stable-security [amd64])
"""

DNF_UPDATES = """
bash.x86_64                        5.2.26-3.fc40                 updates
curl.x86_64                        8.6.0-8.fc40                  updates
texlive-collection-latexrecommended.noarch
                                   11:svn65512-1.fc40            updates
Obsoleting Packages
grub2-tools.x86_64                 1:2.06-120.fc40               updates
    grub2-tools.x86_64             1:2.06-118.fc40               @updates
"""

DNF_SECURITY = """FEDORA-2024-1a2b3c4d5e Moderate/Sec.  curl-8.6.0-8.fc40.x86_64
FEDORA-2024-9f8e7d6c5b Important/Sec. curl-minimal-8.6.0-8.fc40.x86_64
"""

DNF5_SECURITY = """Name                 Type     Severity  Package                    Issued
FEDORA-2024-1a2b3c4d security Moderate  curl-8.6.0-8.fc40.x86_64   2024-05-01 00:00:00
"""

RPM_INSTALLED = "bash.x86_64 5.2.26-1.fc40\ncurl.x86_64 8.6.0-7.fc40\n"

PACMAN = "linux 6.10.1.arch1-1 -> 6.10.2.arch1-1\nopenssl 3.3.1-1 -> 3.3.2-1\nvim 9.1-1 -> 9.1-2 [ignored]\n"


def _latest_status():
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-updates"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-updates") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _output(manager, updates="", security="", installed="", rc="0", source="", nixos=False):
    header = f"manager={manager}\nsource={source}\nrc={rc}\n" + ("nixos=1\n" if nixos else "")
    return f"{header}{SCRIPT_SEP}\n{updates}\n{SCRIPT_SEP}\n{security}\n{SCRIPT_SEP}\n{installed}\n"


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(PackageUpdates, CFG)


def _run(plugin, run_cycle, stdout, rc=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(rc, stdout, stderr))


class TestParsers:
    def test_apt_list_flags_security_origins(self):
        packages = {p["name"]: p for p in parse_apt(APT_LIST)}
        assert set(packages) == {"bash", "libssl3", "openssl"}
        assert packages["bash"] == {"name": "bash", "current": "5.1-6ubuntu1", "new": "5.1-6ubuntu1.1",
                                    "security": False, "origin": "jammy-updates"}
        assert packages["libssl3"]["security"] and packages["openssl"]["security"]

    def test_apt_simulation_lines(self):
        packages = {p["name"]: p for p in parse_apt(APT_SIM)}
        assert set(packages) == {"libc6", "linux-image-6.1.0-26-amd64"}
        assert packages["libc6"]["current"] == "2.36-9+deb12u7"
        assert packages["libc6"]["security"]
        assert packages["linux-image-6.1.0-26-amd64"]["current"] == ""
        assert not packages["linux-image-6.1.0-26-amd64"]["security"]

    def test_dnf_joins_versions_and_security(self):
        packages = {p["name"]: p for p in parse_dnf(DNF_UPDATES, DNF_SECURITY, RPM_INSTALLED)}
        assert set(packages) == {"bash", "curl", "texlive-collection-latexrecommended"}
        assert packages["curl"]["security"] and not packages["bash"]["security"]
        assert packages["curl"]["current"] == "8.6.0-7.fc40"
        assert packages["texlive-collection-latexrecommended"]["new"] == "11:svn65512-1.fc40"

    def test_dnf5_advisory_table(self):
        packages = {p["name"]: p for p in parse_dnf(DNF_UPDATES, DNF5_SECURITY, "")}
        assert packages["curl"]["security"]

    def test_pacman_with_arch_audit(self):
        packages = {p["name"]: p for p in parse_pacman(PACMAN, "openssl\n")}
        assert packages["linux"]["current"] == "6.10.1.arch1-1"
        assert packages["openssl"]["security"] and not packages["linux"]["security"]
        assert packages["vim"]["origin"] == "ignored"

    def test_pacman_arch_audit_sentence_form(self):
        audit = "Package openssl is affected by CVE-2024-0001. Update to 3.3.2-1!\n"
        assert [p["name"] for p in parse_pacman(PACMAN, audit) if p["security"]] == ["openssl"]


class TestCollection:
    def test_apt_counts_and_warns_on_security(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output("apt", APT_LIST, source="apt list --upgradable"))
        assert _latest_metric("updates_pending") == 3.0
        assert _latest_metric("security_updates_pending") == 2.0
        assert _latest_status() == "warning"
        assert "libssl3" in result.logs[0][0]
        assert [p["name"] for p in result.snapshot["packages"]][:2] == ["libssl3", "openssl"]

    def test_no_updates_is_online(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output("apt", "Listing... Done"))
        assert _latest_status() == "online"
        assert _latest_metric("updates_pending") == 0.0

    def test_plain_updates_are_online_by_default(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output("pacman", "linux 1-1 -> 1-2", rc="0"))
        assert _latest_status() == "online"

    def test_update_count_thresholds(self, make_plugin, run_cycle):
        p = make_plugin(PackageUpdates, {**CFG, "warning": 2, "threshold": 3,
                                         "security_warning": None})
        _run(p, run_cycle, _output("pacman", PACMAN, rc="0"))
        assert _latest_status() == "failed"

    def test_security_threshold_fails(self, make_plugin, run_cycle):
        p = make_plugin(PackageUpdates, {**CFG, "security_threshold": 2})
        _run(p, run_cycle, _output("apt", APT_LIST))
        assert _latest_status() == "failed"

    def test_security_warning_can_be_disabled(self, make_plugin, run_cycle):
        p = make_plugin(PackageUpdates, {**CFG, "security_warning": None})
        _run(p, run_cycle, _output("apt", APT_LIST))
        assert _latest_status() == "online"

    def test_dnf_exit_100_means_updates(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output("dnf", DNF_UPDATES, DNF_SECURITY, RPM_INSTALLED, rc="100"))
        assert _latest_metric("updates_pending") == 3.0
        assert _latest_metric("security_updates_pending") == 1.0

    def test_dnf_without_cache_is_unavailable(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output(
            "dnf", "Error: Cache-only enabled but no cache for 'fedora'", rc="1"))
        assert _latest_status() == "unavailable"
        assert "no cache" in result.logs[0][0]

    def test_checkupdates_exit_2_means_none(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output("pacman", "", rc="2", source="checkupdates"))
        assert _latest_status() == "online"
        assert _latest_metric("updates_pending") == 0.0

    def test_no_manager_is_unavailable(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output(""))
        assert _latest_status() == "unavailable"
        assert "No supported package manager" in result.logs[0][0]

    def test_nixos_points_at_nixos_upgrade(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output("", nixos=True))
        assert _latest_status() == "unavailable"
        assert "nixos_upgrade" in result.logs[0][0]

    def test_unreachable_host_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", rc=-1, stderr="connection refused")
        assert _latest_status() == "unavailable"


class TestConfig:
    def test_defaults(self, plugin):
        assert PackageUpdates("updates", {"name": "updates"}).interval == 3600
        assert plugin.manager is None
        assert plugin.security_warning == 1.0 and plugin.warning is None

    def test_manager_override_is_quoted_into_the_script(self, make_plugin):
        p = make_plugin(PackageUpdates, {**CFG, "manager": "DNF", "interval": 600})
        assert p.manager == "dnf" and p.interval == 600
        assert p.commands()[0].text.startswith("m=dnf\n")

    def test_unknown_manager_auto_detects(self, make_plugin):
        p = make_plugin(PackageUpdates, {**CFG, "manager": "zypper"})
        assert p.commands()[0].text.startswith("m=''\n")


class TestCards:
    def test_rows_and_colors(self, plugin, run_cycle):
        assert plugin._manager_text == "Detecting..."
        _run(plugin, run_cycle, _output("apt", APT_LIST))
        assert plugin._manager_text == "apt"
        rows = plugin._package_rows
        assert len({r["id"] for r in rows}) == 3
        security = [r for r in rows if r["security"]]
        assert plugin._security_cell(security[0]) == "warning"
        assert plugin._security_cell(rows[-1]) is None
        assert plugin._security_color(0) == "online" and plugin._security_color(1) == "warning"
        assert plugin._updates_color(100) == "online"


def _stub(bin_dir, name, body):
    path = bin_dir / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


@pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")
class TestScript:
    """Run the real probe script against stub package managers."""

    def _run(self, tmp_path, manager=None):
        env = {**os.environ, "PATH": f"{tmp_path}:{os.environ.get('PATH', '')}"}
        out = subprocess.run(["sh", "-c", _probe_script(manager)], capture_output=True,
                             text=True, env=env)
        return out.stdout

    def test_apt(self, tmp_path, make_plugin, run_cycle):
        _stub(tmp_path, "apt-get", "exit 0")
        _stub(tmp_path, "apt", f"cat <<'EOF'\n{APT_LIST}EOF")
        stdout = self._run(tmp_path)
        assert stdout.startswith("manager=apt\nsource=apt list --upgradable\nrc=0\n")
        p = make_plugin(PackageUpdates, CFG)
        run_cycle(p, lambda c: CmdResult(0, stdout, ""))
        assert _latest_metric("security_updates_pending") == 2.0

    def test_dnf_reads_rpm_for_current_versions(self, tmp_path, make_plugin, run_cycle):
        _stub(tmp_path, "dnf", (
            'case "$*" in *updateinfo*) cat <<\'EOF\'\n' + DNF_SECURITY + "EOF\n;;\n"
            "*) cat <<'EOF'\n" + DNF_UPDATES + "EOF\nexit 100;;\nesac"))
        _stub(tmp_path, "rpm", 'shift 3; for n in "$@"; do echo "$n 0.1-1"; done')
        stdout = self._run(tmp_path, "dnf")
        assert "rc=100" in stdout
        p = make_plugin(PackageUpdates, CFG)
        result = run_cycle(p, lambda c: CmdResult(0, stdout, ""))
        currents = {r["name"]: r["current"] for r in result.snapshot["packages"]}
        assert currents["bash"] == "0.1-1"
        assert currents["texlive-collection-latexrecommended"] == "0.1-1"

    def test_pacman_falls_back_when_checkupdates_errors(self, tmp_path, make_plugin, run_cycle):
        _stub(tmp_path, "checkupdates", "echo 'cannot fetch' >&2; exit 1")
        _stub(tmp_path, "pacman", f"cat <<'EOF'\n{PACMAN}EOF")
        stdout = self._run(tmp_path, "pacman")
        assert "source=pacman -Qu" in stdout
        p = make_plugin(PackageUpdates, CFG)
        run_cycle(p, lambda c: CmdResult(0, stdout, ""))
        assert _latest_metric("updates_pending") == 3.0
