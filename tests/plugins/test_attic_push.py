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


def _poll(out, exit_code=None, alive=True):
    """The raw stdout one poll of the detached check produces on the target."""
    return CmdResult(0, (
        f"===XMONITOR_SIZE===\n{len(out)}\n"
        f"===XMONITOR_EXIT===\n{exit_code if exit_code is not None else ''}\n"
        f"===XMONITOR_ALIVE===\n{1 if alive else 0}\n"
        f"===XMONITOR_OUT===\n{out}"
    ), "")


def _launch(plugin, run_cycle, pid=4242):
    """One cycle with no job running: it launches the check and records its pid."""
    return run_cycle(plugin, lambda c: CmdResult(0, f"{pid}\n", ""))


def _run(plugin, run_cycle, stdout, exit_code=0):
    """Launch the check, then poll it once as finished with this output."""
    _launch(plugin, run_cycle)
    return run_cycle(plugin, lambda c: _poll(stdout, exit_code, alive=False))


def _rows(plugin):
    return {row["name"]: row for row in plugin.data.latest_snapshot(default={})["targets"]}


class TestScript:
    def test_one_script_checks_every_target(self, plugin):
        text = plugin.check_script()
        assert "check Alpha 'github:owner/fleet#nixosConfigurations.\"Alpha\".config.system.build.toplevel'" in text
        assert "check kernel 'github:owner/fleet#packages.aarch64-linux.kernel'" in text
        assert "--store https://cache.example/fleet" in text
        assert "refresh=--refresh" in text

    def test_local_flake_is_never_refreshed(self):
        assert "refresh=\n" in check_script("/etc/nixos", [("A", "/etc/nixos#x")], "https://c", [], "nix")

    def test_upstream_paths_are_left_out(self):
        script = check_script("/f", [("A", "/f#x")], "https://c", ["cache.nixos.org-1", "other-1"], "nix")
        assert 'split("cache.nixos.org-1: other-1:", up, " ")' in script

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
            # nix pads the path column with spaces then a tab, so the widest path has only the tab.
            f"  *'path-info -r --sigs'*) printf '{ALPHA}      \\tultimate\\n"
            "/nix/store/dddd-dep\\tultimate\\n"
            "/nix/store/eeee-glibc   \\tcache.nixos.org-1:abc\\n"
            "/nix/store/ffff-zlib\\tcache.nixos.org-1:def\\n' ;;\n"
            "  *path-info*) exit 0 ;;\n"
            "  *metadata*) echo '{\"revision\":\"abc\"}' ;;\n"
            "esac\n")
        nix.chmod(0o755)
        script = check_script("/f", [("Alpha", "/f#a"), ("Broken", "/f#Broken")],
                              "https://c", ["cache.nixos.org-1"], str(nix))
        run = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
        facts, metadata = parse_report(run.stdout)
        assert facts["Alpha"] == {"target": ALPHA, "built": "1", "own": "2",
                                  "missing": ["/nix/store/dddd-dep"]}
        assert facts["Broken"]["error"] == "error: no such attribute"
        assert metadata == {"revision": "abc"}
        # The evaluation's stderr is copied to the job's log as it runs, not only into the report.
        assert run.stderr == "error: no such attribute\n"


class TestKeptOnlyInTheCache:
    @staticmethod
    def _nix(tmp_path, local=True, missing=""):
        """A fake nix whose store holds ALPHA when `local`, and whose cache lacks `missing`."""
        nix = tmp_path / "nix"
        absent = f',"{missing}":null' if missing else ''
        nix.write_text(
            "#!/bin/sh\n"
            'case "$*" in\n'
            f"  *eval*) echo -n {ALPHA} ;;\n"
            "  *'path-info --stdin'*) cat >/dev/null; "
            f"echo '{{\"{ALPHA}\":{{}}{absent}}}' ;;\n"
            f"  *'path-info -r'*) printf '{ALPHA}\\n/nix/store/dddd-dep\\n' ;;\n"
            f"  *path-info*) exit {0 if local else 1} ;;\n"
            "esac\n")
        nix.chmod(0o755)
        return str(nix)

    @staticmethod
    def _check(nix, closure_list):
        script = check_script("/f", [("Alpha", "/f#a")], "https://c", [], nix,
                              {"Alpha": str(closure_list)})
        return parse_report(subprocess.run(["sh", "-c", script], capture_output=True, text=True).stdout)[0]["Alpha"]

    def test_a_fully_pushed_root_is_never_dropped(self, tmp_path):
        link, closure_list = tmp_path / "alpha", tmp_path / "alpha.closure"
        link.symlink_to(ALPHA)
        fact = self._check(self._nix(tmp_path), closure_list)
        assert fact == {"target": ALPHA, "built": "1", "own": "2", "missing": []}
        assert link.is_symlink() and not closure_list.exists()
        assert sorted(p.name for p in tmp_path.iterdir()) == ["alpha", "nix"]

    def test_a_dropped_target_is_judged_by_its_list(self, tmp_path):
        closure_list = tmp_path / "alpha.closure"
        closure_list.write_text(f"{ALPHA}\n{ALPHA}\n/nix/store/dddd-dep\n")
        fact = self._check(self._nix(tmp_path, local=False, missing="/nix/store/dddd-dep"),
                           closure_list)
        assert fact == {"target": ALPHA, "built": "1", "local": "0", "own": "2",
                        "missing": ["/nix/store/dddd-dep"]}

    def test_a_list_for_an_older_closure_counts_for_nothing(self, tmp_path):
        closure_list = tmp_path / "alpha.closure"
        closure_list.write_text(f"{BETA}\n{BETA}\n")
        fact = self._check(self._nix(tmp_path, local=False), closure_list)
        assert fact["built"] == "0" and "local" not in fact

    def test_only_named_targets_read_a_closure_list(self, make_plugin):
        plugin = make_plugin(AtticPush, {**CFG, "build_root_dir": "/roots", "drop_pushed": ["Alpha"],
                                         "build_links": {"Alpha": "alpha-deploy"}})
        text = plugin.check_script()
        assert ("check Alpha 'github:owner/fleet#nixosConfigurations.\"Alpha\".config.system.build.toplevel' "
                "/roots/alpha-deploy.closure") in text
        assert "check Beta 'github:owner/fleet#nixosConfigurations.\"Beta\".config.system.build.toplevel'\n" in text

    def test_a_dropped_row_says_so(self, plugin, run_cycle):
        _run(plugin, run_cycle, _report(f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\tlocal\t0",
                                        "Alpha\town\t2", METADATA))
        row = _rows(plugin)["Alpha"]
        assert row["status"] == "online" and row["summary"] == "Pushed, kept only in the cache"

    def test_the_script_never_writes_to_the_build_root_folder(self, make_plugin):
        plugin = make_plugin(AtticPush, {**CFG, "build_root_dir": "/roots", "drop_pushed": ["Alpha"]})
        text = plugin.check_script()
        assert "rm -f" not in text and "mv " not in text and "readlink" not in text


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
        result = _run(plugin, run_cycle, "", exit_code=1)
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


class TestDetachedJob:
    def test_is_never_sampled_on_the_agent(self):
        assert AtticPush.SAMPLED is False

    def test_a_cycle_without_a_job_launches_the_check(self, plugin):
        commands = plugin.commands()
        assert len(commands) == 1
        text = commands[0].text
        assert "setsid" in text and "attic_push-test-plugin" in text
        assert "timeout 1800 sh -c" in text

    def test_launching_records_a_running_job(self, plugin, run_cycle):
        result = _launch(plugin, run_cycle, pid=1234)
        job = plugin.jobs.running()
        assert job["kind"] == "check" and job["pid"] == 1234
        assert result.status is None and result.snapshot is None

    def test_a_failed_launch_is_unavailable_and_records_no_job(self, plugin, run_cycle):
        result = run_cycle(plugin, lambda c: CmdResult(-1, "", "agent offline"))
        assert result.status == "unavailable"
        assert plugin.jobs.running() is None

    def test_a_running_job_is_polled_instead_of_relaunched(self, plugin, run_cycle):
        _launch(plugin, run_cycle)
        text = plugin.commands()[0].text
        assert "kill -0 4242" in text and "setsid" not in text

    def test_a_running_check_keeps_the_previous_snapshot(self, plugin, run_cycle):
        _run(plugin, run_cycle, _report(f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\town\t1"))
        before = plugin.data.latest_snapshot()
        _launch(plugin, run_cycle)
        result = run_cycle(plugin, lambda c: _poll(f"Alpha\ttarget\t{ALPHA}\n"))
        assert result.status is None and result.snapshot is None
        assert plugin.data.latest_snapshot() == before
        job = plugin.jobs.running()
        assert job["progress"] == "1 of 3 targets evaluated"

    def test_output_reaches_the_job_log_once(self, plugin, run_cycle, db_manager):
        _launch(plugin, run_cycle)
        first = f"Alpha\ttarget\t{ALPHA}\n"
        run_cycle(plugin, lambda c: _poll(first))
        run_cycle(plugin, lambda c: _poll(first + "Alpha\tbuilt\t1\n"))
        job_id = plugin.jobs.running()["id"]
        lines = [row["message"] for row in db_manager.job_output(job_id, limit=0)]
        assert lines == [f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1"]

    def test_a_finished_check_is_parsed_from_its_whole_output(self, plugin, run_cycle):
        _launch(plugin, run_cycle)
        run_cycle(plugin, lambda c: _poll(f"Alpha\ttarget\t{ALPHA}\nAlpha\tbuilt\t1\n"))
        result = run_cycle(plugin, lambda c: _poll(_report(
            f"Alpha\ttarget\t{ALPHA}", "Alpha\tbuilt\t1", "Alpha\town\t4",
            f"Beta\ttarget\t{BETA}", "Beta\tbuilt\t1", "Beta\town\t2",
            f"kernel\ttarget\t{KERNEL}", "kernel\tbuilt\t1", "kernel\town\t1"), 0, alive=False))
        assert result.status == "online"
        assert _rows(plugin)["Alpha"]["pushed"] == "All 4"
        assert plugin.jobs.running() is None
        assert plugin.jobs.recent()[0]["state"] == "succeeded"

    def test_a_check_that_timed_out_fails_its_job(self, plugin, run_cycle):
        _launch(plugin, run_cycle)
        result = run_cycle(plugin, lambda c: _poll(f"Alpha\ttarget\t{ALPHA}\n", 124, alive=False))
        assert plugin.jobs.recent()[0]["state"] == "failed"
        assert any("exited with status 124" in message for message, _ in result.logs)

    def test_a_vanished_check_fails_its_job(self, plugin, run_cycle):
        _launch(plugin, run_cycle)
        result = run_cycle(plugin, lambda c: _poll("", None, alive=False))
        assert plugin.jobs.recent()[0]["state"] == "failed"
        assert result.status == "unavailable"

    def test_an_unanswered_poll_leaves_the_job_running(self, plugin, run_cycle):
        _launch(plugin, run_cycle)
        result = run_cycle(plugin, lambda c: CmdResult(-1, "", "Agent 'x' is not connected"))
        assert plugin.jobs.running() is not None
        assert result.status is None
        assert any("Could not poll" in message for message, _ in result.logs)

    def test_a_restarted_monitor_adopts_the_running_check(self, make_plugin, plugin, run_cycle):
        _launch(plugin, run_cycle, pid=777)
        restarted = make_plugin(AtticPush, CFG)
        assert "kill -0 777" in restarted.commands()[0].text

    def test_a_running_check_is_polled_sooner_than_the_interval(self, plugin, run_cycle):
        assert plugin.next_cycle_in() is None
        _launch(plugin, run_cycle)
        assert plugin.next_cycle_in() == 30

    def test_job_poll_is_configurable(self, make_plugin, run_cycle):
        plugin = make_plugin(AtticPush, {**CFG, "job_poll": "10s"})
        _launch(plugin, run_cycle)
        assert plugin.next_cycle_in() == 10


class TestUiSpec:
    def test_runs_have_a_job_panel(self, plugin):
        assert plugin.UI_SPEC['job_panel']['title'] == 'Runs'
        assert ['jobs'] in plugin.UI_SPEC['layout']

    def test_table_titles_are_in_sentence_case(self, plugin):
        tables = plugin.UI_SPEC['tables']
        assert tables['targets']['title'] == 'Tracked targets'
        assert tables['missing']['title'] == 'Paths not in the cache'


class TestReadOnly:
    def test_offers_no_actions(self, plugin):
        assert plugin.get_actions() == []
        assert plugin.plan_action("build_target", target="Alpha") is None
        assert plugin.plan_action("push_target", target="Alpha") is None

    def test_rows_offer_no_actions(self, plugin):
        assert 'row_actions' not in plugin.UI_SPEC['tables']['targets']

    def test_removed_build_and_push_keys_are_ignored(self, make_plugin):
        plugin = make_plugin(AtticPush, {**CFG, "push_command": "attic push fleet",
                                         "build_args": ["--keep-going"]})
        text = plugin.check_script()
        assert "attic push" not in text and "nix build" not in text
