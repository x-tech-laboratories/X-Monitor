"""Whether the closures a host builds for the fleet are built from the flake's
latest revision and pushed to an Attic binary cache. One script on the building
host evaluates every tracked target from the flake, checks whether that store
path is in the local store, and asks the cache which of the closure's own paths
it lacks. Paths signed by an upstream cache are left out, since Attic never
stores them. The script runs as a detached job on the target, so an X-Monitor
restart or redeploy never kills a run in flight: a cycle with no job running
launches it, later cycles poll it every `job_poll` instead of every interval,
and the finished run's whole output becomes the new snapshot. While it runs the
previous snapshot and status stay, and its output and progress show in the
runs panel. A target whose evaluation fails is failed; one not yet built,
or not fully pushed, is `pending_status`. Config: flake, configurations
(nixosConfigurations names, tracked by their system toplevel), installables
(name to flake attribute, for any other derivation), cache_url, upstream_keys,
missing_limit, pending_status, nix_bin, nix_args, timeout (the longest a run
may take before it is killed), job_poll, build_args, build_root_dir,
build_links, push_command, drop_pushed.

A target named in `drop_pushed` is kept only in the cache: once a check finds
it fully pushed, its closure's path list is written beside its build root as
`<link>.closure` and the root is removed, so garbage collection frees the
store. Later checks read that list for a target no longer in the local store,
so it still counts as built and its paths are still checked against the cache.

Each tracked target's row can also be built or pushed by hand. Both run as
detached actions on the building host and end by checking that one target
again, so its row shows the outcome as soon as the action finishes. Build
realises the target from the flake's latest revision with `build_args`; with
`build_root_dir` its result is linked there (under its name in `build_links`,
else `<monitor id>-<target>`), so it stays rooted until it is replaced. Push
runs `push_command` with the target's store path appended, and is offered only
when `push_command` is set; Build also pushes what it built with it."""

import json
import shlex
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors import ssh_connector as detached
from x_monitor.core.connectors.types import ActionPlan, CmdResult, Command, CollectResult, Status
from x_monitor.plugins.base.plugin_helpers import StatusAccumulator, parse_duration


# ==================================================================================================
# Layout and defaults
# ==================================================================================================

_DEFAULT_LAYOUT = [
    ['host_card', 'built_card', 'pushed_card', 'revision_card'],
    ['targets'],
    ['missing'],
    ['jobs'],
    ['events'],
]

# The signing key name cache.nixos.org uses, which Attic skips by default.
_DEFAULT_UPSTREAM_KEYS = ['cache.nixos.org-1']

# The line key the script reports the flake's metadata under, never a target name.
_FLAKE_KEY = '@flake'

# The kind the check's detached job is recorded under.
_JOB_KIND = 'check'

# The per-target row actions, with the word each one's outcome is logged under.
_TARGET_ACTIONS = {'build_target': 'Build', 'push_target': 'Push'}


# ==================================================================================================
# Script
# ==================================================================================================

def _check_function(nix: str, cache_url: str, upstream_keys: List[str]) -> str:
    """Shell functions printing `name<TAB>key<TAB>value` lines about one target: `check` evaluates it, then `inspect` reads the closure at $out.

    `inspect` reads $link and $list, the target's build root and closure list, both empty unless it is kept only in the cache."""
    # nix pads the path column with spaces and then a tab, so the widest path has only the tab before its signatures.
    keys = ' '.join(f'{key}:' for key in upstream_keys)
    skip_upstream = (f'BEGIN {{ n = split("{keys}", up, " ") }} '
                     '{ for (i = 2; i <= NF; i++) for (k = 1; k <= n; k++) if (index($i, up[k]) == 1) next; print $1 }')
    own_paths = (f'{nix} path-info -r --sigs "$out" | awk {shlex.quote(skip_upstream)}'
                 if upstream_keys else f'{nix} path-info -r "$out"')
    return '\n'.join([
        'report() { printf "%s\\t%s\\t%s\\n" "$name" "$1" "$(printf "%s" "$2" | tr "\\t\\n" "  ")"; }',
        'check() {',
        '    name=$1 link=$3 list=$4',
        # nix's stderr reaches the job's log as it evaluates, and is kept for the error report.
        '    out=$(' + detached.stream_stderr(nix + ' eval --raw --no-write-lock-file $refresh "$2"', '"$t/rc"',
                                           keep='"$t/err"', to_stderr=True) + ')',
        '    if [ "$(cat "$t/rc")" != 0 ]; then',
        '        report error "$(tail -c 400 "$t/err")"',
        '        return',
        '    fi',
        '    refresh=',
        '    report target "$out"',
        '    inspect',
        '}',
        'inspect() {',
        f'    if {nix} path-info "$out" >/dev/null 2>&1; then',
        '        report built 1',
        f'        {own_paths} > "$t/own"',
        # A target dropped from the store is judged by the closure list written when it was dropped.
        '    elif [ -n "$list" ] && [ "$(head -n 1 "$list" 2>/dev/null)" = "$out" ]; then',
        '        report built 1',
        '        report local 0',
        '        tail -n +2 "$list" > "$t/own"',
        '    else',
        '        report built 0',
        '        echo "$out" > "$t/own"',
        '    fi',
        '    report own "$(wc -l < "$t/own")"',
        f'    json=$({nix} path-info --stdin --json --store {shlex.quote(cache_url)} < "$t/own" 2>"$t/err")',
        '    if [ -z "$json" ]; then',
        '        report cache_error "$(tail -c 400 "$t/err")"',
        '        return',
        '    fi',
        '    printf "%s\\n" "$json" | grep -o \'"/nix/store/[^"]*":null\' | cut -d\'"\' -f2 > "$t/missing"',
        '    while read -r path; do report missing "$path"; done < "$t/missing"',
        # Only a root still pointing at this closure is dropped, and its list is in place before the root goes.
        '    if [ ! -s "$t/missing" ] && [ -n "$link" ] && [ "$(readlink -f "$link")" = "$out" ]; then',
        '        { echo "$out"; cat "$t/own"; } > "$list.tmp" && mv "$list.tmp" "$list" && rm -f "$link" && report dropped 1',
        '    fi',
        '}',
    ])


def check_line(name: str, installable: str, link: str = '', closure_list: str = '') -> str:
    """The `check` call for one target, with its build root and closure list when it is kept only in the cache."""
    args = [name, installable] + ([link, closure_list] if link else [])
    return 'check ' + ' '.join(shlex.quote(a) for a in args)


def check_script(flake: str, targets: List[Tuple[str, str]], cache_url: str,
                 upstream_keys: List[str], nix: str,
                 roots: Optional[Dict[str, Tuple[str, str]]] = None) -> str:
    """The whole cycle's script: each target in turn, then the flake's metadata; `roots` maps a target kept only in the cache to its (link, list)."""
    lines = [
        't=$(mktemp -d)',
        'trap \'rm -rf "$t"\' EXIT',
        # Only the first evaluation refetches a remote flake, so every target is judged at the same revision.
        f'refresh={"--refresh" if _is_remote(flake) else ""}',
        _check_function(nix, cache_url, upstream_keys),
    ]
    for name, installable in targets:
        lines.append(check_line(name, installable, *(roots or {}).get(name, ())))
    lines.append(f'name={shlex.quote(_FLAKE_KEY)}; '
                 f'report metadata "$({nix} flake metadata --json --no-write-lock-file '
                 f'{shlex.quote(flake)} 2>/dev/null)"')
    return '\n'.join(lines)


def build_script(name: str, build: str, cache_url: str, upstream_keys: List[str], nix: str,
                 push_command: str = '', root: Tuple[str, str] = ('', '')) -> str:
    """Run `build`, which prints the path it built, push that path when there is a `push_command`, then report on that one target."""
    lines = [
        't=$(mktemp -d)',
        'trap \'rm -rf "$t"\' EXIT',
        _check_function(nix, cache_url, upstream_keys),
        f'name={shlex.quote(name)} link={shlex.quote(root[0])} list={shlex.quote(root[1])}',
        f'out=$({build})',
        'rc=$?',
        'out=$(printf "%s\\n" "$out" | tail -n 1)',
    ]
    if push_command:
        # Pushed here rather than left to a store watcher, so the report that follows never races the upload.
        lines.append(f'if [ "$rc" = 0 ] && [ -n "$out" ]; then {push_command} "$out" || rc=$?; fi')
    lines += [
        'if [ -n "$out" ]; then report target "$out"; inspect; fi',
        'exit $rc',
    ]
    return '\n'.join(lines)


def push_script(name: str, path: str, push_command: str, cache_url: str,
                upstream_keys: List[str], nix: str, root: Tuple[str, str] = ('', '')) -> str:
    """Push one target's store path, then report on it again; the push's status is the script's."""
    return '\n'.join([
        't=$(mktemp -d)',
        'trap \'rm -rf "$t"\' EXIT',
        _check_function(nix, cache_url, upstream_keys),
        f'name={shlex.quote(name)} link={shlex.quote(root[0])} list={shlex.quote(root[1])}',
        f'out={shlex.quote(path)}',
        f'{push_command} "$out"',
        'rc=$?',
        'report target "$out"',
        'inspect',
        'exit $rc',
    ])


def _is_remote(flake: str) -> bool:
    """Whether the flake is fetched rather than read from a local path, which needs --refresh to see a new commit."""
    return not (flake.startswith(('/', '.', 'path:', 'git+file://', 'file://')))


# ==================================================================================================
# Parsing
# ==================================================================================================

def parse_report(stdout: str) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    """Group the script's lines into per-target facts, plus the flake's metadata."""
    facts: Dict[str, Dict[str, Any]] = {}
    metadata: Dict[str, Any] = {}
    for line in stdout.splitlines():
        parts = line.split('\t', 2)
        if len(parts) != 3:
            continue
        name, key, value = parts
        if name == _FLAKE_KEY:
            try:
                decoded = json.loads(value)
            except ValueError:
                decoded = {}
            metadata = decoded if isinstance(decoded, dict) else {}
            continue
        entry = facts.setdefault(name, {'missing': []})
        if key == 'missing':
            entry['missing'].append(value)
        else:
            entry[key] = value
    return facts, metadata


def _flake_revision(metadata: Dict[str, Any]) -> Optional[str]:
    locked = metadata.get('locked') if isinstance(metadata.get('locked'), dict) else {}
    return metadata.get('revision') or locked.get('rev') or locked.get('dirtyRev')


# ==================================================================================================
# Plugin
# ==================================================================================================

class AtticPush(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.flake = str(config.get('flake', '/etc/nixos'))
        self.configurations = [str(c) for c in config.get('configurations') or []]
        self.installables = {str(k): str(v) for k, v in (config.get('installables') or {}).items()}
        self.cache_url = str(config.get('cache_url') or '')
        self.upstream_keys = [str(k) for k in config.get('upstream_keys', _DEFAULT_UPSTREAM_KEYS)]
        self.missing_limit = int(config.get('missing_limit', 50))
        self.pending_status = str(Status(str(config.get('pending_status', 'warning'))))
        self.nix_bin = str(config.get('nix_bin', 'nix'))
        self.nix_args = list(config.get(
            'nix_args', ['--extra-experimental-features', 'nix-command flakes']))
        self.timeout = parse_duration(config.get('timeout', '30m'))
        self.job_poll_interval = parse_duration(config.get('job_poll', '30s'))
        self.build_args = list(config.get('build_args', ['--keep-going', '--print-build-logs']))
        self.build_root_dir = config.get('build_root_dir') or None
        self.build_links = {str(k): str(v) for k, v in (config.get('build_links') or {}).items()}
        self.push_command = str(config.get('push_command') or '')
        self.drop_pushed = [str(n) for n in config.get('drop_pushed') or []]
        # One fixed directory per monitor, so finished runs never pile up on the target.
        self.workdir = detached.workdir_for(f'attic_push-{self.id}')
        self._polling_job = None

    def targets(self) -> List[Tuple[str, str]]:
        """Every tracked (name, installable), configurations first."""
        flake = self.flake
        tracked = [(c, f'{flake}#nixosConfigurations."{c}".config.system.build.toplevel')
                   for c in self.configurations]
        tracked += [(name, f'{flake}#{attribute}') for name, attribute in self.installables.items()]
        return tracked

    def _link(self, name: str) -> Optional[str]:
        """The build root a target's build is linked at, when there is a build_root_dir."""
        if not self.build_root_dir:
            return None
        return f"{self.build_root_dir.rstrip('/')}/{self.build_links.get(name, f'{self.id}-{name}')}"

    def _root(self, name: str) -> Tuple[str, str]:
        """The (build root, closure list) of a target kept only in the cache, else two empty strings."""
        link = self._link(name)
        if link is None or name not in self.drop_pushed:
            return '', ''
        return link, f'{link}.closure'

    # --- collection ---

    @property
    def _nix(self) -> str:
        return ' '.join([self.nix_bin] + [shlex.quote(a) for a in self.nix_args])

    def check_script(self) -> str:
        """The script one run executes on the building host."""
        roots = {name: self._root(name) for name, _ in self.targets() if self._root(name)[0]}
        return check_script(self.flake, self.targets(), self.cache_url, self.upstream_keys, self._nix, roots)

    def commands(self) -> List[Command]:
        self._polling_job = None
        if not self.cache_url or not self.targets():
            return []
        job = self.jobs.running() if self.jobs else None
        if job and job.get('pid') and job.get('workdir'):
            # parse() must read the results the way they were requested, even if the job ends mid-cycle.
            self._polling_job = job
            # Every poll reads the whole output, since the finished run is parsed from all of it.
            return [Command(detached.poll_command(job['workdir'], job['pid'], 0))]
        return [Command(detached.launch_command(self._run_command(), self.workdir))]

    def _run_command(self) -> str:
        """The script under `timeout`, which kills its whole process group once the run takes too long."""
        return f'timeout {int(self.timeout)} sh -c {shlex.quote(self.check_script())}'

    def parse(self, results: List[CmdResult]) -> CollectResult:
        job, self._polling_job = self._polling_job, None
        if not self.cache_url:
            return CollectResult.failed('No cache_url is configured')
        if not self.targets():
            return CollectResult.failed('No configurations or installables are configured')
        if not results:
            return CollectResult.unavailable('No result for this cycle')
        if job is not None:
            return self._parse_poll(job, results[0])
        return self._parse_launch(results[0])

    def _parse_launch(self, result: CmdResult) -> CollectResult:
        """Record the launched run as a job; until it finishes the previous snapshot stands."""
        pid = detached.parse_launch(result.stdout) if result.exit_code == 0 else None
        if pid is None:
            return CollectResult.unavailable(
                f"Could not start the check: {(result.stderr or result.stdout).strip()[:200]}")
        job_id = self.jobs.create(_JOB_KIND, self._run_command(), self.workdir)
        self.jobs.set_pid(job_id, pid)
        return CollectResult()

    def _parse_poll(self, job: dict, result: CmdResult) -> CollectResult:
        """Advance the running check from one poll, and parse its whole output once it finishes."""
        job_id = job['id']
        # A poll that never reached the target says nothing about the job; only a real answer may finish it.
        if result.exit_code != 0 and not result.stdout.strip():
            return CollectResult(logs=[(
                f"Could not poll the running check: "
                f"{(result.stderr or '').strip()[:200] or f'exit {result.exit_code}'}", 'WARNING')])
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
        facts, metadata = parse_report(poll.new_output)
        self.jobs.set_progress(job_id, f"{len(facts)} of {len(self.targets())} targets evaluated")

        if not finished:
            return CollectResult()
        if poll.exit_code is None:
            self.jobs.finish(job_id, 'failed', exit_code=-1,
                             error='Process ended without writing an exit code')
            return CollectResult.unavailable('The check ended before it finished')
        error = f"Exited with status {poll.exit_code}" if poll.exit_code else None
        self.jobs.finish(job_id, 'failed' if error else 'succeeded', exit_code=poll.exit_code, error=error)
        if not facts:
            return CollectResult.unavailable(
                f"Could not check the tracked targets: {poll.new_output.strip()[-200:] or error}")
        collected = self._collect(facts, metadata)
        if error:
            collected.logs.append((f"The check exited with status {poll.exit_code}", 'WARNING'))
        return collected

    def _collect(self, facts: Dict[str, Dict[str, Any]], metadata: Dict[str, Any]) -> CollectResult:
        """The finished run's rows, counts and status."""
        rows = [self._row(name, facts.get(name)) for name, _ in self.targets()]
        return self._summarise(rows, _flake_revision(metadata))

    def _summarise(self, rows: List[Dict[str, Any]], revision: Optional[str]) -> CollectResult:
        """The counts, status and snapshot for a whole set of rows."""
        acc = StatusAccumulator()
        logs: List[Tuple[str, str]] = []
        for row in rows:
            acc.escalate(row['status'])
            if row['status'] != 'online':
                logs.append((f"{row['name']}: {row['summary']}", Status(row['status']).log_level))

        built = sum(1 for r in rows if r['built'] == 'Yes')
        pushed = sum(1 for r in rows if r['pushed_ok'])
        logs.insert(0, (f"{built} of {len(rows)} targets built, {pushed} fully pushed", 'INFO'))
        return CollectResult(
            metrics={'targets_total': float(len(rows)), 'targets_built': float(built),
                     'targets_pushed': float(pushed),
                     'missing_paths': float(sum(r['missing_count'] for r in rows))},
            logs=logs, status=str(acc.status),
            snapshot={'revision': revision, 'targets': rows},
        )

    def _row(self, name: str, fact: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """One target's table row, with its status and a one-line summary."""
        row = {'name': name, 'target': '--', 'built': '--', 'pushed': '--', 'pushed_ok': False,
               'missing_count': 0, 'missing': [], 'status': 'unavailable', 'summary': 'Not checked'}
        if fact is None:
            return row
        if 'error' in fact:
            row.update(status='failed', summary=f"Evaluation failed: {fact['error'].strip()}")
            return row

        is_built = fact.get('built') == '1'
        is_local = fact.get('local') != '0'
        missing = fact.get('missing') or []
        own = int(fact['own']) if str(fact.get('own', '')).isdigit() else 0
        row.update(target=fact.get('target', '--'), built='Yes' if is_built else 'No', local=is_local,
                   missing_count=len(missing), missing=missing[:self.missing_limit])
        if 'cache_error' in fact:
            row.update(pushed='Unknown', status='unavailable',
                       summary=f"Could not query the cache: {fact['cache_error'].strip()}")
            return row

        # An unbuilt target was checked by its root path alone, so its count says nothing about the closure.
        if not is_built:
            row['pushed'] = 'No' if missing else 'Root only'
        elif missing:
            row['pushed'] = f'{len(missing)} of {own} missing'
        else:
            row['pushed'] = f'All {own}'
        row['pushed_ok'] = is_built and not missing
        if row['pushed_ok']:
            row.update(status='online', summary='Built and pushed' if is_local and 'dropped' not in fact
                       else 'Pushed, kept only in the cache')
        elif not is_built:
            row.update(status=self.pending_status, summary='Not built from the latest flake')
        else:
            row.update(status=self.pending_status,
                       summary=f"{len(missing)} of {own} paths are not in the cache")
        return row

    # --- actions ---

    def plan_action(self, action_id: str, **kwargs):
        if action_id not in _TARGET_ACTIONS:
            return None
        name = kwargs.get('target')
        installable = dict(self.targets()).get(name)
        if installable is None:
            return self._refused(f"{name!r} is not a tracked target")
        if action_id == 'build_target':
            return ActionPlan(build_script(name, self._build_command(name, installable), self.cache_url,
                                           self.upstream_keys, self._nix, self.push_command, self._root(name)),
                              detached=True)
        if not self.push_command:
            return self._refused('No push_command is configured')
        row = next((r for r in self._rows if r.get('name') == name), None)
        if row is None or row.get('built') != 'Yes':
            return self._refused(f"{name} is not built from the latest flake, so there is nothing to push")
        if row.get('local') is False:
            return self._refused(f"{name} is kept only in the cache, so there is nothing here to push; build it again")
        return ActionPlan(push_script(name, row['target'], self.push_command, self.cache_url,
                                      self.upstream_keys, self._nix, self._root(name)), detached=True)

    def _build_command(self, name: str, installable: str) -> str:
        """`nix build` of one target from the flake's latest revision, printing the path it built."""
        args = ' '.join(shlex.quote(a) for a in self.build_args + (['--refresh'] if _is_remote(self.flake) else []))
        link = self._link(name)
        if link is None:
            return f'{self._nix} build --print-out-paths --no-link {args} {shlex.quote(installable)}'
        # One fixed link per target, so each build replaces the root the last one held.
        return (f'mkdir -p {shlex.quote(self.build_root_dir)} && {self._nix} build --print-out-paths '
                f'--out-link {shlex.quote(link)} {args} {shlex.quote(installable)}')

    def interpret_action(self, action_id: str, result: CmdResult, **kwargs):
        if action_id not in _TARGET_ACTIONS:
            return result.exit_code == 0
        # The report names the target, so an action that finishes after a restart, which loses its arguments, still knows it.
        facts, _ = parse_report(result.stdout)
        name = next(iter(facts), None) or kwargs.get('target') or 'the target'
        verb = _TARGET_ACTIONS[action_id]
        succeeded = result.exit_code == 0
        rows = self._rows
        if facts and rows:
            outcome = self._summarise([self._row(r['name'], facts[r['name']]) if r['name'] in facts else r
                                       for r in rows], self._snapshot().get('revision'))
        else:
            outcome = CollectResult()
        outcome.logs.insert(0, (f"{verb} of {name} finished" if succeeded
                                else f"{verb} of {name} failed (exit {result.exit_code})",
                                'INFO' if succeeded else 'ERROR'))
        outcome.success = succeeded
        return outcome

    @staticmethod
    def _refused(message: str) -> CollectResult:
        """An action outcome that reports a problem without touching the monitor's status."""
        return CollectResult(logs=[(message, 'WARNING')], metadata={'content': message}, success=False)

    # --- UI ---

    def _snapshot(self) -> Dict[str, Any]:
        snapshot = self.data.latest_snapshot(default={}) if self.data else {}
        return snapshot if isinstance(snapshot, dict) else {}

    @property
    def _rows(self) -> List[Dict[str, Any]]:
        return list(self._snapshot().get('targets') or [])

    @property
    def _missing_rows(self) -> List[Dict[str, str]]:
        return [{'key': f"{row['name']}:{path}", 'name': row['name'], 'path': path}
                for row in self._rows for path in row.get('missing') or []]

    def _count_pair(self, field: str, good) -> Tuple[str, Optional[str]]:
        rows = self._rows
        if not rows:
            return '--', None
        count = sum(1 for row in rows if good(row.get(field)))
        return f'{count} / {len(rows)}', 'online' if count == len(rows) else self.pending_status

    @property
    def _built_text(self) -> str:
        return self._count_pair('built', lambda v: v == 'Yes')[0]

    @property
    def _built_color(self) -> Optional[str]:
        return self._count_pair('built', lambda v: v == 'Yes')[1]

    @property
    def _pushed_text(self) -> str:
        return self._count_pair('pushed_ok', bool)[0]

    @property
    def _pushed_color(self) -> Optional[str]:
        return self._count_pair('pushed_ok', bool)[1]

    @property
    def _revision_text(self) -> str:
        revision = self._snapshot().get('revision')
        return revision[:12] if revision else '--'

    @staticmethod
    def _row_color(row: Dict[str, Any]) -> Optional[str]:
        return row.get('status')

    def _built_cell(self, row: Dict[str, Any]) -> Optional[str]:
        return {'Yes': 'online', 'No': self.pending_status}.get(row.get('built'))

    def _pushed_cell(self, row: Dict[str, Any]) -> Optional[str]:
        if row.get('pushed_ok'):
            return 'online'
        return self.pending_status if row.get('built') in ('Yes', 'No') else None

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'built_card': {'title': 'BUILT', 'value_attr': '_built_text',
                               'color_attr': '_built_color'},
                'pushed_card': {'title': 'PUSHED', 'value_attr': '_pushed_text',
                                'color_attr': '_pushed_color'},
                'revision_card': {'title': 'FLAKE REVISION', 'value_attr': '_revision_text',
                                  'refresh': True},
            },
            'tables': {
                'targets': {
                    'title': 'Tracked targets',
                    'row_key': 'name',
                    'rows_attr': '_rows',
                    'columns': [
                        {'name': 'name', 'label': 'Target', 'field': 'name', 'align': 'left',
                         'cell_color_by': self._row_color},
                        {'name': 'built', 'label': 'Built', 'field': 'built', 'align': 'left',
                         'cell_color_by': self._built_cell},
                        {'name': 'pushed', 'label': 'Pushed', 'field': 'pushed', 'align': 'left',
                         'cell_color_by': self._pushed_cell, 'sort_field': 'missing_count'},
                        {'name': 'summary', 'label': 'State', 'field': 'summary', 'align': 'left'},
                        {'name': 'target', 'label': 'Store path', 'field': 'target', 'align': 'left'},
                    ],
                    'row_actions': [
                        {'id': 'build_target', 'icon': 'build', 'tooltip': 'Build', 'kind': 'dispatch',
                         'action_id': 'build_target', 'params': {'target': 'name'},
                         'confirm': 'Build {row[name]} from the latest flake now?'},
                        {'id': 'push_target', 'icon': 'cloud_upload', 'tooltip': 'Push', 'kind': 'dispatch',
                         'action_id': 'push_target', 'params': {'target': 'name'},
                         'visible_if': lambda p: bool(p.push_command)},
                    ],
                },
                'missing': {
                    'title': 'Paths not in the cache',
                    'row_key': 'key',
                    'rows_attr': '_missing_rows',
                    'columns': [
                        {'name': 'name', 'label': 'Target', 'field': 'name', 'align': 'left'},
                        {'name': 'path', 'label': 'Store path', 'field': 'path', 'align': 'left'},
                    ],
                },
            },
            'job_panel': {'widget': 'jobs', 'title': 'Runs', 'history_limit': 10},
            'events': {'title': 'Events', 'limit': 100},
        }
