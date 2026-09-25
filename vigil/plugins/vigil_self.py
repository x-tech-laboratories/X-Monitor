"""Vigil watching itself: process memory, CPU, and uptime from /proc/self,
plus collection health across every other monitor, gathered through the
io_call escape hatch since it reads local files and live engine state rather
than issuing connector requests. Config: memory_warning / memory_threshold
(MB of RSS), stale_warning / stale_threshold (how many intervals overdue a
monitor may run), slow_cycle_fraction / slow_cycle_seconds (how long a
monitor's average cycle may take, as a share of its interval or in seconds).
RSS past its bounds sets warning/failed, monitors overdue past stale_warning
are warning ("late"), any past stale_threshold makes the status failed
("stalled"), and a monitor whose cycles run past either slow bound is
warning ("slow"). A table lists every monitor's recent cycle times, slowest
first, with how long its SSH commands queued for a channel. A sample that
raises before anything was read is unavailable."""

import os
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from vigil.plugins.base.plugin_base import Plugin
from vigil.core.connectors.types import CollectResult
from vigil.plugins.base.plugin_helpers import level_for

_CLOCK_TICKS = os.sysconf('SC_CLK_TCK') if hasattr(os, 'sysconf') else 100

_DEFAULT_LAYOUT = [
    ['uptime_card', 'memory_card', 'monitors_card', 'slow_card'],
    ['chart'],
    ['timings'],
    ['events'],
]


def _read_rss_mb() -> Optional[float]:
    try:
        with open('/proc/self/status') as fh:
            for line in fh:
                if line.startswith('VmRSS:'):
                    return int(line.split()[1]) / 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def _read_cpu_seconds() -> Optional[float]:
    try:
        with open('/proc/self/stat') as fh:
            fields = fh.read().split()
        return (int(fields[13]) + int(fields[14])) / _CLOCK_TICKS
    except (OSError, ValueError, IndexError):
        return None


class VigilSelfPlugin(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.memory_warning   = float(config.get('memory_warning',   256))
        self.memory_threshold = float(config.get('memory_threshold', 512))
        # A pushed monitor is only guaranteed an event every
        # SAMPLE_MAX_QUIET_INTERVALS, so a bound at or under that would read a
        # healthy quiet stream as late.
        self.stale_warning    = float(config.get(
            'stale_warning', Plugin.SAMPLE_MAX_QUIET_INTERVALS + 1))
        self.stale_threshold  = float(config.get('stale_threshold',  10))
        self.slow_cycle_fraction = float(config.get('slow_cycle_fraction', 0.5))
        # Zero leaves only the share-of-interval bound.
        self.slow_cycle_seconds = float(config.get('slow_cycle_seconds', 0) or 0)
        self._started_at = time.time()
        self._last_cpu_sample: Optional[Tuple[float, float]] = None
        self.target = 'vigil'

        from vigil.core.ui.spec import threshold_color
        self._memory_color = threshold_color(
            warning=self.memory_warning, threshold=self.memory_threshold)
        self._uptime_format = lambda v: '--' if v is None else _format_uptime(v)
        self._memory_format = lambda v: '-- MB' if v is None else f'{v:.0f} MB'

    def _walk_monitors(self):
        if self.engine is None:
            return
        stack = list(self.engine.plugins)
        while stack:
            p = stack.pop()
            stack.extend(p.children)
            if p is not self:
                yield p

    def _collection_health(self) -> Tuple[int, int, int, list]:
        now = time.monotonic()
        total = late = stalled = 0
        offenders = []

        for p in self._walk_monitors():
            if p.children:
                continue
            total += 1
            last = self.engine.last_collected(p.id) if self.engine else 0.0
            if not last:
                continue
            overdue = (now - last) / p.interval if p.interval else 0
            if overdue >= self.stale_threshold:
                stalled += 1
                offenders.append((overdue, p.name))
            elif overdue >= self.stale_warning:
                late += 1
                offenders.append((overdue, p.name))

        offenders.sort(reverse=True)
        return total, late, stalled, offenders[:5]

    def _is_slow(self, avg_seconds: float, interval: float) -> bool:
        if self.slow_cycle_seconds and avg_seconds > self.slow_cycle_seconds:
            return True
        return bool(interval) and self.slow_cycle_fraction > 0 and avg_seconds > interval * self.slow_cycle_fraction

    def _cycle_rows(self) -> List[Dict[str, Any]]:
        """One row per monitor that has timed a cycle, slowest average first."""
        rows = []
        for p in self._walk_monitors():
            if p.children:
                continue
            timing = self.engine.cycle_timing(p.id)
            if timing is None:
                continue
            rows.append({
                'id': p.id,
                'name': p.name,
                'interval': p.interval,
                'last': round(timing.last_seconds, 3),
                'avg': round(timing.avg_seconds, 3),
                'max': round(timing.max_seconds, 3),
                'wait': round(timing.avg_wait_seconds, 3),
                'share': round(100.0 * timing.avg_seconds / p.interval, 1) if p.interval else None,
                'slow': self._is_slow(timing.avg_seconds, p.interval),
            })
        rows.sort(key=lambda r: r['avg'], reverse=True)
        return rows

    def io_call(self) -> Optional[Callable[[], Any]]:
        # Reads /proc/self plus the engine's live collection-health map —
        # local introspection the declarative connector requests can't model.
        # A sample that raises is handed to parse_results as an error so the cycle records unavailable instead of nothing.
        def _sample():
            try:
                return self._sample()
            except Exception as e:
                return {'error': f"{type(e).__name__}: {e}"}
        return _sample

    def _sample(self) -> Dict[str, Any]:
        rss_mb = _read_rss_mb()
        cpu_seconds = _read_cpu_seconds()
        uptime_seconds = time.time() - self._started_at

        cpu_pct = None
        if cpu_seconds is not None:
            now = time.monotonic()
            if self._last_cpu_sample:
                prev_time, prev_cpu = self._last_cpu_sample
                elapsed = now - prev_time
                if elapsed > 0:
                    cpu_pct = 100.0 * (cpu_seconds - prev_cpu) / elapsed
            self._last_cpu_sample = (now, cpu_seconds)

        total, late, stalled, offenders = self._collection_health()
        return {
            'cycles': self._cycle_rows() if self.engine is not None else [],
            'rss_mb': rss_mb,
            'cpu_pct': cpu_pct,
            'uptime_seconds': uptime_seconds,
            'total': total,
            'late': late,
            'stalled': stalled,
            'offenders': offenders,
        }

    def parse_results(self, results: List[Any]) -> CollectResult:
        result = results[0]
        if 'error' in result:
            return CollectResult.unavailable(f"Self sample could not be taken: {result['error']}")
        rss_mb = result['rss_mb']
        cpu_pct = result['cpu_pct']
        uptime_seconds = result['uptime_seconds']
        total, late, stalled, offenders = result['total'], result['late'], result['stalled'], result['offenders']

        cycles = result.get('cycles') or []
        slow = [row for row in cycles if row['slow']]

        metrics = {'uptime_seconds': uptime_seconds, 'monitors_total': float(total),
                   'monitors_late': float(late), 'monitors_stalled': float(stalled),
                   'monitors_slow': float(len(slow))}
        if cycles:
            metrics['slowest_cycle_seconds'] = cycles[0]['avg']
        if rss_mb is not None:
            metrics['memory_mb'] = rss_mb
        if cpu_pct is not None:
            metrics['cpu_pct'] = cpu_pct

        mem_level = (
            level_for(rss_mb, self.memory_warning, self.memory_threshold)
            if rss_mb is not None else 'online'
        )
        if stalled:
            collect_level = 'failed'
        elif late or slow:
            collect_level = 'warning'
        else:
            collect_level = 'online'

        overall = max(
            (mem_level, collect_level),
            key=lambda lvl: ('online', 'warning', 'failed').index(lvl),
        )

        parts = [f"up {_format_uptime(uptime_seconds)}"]
        if rss_mb is not None:
            parts.append(f"RSS {rss_mb:.0f} MB")
        if cpu_pct is not None:
            parts.append(f"CPU {cpu_pct:.1f}%")
        parts.append(f"{total} monitors")
        if late or stalled:
            parts.append(f"{late} late, {stalled} stalled")
        if offenders:
            worst = ', '.join(f"{name} ({mult:.0f}x)" for mult, name in offenders)
            parts.append(f"worst: {worst}")
        if slow:
            named = ', '.join(f"{row['name']} ({row['avg']:.1f}s of {row['interval']:.0f}s)" for row in slow[:5])
            parts.append(f"slow: {named}")

        log_level = "ERROR" if overall == 'failed' else "WARNING" if overall == 'warning' else "INFO"
        return CollectResult(metrics=metrics, logs=[(' | '.join(parts), log_level)], status=overall,
                             snapshot=cycles)

    @staticmethod
    def _monitors_text(values: Dict[str, Any]) -> str:
        total = values.get('monitors_total')
        if total is None:
            return '--'
        n_late = int(values.get('monitors_late') or 0)
        n_stalled = int(values.get('monitors_stalled') or 0)
        if n_stalled:
            return f'{int(total)} ({n_stalled} stalled)'
        if n_late:
            return f'{int(total)} ({n_late} late)'
        return f'{int(total)} OK'

    @staticmethod
    def _monitors_color(values: Dict[str, Any]) -> Optional[str]:
        if values.get('monitors_total') is None:
            return None
        if int(values.get('monitors_stalled') or 0):
            return 'failed'
        if int(values.get('monitors_late') or 0):
            return 'warning'
        return 'online'

    @staticmethod
    def _slow_row_color(row: Dict[str, Any]) -> Optional[str]:
        return 'warning' if row.get('slow') else None

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'uptime_card': {'metric': 'uptime_seconds', 'title': 'VIGIL UPTIME',
                                'format': self._uptime_format},
                'memory_card': {'metric': 'memory_mb', 'title': 'MEMORY', 'format': self._memory_format,
                                'color': self._memory_color},
                'monitors_card': {'title': 'MONITORS',
                                  'metrics': ['monitors_total', 'monitors_late', 'monitors_stalled'],
                                  'format_fn': self._monitors_text, 'color_fn': self._monitors_color},
                'slow_card': {'metric': 'monitors_slow', 'title': 'SLOW MONITORS', 'color': 'nonzero_warning'},
            },
            'chart': {'metric': 'memory_mb', 'title': 'VIGIL MEMORY (MB)'},
            'tables': {
                'timings': {
                    'row_key': 'id',
                    'columns': [
                        {'name': 'name', 'label': 'MONITOR', 'field': 'name', 'sortable': True, 'align': 'left',
                         'cell_color_by': self._slow_row_color},
                        {'name': 'interval', 'label': 'INTERVAL (S)', 'field': 'interval', 'sortable': True,
                         'align': 'right'},
                        {'name': 'last', 'label': 'LAST (S)', 'field': 'last', 'sortable': True, 'align': 'right'},
                        {'name': 'avg', 'label': 'AVG (S)', 'field': 'avg', 'sortable': True, 'align': 'right'},
                        {'name': 'max', 'label': 'MAX (S)', 'field': 'max', 'sortable': True, 'align': 'right'},
                        {'name': 'wait', 'label': 'CHANNEL WAIT (S)', 'field': 'wait', 'sortable': True,
                         'align': 'right'},
                        {'name': 'share', 'label': '% OF INTERVAL', 'field': 'share', 'sortable': True,
                         'align': 'right', 'cell_color_by': self._slow_row_color},
                    ],
                },
            },
            'events': True,
        }


def _format_uptime(seconds: float) -> str:
    seconds = int(seconds)
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"
