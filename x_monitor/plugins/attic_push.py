"""Whether the closures a host builds for the fleet are built from the flake's
latest revision and pushed to an Attic binary cache. Each cycle runs one script
on the building host that evaluates every tracked target from the flake, checks
whether that store path is in the local store, and asks the cache which of the
closure's own paths it lacks. Paths signed by an upstream cache are left out,
since Attic never stores them. A target whose evaluation fails is failed; one
not yet built, or not fully pushed, is `pending_status`. Config: flake,
configurations (nixosConfigurations names, tracked by their system toplevel),
installables (name to flake attribute, for any other derivation), cache_url,
upstream_keys, missing_limit, pending_status, nix_bin, nix_args, timeout."""

import json
import shlex
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult, Status
from x_monitor.plugins.base.plugin_helpers import StatusAccumulator, parse_duration


# ==================================================================================================
# Layout and defaults
# ==================================================================================================

_DEFAULT_LAYOUT = [
    ['host_card', 'built_card', 'pushed_card', 'revision_card'],
    ['targets'],
    ['missing'],
    ['events'],
]

# The signing key name cache.nixos.org uses, which Attic skips by default.
_DEFAULT_UPSTREAM_KEYS = ['cache.nixos.org-1']

# The line key the script reports the flake's metadata under, never a target name.
_FLAKE_KEY = '@flake'


# ==================================================================================================
# Script
# ==================================================================================================

def _check_function(nix: str, cache_url: str, upstream_keys: List[str]) -> str:
    """A shell function printing `name<TAB>key<TAB>value` lines about one target."""
    upstream = ' '.join(f'-e {shlex.quote(f" {key}:")}' for key in upstream_keys)
    own_paths = (f'{nix} path-info -r --sigs "$out" | grep -v -F {upstream} | cut -d" " -f1'
                 if upstream_keys else f'{nix} path-info -r "$out"')
    return '\n'.join([
        'report() { printf "%s\\t%s\\t%s\\n" "$name" "$1" "$(printf "%s" "$2" | tr "\\t\\n" "  ")"; }',
        'check() {',
        '    name=$1',
        '    if ! out=$(' + nix + ' eval --raw --no-write-lock-file $refresh "$2" 2>"$t/err"); then',
        '        report error "$(tail -c 400 "$t/err")"',
        '        return',
        '    fi',
        '    refresh=',
        '    report target "$out"',
        f'    if {nix} path-info "$out" >/dev/null 2>&1; then',
        '        report built 1',
        f'        {own_paths} > "$t/own"',
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
        '    printf "%s\\n" "$json" | grep -o \'"/nix/store/[^"]*":null\' | cut -d\'"\' -f2 \\',
        '        | while read -r path; do report missing "$path"; done',
        '}',
    ])


def check_script(flake: str, targets: List[Tuple[str, str]], cache_url: str,
                 upstream_keys: List[str], nix: str) -> str:
    """The whole cycle's script: the flake's metadata, then each target in turn."""
    lines = [
        't=$(mktemp -d)',
        'trap \'rm -rf "$t"\' EXIT',
        # Only the first evaluation refetches a remote flake, so every target is judged at the same revision.
        f'refresh={"--refresh" if _is_remote(flake) else ""}',
        _check_function(nix, cache_url, upstream_keys),
    ]
    for name, installable in targets:
        lines.append(f'check {shlex.quote(name)} {shlex.quote(installable)}')
    lines.append(f'name={shlex.quote(_FLAKE_KEY)}; '
                 f'report metadata "$({nix} flake metadata --json --no-write-lock-file '
                 f'{shlex.quote(flake)} 2>/dev/null)"')
    return '\n'.join(lines)


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

    def targets(self) -> List[Tuple[str, str]]:
        """Every tracked (name, installable), configurations first."""
        flake = self.flake
        tracked = [(c, f'{flake}#nixosConfigurations."{c}".config.system.build.toplevel')
                   for c in self.configurations]
        tracked += [(name, f'{flake}#{attribute}') for name, attribute in self.installables.items()]
        return tracked

    # --- collection ---

    def commands(self) -> List[Command]:
        if not self.cache_url or not self.targets():
            return []
        nix = ' '.join([self.nix_bin] + [shlex.quote(a) for a in self.nix_args])
        script = check_script(self.flake, self.targets(), self.cache_url, self.upstream_keys, nix)
        return [Command(script, timeout=self.timeout)]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        if not self.cache_url:
            return CollectResult.failed('No cache_url is configured')
        if not self.targets():
            return CollectResult.failed('No configurations or installables are configured')
        if not results:
            return CollectResult.unavailable('No result for this cycle')
        result = results[0]
        facts, metadata = parse_report(result.stdout)
        if not facts:
            return CollectResult.unavailable(
                f"Could not check the tracked targets: {(result.stderr or result.stdout).strip()[:200]}")

        acc = StatusAccumulator()
        logs: List[Tuple[str, str]] = []
        rows: List[Dict[str, Any]] = []
        for name, _ in self.targets():
            row = self._row(name, facts.get(name))
            rows.append(row)
            acc.escalate(row['status'])
            if row['status'] != 'online':
                logs.append((f"{name}: {row['summary']}", Status(row['status']).log_level))

        built = sum(1 for r in rows if r['built'] == 'Yes')
        pushed = sum(1 for r in rows if r['pushed_ok'])
        logs.insert(0, (f"{built} of {len(rows)} targets built, {pushed} fully pushed", 'INFO'))
        return CollectResult(
            metrics={'targets_total': float(len(rows)), 'targets_built': float(built),
                     'targets_pushed': float(pushed),
                     'missing_paths': float(sum(r['missing_count'] for r in rows))},
            logs=logs, status=str(acc.status),
            snapshot={'revision': _flake_revision(metadata), 'targets': rows},
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
        missing = fact.get('missing') or []
        own = int(fact['own']) if str(fact.get('own', '')).isdigit() else 0
        row.update(target=fact.get('target', '--'), built='Yes' if is_built else 'No',
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
            row.update(status='online', summary='Built and pushed')
        elif not is_built:
            row.update(status=self.pending_status, summary='Not built from the latest flake')
        else:
            row.update(status=self.pending_status,
                       summary=f"{len(missing)} of {own} paths are not in the cache")
        return row

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
            'events': {'title': 'Events', 'limit': 100},
        }
