import subprocess

import pytest

from x_monitor.plugins.attic_push import AtticPush, check_script, parse_report
from x_monitor.core.connectors.types import CmdResult

CFG = {
    "flake": "github:owner/fleet",
    "configurations": ["Alpha", "Beta"],
    "installables": {"kernel": "packages.aarch64-linux.kernel"},
    "cache_url": "https://cache.example/fleet",
}

ALPHA = "/nix/store/aaaa-nixos-system-Alpha"
BETA = "/nix/store/bbbb-nixos-system-Beta"
KERNEL = "/nix/store/kkkk-linux"
METADATA = '@flake\tmetadata\t{"revision": "0123456789abcdef0123", "locked": {}}'


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(AtticPush, CFG)


def _report(*lines: str) -> str:
    return "\n".join(lines) + "\n"


def _run(plugin, run_cycle, stdout, rc=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(rc, stdout, stderr))


def _rows(plugin):
    return {row["name"]: row for row in plugin.data.latest_snapshot(default={})["targets"]}


class TestScript:
    def test_one_command_checks_every_target(self, plugin):
        commands = plugin.commands()
        assert len(commands) == 1
        text = commands[0].text
        assert "check Alpha 'github:owner/fleet#nixosConfigurations.\"Alpha\".config.system.build.toplevel'" in text
        assert "check kernel 'github:owner/fleet#packages.aarch64-linux.kernel'" in text
        assert "--store https://cache.example/fleet" in text
        assert "refresh=--refresh" in text

    def test_local_flake_is_never_refreshed(self):
        assert "refresh=\n" in check_script("/etc/nixos", [("A", "/etc/nixos#x")], "https://c", [], "nix")

    def test_upstream_paths_are_left_out(self):
        script = check_script("/f", [("A", "/f#x")], "https://c", ["cache.nixos.org-1", "other-1"], "nix")
        assert "grep -v -F -e ' cache.nixos.org-1:' -e ' other-1:'" in script

    def test_nothing_to_check_without_a_cache(self, make_plugin):
        plugin = make_plugin(AtticPush, {**CFG, "cache_url": ""})
        assert plugin.commands() == []

    def test_script_reports_through_a_fake_nix(self, tmp_path):
        nix = tmp_path / "nix"
        nix.write_text(
            "#!/bin/sh\n"
            'case "$*" in\n'
            "  *eval*Broken*) echo 'error: no such attribute' >&2; exit 1 ;;\n"
            f"  *eval*) echo -n {ALPHA} ;;\n"
            "  *'path-info --stdin'*) cat >/dev/null; "
            f"echo '{{\"{ALPHA}\":{{\"ca\":null}},\"/nix/store/dddd-dep\":null}}' ;;\n"
            f"  *'path-info -r --sigs'*) printf '{ALPHA} \\n/nix/store/dddd-dep \\n"
            "/nix/store/eeee-glibc cache.nixos.org-1:abc\\n' ;;\n"
            "  *path-info*) exit 0 ;;\n"
            "  *metadata*) echo '{\"revision\":\"abc\"}' ;;\n"
            "esac\n")
        nix.chmod(0o755)
        script = check_script("/f", [("Alpha", "/f#a"), ("Broken", "/f#Broken")],
                              "https://c", ["cache.nixos.org-1"], str(nix))
        stdout = subprocess.run(["bash", "-c", script], capture_output=True, text=True).stdout
        facts, metadata = parse_report(stdout)
        assert facts["Alpha"] == {"target": ALPHA, "built": "1", "own": "2",
                                  "missing": ["/nix/store/dddd-dep"]}
        assert facts["Broken"]["error"] == "error: no such attribute"
        assert metadata == {"revision": "abc"}


class TestParse:
    def test_built_and_pushed_is_online(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _report(
            f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\town\t12",
            f"Beta\ttarget\t{BETA}", "Beta\tbuilt\t1", "Beta\town\t3",
            f"kernel\ttarget\t{KERNEL}", "kernel\tbuilt\t1", "kernel\town\t1",
            METADATA))
        assert result.status == "online"
        assert result.metrics["targets_pushed"] == 3.0
        rows = _rows(plugin)
        assert rows["Alpha"]["pushed"] == "All 12"
        assert rows["Alpha"]["target"] == ALPHA
        assert plugin._revision_text == "0123456789ab"
        assert plugin._pushed_text == "3 / 3"

    def test_missing_paths_are_pending(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _report(
            f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\town\t12",
            "Alpha\tmissing\t/nix/store/dddd-dep", "Alpha\tmissing\t/nix/store/ffff-dep",
            f"Beta\ttarget\t{BETA}", "Beta\tbuilt\t1", "Beta\town\t3",
            f"kernel\ttarget\t{KERNEL}", "kernel\tbuilt\t1", "kernel\town\t1"))
        assert result.status == "warning"
        assert result.metrics["missing_paths"] == 2.0
        row = _rows(plugin)["Alpha"]
        assert row["pushed"] == "2 of 12 missing"
        assert row["summary"] == "2 of 12 paths are not in the cache"
        assert [r["path"] for r in plugin._missing_rows] == ["/nix/store/dddd-dep", "/nix/store/ffff-dep"]

    def test_unbuilt_target_is_pending(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _report(
            f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t0", "Alpha\town\t1",
            f"Alpha\tmissing\t{ALPHA}"))
        assert result.status == "warning"
        row = _rows(plugin)["Alpha"]
        assert (row["built"], row["pushed"]) == ("No", "No")
        assert row["summary"] == "Not built from the latest flake"
        assert plugin._built_text == "0 / 3"

    def test_unbuilt_but_cached_root(self, plugin, run_cycle):
        _run(plugin, run_cycle, _report(f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t0", "Alpha\town\t1"))
        assert _rows(plugin)["Alpha"]["pushed"] == "Root only"

    def test_failed_evaluation_fails(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _report("Alpha\terror\terror: attribute missing"))
        assert result.status == "failed"
        assert _rows(plugin)["Alpha"]["summary"] == "Evaluation failed: error: attribute missing"
        assert _rows(plugin)["Beta"]["status"] == "unavailable"

    def test_unreachable_cache_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, _report(
            f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\town\t5",
            "Alpha\tcache_error\tunable to download"))
        row = _rows(plugin)["Alpha"]
        assert (row["status"], row["pushed"]) == ("unavailable", "Unknown")

    def test_no_output_is_unavailable(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, "", rc=-1, stderr="agent offline")
        assert result.status == "unavailable"

    def test_missing_list_is_capped(self, make_plugin, run_cycle):
        plugin = make_plugin(AtticPush, {**CFG, "missing_limit": 1})
        _run(plugin, run_cycle, _report(
            f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\town\t9",
            "Alpha\tmissing\t/nix/store/1", "Alpha\tmissing\t/nix/store/2"))
        row = _rows(plugin)["Alpha"]
        assert row["missing"] == ["/nix/store/1"]
        assert row["missing_count"] == 2

    def test_pending_status_is_configurable(self, make_plugin, run_cycle):
        plugin = make_plugin(AtticPush, {**CFG, "configurations": ["Alpha"], "installables": {},
                                         "pending_status": "failed"})
        result = _run(plugin, run_cycle, _report(f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t0",
                                                 "Alpha\town\t1"))
        assert result.status == "failed"
