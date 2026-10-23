"""mdadm array health, read from /proc/mdstat. A degraded array is failed and a
rebuilding one warning; an unreadable /proc/mdstat or a host with no arrays
is unavailable."""

import re

from typing import Any, Dict, List

from x_monitor.plugins.base.signal_plugin import (
    SignalPlugin,
)
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult


_ARRAY_RE = re.compile(r'^(md\d+)\s*:\s*(\S+)\s+(\S+)', re.MULTILINE)


_LEVEL_RE = re.compile(r'\b(raid\d+|linear|multipath|faulty|container)\b')


_STATE_RE = re.compile(r'\[(\d+)/(\d+)\]\s*\[([U_]+)\]')


_RECOVERY_RE = re.compile(r'(recovery|resync|reshape|check)\s*=\s*([\d.]+)%')


_STATE_COLORS = {'clean': 'online', 'resyncing': 'warning', 'degraded': 'failed'}


def _array_caption(item: Dict[str, Any]) -> str:
    """An array tile's caption: its RAID level, then its state or its rebuild progress."""
    parts = [item['level']] if item.get('level') else []
    action, progress = item.get('action'), item.get('progress')
    rebuild = f"{action} {progress:.0f}%" if action and progress is not None else None
    if item.get('state') == 'degraded':
        parts.append('degraded')
        if rebuild:
            parts.append(rebuild)
    else:
        parts.append(rebuild or item.get('state', '--'))
    return ' · '.join(parts)


def _array_color(item: Dict[str, Any]):
    """An array tile's color: clean is online, resyncing warning and degraded failed."""
    return _STATE_COLORS.get(item.get('state'))


class Md(SignalPlugin):
    """Linux software RAID health from /proc/mdstat — the mdadm sibling of the
    zfs monitor, counting arrays that are clean, degraded or rebuilding and
    keeping each array's level, state and rebuild progress in the snapshot."""

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command("cat /proc/mdstat 2>&1")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0 and not stdout.strip():
            return CollectResult.unavailable(f"Failed to read /proc/mdstat: {stderr}")

        ok = degraded = 0
        recovering = False
        logs = []
        arrays: List[Dict[str, Any]] = []

        for m in _ARRAY_RE.finditer(stdout):
            dev = m.group(1)
            header_end = stdout.find('\n', m.start())
            header = stdout[m.start():] if header_end < 0 else stdout[m.start():header_end]
            level = _LEVEL_RE.search(header)
            block = stdout[m.end():]
            next_blank = block.find('\n\n')
            block = block if next_blank < 0 else block[:next_blank]

            state = _STATE_RE.search(block)
            recov = _RECOVERY_RE.search(block)
            array = {
                'label': dev,
                'level': level.group(1) if level else None,
                'state': 'clean',
                'action': recov.group(1) if recov else None,
                'progress': float(recov.group(2)) if recov else None,
            }
            arrays.append(array)

            if state:
                expected, active, flags = int(state.group(1)), int(state.group(2)), state.group(3)
                if flags.count('_') > 0 or active < expected:
                    degraded += 1
                    array['state'] = 'degraded'
                    logs.append((f"{dev}: DEGRADED [{active}/{expected}] [{flags}]", "ERROR"))
                    continue

            if recov:
                recovering = True
                array['state'] = 'resyncing'
                logs.append((f"{dev}: {recov.group(1)} {recov.group(2)}% in progress", "WARNING"))
                ok += 1
                continue

            ok += 1
            logs.append((f"{dev}: clean", "INFO"))

        if ok + degraded == 0:
            result = CollectResult.unavailable("No RAID arrays found in /proc/mdstat")
            result.snapshot = []
            return result

        metrics = {
            'arrays_total': float(ok + degraded),
            'arrays_ok': float(ok),
            'arrays_degraded': float(degraded),
        }
        if degraded:
            status = 'failed'
        elif recovering:
            status = 'warning'
        else:
            status = 'online'
        return CollectResult(metrics=metrics, logs=logs, status=status, snapshot=arrays)

    def cards(self) -> Dict[str, Dict[str, Any]]:
        return {
            'md_total_card': {'metric': 'arrays_total', 'title': 'ARRAYS', 'format': 'int'},
            'md_degraded_card': {
                'kind': 'share', 'title': 'ARRAY HEALTH', 'format': 'int',
                'parts': [
                    {'metric': 'arrays_ok', 'label': 'Clean', 'color': 'online'},
                    {'metric': 'arrays_degraded', 'label': 'Degraded', 'color': 'failed'},
                ],
            },
            'md_array_tiles': {
                'title': 'ARRAY STATE',
                'repeat': {
                    'source': 'snapshot',
                    'container': 'tiles',
                    'item_format_fn': _array_caption,
                    'item_color_by': _array_color,
                    'empty_text': 'No RAID arrays found',
                },
            },
        }

    def card_row(self) -> List[str]:
        return ['md_total_card', 'md_degraded_card']

    def rows(self) -> List[List[str]]:
        return [['md_array_tiles']]
