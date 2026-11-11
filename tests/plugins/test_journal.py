import json

from x_monitor.core.connectors.types import CmdResult
from x_monitor.plugins.journal import (
    Journal, parse_entries, parse_entry, poll_command, priority_of, search_command, search_failure,
)

CFG = {"name": "test-journal", "id": "test-journal", "interval": 300, "ssh_config": {"host": "test.host"}}


def _line(message, priority=6, unit="nginx.service", identifier="nginx", cursor="c1", usec=1794381916454548):
    return json.dumps({"__REALTIME_TIMESTAMP": str(usec), "__CURSOR": cursor, "PRIORITY": str(priority),
                       "_SYSTEMD_UNIT": unit, "SYSLOG_IDENTIFIER": identifier, "_PID": "42", "MESSAGE": message})


# ============================================================================
# Entries
# ============================================================================

def test_an_entry_carries_its_time_priority_unit_and_message():
    entry = parse_entry(_line("worker started", priority=5))

    assert entry == {"epoch": 1794381916.454548, "cursor": "c1", "priority": 5, "unit": "nginx.service",
                     "identifier": "nginx", "pid": "42", "message": "worker started"}


def test_a_message_that_is_not_utf8_is_decoded_from_its_byte_list():
    line = json.dumps({"__REALTIME_TIMESTAMP": "1", "PRIORITY": "3", "MESSAGE": [104, 105, 255]})

    assert parse_entry(line)["message"] == "hi�"


def test_an_entry_without_a_unit_or_identifier_falls_back_to_its_command_name():
    line = json.dumps({"__REALTIME_TIMESTAMP": "1", "MESSAGE": "x", "_COMM": "kthreadd"})

    entry = parse_entry(line)

    assert entry["identifier"] == "kthreadd"
    assert entry["priority"] == 6


def test_lines_that_are_not_entries_are_skipped():
    stdout = "-- No entries --\n" + _line("a") + "\n{not json\n" + _line("b", cursor="c2") + "\n"

    assert [entry["message"] for entry in parse_entries(stdout)] == ["a", "b"]


def test_priorities_are_read_by_number_or_name():
    assert priority_of("3") == 3
    assert priority_of("err") == 3
    assert priority_of("Warning") == 4
    assert priority_of("error") == 3
    assert priority_of(None) == 7
    assert priority_of("nonsense", default=6) == 6
    assert priority_of(9) == 7


# ============================================================================
# Commands
# ============================================================================

def test_the_first_poll_reads_the_last_interval():
    command = poll_command(None, 300)

    assert "--since=-300s" in command
    assert "-p warning" in command
    assert "--after-cursor" not in command


def test_a_later_poll_reads_after_the_cursor_and_falls_back_to_the_interval():
    command = poll_command("s=abc;i=1", 300)

    assert command.index("--after-cursor='s=abc;i=1'") < command.index("|| ")
    assert command.endswith("--since=-300s")


def test_a_search_asks_journalctl_for_its_filters_newest_first():
    command = search_command(since="1h", priority=4, unit="nginx.service", limit=200)

    assert command.startswith("journalctl --no-pager -q -r -o json")
    assert "--since=-3600s" in command
    assert "-p 4" in command
    assert "-u nginx.service" in command
    assert command.endswith("-n 200")


def test_a_search_of_this_boot_and_every_priority_adds_no_priority_filter():
    command = search_command(since="boot", priority=7)

    assert " -b" in command
    assert " -p " not in command


def test_a_text_search_pipes_through_grep_with_the_text_quoted():
    command = search_command(text="can't bind", limit=50)

    assert "| grep -iF -e 'can'\"'\"'t bind' | head -n 50" in command


def test_a_unit_with_shell_characters_is_quoted():
    assert "-u 'a;rm -rf /'" in search_command(unit="a;rm -rf /")


def test_a_search_limit_is_capped():
    assert search_command(limit=1_000_000).endswith("-n 5000")


def test_a_search_failure_is_the_error_journalctl_printed():
    assert search_failure(CmdResult(1, "", "Failed to open journal")) == "Failed to open journal"
    assert search_failure(CmdResult(0, _line("ok"), "")) is None
    assert search_failure(CmdResult(0, "", "")) is None


# ============================================================================
# Polling
# ============================================================================

def test_a_poll_counts_new_errors_and_warnings_and_keeps_the_cursor(make_plugin):
    plugin = make_plugin(Journal, CFG)
    stdout = "\n".join([_line("disk full", priority=3, cursor="c1"), _line("slow", priority=4, cursor="c2"),
                        _line("crashed", priority=2, unit="app.service", cursor="c3")])

    result = plugin.parse([CmdResult(0, stdout, "")])

    assert result.metrics == {"errors_new": 2.0, "warnings_new": 1.0}
    assert result.status == "online"
    assert result.logs == []
    assert "--after-cursor=c3" in plugin.commands()[0].text


def test_errors_past_the_configured_limits_raise_the_status(make_plugin):
    plugin = make_plugin(Journal, {**CFG, "warning": 1, "threshold": 3})
    one = _line("x", priority=3)

    warned = plugin.parse([CmdResult(0, one, "")])

    assert warned.status == "warning"
    assert warned.logs == [("1 new error entry; newest from nginx.service: x", "WARNING")]
    assert plugin.parse([CmdResult(0, "\n".join([one] * 3), "")]).status == "failed"
    assert plugin.parse([CmdResult(0, "", "")]).status == "online"


def test_a_quiet_poll_keeps_the_previous_cursor(make_plugin):
    plugin = make_plugin(Journal, CFG)
    plugin.parse([CmdResult(0, _line("x", priority=4, cursor="keep"), "")])

    plugin.parse([CmdResult(0, "-- No entries --\n", "")])

    assert "--after-cursor=keep" in plugin.commands()[0].text


def test_an_account_that_sees_only_its_own_journal_is_a_warning(make_plugin):
    plugin = make_plugin(Journal, CFG)
    hint = "Hint: You are currently not seeing messages from other users and the system."

    result = plugin.parse([CmdResult(0, "", hint)])

    assert result.status == "warning"
    assert "systemd-journal" in result.logs[0][0]


def test_a_journal_that_cannot_be_read_is_unavailable(make_plugin):
    plugin = make_plugin(Journal, CFG)

    result = plugin.parse([CmdResult(127, "", "journalctl: command not found")])

    assert result.status == "unavailable"
    assert "command not found" in result.logs[0][0]


# ============================================================================
# Searching
# ============================================================================

def test_the_query_action_runs_the_search_for_its_arguments(make_plugin):
    plugin = make_plugin(Journal, CFG)

    plan = plugin.plan_action("query_logs", since="24h", priority="err", unit="", text="", limit=100)

    assert plan.command == search_command(since="24h", priority=3, limit=100)


def test_the_query_action_defaults_to_the_configured_limit(make_plugin):
    plugin = make_plugin(Journal, {**CFG, "max_entries": 250})

    assert plugin.plan_action("query_logs").command.endswith("-n 250")


def test_the_query_answer_carries_its_entries_and_drops_matches_only_in_field_names(make_plugin):
    plugin = make_plugin(Journal, CFG)
    stdout = "\n".join([_line("message about MESSAGE", cursor="c1"), _line("other", cursor="c2")])

    outcome = plugin.interpret_action("query_logs", CmdResult(0, stdout, ""), text="message")

    assert outcome.success
    assert [entry["cursor"] for entry in json.loads(outcome.metadata["entries"])] == ["c1"]


def test_a_failed_query_says_why(make_plugin):
    plugin = make_plugin(Journal, CFG)

    outcome = plugin.interpret_action("query_logs", CmdResult(1, "", "No journal files were found."))

    assert not outcome.success
    assert outcome.metadata == {"content": "No journal files were found."}
    assert outcome.status is None
