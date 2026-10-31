import json
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from x_monitor.plugins.nixos_upgrade import NixosUpgrade
from x_monitor.core.connectors.types import CmdResult, CollectResult
from x_monitor.core.database.database import db, StatusHistory, Metric


BASE_CFG = {
    "name":       "test-nixos",
    "id":         "test-nixos",
    "interval":   300,
    "flake":      "/etc/nixos",
    "ssh_config": {"host": "test.host"},
}

CURRENT = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nixos-system-host-26.11"
TARGET = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-host-26.11"
KERNEL = "/nix/store/cccccccccccccccccccccccccccccccc-linux-6.18.46/bzImage"
NEW_KERNEL = "/nix/store/dddddddddddddddddddddddddddddddd-linux-6.19.1/bzImage"


def _latest_status(plugin_id: str):
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == plugin_id
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(plugin_id: str, metric: str):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == plugin_id) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


def _probe(current=CURRENT, booted=None, switched=None, generation=210,
           version="26.11.20260826.9fbb54b", kernels=(KERNEL, KERNEL)) -> CmdResult:
    """The stdout the probe script produces on a NixOS target."""
    booted_kernel, current_kernel = kernels
    switched = int(time.time()) - 3600 if switched is None else switched
    lines = [
        "hostname=host",
        f"current={current}",
        f"booted={booted or current}",
        f"switched={switched}",
        f"profile=system-{generation}-link",
        f"version={version}",
        f'version_json={{"nixosVersion":"{version}"}}',
    ]
    for part in ("initrd", "kernel", "kernel-modules", "systemd"):
        suffix = f"/{part}"
        lines.append(f"booted_part={booted_kernel}{suffix}")
        lines.append(f"current_part={current_kernel}{suffix}")
    return CmdResult(0, "\n".join(lines) + "\n", "")


def _metadata(revision="f" * 40, last_modified=None, inputs=None, dirty=False) -> CmdResult:
    """The stdout `nix flake metadata --json` produces."""
    last_modified = int(time.time()) - 7200 if last_modified is None else last_modified
    inputs = {"nixpkgs": int(time.time()) - 86400} if inputs is None else inputs
    nodes = {"root": {"inputs": {name: name for name in inputs}}}
    for name, stamp in inputs.items():
        nodes[name] = {"locked": {"lastModified": stamp, "rev": "0" * 40}}
    rev_key = "dirtyRev" if dirty else "rev"
    return CmdResult(0, json.dumps({
        "lastModified": last_modified,
        "locked": {rev_key: revision, "lastModified": last_modified},
        "locks": {"nodes": nodes, "root": "root", "version": 7},
    }), "")


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(NixosUpgrade, BASE_CFG)


def _eval_output(eval_result, metadata) -> str:
    """The output the evaluation script prints once both of its commands have run."""
    sections = []
    for name, result in (("eval", eval_result), ("metadata", metadata)):
        for stream, text in (("stdout", result.stdout), ("stderr", result.stderr),
                             ("exit", str(result.exit_code))):
            sections.append(f"@@x-monitor-eval {name} {stream}\n{text}\n")
    return "".join(sections)


def _launches_eval(plugin) -> bool:
    """Whether the plugin's next cycle launches an evaluation beside its probe."""
    cmds = plugin.commands()
    return len(cmds) == 2 and "setsid" in cmds[1].text


def _cycle(plugin, *outputs):
    """Run one cycle on the plugin's commands, feeding it these outputs."""
    plugin.commands()
    result = plugin.parse(list(outputs))
    plugin.storage.apply(result)
    return result


def _collect(plugin, probe=None, eval_result=None, metadata=None, pid=4343):
    """Drive the plugin until this cycle's probe is judged, launching and then
    finishing an evaluation with these results whenever one is due."""
    probe = probe if probe is not None else _probe()
    if not _launches_eval(plugin):
        return _cycle(plugin, probe)
    _cycle(plugin, probe, CmdResult(0, f"{pid}\n", ""))
    cmds = plugin.commands()
    assert len(cmds) == 2 and "XMONITOR_SIZE" in cmds[1].text    # the next cycle polls it
    eval_result = eval_result if eval_result is not None else CmdResult(0, TARGET + "\n", "")
    metadata = metadata if metadata is not None else _metadata()
    code = 0 if eval_result.exit_code == 0 and metadata.exit_code == 0 else 1
    result = plugin.parse([probe, _poll(1, code, False, _eval_output(eval_result, metadata))])
    plugin.storage.apply(result)
    return result


def _rewind_eval(plugin, seconds: int) -> None:
    """Age the stored evaluation by `seconds`, as if that much time had passed."""
    state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
    state["evaluated_epoch"] = int(time.time()) - seconds
    plugin.storage.apply(CollectResult(
        metrics={"flake_eval_epoch": float(state["evaluated_epoch"])},
        metadata={"flake_eval_epoch": json.dumps(state)},
    ))


class TestDrift:
    async def test_matching_closure_is_online(self, plugin):
        _collect(plugin, eval_result=CmdResult(0, CURRENT + "\n", ""))
        assert _latest_status("test-nixos") == "online"
        assert _latest_metric("test-nixos", "up_to_date") == 1.0

    async def test_differing_closure_warns(self, plugin):
        _collect(plugin)
        assert _latest_status("test-nixos") == "warning"
        assert _latest_metric("test-nixos", "up_to_date") == 0.0

    async def test_drift_status_is_configurable(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "drift_status": "failed"})
        _collect(p)
        assert _latest_status("test-nixos") == "failed"

    async def test_unrecognised_drift_status_falls_back_to_warning(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "drift_status": "catastrophe"})
        assert p.drift_status == "warning"

    async def test_drift_logs_both_closures(self, plugin):
        result = _collect(plugin)
        message = next(m for m, _ in result.logs if "out of date" in m)
        assert TARGET in message and CURRENT in message

    async def test_new_closure_is_re_evaluated_before_being_called_drift(self, plugin):
        _collect(plugin, eval_result=CmdResult(0, CURRENT + "\n", ""))   # evaluated: matches
        newer = "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-nixos-system-host-26.11"
        result = _collect(plugin, probe=_probe(current=newer))            # a deploy landed since
        assert "up_to_date" not in result.metrics
        assert _latest_status("test-nixos") == "online"
        assert _launches_eval(plugin)                                     # the next cycle evaluates

    async def test_new_closure_that_still_differs_after_evaluation_is_drift(self, plugin):
        _collect(plugin, eval_result=CmdResult(0, CURRENT + "\n", ""))
        newer = "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-nixos-system-host-26.11"
        _collect(plugin, probe=_probe(current=newer))
        _collect(plugin, probe=_probe(current=newer), eval_result=CmdResult(0, TARGET + "\n", ""))
        assert _latest_status("test-nixos") == "warning"
        assert _latest_metric("test-nixos", "up_to_date") == 0.0

    async def test_evaluation_failure_is_failed(self, plugin):
        _collect(plugin, eval_result=CmdResult(1, "", "error: attribute 'nope' missing"))
        assert _latest_status("test-nixos") == "failed"
        assert _latest_metric("test-nixos", "up_to_date") is None

    async def test_non_nixos_host_is_unavailable(self, plugin):
        _collect(plugin, probe=CmdResult(0, "current=\nbooted=\n", ""))
        assert _latest_status("test-nixos") == "unavailable"

    async def test_unreachable_target_is_unavailable(self, plugin):
        _collect(plugin, probe=CmdResult(255, "", "ssh: connect failed"))
        assert _latest_status("test-nixos") == "unavailable"

    async def test_unreachable_eval_host_is_unavailable(self, plugin):
        _cycle(plugin, _probe(), CmdResult(-1, "", "Agent 'x' is not connected"))
        assert _latest_status("test-nixos") == "unavailable"
        assert _latest_metric("test-nixos", "up_to_date") is None
        assert plugin.jobs.running_side("eval") is None

    async def test_failed_launch_is_a_failed_evaluation(self, plugin):
        _cycle(plugin, _probe(), CmdResult(1, "", "setsid: not found"))
        assert _latest_status("test-nixos") == "failed"
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert "setsid: not found" in state["eval_error"]


class TestReboot:
    async def test_same_kernel_needs_no_reboot(self, plugin):
        _collect(plugin, eval_result=CmdResult(0, CURRENT + "\n", ""))
        assert _latest_metric("test-nixos", "reboot_required") == 0.0
        assert _latest_status("test-nixos") == "online"

    async def test_changed_kernel_requires_reboot(self, plugin):
        _collect(plugin, probe=_probe(kernels=(KERNEL, NEW_KERNEL)),
                 eval_result=CmdResult(0, CURRENT + "\n", ""))
        assert _latest_metric("test-nixos", "reboot_required") == 1.0
        assert _latest_status("test-nixos") == "warning"

    async def test_reboot_status_is_configurable(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "reboot_status": "failed"})
        _collect(p, probe=_probe(kernels=(KERNEL, NEW_KERNEL)),
                 eval_result=CmdResult(0, CURRENT + "\n", ""))
        assert _latest_status("test-nixos") == "failed"


class TestFlakeMetadata:
    async def test_revision_and_inputs_recorded(self, plugin):
        modified = int(time.time()) - 7200
        oldest = int(time.time()) - 86400
        _collect(plugin, metadata=_metadata(revision="a" * 40, last_modified=modified,
                                            inputs={"nixpkgs": oldest, "flake-utils": oldest + 60}))
        assert _latest_metric("test-nixos", "flake_last_modified_epoch") == float(modified)
        assert _latest_metric("test-nixos", "inputs_last_modified_epoch") == float(oldest)
        assert _latest_metric("test-nixos", "flake_reachable") == 1.0
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert state["flake_revision"] == "a" * 40
        assert state["oldest_input"] == "nixpkgs"

    async def test_dirty_checkout_revision_is_read_and_marked(self, plugin):
        _collect(plugin, metadata=_metadata(revision="a" * 40 + "-dirty", dirty=True))
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert state["flake_revision"] == "a" * 40 + "-dirty"
        assert plugin._revision_text == "a" * 12 + "-dirty"

    async def test_metadata_failure_is_unavailable_and_keeps_drift(self, plugin):
        _collect(plugin, eval_result=CmdResult(0, CURRENT + "\n", ""),
                 metadata=CmdResult(1, "", "error: unable to fetch"))
        assert _latest_metric("test-nixos", "flake_reachable") == 0.0
        assert _latest_metric("test-nixos", "up_to_date") == 1.0
        assert _latest_status("test-nixos") == "unavailable"

    async def test_stale_inputs_warn_when_max_input_age_set(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "max_input_age": "7d"})
        stale = int(time.time()) - 30 * 86400
        _collect(p, eval_result=CmdResult(0, CURRENT + "\n", ""),
                 metadata=_metadata(inputs={"nixpkgs": stale}))
        assert _latest_status("test-nixos") == "warning"

    async def test_stale_inputs_ignored_without_max_input_age(self, plugin):
        stale = int(time.time()) - 365 * 86400
        _collect(plugin, eval_result=CmdResult(0, CURRENT + "\n", ""),
                 metadata=_metadata(inputs={"nixpkgs": stale}))
        assert _latest_status("test-nixos") == "online"


class TestEvalSchedule:
    async def test_first_cycle_evaluates(self, plugin):
        assert _launches_eval(plugin)

    async def test_fresh_evaluation_is_not_repeated(self, plugin):
        _collect(plugin)
        assert not _launches_eval(plugin)

    async def test_stale_evaluation_is_redone(self, plugin):
        _collect(plugin)
        _rewind_eval(plugin, 7200)
        assert _launches_eval(plugin)

    async def test_fresh_failure_is_not_retried_immediately(self, plugin):
        _collect(plugin, eval_result=CmdResult(1, "", "error: attribute missing"))
        assert not _launches_eval(plugin)

    async def test_failed_evaluation_retries_after_retry_interval(self, plugin):
        _collect(plugin, eval_result=CmdResult(1, "", "error: attribute missing"))
        _rewind_eval(plugin, 20 * 60)                      # past 15m retry, short of 1h eval
        assert _launches_eval(plugin)

    async def test_failed_metadata_retries_too(self, plugin):
        _collect(plugin, metadata=CmdResult(1, "", "error: unable to download"))
        _rewind_eval(plugin, 20 * 60)
        assert _launches_eval(plugin)

    async def test_healthy_evaluation_ignores_retry_interval(self, plugin):
        _collect(plugin)
        _rewind_eval(plugin, 20 * 60)
        assert not _launches_eval(plugin)

    def test_retry_interval_never_exceeds_eval_interval(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "eval_interval": "10m", "retry_interval": "15m"})
        assert p.retry_interval == 600

    async def test_dashboard_poll_forces_evaluation(self, plugin):
        _collect(plugin)                                   # fresh, so a tick would probe only
        plugin.engine = MagicMock(run_cycle_now=AsyncMock(return_value=True))
        assert await plugin.run_cycle() is True
        assert _launches_eval(plugin)

    async def test_probe_only_cycle_still_tracks_drift(self, plugin):
        _collect(plugin)                                   # evaluates, drift found
        result = _collect(plugin, probe=_probe(current=TARGET))   # a switch landed
        assert result.metrics["up_to_date"] == 1.0
        assert _latest_status("test-nixos") == "online"


class TestCommands:
    def test_commands_run_on_the_target_by_default(self, plugin):
        assert all(c.agent is None for c in plugin.commands())

    async def test_eval_agent_offloads_only_the_evaluation(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "eval_agent": "big-host", "configuration": "host"})
        probe, launch = p.commands()
        assert probe.agent is None                          # the probe stays on the target
        assert launch.agent == "big-host"

    async def test_offloaded_eval_waits_for_the_probed_hostname(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "eval_agent": "big-host"})
        assert len(p.commands()) == 1                       # no name yet: probe only
        _cycle(p, _probe())                                 # the probe reports hostname=host
        assert p.commands()[1].agent == "big-host"
        assert 'nixosConfigurations.\\"host\\"' in p._eval_script()
        assert "uname" not in p._eval_script()              # never the evaluating host's own name

    def test_local_flake_needs_no_refresh(self, plugin):
        script = plugin._eval_script()
        assert "--refresh" not in script
        assert '"/etc/nixos#nixosConfigurations.\\"$(uname -n)\\"' in script

    def test_remote_flake_refreshes(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "flake": "github:owner/config"})
        assert p._eval_script().count("--refresh") == 2

    def test_configuration_overrides_the_hostname(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "configuration": "ragnarok"})
        assert 'nixosConfigurations.\\"ragnarok\\"' in p._eval_script()
        assert "$(uname -n)" not in p._eval_script()

    def test_eval_never_writes_the_lock_file(self, plugin):
        assert plugin._eval_script().count("--no-write-lock-file") == 2

    def test_eval_carries_its_own_timeout(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "eval_timeout": "20m"})
        assert p._eval_command().startswith("timeout 1200 sh -c ")
        assert "timeout 1200" in p.commands()[1].text



class TestReadOnly:
    def test_offers_no_actions(self, plugin):
        assert plugin.get_actions() == []
        for action_id in ("update_flake", "switch", "build", "reboot"):
            assert plugin.plan_action(action_id) is None

    async def test_removed_management_keys_are_ignored(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "auto_switch": True, "build_at": "02:30",
                                       "switch_agent": "builder", "push_ssh_key": "/run/key"})
        cmds = p.commands()
        assert len(cmds) == 2 and all(c.agent is None for c in cmds)
        assert not any("nixos-rebuild" in c.text or "flake update" in c.text for c in cmds)

    async def test_drift_never_launches_anything_but_the_evaluation(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "auto_switch": True, "auto_switch_after": "0s"})
        _collect(p)                                         # drift against TARGET
        _rewind_eval(p, 7200)
        cmds = p.commands()
        assert len(cmds) == 2 and "nixos-rebuild" not in cmds[1].text


class TestLocalPath:
    @pytest.mark.parametrize("ref,expected", [
        ("/etc/nixos", "/etc/nixos"),
        ("path:/etc/nixos", "/etc/nixos"),
        ("git+file:///etc/nixos", "/etc/nixos"),
        ("git+file:///etc/nixos?ref=main", "/etc/nixos"),
        ("./config", "./config"),
        ("github:owner/config", None),
        ("gitlab:owner/config", None),
    ])
    def test_local_paths_are_recognised(self, make_plugin, ref, expected):
        assert make_plugin(NixosUpgrade, {**BASE_CFG, "flake": ref}).local_path == expected


def _poll(size, exit_code, alive, out):
    """Build the raw stdout one poll_command produces on the target."""
    return CmdResult(0, (
        f"===XMONITOR_SIZE===\n{size}\n"
        f"===XMONITOR_EXIT===\n{exit_code if exit_code is not None else ''}\n"
        f"===XMONITOR_ALIVE===\n{1 if alive else 0}\n"
        f"===XMONITOR_OUT===\n{out}"
    ), "")


def _launch_eval(plugin, pid=4343):
    """Run the cycle that launches an evaluation, returning its job row."""
    assert _launches_eval(plugin)
    _cycle(plugin, _probe(), CmdResult(0, f"{pid}\n", ""))
    return plugin.jobs.running_side("eval")


def _poll_eval(plugin, poll_result, probe=None):
    """Run one cycle that polls the running evaluation beside the probe."""
    cmds = plugin.commands()
    assert len(cmds) == 2 and "XMONITOR_SIZE" in cmds[1].text
    result = plugin.parse([probe if probe is not None else _probe(), poll_result])
    plugin.storage.apply(result)
    return result


def _finished(eval_result=None, metadata=None, code=0):
    """A poll of an evaluation that has finished with these results."""
    eval_result = eval_result if eval_result is not None else CmdResult(0, TARGET + "\n", "")
    metadata = metadata if metadata is not None else _metadata()
    return _poll(1, code, False, _eval_output(eval_result, metadata))


class TestDetachedEvaluation:
    async def test_launch_records_a_side_job(self, plugin):
        command = plugin._eval_command()
        job = _launch_eval(plugin, pid=4343)
        assert (job["kind"], job["pid"]) == ("eval", 4343)
        assert job["workdir"] == plugin.eval_workdir and job["command"] == command
        assert plugin.jobs.running() is None                # never the main job

    async def test_the_workdir_is_fixed_per_monitor(self, plugin, make_plugin):
        assert plugin.eval_workdir == make_plugin(NixosUpgrade, BASE_CFG).eval_workdir
        assert plugin.eval_workdir.endswith("nixos_upgrade-test-nixos-eval")

    async def test_a_running_evaluation_keeps_the_stored_state(self, plugin):
        _collect(plugin)                                    # drift against TARGET
        _rewind_eval(plugin, 7200)
        _launch_eval(plugin)
        result = _poll_eval(plugin, _poll(0, None, True, ""))
        assert result.metrics["up_to_date"] == 0.0          # still judged against the stored target
        assert plugin.jobs.running_side("eval") is not None

    async def test_a_running_evaluation_is_never_relaunched(self, plugin):
        _launch_eval(plugin)
        plugin.engine = MagicMock(run_cycle_now=AsyncMock(return_value=True))
        await plugin.run_cycle()                            # a dashboard poll
        assert plugin._force_eval is False
        assert not _launches_eval(plugin)
        _poll_eval(plugin, _poll(0, None, True, ""))
        assert len(plugin.jobs.recent(limit=99)) == 1

    async def test_finishing_folds_the_result(self, plugin):
        job = _launch_eval(plugin)
        result = _poll_eval(plugin, _finished(eval_result=CmdResult(0, CURRENT, "")))
        assert result.metrics["up_to_date"] == 1.0
        assert plugin.jobs.running_side("eval") is None
        row = plugin.jobs.recent(limit=1)[0]
        assert (row["id"], row["state"]) == (job["id"], "succeeded")
        assert not _launches_eval(plugin)                   # fresh until eval_interval passes

    async def test_finished_output_stays_in_the_job_log(self, plugin):
        job = _launch_eval(plugin)
        _poll_eval(plugin, _finished(eval_result=CmdResult(0, TARGET, "evaluating...")))
        log = [line["message"] for line in await plugin.jobs.log(job["id"])]
        assert TARGET in log and "evaluating..." in log

    async def test_an_evaluation_error_is_failed(self, plugin):
        _launch_eval(plugin)
        _poll_eval(plugin, _finished(eval_result=CmdResult(1, "", "error: attribute 'nope' missing"),
                                     code=1))
        assert _latest_status("test-nixos") == "failed"
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert "attribute 'nope' missing" in state["eval_error"] and not state["eval_unreachable"]
        assert plugin.jobs.recent(limit=1)[0]["state"] == "failed"

    async def test_a_vanished_evaluation_is_a_failed_job_and_an_eval_error(self, plugin):
        _launch_eval(plugin)
        _poll_eval(plugin, _poll(0, None, False, ""))
        row = plugin.jobs.recent(limit=1)[0]
        assert (row["state"], row["exit_code"]) == ("failed", -1)
        assert _latest_status("test-nixos") == "failed"
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert "without writing an exit code" in state["eval_error"]

    async def test_a_timed_out_evaluation_says_so(self, plugin):
        _launch_eval(plugin)
        _poll_eval(plugin, _poll(0, 124, False, ""))
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert "Timed out after 10 Minutes" in state["eval_error"]
        assert _latest_status("test-nixos") == "failed"

    async def test_an_unanswered_poll_is_unreachable_and_keeps_the_job(self, plugin):
        _launch_eval(plugin)
        _poll_eval(plugin, CmdResult(-1, "", "Agent 'x' is not connected"))
        assert _latest_status("test-nixos") == "unavailable"
        assert plugin.jobs.running_side("eval") is not None
        _poll_eval(plugin, _finished(eval_result=CmdResult(0, CURRENT, "")))
        assert _latest_status("test-nixos") == "online"

    async def test_a_failed_probe_still_records_the_launch(self, plugin):
        assert _launches_eval(plugin)
        _cycle(plugin, CmdResult(255, "", "ssh: connect failed"), CmdResult(0, "4343\n", ""))
        assert plugin.jobs.running_side("eval")["pid"] == 4343

    async def test_a_finish_on_a_failed_probe_is_still_stored(self, plugin):
        _launch_eval(plugin)
        _poll_eval(plugin, _finished(), probe=CmdResult(255, "", "ssh: connect failed"))
        state = json.loads(plugin.data.latest_metric("flake_eval_epoch").metadata)
        assert state["target"] == TARGET

    async def test_a_restarted_monitor_adopts_the_running_evaluation(self, plugin, make_plugin):
        job = _launch_eval(plugin)
        restarted = make_plugin(NixosUpgrade, BASE_CFG)
        assert not _launches_eval(restarted)
        _poll_eval(restarted, _finished())
        assert restarted.jobs.recent(limit=1)[0]["id"] == job["id"]
        assert restarted.jobs.running_side("eval") is None

    async def test_the_evaluation_is_polled_on_the_eval_agent(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "eval_agent": "big-host", "configuration": "host"})
        job = _launch_eval(p)
        assert p.job_agent(job) == "big-host"
        assert p.commands()[1].agent == "big-host"

    async def test_a_running_evaluation_is_polled_every_job_poll(self, plugin, make_plugin):
        assert plugin.next_cycle_in() is None
        _launch_eval(plugin)
        assert plugin.next_cycle_in() == 30
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "job_poll": "1m"})
        assert p.next_cycle_in() == 60

    def test_the_script_splits_back_into_both_results(self, make_plugin, tmp_path):
        import os
        import subprocess
        nix = tmp_path / "nix"
        nix.write_text(
            "#!/bin/sh\n"
            'case "$*" in\n'
            '  *"flake metadata"*) echo \'{"lastModified": 5}\'; echo "fetching" >&2 ;;\n'
            f'  *eval*) echo "warning: dirty" >&2; printf {TARGET}; exit 0 ;;\n'
            "esac\n")
        nix.chmod(0o755)
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "nix_bin": str(nix), "nix_args": []})
        env = {**os.environ, "HOME": str(tmp_path)}
        run = subprocess.run(["sh", "-c", f'mkdir -p "{p.eval_workdir}" && {p._eval_command()}'],
                             capture_output=True, text=True, env=env)
        assert run.returncode == 0
        from x_monitor.plugins.nixos_upgrade import _split_eval_output
        parts = _split_eval_output(run.stdout, "missing")
        assert parts["eval"] == CmdResult(0, TARGET, "warning: dirty")
        assert parts["metadata"] == CmdResult(0, '{"lastModified": 5}', "fetching")
        # nix's stderr is printed as it runs, before any command's stdout, so the job's log shows it live.
        assert run.stdout.startswith("@@x-monitor-eval eval stderr\nwarning: dirty\n"
                                     "@@x-monitor-eval metadata stderr\nfetching\n")

    def test_a_command_the_run_never_reported_on_fails(self):
        from x_monitor.plugins.nixos_upgrade import _split_eval_output
        parts = _split_eval_output("@@x-monitor-eval eval stdout\n" + TARGET + "\n", "killed")
        assert parts["eval"] == CmdResult(1, "", "killed")
        assert parts["metadata"] == CmdResult(1, "", "killed")


class TestUI:
    async def test_configuration_row_shows_the_resolved_hostname(self, plugin):
        _collect(plugin)
        rows = {r["label"]: r["value"] for r in plugin._detail_rows}
        assert rows["Configuration"] == "host"

    async def test_configuration_row_prefers_the_configured_name(self, make_plugin):
        p = make_plugin(NixosUpgrade, {**BASE_CFG, "configuration": "gateway"})
        _collect(p)
        rows = {r["label"]: r["value"] for r in p._detail_rows}
        assert rows["Configuration"] == "gateway"

    async def test_configuration_row_before_any_probe(self, plugin):
        rows = {r["label"]: r["value"] for r in plugin._detail_rows}
        assert rows["Configuration"] == "the target's hostname"

    async def test_detail_rows_cover_both_closures(self, plugin):
        _collect(plugin)
        rows = {r['label']: r['value'] for r in plugin._detail_rows}
        assert rows['Running closure'] == CURRENT
        assert rows['Flake closure'] == TARGET
        assert rows['Flake'] == "/etc/nixos"

    async def test_drift_card_states(self, plugin):
        assert plugin._drift_text == 'UNKNOWN'
        _collect(plugin)
        assert plugin._drift_text == 'OUT OF DATE'
        assert plugin._drift_color == 'warning'
        _collect(plugin, probe=_probe(current=TARGET))
        assert plugin._drift_text == 'UP TO DATE'
        assert plugin._drift_color == 'online'

    async def test_reboot_card_states(self, plugin):
        _collect(plugin)
        assert plugin._reboot_text == 'NOT NEEDED'
        _collect(plugin, probe=_probe(kernels=(KERNEL, NEW_KERNEL)))
        assert plugin._reboot_text == 'REQUIRED'

    def test_details_table_has_a_title(self, plugin):
        assert plugin.UI_SPEC['tables']['details']['title'] == 'Deployment details'

    async def test_shows_no_job_panel(self, plugin):
        spec = plugin.UI_SPEC
        assert 'job_panel' not in spec and 'buttons' not in spec
        assert all('jobs' not in row for row in spec['layout'])
        assert spec['cards']['flake_card']['value'] == "/etc/nixos"
