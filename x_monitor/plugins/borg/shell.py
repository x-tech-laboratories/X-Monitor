"""Shell plumbing shared by every borg call: framing several calls into one command, reading them back apart, and naming what went wrong."""

import re
import shlex
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from x_monitor.core.connectors.types import CmdResult


_POLL_BASE_DIR_VAR = "__x_monitor_poll_base"
_POLL_DEADLINE_VAR = "__x_monitor_poll_end"
_POLL_LEFT_FN = "__x_monitor_poll_left"
_POLL_RC_VAR = "__x_monitor_poll_rc"
_JOB_RC_VAR = "__x_monitor_job_rc"
_STEP_RC_VAR = "__x_monitor_step_rc"
_SKIP_VAR = "__x_monitor_skip"
_SKIP_MARK = "__XMONITOR_SKIP__ "
# A job prints this before each step it chains, and the line becomes the job's progress until borg reports its own.
_STEP_MARK = "==> "
_FRAME = "__XMONITOR_BORG__"
_CUT_SHORT = "no output: the poll ended before this call ran"
# A repository host goes into a shell probe, so only characters a hostname or an IP address can hold get through.
_SAFE_HOST = re.compile(r"^[A-Za-z0-9.:_-]+$")


def _as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value]


def _redact(command: str) -> str:
    return re.sub(
        r"(BORG_PASS(?:PHRASE|COMMAND)=)('(?:[^']|'\\'')*'|\"[^\"]*\"|\S+)",
        r"\1*****",
        command,
    )


def _frame_line(index: int, stream: str, code) -> str:
    """The marker that separates one poll call's captured output from the next."""
    return f"{_FRAME} {index} {stream} {code}"


def _split_poll(result: CmdResult, count: int) -> List[CmdResult]:
    """Splits a sequential poll's framed transcript back into one CmdResult per borg call."""
    streams: Dict[int, Dict[str, str]] = {}
    codes: Dict[int, int] = {}
    key = None
    buf: List[str] = []

    def flush() -> None:
        if key is not None:
            streams.setdefault(key[0], {})[key[1]] = "\n".join(buf).strip()

    for line in (result.stdout or "").splitlines():
        if not line.startswith(_FRAME + " "):
            buf.append(line)
            continue
        flush()
        buf = []
        fields = line.split()
        try:
            index, stream, code = int(fields[1]), fields[2], int(fields[3])
        except (IndexError, ValueError):
            key = None
            continue
        key = (index, stream)
        codes[index] = code
    flush()

    # No frame arrived at all, so the shell or sudo failed before the first borg call and the whole transcript is that failure.
    if not codes:
        return [result] + [CmdResult(result.exit_code, "", result.stderr)] * (count - 1)

    results = []
    for index in range(count):
        if index not in codes:
            results.append(CmdResult(result.exit_code or 1, "", _CUT_SHORT))
            continue
        captured = streams.get(index, {})
        results.append(CmdResult(codes[index], captured.get('out', ''), captured.get('err', '')))
    return results


def _failure_hint(stderr: str) -> Optional[str]:
    text = (stderr or "").lower()
    if "permission denied (publickey)" in text or "publickey" in text:
        return ("Hint: borg could not authenticate to the repo server — set "
                "`ssh_key` to a private key on that host which the borg server "
                "authorizes (borg makes its own SSH connection, so X-Monitor's own "
                "login key does not apply).")
    if "command not found" in text:
        return ("Hint: the borg binary is not on PATH for that user — under sudo "
                "it must be on root's PATH too (set `borg_bin` to an absolute path).")
    if "a password is required" in text or "sudo: a terminal is required" in text:
        return ("Hint: sudo needs a password — grant the SSH user passwordless "
                "sudo for borg (NOPASSWD).")
    if "not allowed to set the following environment variables" in text:
        return ("Hint: sudoers forbids setting BORG_PASSPHRASE — the rule needs "
                "the SETENV tag to pass the passphrase through sudo.")
    if "passphrase" in text or "not a valid repository" in text:
        return ("Hint: the repo is encrypted and the passphrase was missing or "
                "wrong — check `passphrase_file` / `passphrase_command`.")
    if "permission denied" in text:
        return ("Hint: the SSH user cannot read the repo — add it to the repo's "
                "group or set `require_sudo: true`.")
    if "does not exist" in text or "no such file" in text:
        return "Hint: the `repo` path does not exist on that host."
    if "failed to create/acquire the lock" in text:
        # borg locks its local chunks cache under <base dir>/.cache/borg as well as the repo, and the two mean different things.
        if "/.cache/borg/" in text:
            return ("Hint: the lock is on borg's local chunks cache on this host, "
                    "not on the repo — another borg process is using the same "
                    "`cache_dir`. Give it a cache_dir of its own, or raise "
                    "`lock_wait` past the time that process needs.")
        return ("Hint: the repo is locked by another borg process — a backup may "
                "be running.")
    return None


def _list_unavailable(exit_code: int, detail: str) -> bool:
    """True when the listing could not be gathered at all, as opposed to borg reporting a repo problem."""
    text = detail.lower()
    # A lock borg gave up waiting for says only that something else held the repo or its cache, which leaves the archives unread rather than bad.
    return (exit_code == -1 or "command not found" in text
            or "permission denied" in text
            or "failed to create/acquire the lock" in text)


def _ssh_endpoint(repo: str) -> Optional[Tuple[str, int]]:
    """The host and port of an `ssh://` repository URL, or None for a local path or a name the shell could misread."""
    if not (repo or '').startswith('ssh://'):
        return None
    try:
        parts = urlsplit(repo)
        host, port = parts.hostname, parts.port or 22
    except ValueError:
        return None
    if not host or not _SAFE_HOST.match(host):
        return None
    return host, port


def _preflight_script(endpoint: Optional[Tuple[str, int]], units: List[str]) -> Optional[str]:
    """Shell that sets the skip variable to the first reason a job should not start, or None when there is nothing to test."""
    tests = []
    if endpoint:
        host, port = endpoint
        # Reads the SSH banner rather than pinging, since a host can answer ICMP while its SSH transport hangs.
        probe = shlex.quote(f"exec 3<>/dev/tcp/{host}/{port} && head -c 4 <&3")
        reason = shlex.quote(f"{host}:{port} is not answering SSH")
        tests.append(f"if ! timeout 5 bash -c {probe} 2>/dev/null | grep -q '^SSH-'; then {_SKIP_VAR}={reason}; fi")
    for unit in units:
        reason = shlex.quote(f"{unit} is running")
        tests.append(f'if [ -z "${_SKIP_VAR}" ] && systemctl is-active --quiet {shlex.quote(unit)}; '
                     f'then {_SKIP_VAR}={reason}; fi')
    if not tests:
        return None
    return "; ".join([f"{_SKIP_VAR}="] + tests)


def _with_preflight(preflight: Optional[str], launch: str) -> str:
    """Runs `launch` only when the preflight found no reason to skip, and otherwise prints that reason instead."""
    if not preflight:
        return launch
    return (f'{preflight}; if [ -n "${_SKIP_VAR}" ]; then echo "{_SKIP_MARK}${_SKIP_VAR}"; '
            f'else {launch}; fi')


def _skip_reason(stdout: str) -> Optional[str]:
    """The reason a launch printed for skipping its job, or None when it launched."""
    for line in (stdout or '').splitlines():
        if line.startswith(_SKIP_MARK):
            return line[len(_SKIP_MARK):].strip()
    return None


def _then_steps(first: str, steps: List[Tuple[str, str]]) -> str:
    """Runs `first`, then each (label, command) step while everything so far ended in success or a borg warning, exiting with the worst status."""
    if not steps:
        return first
    parts = [f"{first}; {_JOB_RC_VAR}=$?"]
    for label, command in steps:
        parts.append(f'if [ "${_JOB_RC_VAR}" -le 1 ]; then echo {shlex.quote(_STEP_MARK + label)}; {command}; '
                     f'{_STEP_RC_VAR}=$?; if [ "${_STEP_RC_VAR}" -gt "${_JOB_RC_VAR}" ]; then {_JOB_RC_VAR}=${_STEP_RC_VAR}; fi; fi')
    # A plain `exit` would leave the job's shell before it records the status, so a subshell carries it instead.
    parts.append(f'(exit "${_JOB_RC_VAR}")')
    return "; ".join(parts)


def _wrap_job(command: str, wrappers: List[str], lock: Optional[str]) -> str:
    """Runs the whole job under the given wrapper argv, saying so first when it has to wait for the lock."""
    if not wrappers:
        return command
    wrapped = " ".join(shlex.quote(a) for a in wrappers) + " sh -c " + shlex.quote(command)
    if not lock:
        return wrapped
    waiting = shlex.quote(f"{_STEP_MARK}Waiting for another job to release {lock}")
    return f"flock -n {shlex.quote(lock)} true 2>/dev/null || echo {waiting}; {wrapped}"


def _archive_member(path: str) -> Optional[str]:
    """A path as borg stores it inside an archive, or None when it could climb out of the restore dir."""
    member = (path or '').strip().strip('/')
    if any(part in ('..', '.') for part in member.split('/')):
        return None
    return member
