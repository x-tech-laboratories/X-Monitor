"""NixOS flake deployment drift: whether the running system is the one the
configured flake currently evaluates to. Every cycle reads the target's
/run/current-system, /run/booted-system, generation and version (one cheap
script); every `eval_interval` it additionally evaluates
`<flake>#nixosConfigurations.<host>.config.system.build.toplevel` and reads
`nix flake metadata`, so drift is a comparison of two store paths rather than
a guess from revisions, and the flake's own revision and input ages are
tracked alongside it. The evaluation runs as one detached job, so an X-Monitor
restart or redeploy never kills it: later cycles keep probing, poll the job
every `job_poll` and judge drift against the stored evaluation until it
finishes, and `eval_timeout` bounds the whole run. Each evaluation is kept
with its output in the job history. A failed evaluation is retried after
`retry_interval` rather than held for the full `eval_interval`, and a dashboard
poll evaluates unless an evaluation is already running. An unreachable or
non-NixOS target, unreadable flake metadata, or an evaluation that never
reached its host is unavailable; an evaluation that ran and errored, or ended
without reporting, is failed. `eval_agent` runs the evaluation on another
agent's host, for a target too small to evaluate its own flake; the probe stays
on the target, so drift is still read from the machine it describes. The
monitor only reads: updating, building and switching the flake is X-Nix's job.
Config: flake, configuration, eval_agent, eval_interval, retry_interval,
eval_timeout, job_poll, max_input_age, drift_status, reboot_status, nix_bin,
nix_args."""

import json
import shlex
import time
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.plugins.base.nixos_boot import boot_parts_script, reboot_required as nixos_reboot_required
from x_monitor.core.connectors import ssh_connector as detached
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult, Status
from x_monitor.plugins.base.plugin_helpers import (
    StatusAccumulator, format_age, format_duration, parse_duration,
)


_DEFAULT_LAYOUT = [
    ['host_card', 'drift_card', 'reboot_card', 'generation_card'],
    ['flake_card', 'revision_card', 'switched_card', 'inputs_card'],
    ['details'],
    ['events'],
]

# Metric carrying the evaluation's epoch as its value and the whole evaluated
# state as JSON metadata, so a restart resumes the eval schedule.
_STATE_METRIC = 'flake_eval_epoch'

_LOCAL_SCHEMES = ('path:', 'git+file://', 'file://')

# The kind the flake evaluation's detached job is recorded under.
_EVAL_JOB_KIND = 'eval'

# The two commands one evaluation runs, in the order the script runs them.
_EVAL_PARTS = ('eval', 'metadata')

# Starts a line naming the command and stream the evaluation script prints next.
_EVAL_MARK = '@@x-monitor-eval'

# The exit status `timeout` gives a run it killed.
_TIMED_OUT = 124


def _probe_script() -> str:
    """One script collecting every cheap fact about the deployed system."""
    return '\n'.join([
        'echo "hostname=$(uname -n)"',
        'echo "current=$(readlink -f /run/current-system 2>/dev/null)"',
        'echo "booted=$(readlink -f /run/booted-system 2>/dev/null)"',
        'echo "switched=$(stat -c %Y /run/current-system 2>/dev/null)"',
        'echo "profile=$(readlink /nix/var/nix/profiles/system 2>/dev/null)"',
        'echo "version=$(cat /run/current-system/nixos-version 2>/dev/null)"',
        "echo \"version_json=$(nixos-version --json 2>/dev/null | tr -d '\\n')\"",
        *boot_parts_script(),
    ])


def _parse_probe(stdout: str) -> Dict[str, Any]:
    """Turn the probe script's key=value lines into a dict, collecting the
    repeated booted_part/current_part lines into lists."""
    fields: Dict[str, Any] = {'booted_part': [], 'current_part': []}
    for line in stdout.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            continue
        value = value.strip()
        if key in ('booted_part', 'current_part'):
            fields[key].append(value)
        else:
            fields[key] = value
    return fields


def _generation(profile_link: str) -> Optional[int]:
    """Extract the generation number from a `system-210-link` profile symlink."""
    name = profile_link.rsplit('/', 1)[-1]
    if not (name.startswith('system-') and name.endswith('-link')):
        return None
    try:
        return int(name[len('system-'):-len('-link')])
    except ValueError:
        return None


def _eval_script(commands: Dict[str, str], workdir: str) -> str:
    """Run each command in turn, printing its stderr live after a marker line
    so the job's log shows nix's progress, then print every command's stdout
    and exit status after marker lines, so the finished output splits back
    into one result per command."""
    # workdir_for() names only safe characters under $HOME, so double quotes suffice.
    lines = [f'w="{workdir}"']
    for name, command in commands.items():
        lines.append(f'echo "{_EVAL_MARK} {name} stderr"')
        lines.append(detached.stream_stderr(command, f'"$w/{name}.exit"', stdout_to=f'"$w/{name}.stdout"'))
    for name in commands:
        for stream in ('stdout', 'exit'):
            lines.append(f'echo "{_EVAL_MARK} {name} {stream}"; cat "$w/{name}.{stream}"; echo')
    # The run fails when either command did, so its job row shows it.
    lines.append(' && '.join(f'[ "$(cat "$w/{name}.exit")" = 0 ]' for name in commands))
    return '\n'.join(lines)


def _split_eval_output(output: str, missing: str) -> Dict[str, CmdResult]:
    """Split a finished evaluation's output back into one result per command;
    a command the run never reported on gets a failed result saying `missing`."""
    sections: Dict[Tuple[str, str], List[str]] = {}
    current = None
    for line in output.split('\n'):
        mark, _, rest = line.partition(' ')
        if mark == _EVAL_MARK:
            current = tuple(rest.split(' ', 1))
            sections[current] = []
        elif current is not None:
            sections[current].append(line)

    def text(name: str, stream: str) -> str:
        return '\n'.join(sections.get((name, stream), [])).strip()

    results = {}
    for name in _EVAL_PARTS:
        code = text(name, 'exit')
        if not code.lstrip('-').isdigit():
            results[name] = CmdResult(1, '', missing)
            continue
        results[name] = CmdResult(int(code), text(name, 'stdout'), text(name, 'stderr'))
    return results


def _decode_json(raw: str) -> Dict[str, Any]:
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _short_rev(revision: Optional[str]) -> str:
    """Abbreviate a flake revision, keeping the -dirty marker a local checkout
    with uncommitted changes carries."""
    if not revision:
        return '--'
    head, sep, tail = revision.partition('-')
    return head[:12] + sep + tail


def _escape(value: str) -> str:
    """Escape a value for embedding inside a double-quoted shell word."""
    return value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$')


def _severity(value, default: str) -> str:
    """Read a configured status name, falling back on anything unrecognised."""
    try:
        return str(Status(str(value)))
    except ValueError:
        return default


def _oldest_input(locks: Dict[str, Any]) -> Tuple[Optional[str], Optional[int]]:
    """Return the (name, lastModified) of the least recently updated locked
    input — the one `nix flake update` would move furthest."""
    nodes = locks.get('nodes')
    if not isinstance(nodes, dict):
        return None, None
    root = locks.get('root', 'root')
    oldest_name, oldest_epoch = None, None
    for name, node in nodes.items():
        if name == root or not isinstance(node, dict):
            continue
        locked = node.get('locked')
        stamp = locked.get('lastModified') if isinstance(locked, dict) else None
        if not isinstance(stamp, (int, float)):
            continue
        if oldest_epoch is None or stamp < oldest_epoch:
            oldest_name, oldest_epoch = name, int(stamp)
    return oldest_name, oldest_epoch


class NixosUpgrade(Plugin):
    RUNS_ON_AGENT = False
    # The evaluation runs beside any job a custom action launches, and never blocks its button.
    SIDE_JOB_KINDS = (_EVAL_JOB_KIND,)

    def __init__(self, name: str, config):
        super().__init__(name, config)
        self.flake = str(config.get('flake', '/etc/nixos'))
        self.configuration = config.get('configuration')
        self.eval_agent = config.get('eval_agent') or None
        self.eval_interval = parse_duration(config.get('eval_interval', '1h'))
        self.retry_interval = min(parse_duration(config.get('retry_interval', '15m')),
                                  self.eval_interval)
        self.eval_timeout = parse_duration(config.get('eval_timeout', '10m'))
        self.job_poll_interval = parse_duration(config.get('job_poll', '30s'))
        # One fixed directory per monitor, so finished evaluations never pile up on the eval host.
        self.eval_workdir = detached.workdir_for(f'nixos_upgrade-{self.id}-eval')
        self.max_input_age = (
            parse_duration(config['max_input_age'])
            if config.get('max_input_age') is not None else None
        )
        self.drift_status = _severity(config.get('drift_status'), 'warning')
        self.reboot_status = _severity(config.get('reboot_status'), 'warning')
        self.nix_bin = str(config.get('nix_bin', 'nix'))
        self.nix_args = list(config.get(
            'nix_args', ['--extra-experimental-features', 'nix-command flakes']))
        # Set when the running closure changed or a dashboard poll asked, so
        # the next cycle re-evaluates instead of waiting out eval_interval.
        self._force_eval = False
        # The evaluation the current cycle launched (its command) or polled (its job row).
        self._eval_launch = None
        self._eval_polling = None

    # --- flake reference ---

    @property
    def local_path(self) -> Optional[str]:
        """The flake's filesystem path when it is a local checkout, else None."""
        ref = self.flake
        for scheme in _LOCAL_SCHEMES:
            if ref.startswith(scheme):
                ref = ref[len(scheme):]
                break
        else:
            if not (ref.startswith('/') or ref.startswith('.')):
                return None
        path = ref.split('?', 1)[0].split('#', 1)[0]
        return path or None

    def _refresh_args(self) -> List[str]:
        """A mutable remote ref is only seen freshly with --refresh; a local
        path is read from disk every time and needs none."""
        return [] if self.local_path else ['--refresh']

    def _attribute(self) -> Optional[str]:
        """The nixosConfigurations attribute to evaluate: the configured name,
        else the hostname the last probe reported (needed when the evaluation
        runs on another host, where `uname -n` would name the wrong machine)."""
        if self.configuration:
            return str(self.configuration)
        snapshot = self.data.latest_snapshot(default={}) if self.data else {}
        return (snapshot or {}).get('hostname') or None

    def _installable(self) -> str:
        """The flake installable for this host's system closure, double-quoted
        so an unknown attribute falls back to the evaluating host's own hostname."""
        attr = self._attribute()
        attr = _escape(attr) if attr else '$(uname -n)'
        return (f'"{_escape(self.flake)}#nixosConfigurations.\\"{attr}\\"'
                f'.config.system.build.toplevel"')

    # --- collection ---

    def commands(self) -> List[Command]:
        commands = [Command(_probe_script())]
        self._eval_launch = self._eval_polling = None
        eval_job = self._running_eval()
        if eval_job is not None:
            self._eval_polling = eval_job
            # Every poll reads the whole output, since the finished evaluation is parsed from all of it.
            commands.append(Command(detached.poll_command(eval_job['workdir'], eval_job['pid'], 0),
                                    agent=self.job_agent(eval_job)))
        # An offloaded evaluation needs the target's attribute name, which the first probe supplies.
        elif self._due_for_eval() and not (self.eval_agent and self._attribute() is None):
            self._eval_launch = self._eval_command()
            commands.append(Command(detached.launch_command(self._eval_launch, self.eval_workdir),
                                    agent=self.eval_agent))
        return commands

    def _eval_script(self) -> str:
        """The script one evaluation runs: `nix eval` of the toplevel, then `nix flake metadata`."""
        nix = ' '.join([self.nix_bin] + [shlex.quote(a) for a in self.nix_args])
        refresh = ' '.join(self._refresh_args())
        return _eval_script({
            'eval': ' '.join(filter(None, [nix, 'eval --raw --no-write-lock-file', refresh,
                                           self._installable()])),
            'metadata': ' '.join(filter(None, [nix, 'flake metadata --json --no-write-lock-file',
                                               refresh, shlex.quote(self.flake)])),
        }, self.eval_workdir)

    def _eval_command(self) -> str:
        """The evaluation script under `timeout`, which kills it once it takes longer than eval_timeout."""
        return f'timeout {int(self.eval_timeout)} sh -c {shlex.quote(self._eval_script())}'

    def _running_eval(self) -> Optional[dict]:
        """The running evaluation job, if one was launched and recorded with its pid."""
        job = self.jobs.running_side(_EVAL_JOB_KIND) if self.jobs else None
        if job and job.get('pid') and job.get('workdir'):
            return job
        return None

    def job_agent(self, job: dict) -> Optional[str]:
        return self.eval_agent if job.get('kind') == _EVAL_JOB_KIND else super().job_agent(job)

    def _state(self) -> Dict[str, Any]:
        """The last evaluation's stored result: target closure, flake revision
        and input ages, carried between cycles as metric metadata."""
        metric = self.data.latest_metric(_STATE_METRIC) if self.data else None
        return _decode_json(metric.metadata) if metric is not None and metric.metadata else {}

    def _due_for_eval(self) -> bool:
        if self._force_eval:
            return True
        state = self._state()
        evaluated = state.get('evaluated_epoch')
        if not evaluated:
            return True
        # A failed evaluation waits only retry_interval; holding its error for a whole eval_interval hides a fix.
        failed = bool(state.get('eval_error') or state.get('metadata_error'))
        wait = self.retry_interval if failed else self.eval_interval
        return time.time() - float(evaluated) >= wait

    async def run_cycle(self) -> bool:
        """A dashboard poll is an explicit ask, so it evaluates unless an evaluation is already running."""
        if self._running_eval() is None:
            self._force_eval = True
        return await super().run_cycle()

    def parse(self, results: List[CmdResult]) -> CollectResult:
        eval_launch, self._eval_launch = self._eval_launch, None
        eval_job, self._eval_polling = self._eval_polling, None
        if not results:
            return CollectResult.unavailable('No probe result for this cycle')

        # The evaluation is handled first, so a launched job is recorded even when the probe failed.
        folded = None
        if len(results) > 1 and eval_launch is not None:
            folded = self._parse_eval_launch(eval_launch, results[1])
        elif len(results) > 1 and eval_job is not None:
            folded = self._parse_eval_poll(eval_job, results[1])

        probe = results[0]
        if probe.exit_code != 0 and not probe.stdout.strip():
            return self._keep_state(CollectResult.unavailable(
                f"Could not read the deployed system: {(probe.stderr or probe.stdout).strip()[:200]}"),
                folded)

        fields = _parse_probe(probe.stdout)
        current = fields.get('current')
        if not current:
            return self._keep_state(CollectResult.unavailable(
                '/run/current-system is unreadable — is this a NixOS host?'), folded)

        evaluated = folded is not None
        return self._assemble(fields, current, folded if evaluated else self._state(), evaluated)

    @staticmethod
    def _keep_state(result: CollectResult, state: Optional[Dict[str, Any]]) -> CollectResult:
        """Store an evaluation that finished on a cycle whose probe failed, so it is not lost."""
        if state is not None:
            result.metrics[_STATE_METRIC] = float(state.get('evaluated_epoch') or 0)
            result.metadata[_STATE_METRIC] = json.dumps(state)
        return result

    def _parse_eval_launch(self, command: str, result: CmdResult) -> Optional[Dict[str, Any]]:
        """Record the launched evaluation as a job, or fold a launch that failed as a failed evaluation."""
        self._force_eval = False
        pid = detached.parse_launch(result.stdout) if result.exit_code == 0 else None
        if pid is None:
            # A launch whose host never answered (exit -1) is unreachable, like any other evaluation that never ran.
            failure = CmdResult(result.exit_code or 1, '', "Could not start the evaluation: "
                                f"{(result.stderr or result.stdout).strip()[:200]}")
            return self._eval_state(failure, failure)
        job_id = self.jobs.create(_EVAL_JOB_KIND, command, self.eval_workdir)
        self.jobs.set_pid(job_id, pid)
        return None

    def _parse_eval_poll(self, job: dict, result: CmdResult) -> Optional[Dict[str, Any]]:
        """Advance the running evaluation from one poll, returning the folded state once it finishes."""
        job_id = job['id']
        if result.exit_code != 0 and not result.stdout.strip():
            # The eval host never answered, so this cycle is unreachable, but the job stays running for a later poll.
            unreachable = CmdResult(-1, '', "Could not poll the running evaluation: "
                                    f"{(result.stderr or '').strip()[:200] or f'exit {result.exit_code}'}")
            return self._eval_state(unreachable, unreachable)
        poll = detached.parse_poll(result.stdout)
        finished = poll.exit_code is not None or not poll.alive

        # output_seq counts the characters of the output already copied into the job's log.
        fresh = poll.new_output[job['output_seq']:]
        lines, consumed = detached.split_lines(fresh)
        if finished and fresh[consumed:]:
            lines.append(fresh[consumed:])
            consumed = len(fresh)
        if lines:
            self.jobs.append_output(job_id, lines)
            self.jobs.bump_output_seq(job_id, job['output_seq'] + consumed)
        if not finished:
            return None

        if poll.exit_code is None:
            error = 'Process ended without writing an exit code'
            self.jobs.finish(job_id, 'failed', exit_code=-1, error=error)
        else:
            error = (None if poll.exit_code == 0
                     else f"Timed out after {format_duration(self.eval_timeout)}"
                     if poll.exit_code == _TIMED_OUT else f"Exited with status {poll.exit_code}")
            self.jobs.finish(job_id, 'failed' if error else 'succeeded',
                             exit_code=poll.exit_code, error=error)
        parts = _split_eval_output(poll.new_output, f"The evaluation ended before reporting: {error or 'no output'}")
        return self._eval_state(parts['eval'], parts['metadata'])

    def _eval_state(self, eval_result: CmdResult, metadata_result: CmdResult) -> Dict[str, Any]:
        """Fold this cycle's evaluation and flake metadata into the stored
        state, keeping the last known good values for whichever half failed."""
        state = dict(self._state())
        state['evaluated_epoch'] = int(time.time())

        if eval_result.exit_code == 0 and eval_result.stdout.strip():
            state['target'] = eval_result.stdout.strip().splitlines()[-1].strip()
            state['eval_error'] = None
        else:
            state['eval_error'] = (
                (eval_result.stderr or eval_result.stdout).strip()[:400]
                or f'nix eval exited {eval_result.exit_code}')
            # An eval host that never answered measured nothing, unlike an evaluation that ran and errored.
            state['eval_unreachable'] = eval_result.exit_code == -1

        data = _decode_json(metadata_result.stdout) if metadata_result.exit_code == 0 else {}
        if data:
            locked = data.get('locked') if isinstance(data.get('locked'), dict) else {}
            # An uncommitted local checkout has no `rev`, only a `dirtyRev`.
            state['flake_revision'] = (data.get('revision') or locked.get('rev')
                                       or locked.get('dirtyRev'))
            state['flake_last_modified'] = data.get('lastModified') or locked.get('lastModified')
            locks = data.get('locks') if isinstance(data.get('locks'), dict) else {}
            name, epoch = _oldest_input(locks)
            state['oldest_input'] = name
            state['inputs_last_modified'] = epoch
            state['metadata_error'] = None
        else:
            state['metadata_error'] = (
                (metadata_result.stderr or metadata_result.stdout).strip()[:400]
                or f'nix flake metadata exited {metadata_result.exit_code}')
        return state

    def _assemble(self, fields: Dict[str, Any], current: str,
                  state: Dict[str, Any], evaluated: bool) -> CollectResult:
        """Turn the probe's facts and the stored evaluation into this cycle's
        metrics, log lines and worst-of status."""
        acc = StatusAccumulator()
        now = int(time.time())
        metrics: Dict[str, float] = {}
        metadata: Dict[str, str] = {}
        logs: List[Tuple[str, str]] = []

        version = fields.get('version') or _decode_json(
            fields.get('version_json', '')).get('nixosVersion') or 'unknown'
        generation = _generation(fields.get('profile', ''))
        if generation is not None:
            metrics['generation'] = float(generation)

        switched = fields.get('switched')
        if switched and switched.isdigit():
            metrics['last_switch_epoch'] = float(switched)
            logs.append((f"Running NixOS {version}, generation {generation or '?'}, "
                         f"switched {format_age(now - int(switched))}", 'INFO'))
        else:
            logs.append((f"Running NixOS {version}, generation {generation or '?'}", 'INFO'))

        target = state.get('target')
        if state.get('eval_error'):
            unreachable = bool(state.get('eval_unreachable'))
            acc.escalate('unavailable' if unreachable else 'failed')
            logs.append((f"Flake evaluation failed: {state['eval_error']}",
                         'WARNING' if unreachable else 'ERROR'))
        previous = ((self.data.latest_snapshot(default={}) or {}).get('current')
                    if self.data else None)
        if target and not evaluated and previous and previous != current and target != current:
            # A closure that changed since the last evaluation is judged against a fresh one, not a stale target.
            self._force_eval = True
            logs.append((f"Running closure changed to {current}; re-evaluating the flake before "
                         "judging drift", 'INFO'))
        elif target:
            up_to_date = target == current
            metrics['up_to_date'] = 1.0 if up_to_date else 0.0
            if up_to_date:
                logs.append(('System matches the flake', 'INFO'))
            else:
                acc.escalate(self.drift_status)
                logs.append((f"System is out of date: {self.flake} evaluates to {target}, "
                             f"running {current}", Status(self.drift_status).log_level))

        if state.get('metadata_error'):
            acc.escalate('unavailable')
            logs.append((f"Could not read flake metadata: {state['metadata_error']}", 'WARNING'))
        metrics['flake_reachable'] = 0.0 if state.get('metadata_error') else 1.0

        flake_modified = state.get('flake_last_modified')
        if flake_modified:
            metrics['flake_last_modified_epoch'] = float(flake_modified)
            revision = state.get('flake_revision')
            logs.append((f"Flake last changed {format_age(now - int(flake_modified))}"
                         + (f" at {_short_rev(revision)}" if revision else ''), 'INFO'))

        inputs_modified = state.get('inputs_last_modified')
        if inputs_modified:
            metrics['inputs_last_modified_epoch'] = float(inputs_modified)
            age = now - int(inputs_modified)
            stale = self.max_input_age is not None and age > self.max_input_age
            if stale:
                acc.escalate('warning')
            logs.append((
                f"Oldest locked input {state.get('oldest_input') or '?'} is "
                f"{format_age(age)}" + (
                    f", over the {format_duration(self.max_input_age)} limit" if stale else ''),
                'WARNING' if stale else 'INFO'))

        reboot = self._reboot_required(fields)
        if reboot is not None:
            metrics['reboot_required'] = 1.0 if reboot else 0.0
            if reboot:
                acc.escalate(self.reboot_status)
                logs.append(('Reboot required: the booted kernel/initrd is not the current one',
                             Status(self.reboot_status).log_level))

        metrics[_STATE_METRIC] = float(state.get('evaluated_epoch') or 0)
        metadata[_STATE_METRIC] = json.dumps(state)

        return CollectResult(
            metrics=metrics, metadata=metadata, logs=logs, status=str(acc.status),
            snapshot={'current': current, 'version': version,
                      'generation': generation, 'booted': fields.get('booted'),
                      'hostname': fields.get('hostname')},
        )

    @staticmethod
    def _reboot_required(fields: Dict[str, Any]) -> Optional[bool]:
        """Whether the booted closure's kernel-side parts differ from the
        current one's; None when the comparison could not be made."""
        return nixos_reboot_required(fields.get('booted_part') or [],
                                     fields.get('current_part') or [])

    # --- UI ---

    def _metric(self, name: str) -> Optional[float]:
        metric = self.data.latest_metric(name)
        return metric.value if metric is not None else None

    def _drift_pair(self) -> Tuple[str, Optional[str]]:
        state = self._state()
        if state.get('eval_error'):
            return 'EVAL FAILED', 'failed'
        value = self._metric('up_to_date')
        if value is None:
            return 'UNKNOWN', 'unavailable'
        if value > 0.5:
            return 'UP TO DATE', 'online'
        return 'OUT OF DATE', self.drift_status

    def _reboot_pair(self) -> Tuple[str, Optional[str]]:
        value = self._metric('reboot_required')
        if value is None:
            return '--', 'unavailable'
        if value > 0.5:
            return 'REQUIRED', self.reboot_status
        return 'NOT NEEDED', 'online'

    def _inputs_pair(self) -> Tuple[str, Optional[str]]:
        epoch = self._metric('inputs_last_modified_epoch')
        if not epoch:
            return '--', None
        age = int(time.time()) - int(epoch)
        stale = self.max_input_age is not None and age > self.max_input_age
        return format_age(age), 'warning' if stale else 'online'

    @property
    def _drift_text(self) -> str:
        return self._drift_pair()[0]

    @property
    def _drift_color(self) -> Optional[str]:
        return self._drift_pair()[1]

    @property
    def _reboot_text(self) -> str:
        return self._reboot_pair()[0]

    @property
    def _reboot_color(self) -> Optional[str]:
        return self._reboot_pair()[1]

    @property
    def _inputs_text(self) -> str:
        return self._inputs_pair()[0]

    @property
    def _inputs_color(self) -> Optional[str]:
        return self._inputs_pair()[1]

    @property
    def _revision_text(self) -> str:
        return _short_rev(self._state().get('flake_revision'))

    @property
    def _switched_text(self) -> str:
        epoch = self._metric('last_switch_epoch')
        return format_age(int(time.time()) - int(epoch)) if epoch else '--'

    @property
    def _detail_rows(self) -> List[Dict[str, str]]:
        """The full deployment picture as label/value rows: what is running,
        what the flake says should be, and when each was last established."""
        state = self._state()
        snapshot = self.data.latest_snapshot(default={}) or {}
        now = int(time.time())

        def stamp(epoch) -> str:
            return format_age(now - int(epoch)) if epoch else '--'

        rows = [
            ('Flake', self.flake),
            ('Configuration', self.configuration or snapshot.get('hostname') or "the target's hostname"),
            ('NixOS version', snapshot.get('version', '--')),
            ('Generation', str(snapshot.get('generation') or '--')),
            ('Last switch', self._switched_text),
            ('Running closure', snapshot.get('current', '--')),
            ('Flake closure', state.get('target') or '--'),
            ('Flake revision', state.get('flake_revision') or '--'),
            ('Flake last changed', stamp(state.get('flake_last_modified'))),
            ('Oldest input', f"{state.get('oldest_input') or '--'} "
                             f"({stamp(state.get('inputs_last_modified'))})"),
            ('Last evaluated', stamp(state.get('evaluated_epoch'))),
        ]
        for label, error in (('Evaluation error', state.get('eval_error')),
                             ('Metadata error', state.get('metadata_error'))):
            if error:
                rows.append((label, error))
        return [{'label': label, 'value': value} for label, value in rows]

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'drift_card': {'title': 'DEPLOYMENT', 'value_attr': '_drift_text',
                               'color_attr': '_drift_color'},
                'reboot_card': {'title': 'REBOOT', 'value_attr': '_reboot_text',
                                'color_attr': '_reboot_color'},
                'generation_card': {'metric': 'generation', 'title': 'GENERATION',
                                    'format': 'int'},
                'flake_card': {'title': 'FLAKE', 'value': self.flake},
                'revision_card': {'title': 'REVISION', 'value_attr': '_revision_text',
                                  'refresh': True},
                'switched_card': {'title': 'LAST SWITCH', 'value_attr': '_switched_text',
                                  'refresh': True},
                'inputs_card': {'title': 'OLDEST INPUT', 'value_attr': '_inputs_text',
                                'color_attr': '_inputs_color'},
            },
            'tables': {
                'details': {
                    'title': 'Deployment details',
                    'row_key': 'label',
                    'rows_attr': '_detail_rows',
                    'columns': [
                        {'name': 'label', 'label': 'Field', 'field': 'label', 'align': 'left'},
                        {'name': 'value', 'label': 'Value', 'field': 'value', 'align': 'left'},
                    ],
                },
            },
            'events': {'title': 'Events', 'limit': 100, 'full_height': True},
        }
