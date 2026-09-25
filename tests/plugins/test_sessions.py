import time

import pytest

from vigil.plugins.sessions import (
    Sessions, _probe_script, _source_allowed, parse_last, parse_loginctl, parse_who,
)
from vigil.plugins.base.plugin_helpers import SCRIPT_SEP
from vigil.core.connectors.types import CmdResult
from vigil.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-sessions", "id": "test-sessions", "ssh_config": {"host": "test.host"}}


def _block(sid, user, host="", remote=None, tty="pts/0", seat="", cls="user", kind="tty",
           service="sshd", since="Thu 2026-09-24 10:00:00 UTC", idle="no", idle_since="0"):
    remote = ("yes" if host else "no") if remote is None else remote
    return (f"Id={sid}\nName={user}\nTimestamp={since}\nSeat={seat}\nTTY={tty}\n"
            f"Remote={remote}\nRemoteHost={host}\nRemoteUser=\nService={service}\n"
            f"Type={kind}\nClass={cls}\nState=active\nIdleHint={idle}\nIdleSinceHint={idle_since}\n")


ALICE_SSH = _block("4", "alice", "192.0.2.5")
ALICE_DESKTOP = _block("2", "alice", tty="", seat="seat0", kind="wayland", service="gdm-password")
MANAGER = _block("3", "alice", tty="", cls="manager", kind="unspecified", service="systemd-user")
GREETER = _block("c1", "gdm", tty="tty1", seat="seat0", cls="greeter", kind="wayland", service="gdm-launch-environment")
MALLORY = _block("7", "mallory", "203.0.113.9")

WHO = """alice    pts/0        2026-09-24 10:00   .          1234 192.0.2.5
bob      tty1         2026-09-24 08:00 01:20        987
carol    pts/1        2026-09-23 22:00  old         4321 (host1.example.com)
dave     :0           2026-09-24 07:00   ?          555 (:0)
"""

LAST = """alice    pts/0        192.0.2.5        2026-09-24T10:00:00+00:00   still logged in
reboot   system boot  0.0.0.0          2026-09-24T07:59:00+00:00   still running
bob      tty1         0.0.0.0          2026-09-23T08:00:00+00:00 - 2026-09-23T17:00:00+00:00  (09:00)
carol    pts/1        198.51.100.7     2026-09-22T22:00:00+00:00 - crash                     (1+02:00)

wtmp begins 2026-09-01T00:00:00+00:00
"""


def _output(sessions="", source="loginctl", last=LAST):
    return f"source={source}\n{SCRIPT_SEP}\n{sessions}{SCRIPT_SEP}\n{last}"


def _latest_status():
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-sessions"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-sessions") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Sessions, CFG)


@pytest.fixture
def guarded(make_plugin):
    return make_plugin(Sessions, {**CFG, "allowed_users": ["alice", "svc-*"],
                                  "allowed_sources": ["192.0.2.0/24", "*.example.com"]})


def _run(plugin, run_cycle, stdout, rc=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(rc, stdout, stderr))


class TestParsers:
    def test_loginctl_without_separators_and_ignored_classes(self):
        sessions = parse_loginctl(ALICE_DESKTOP + MANAGER + GREETER + ALICE_SSH)
        assert [s["id"] for s in sessions] == ["2", "4"]
        desktop, ssh = sessions
        assert desktop["seat"] == "seat0" and not desktop["remote"] and desktop["host"] == ""
        assert ssh["host"] == "192.0.2.5" and ssh["remote"]
        assert ssh["since"] == "2026-09-24 10:00:00 UTC"
        assert ssh["class"] == "user"

    def test_loginctl_blank_line_separated(self):
        assert len(parse_loginctl(ALICE_SSH + "\n" + MALLORY)) == 2

    def test_loginctl_idle(self):
        stamp = int(time.time() - 600) * 1_000_000
        session = parse_loginctl(_block("5", "alice", idle="yes", idle_since=str(stamp)))[0]
        assert session["idle"] and session["idle_since"] == stamp // 1_000_000

    def test_who(self):
        sessions = {s["user"]: s for s in parse_who(WHO)}
        assert sessions["alice"]["host"] == "192.0.2.5" and sessions["alice"]["remote"]
        assert sessions["alice"]["idle_text"] == "active"
        assert sessions["bob"]["host"] == "" and sessions["bob"]["idle_text"] == "01:20"
        assert sessions["carol"]["host"] == "host1.example.com"
        assert sessions["carol"]["idle_text"] == "over 1 day"
        assert sessions["dave"]["host"] == "" and not sessions["dave"]["remote"]

    def test_last(self):
        logins = parse_last(LAST)
        assert [entry["user"] for entry in logins] == ["alice", "bob", "carol"]
        assert logins[0]["until"] == "still logged in" and logins[0]["host"] == "192.0.2.5"
        assert logins[1]["host"] == "" and logins[1]["duration"] == "09:00"
        assert logins[1]["until"] == "2026-09-23T17:00:00+00:00"
        assert logins[2]["until"] == "crash" and logins[2]["duration"] == "1+02:00"

    def test_source_matching(self):
        assert _source_allowed("192.0.2.77", ["192.0.2.0/24"])
        assert _source_allowed("2001:db8::5", ["2001:db8::/32"])
        assert not _source_allowed("203.0.113.9", ["192.0.2.0/24", "bad/cidr"])
        assert _source_allowed("Host1.Example.com", ["*.example.com"])
        assert _source_allowed("host1", ["host1"])
        assert not _source_allowed("host1", ["10.0.0.0/8"])


class TestScript:
    def test_recent_logins_asks_last_for_extra_records(self, make_plugin):
        assert "last -i -w -n 20 --time-format iso" in make_plugin(Sessions, CFG).commands()[0].text

    def test_no_last_when_disabled(self):
        assert "last " not in _probe_script(0)

    def test_is_one_sampled_command(self, plugin):
        assert plugin.SAMPLED and len(plugin.commands()) == 1


class TestCollection:
    def test_counts(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output(ALICE_DESKTOP + MANAGER + ALICE_SSH + MALLORY))
        assert _latest_status() == "online"
        assert _latest_metric("sessions_total") == 3.0
        assert _latest_metric("sessions_remote") == 2.0
        assert _latest_metric("users_total") == 2.0
        assert _latest_metric("sessions_unexpected") == 0.0
        assert len(result.snapshot["recent"]) == 3

    def test_recent_logins_capped(self, make_plugin, run_cycle):
        p = make_plugin(Sessions, {**CFG, "recent_logins": 2})
        result = _run(p, run_cycle, _output(ALICE_SSH))
        assert [entry["user"] for entry in result.snapshot["recent"]] == ["alice", "bob"]

    def test_no_sessions_is_online(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output(""))
        assert _latest_status() == "online"
        assert _latest_metric("sessions_total") == 0.0

    def test_who_fallback(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output(WHO, source="who"))
        assert result.snapshot["source"] == "who"
        assert _latest_metric("sessions_total") == 4.0
        assert _latest_metric("sessions_remote") == 2.0

    def test_unreachable_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", rc=-1, stderr="connection refused")
        assert _latest_status() == "unavailable"


class TestAllowlists:
    def test_allowed_sessions_are_online(self, guarded, run_cycle):
        _run(guarded, run_cycle, _output(ALICE_DESKTOP + ALICE_SSH))
        assert _latest_status() == "online"

    def test_unknown_user_warns(self, guarded, run_cycle):
        result = _run(guarded, run_cycle, _output(_block("9", "bob")))
        assert _latest_status() == "warning"
        assert "user bob is not in allowed_users" in result.logs[1][0]

    def test_unknown_source_warns(self, guarded, run_cycle):
        result = _run(guarded, run_cycle, _output(_block("9", "alice", "203.0.113.9")))
        assert _latest_status() == "warning"
        assert "source 203.0.113.9" in result.logs[1][0]
        assert _latest_metric("sessions_unexpected") == 1.0

    def test_hostname_source_matches_glob(self, guarded, run_cycle):
        _run(guarded, run_cycle, _output(_block("9", "alice", "host1.example.com")))
        assert _latest_status() == "online"

    def test_local_session_passes_the_source_check(self, make_plugin, run_cycle):
        p = make_plugin(Sessions, {**CFG, "allowed_sources": ["192.0.2.0/24"]})
        _run(p, run_cycle, _output(ALICE_DESKTOP))
        assert _latest_status() == "online"

    def test_violation_status_is_configurable(self, make_plugin, run_cycle):
        p = make_plugin(Sessions, {**CFG, "allowed_users": ["alice"], "violation_status": "failed"})
        result = _run(p, run_cycle, _output(MALLORY))
        assert _latest_status() == "failed"
        assert result.logs[1][1] == "ERROR"

    def test_violation_logs_once_but_status_holds(self, guarded, run_cycle):
        first = _run(guarded, run_cycle, _output(MALLORY))
        assert sum("Unexpected session" in msg for msg, _ in first.logs) == 1
        second = _run(guarded, run_cycle, _output(MALLORY))
        assert not any("Unexpected session" in msg for msg, _ in second.logs)
        assert _latest_status() == "warning"
        _run(guarded, run_cycle, _output(ALICE_SSH))
        assert _latest_status() == "online"

    def test_returning_session_id_after_it_ended_is_new_again(self, guarded, run_cycle):
        _run(guarded, run_cycle, _output(MALLORY))
        _run(guarded, run_cycle, _output(""))
        again = _run(guarded, run_cycle, _output(MALLORY))
        assert any("Unexpected session" in msg for msg, _ in again.logs)


class TestNewSessionEvents:
    def test_first_cycle_is_a_quiet_baseline(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output(ALICE_SSH))
        assert len(result.logs) == 1

    def test_later_sessions_log_once(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output(ALICE_SSH))
        result = _run(plugin, run_cycle, _output(ALICE_SSH + _block("8", "bob", "192.0.2.6")))
        assert [msg for msg, _ in result.logs[1:]] == ["New session: bob on pts/0 from 192.0.2.6"]
        again = _run(plugin, run_cycle, _output(ALICE_SSH + _block("8", "bob", "192.0.2.6")))
        assert len(again.logs) == 1


class TestRows:
    def test_session_and_recent_rows(self, guarded, run_cycle):
        stamp = int(time.time() - 3600) * 1_000_000
        idle = _block("5", "alice", idle="yes", idle_since=str(stamp))
        _run(guarded, run_cycle, _output(ALICE_DESKTOP + idle + MALLORY))
        rows = {row["id"]: row for row in guarded._session_rows}
        assert rows["2"]["where"] == "seat0" and rows["2"]["host"] == "local"
        assert rows["2"]["type"] == "wayland (gdm-password)" and rows["2"]["idle"] == "active"
        assert rows["5"]["idle"].startswith("1 Hour") or rows["5"]["idle"].startswith("59 Minutes")
        assert guarded._allowed_color(rows["7"]) == "warning"
        assert guarded._allowed_color(rows["2"]) is None
        recent = guarded._recent_rows
        assert recent[1]["host"] == "local" and recent[0]["duration"] == "--"
        assert guarded._unexpected_color(1) == "warning" and guarded._unexpected_color(0) == "online"

    def test_recent_table_can_be_disabled(self, make_plugin):
        assert "recent_logins" not in make_plugin(Sessions, {**CFG, "recent_logins": 0}).UI_SPEC["tables"]
