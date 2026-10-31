"""Nix garbage collection: whether the store is actually being reclaimed on
this host. One cheap script per cycle reads the store filesystem and path
count, every profile's generation links, the `nix-gc` unit and timer state,
and the last collection's own summary line from the journal — so a collection
that stopped running, failed, or was never scheduled reads as a failure rather
than as a slowly filling disk. An unreadable store, a probe that returned
nothing, or no record of any run at all is unavailable. The last run's epoch and yield are carried
forward as metric metadata, so a journal that has since rotated past it does
not erase what was already seen. The monitor only reads: collecting on demand
is X-Nix's job. Config: unit, timer, store, max_age, stale_status,
timer_status, warning, threshold (either null to turn that level off),
max_generations, max_generation_age."""

import json
import re
import shlex
import time
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult, Status
from x_monitor.plugins.base.plugin_helpers import (
    StatusAccumulator, format_age, format_bytes, format_duration, level_for, limit_from, parse_duration,
)


_DEFAULT_LAYOUT = [
    ['host_card', 'last_gc_card', 'freed_card', 'next_gc_card'],
    ['store_card', 'paths_card', 'generations_card', 'roots_card'],
    ['profiles'],
    ['chart'],
    ['events'],
]

# Metric carrying the last collection's epoch as its value and the rest of what
# was seen of that run as JSON metadata, so a rotated journal loses nothing.
_STATE_METRIC = 'last_gc_epoch'

_SUMMARY = re.compile(r'(\d+)\s+store paths deleted,\s+([\d.]+)\s*(\w+)\s+freed')

# systemd logs exactly one of these when a run ends, so the journal — not the unit's
# Result, which a daemon re-exec resets to success — is what decides the outcome.
_FAILED, _FINISHED = 'Failed with result', 'Finished '

# How far from a run's outcome line its summary and error lines may be and still be
# that run's. They land within seconds of each other; this only rejects a stale line
# the journal has kept from an earlier collection.
_RUN_WINDOW = 300

# The units nix renders a collection's yield in, as bytes.
_SIZE_UNITS = {
    'b': 1, 'byte': 1, 'bytes': 1,
    'kb': 1000 ** 1, 'mb': 1000 ** 2, 'gb': 1000 ** 3, 'tb': 1000 ** 4,
    'kib': 1024 ** 1, 'mib': 1024 ** 2, 'gib': 1024 ** 3, 'tib': 1024 ** 4,
    'pib': 1024 ** 5,
}


def _probe_script(unit: str, timer: str, store: str) -> str:
    """One script collecting every cheap fact about collection on this host."""
    unit, timer, store = shlex.quote(unit), shlex.quote(timer), shlex.quote(store)
    return '\n'.join([
        'echo "hostname=$(uname -n)"',
        f'echo "df=$(df -B1 --output=size,used,avail,target {store} 2>/dev/null | tail -1)"',
        f'echo "paths=$(ls -U {store} 2>/dev/null | wc -l)"',
        'echo "roots=$(ls -U /nix/var/nix/gcroots/auto 2>/dev/null | wc -l)"',
        f'echo "svc_state=$(systemctl show {unit} -p ActiveState --value 2>/dev/null)"',
        f'echo "svc_result=$(systemctl show {unit} -p Result --value 2>/dev/null)"',
        f'echo "svc_exit=$(systemctl show {unit} --timestamp=unix -p InactiveEnterTimestamp --value 2>/dev/null)"',
        f'echo "timer_load=$(systemctl show {timer} -p LoadState --value 2>/dev/null)"',
        f'echo "timer_state=$(systemctl show {timer} -p ActiveState --value 2>/dev/null)"',
        f'echo "timer_next=$(systemctl show {timer} --timestamp=unix -p NextElapseUSecRealtime --value 2>/dev/null)"',
        f"echo \"summary=$(journalctl -u {unit} -o short-unix --no-pager -n 1 -g 'store paths deleted' 2>/dev/null | tail -1)\"",
        f"echo \"outcome=$(journalctl -u {unit} -o short-unix --no-pager -n 1 -g 'Finished |Failed with result' 2>/dev/null | tail -1)\"",
        f"echo \"error=$(journalctl -u {unit} -o short-unix --no-pager -n 1 -g 'error:' 2>/dev/null | tail -1)\"",
        # A profile is a symlink whose target is its own generation link; that rules out
        # /nix/var/nix/profiles/default, which points at another profile and would double count.
        'for prof in /nix/var/nix/profiles/* /nix/var/nix/profiles/per-user/*/*; do',
        '  [ -L "$prof" ] || continue',
        '  target=$(readlink "$prof"); base=${prof##*/}',
        '  case "$target" in "$base"-*-link) ;; *) continue ;; esac',
        '  count=0; oldest=',
        '  for link in "$prof"-*-link; do',
        '    [ -L "$link" ] || continue',
        '    count=$((count + 1))',
        '    stamp=$(stat -c %Y "$link" 2>/dev/null)',
        '    if [ -n "$stamp" ] && { [ -z "$oldest" ] || [ "$stamp" -lt "$oldest" ]; }; then oldest=$stamp; fi',
        '  done',
        '  generation=${target#"$base"-}',
        '  echo "profile=$prof|${generation%-link}|$count|$oldest"',
        'done',
    ])


def _parse_probe(stdout: str) -> Dict[str, Any]:
    """Turn the probe's key=value lines into a dict, collecting the repeated
    profile lines into a list."""
    fields: Dict[str, Any] = {'profile': []}
    for line in stdout.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            continue
        value = value.strip()
        if key == 'profile':
            fields['profile'].append(value)
        else:
            fields[key] = value
    return fields


def _epoch(value: Optional[str]) -> Optional[int]:
    """Read a systemd `--timestamp=unix` value ('@1788757200') as an epoch."""
    if not value:
        return None
    digits = value.lstrip('@').split('.')[0]
    return int(digits) if digits.isdigit() else None


def _log_epoch(line: str) -> Optional[int]:
    """Read the epoch off a journalctl `-o short-unix` line."""
    stamp = line.split(' ', 1)[0] if line else ''
    try:
        return int(float(stamp))
    except ValueError:
        return None


def _log_message(line: str) -> str:
    """Strip the timestamp, host and unit prefix off a journalctl line."""
    _, _, message = line.partition(': ')
    return (message or line).strip()[:200]


def _same_run(epoch: Optional[int], run_epoch: int) -> bool:
    """Whether a journal line close to the run's own end belongs to that run."""
    return epoch is not None and abs(run_epoch - epoch) <= _RUN_WINDOW


def _bytes_from(amount: str, unit: str) -> Optional[float]:
    """Turn nix's rendered '44.4 GiB' yield into bytes."""
    factor = _SIZE_UNITS.get(unit.lower())
    if factor is None:
        return None
    try:
        return float(amount) * factor
    except ValueError:
        return None


def _severity(value, default: str) -> str:
    """Read a configured status name, falling back on anything unrecognised."""
    try:
        return str(Status(str(value)))
    except ValueError:
        return default


def _profile_row(raw: str) -> Optional[Dict[str, Any]]:
    """Turn one `path|generation|count|oldest` probe line into a row."""
    parts = raw.split('|')
    if len(parts) != 4:
        return None
    path, generation, count, oldest = parts
    if not path:
        return None
    return {
        'path': path,
        'generation': int(generation) if generation.isdigit() else None,
        'count': int(count) if count.isdigit() else 0,
        'oldest_epoch': int(oldest) if oldest.isdigit() else None,
    }


class NixGc(Plugin):
    def __init__(self, name: str, config):
        super().__init__(name, config)
        self.unit = str(config.get('unit', 'nix-gc.service'))
        self.timer = str(config.get('timer', 'nix-gc.timer'))
        self.store = str(config.get('store', '/nix/store'))
        self.max_age = parse_duration(config.get('max_age', '2w'))
        self.stale_status = _severity(config.get('stale_status'), 'failed')
        self.timer_status = _severity(config.get('timer_status'), 'warning')
        self.warning = limit_from(config, 'warning', 80)
        self.threshold = limit_from(config, 'threshold', 90)
        self.max_generations = (
            int(config['max_generations']) if config.get('max_generations') is not None else None
        )
        self.max_generation_age = (
            parse_duration(config['max_generation_age'])
            if config.get('max_generation_age') is not None else None
        )

    # --- collection ---

    def commands(self) -> List[Command]:
        return [Command(_probe_script(self.unit, self.timer, self.store))]

    def _state(self) -> Dict[str, Any]:
        """The last collection X-Monitor has seen: its epoch, outcome and yield,
        carried between cycles as metric metadata."""
        metric = self.data.latest_metric(_STATE_METRIC) if self.data else None
        if metric is None or not metric.metadata:
            return {}
        try:
            data = json.loads(metric.metadata)
        except (json.JSONDecodeError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def parse(self, results: List[CmdResult]) -> CollectResult:
        if not results:
            return CollectResult.unavailable('No probe result for this cycle')

        probe = results[0]
        if probe.exit_code != 0 and not probe.stdout.strip():
            return CollectResult.unavailable(
                f"Could not read the Nix store: {(probe.stderr or probe.stdout).strip()[:200]}")

        fields = _parse_probe(probe.stdout)
        if not fields.get('df'):
            return CollectResult.unavailable(
                f"{self.store} is unreadable — is Nix installed on this host?")
        return self._assemble(fields, self._collection_state(fields))

    def _collection_state(self, fields: Dict[str, Any]) -> Dict[str, Any]:
        """Fold what this cycle saw of the last collection into the stored
        state, keeping the older record whenever the journal no longer has it."""
        seen = self._observed_run(fields)
        stored = self._state()
        if seen is None:
            return stored
        stored_epoch = int(stored.get('epoch') or 0)
        if _same_run(seen['epoch'], stored_epoch):
            # The same run seen again; a later cycle may have picked up lines the first one missed.
            return {**stored, **{k: v for k, v in seen.items() if v is not None}}
        # A run recorded earlier, such as a manual collection, may be newer than the unit's own, so the newer record wins.
        return seen if seen['epoch'] > stored_epoch else stored

    def _observed_run(self, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """This cycle's reading of the last collection, as one whole record, or
        None when nothing on the host records that a collection ever ran."""
        outcome, summary, error = (str(fields.get(key, ''))
                                   for key in ('outcome', 'summary', 'error'))
        outcome_epoch = _log_epoch(outcome)
        match = _SUMMARY.search(summary)
        summary_epoch = _log_epoch(summary) if match else None

        # The unit's own stop bounds the run when the journal has rotated past every line of it.
        epoch = max((e for e in (outcome_epoch, summary_epoch, _epoch(fields.get('svc_exit')))
                     if e is not None), default=None)
        if epoch is None:
            return None

        run: Dict[str, Any] = {'epoch': epoch, 'deleted': None, 'freed_bytes': None,
                               'error': None}
        # A `Result` of success proves nothing: systemd resets it on a daemon re-exec, which is
        # what a NixOS switch does, so only the journal may call a run failed.
        if _FAILED in outcome:
            run['succeeded'] = False
        elif _FINISHED in outcome:
            run['succeeded'] = True
        else:
            run['succeeded'] = fields.get('svc_result') in (None, '', 'success')

        if match and _same_run(summary_epoch, epoch):
            run['deleted'] = int(match.group(1))
            run['freed_bytes'] = _bytes_from(match.group(2), match.group(3))
        if not run['succeeded'] and _same_run(_log_epoch(error), epoch):
            run['error'] = _log_message(error)
        return run

    def _assemble(self, fields: Dict[str, Any], state: Dict[str, Any]) -> CollectResult:
        """Turn the probe's facts and the stored collection record into this
        cycle's metrics, log lines and worst-of status."""
        acc = StatusAccumulator()
        now = int(time.time())
        metrics: Dict[str, float] = {}
        logs: List[Tuple[str, str]] = []

        metrics.update(self._store_metrics(fields, acc, logs))
        profiles = [row for row in (_profile_row(raw) for raw in fields['profile']) if row]
        metrics.update(self._profile_metrics(profiles, now, acc, logs))
        metrics.update(self._collection_metrics(fields, state, now, acc, logs))

        metrics[_STATE_METRIC] = float(state.get('epoch') or 0)
        return CollectResult(
            metrics=metrics, metadata={_STATE_METRIC: json.dumps(state)},
            logs=logs, status=str(acc.status),
            snapshot={'hostname': fields.get('hostname'), 'profiles': profiles,
                      'timer_load': fields.get('timer_load'),
                      'timer_state': fields.get('timer_state'),
                      'svc_state': fields.get('svc_state'),
                      'svc_result': fields.get('svc_result')},
        )

    def _store_metrics(self, fields: Dict[str, Any], acc: StatusAccumulator,
                       logs: List[Tuple[str, str]]) -> Dict[str, float]:
        """The store's filesystem usage, path count and auto GC root count."""
        metrics: Dict[str, float] = {}
        parts = str(fields.get('df', '')).split()
        if len(parts) >= 3 and all(p.isdigit() for p in parts[:3]):
            size, used, avail = (int(p) for p in parts[:3])
            used_pct = (used / size * 100) if size else 0.0
            metrics['store_used_pct'] = used_pct
            metrics['store_size_gb'] = size / (1024 ** 3)
            metrics['store_used_gb'] = used / (1024 ** 3)
            metrics['store_avail_gb'] = avail / (1024 ** 3)
            level = level_for(used_pct, self.warning, self.threshold)
            acc.escalate(level)
            logs.append((
                f"{self.store} is {used_pct:.1f}% full "
                f"({format_bytes(used, 'B')} of {format_bytes(size, 'B')}, "
                f"{format_bytes(avail, 'B')} free)",
                'INFO' if level == 'online' else 'WARNING'))

        for key, metric in (('paths', 'store_paths'), ('roots', 'gc_roots')):
            value = str(fields.get(key, ''))
            if value.isdigit():
                metrics[metric] = float(value)
        if 'store_paths' in metrics:
            logs.append((f"{int(metrics['store_paths']):,} store paths, "
                         f"{int(metrics.get('gc_roots', 0)):,} indirect GC roots", 'INFO'))
        return metrics

    def _profile_metrics(self, profiles: List[Dict[str, Any]], now: int,
                         acc: StatusAccumulator,
                         logs: List[Tuple[str, str]]) -> Dict[str, float]:
        """Generation counts and the oldest generation still on disk — what a
        collection with `--delete-older-than` is supposed to be bounding."""
        if not profiles:
            return {}
        metrics = {'profiles': float(len(profiles)),
                   'generations': float(sum(row['count'] for row in profiles))}

        stamps = [row['oldest_epoch'] for row in profiles if row['oldest_epoch']]
        if stamps:
            metrics['oldest_generation_epoch'] = float(min(stamps))
            age = now - min(stamps)
            stale = self.max_generation_age is not None and age > self.max_generation_age
            if stale:
                acc.escalate('warning')
            logs.append((
                f"{int(metrics['generations'])} generations across {len(profiles)} profiles, "
                f"oldest kept {format_age(age)}" + (
                    f", over the {format_duration(self.max_generation_age)} limit" if stale else ''),
                'WARNING' if stale else 'INFO'))

        crowded = [row for row in profiles
                   if self.max_generations is not None and row['count'] > self.max_generations]
        if crowded:
            acc.escalate('warning')
            logs.append((
                'Over the ' + str(self.max_generations) + '-generation limit: ' + ', '.join(
                    f"{row['path']} ({row['count']})" for row in crowded), 'WARNING'))
        return metrics

    def _collection_metrics(self, fields: Dict[str, Any], state: Dict[str, Any], now: int,
                            acc: StatusAccumulator,
                            logs: List[Tuple[str, str]]) -> Dict[str, float]:
        """When collection last ran, what it yielded, and whether it is still
        scheduled to run again."""
        metrics: Dict[str, float] = {}
        running = fields.get('svc_state') in ('active', 'activating', 'reloading')
        if running:
            logs.append((f"{self.unit} is collecting now", 'INFO'))

        if not state.get('succeeded', True):
            acc.escalate('failed')
            reason = state.get('error')
            logs.append((f"The last collection failed" + (f": {reason}" if reason else ''),
                         'ERROR'))
        metrics['last_gc_success'] = 1.0 if state.get('succeeded', True) else 0.0

        epoch = state.get('epoch')
        if not epoch:
            acc.escalate('unavailable')
            logs.append((f"Could not tell when {self.unit} last ran — no record in its journal "
                         'and no timestamp on the unit', 'WARNING'))
        else:
            age = now - int(epoch)
            stale = age > self.max_age and not running
            if stale:
                acc.escalate(self.stale_status)
            yielded = state.get('freed_bytes')
            detail = (f", freeing {format_bytes(yielded, 'B')} "
                      f"across {state.get('deleted') or 0:,} paths" if yielded is not None else '')
            logs.append((
                f"Last collected {format_age(age)}{detail}" + (
                    f", over the {format_duration(self.max_age)} limit" if stale else ''),
                Status(self.stale_status).log_level if stale else 'INFO'))
            if yielded is not None:
                metrics['last_gc_freed_gb'] = yielded / (1024 ** 3)
                metrics['last_gc_deleted'] = float(state.get('deleted') or 0)

        scheduled = fields.get('timer_state') == 'active'
        metrics['timer_active'] = 1.0 if scheduled else 0.0
        if not scheduled:
            acc.escalate(self.timer_status)
            missing = fields.get('timer_load') != 'loaded'
            logs.append((
                f"{self.timer} is " + ('not installed' if missing else 'inactive')
                + ' — nothing collects on a schedule here',
                Status(self.timer_status).log_level))
        next_run = _epoch(fields.get('timer_next'))
        if next_run:
            metrics['next_gc_epoch'] = float(next_run)
            logs.append((f"Next collection in {format_duration(max(next_run - now, 0))}", 'INFO'))
        return metrics

    # --- UI ---

    def _metric(self, name: str) -> Optional[float]:
        metric = self.data.latest_metric(name)
        return metric.value if metric is not None else None

    def _last_gc_pair(self) -> Tuple[str, Optional[str]]:
        state = self._state()
        epoch = state.get('epoch')
        if not epoch:
            return 'UNKNOWN', 'unavailable'
        age = int(time.time()) - int(epoch)
        if not state.get('succeeded', True):
            return format_age(age), 'failed'
        return format_age(age), self.stale_status if age > self.max_age else 'online'

    def _next_gc_pair(self) -> Tuple[str, Optional[str]]:
        if (self._metric('timer_active') or 0) < 0.5:
            return 'NOT SCHEDULED', self.timer_status
        epoch = self._metric('next_gc_epoch')
        if not epoch:
            return '--', None
        return format_duration(max(int(epoch) - int(time.time()), 0)), 'online'

    @property
    def _last_gc_text(self) -> str:
        return self._last_gc_pair()[0]

    @property
    def _last_gc_color(self) -> Optional[str]:
        return self._last_gc_pair()[1]

    @property
    def _next_gc_text(self) -> str:
        return self._next_gc_pair()[0]

    @property
    def _next_gc_color(self) -> Optional[str]:
        return self._next_gc_pair()[1]

    @property
    def _freed_text(self) -> str:
        state = self._state()
        freed = state.get('freed_bytes')
        if freed is None:
            return '--'
        return f"{format_bytes(freed, 'B')} · {state.get('deleted') or 0:,} paths"

    @property
    def _profile_rows(self) -> List[Dict[str, str]]:
        """One row per profile: where it is, which generation is live, how many
        are kept, and how far back the oldest goes."""
        snapshot = self.data.latest_snapshot(default={}) or {}
        now = int(time.time())
        rows = []
        for row in snapshot.get('profiles') or []:
            oldest = row.get('oldest_epoch')
            rows.append({
                'path': row.get('path', '--'),
                'generation': str(row.get('generation') or '--'),
                'count': str(row.get('count') or 0),
                'oldest': format_age(now - int(oldest)) if oldest else '--',
            })
        return rows

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'last_gc_card': {'title': 'LAST COLLECTION', 'value_attr': '_last_gc_text',
                                 'color_attr': '_last_gc_color'},
                'freed_card': {'title': 'LAST YIELD', 'value_attr': '_freed_text',
                               'refresh': True},
                'next_gc_card': {'title': 'NEXT COLLECTION', 'value_attr': '_next_gc_text',
                                 'color_attr': '_next_gc_color'},
                'store_card': {'kind': 'gauge', 'metric': 'store_used_pct', 'title': 'STORE USED',
                               'format': 'percent1',
                               'color': {'warning': self.warning,
                                         'threshold': self.threshold}},
                'paths_card': {'metric': 'store_paths', 'title': 'STORE PATHS',
                               'format': 'count_comma'},
                'generations_card': {'metric': 'generations', 'title': 'GENERATIONS',
                                     'format': 'int'},
                'roots_card': {'metric': 'gc_roots', 'title': 'GC ROOTS', 'format': 'count_comma'},
            },
            'tables': {
                'profiles': {
                    'title': 'Profiles',
                    'row_key': 'path',
                    'rows_attr': '_profile_rows',
                    'columns': [
                        {'name': 'path', 'label': 'Profile', 'field': 'path', 'align': 'left'},
                        {'name': 'generation', 'label': 'Current', 'field': 'generation', 'align': 'right'},
                        {'name': 'count', 'label': 'Generations', 'field': 'count', 'align': 'right'},
                        {'name': 'oldest', 'label': 'Oldest kept', 'field': 'oldest', 'align': 'right'},
                    ],
                },
            },
            'chart': {'metric': 'store_paths', 'title': f'STORE PATHS — {self.store}'},
            'events': {'title': 'Events', 'limit': 100, 'full_height': True},
        }
