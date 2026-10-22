"""Processes from `ps` over SSH — sampled locally by the agent on agent-backed
hosts — shown as a tree under their parents with per-row kill actions (SIGTERM
or SIGKILL). Each row's CPU and MEM add up its whole branch, and its own share
sits beside them. Config: max_processes, require_sudo, cpu_warning,
cpu_threshold. The tree keeps the max_processes busiest processes and every
ancestor of each, while the totals still count every process. When both CPU
bounds are set, the busiest process's own CPU share ranks against
cpu_warning/cpu_threshold for warning/failed; otherwise the monitor only
reports. A failed or unparseable collection measured nothing and is
unavailable."""

from typing import Dict, Any, List, Optional, Union

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors.types import ActionPlan, CmdResult, CollectResult, Command, Status
from x_monitor.plugins.base.plugin_helpers import level_for

_SEVERITY = {'online': 0, 'warning': 1, 'failed': 2}

_KILL_SIGNALS = {'kill_term': 'TERM', 'kill_kill': 'KILL'}


# ===== Reading ps =====

def _parse_ps_output(stdout: str) -> List[Dict]:
    processes = []
    lines = stdout.strip().splitlines()
    if len(lines) < 2:
        return processes
    for line in lines[1:]:
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        try:
            processes.append({
                'pid':     int(parts[0]),
                'ppid':    int(parts[1]),
                'user':    parts[2],
                'cpu':     float(parts[3]),
                'mem':     float(parts[4]),
                'command': parts[5].strip(),
            })
        except (ValueError, IndexError):
            continue
    return processes


# ===== Building the tree =====

def _ancestors(pid: int, parent_of: Dict[int, int]) -> List[int]:
    """The pids above a process, nearest first, stopping at a root or a loop."""
    chain, seen = [], {pid}
    parent = parent_of.get(pid)
    while parent in parent_of and parent not in seen:
        chain.append(parent)
        seen.add(parent)
        parent = parent_of.get(parent)
    return chain


def _process_tree(processes: List[Dict], max_processes: int) -> List[Dict]:
    """Rows for the tree: the busiest processes and their ancestors, each totalling its whole branch.

    `cpu` and `mem` hold the branch totals, `own_cpu` and `own_mem` the process alone, and
    `procs` how many processes the branch holds; the totals count every process, shown or not.
    """
    parent_of = {p['pid']: p['ppid'] for p in processes}
    totals = {p['pid']: [p['cpu'], p['mem'], 1] for p in processes}
    for p in processes:
        for pid in _ancestors(p['pid'], parent_of):
            totals[pid][0] += p['cpu']
            totals[pid][1] += p['mem']
            totals[pid][2] += 1

    busiest = sorted(processes, key=lambda p: p['cpu'], reverse=True)[:max_processes]
    kept = set()
    for p in busiest:
        kept.add(p['pid'])
        kept.update(_ancestors(p['pid'], parent_of))

    rows = [{
        'pid':     p['pid'],
        'ppid':    p['ppid'] if p['ppid'] in kept else None,
        'user':    p['user'],
        'cpu':     round(totals[p['pid']][0], 1),
        'mem':     round(totals[p['pid']][1], 1),
        'own_cpu': p['cpu'],
        'own_mem': p['mem'],
        'procs':   totals[p['pid']][2],
        'command': p['command'],
    } for p in processes if p['pid'] in kept]
    rows.sort(key=lambda row: row['cpu'], reverse=True)
    return rows


# ===== The plugin =====

_DEFAULT_LAYOUT = [
    ['host_card', 'count_card', 'top_cpu_card'],
    ['table'],
    ['events'],
]


class Processes(Plugin):
    def __init__(self, name: str, config: Dict[str, Any]):
        super().__init__(name, config)
        self.max_processes = int(config.get('max_processes', 20))
        self.require_sudo  = bool(config.get('require_sudo', False))
        self.cpu_warning   = float(config['cpu_warning'])   if 'cpu_warning'   in config else None
        self.cpu_threshold = float(config['cpu_threshold'])  if 'cpu_threshold'  in config else None

    @property
    def _ranks_cpu(self) -> bool:
        """Whether both CPU thresholds are configured, without which nothing is colored."""
        return self.cpu_warning is not None and self.cpu_threshold is not None

    def _row_cpu_level(self, row):
        """Color one process row by its own CPU share against the configured thresholds."""
        return level_for(row['own_cpu'], self.cpu_warning, self.cpu_threshold)

    SAMPLED = True

    def commands(self) -> List[Command]:
        return [Command("ps -eo pid,ppid,user,pcpu,pmem,comm --sort=-%cpu")]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        ret, stdout, stderr = results[0].exit_code, results[0].stdout, results[0].stderr
        if ret != 0:
            return CollectResult.unavailable(f"Collection failed: {stderr}")

        processes = _parse_ps_output(stdout)

        has_data_rows = len(stdout.strip().splitlines()) > 1
        if not processes and has_data_rows:
            return CollectResult.unavailable(f"Could not parse ps output: {stdout!r}")

        process_count = len(processes)
        top_cpu = max((p['cpu'] for p in processes), default=0.0)

        if self.cpu_warning is not None and self.cpu_threshold is not None:
            overall = level_for(top_cpu, self.cpu_warning, self.cpu_threshold)
        else:
            overall = 'online'

        log_level = Status(overall).log_level
        return CollectResult(
            metrics={'process_count': float(process_count), 'top_cpu_pct': top_cpu},
            snapshot=_process_tree(processes, self.max_processes),
            logs=[(f"{process_count} processes, top CPU {top_cpu:.1f}%", log_level)],
            status=overall,
        )

    def plan_action(self, action_id: str, **kwargs) -> Optional[Union[ActionPlan, CollectResult]]:
        signal = _KILL_SIGNALS.get(action_id)
        if signal is None:
            return None

        pid = kwargs.get('pid')
        if pid is None:
            return CollectResult.failed("Kill action missing pid")

        # -n because a sudo that stops for a password never returns, and nothing here would ever answer it
        prefix = 'sudo -n ' if self.require_sudo else ''
        return ActionPlan(f"{prefix}kill -{signal} {int(pid)}")

    def interpret_action(self, action_id: str, result: CmdResult, **kwargs):
        signal = _KILL_SIGNALS.get(action_id)
        if signal is None:
            return result.exit_code == 0
        pid = kwargs.get('pid')
        if result.exit_code != 0:
            return CollectResult.failed(f"Failed to send SIG{signal} to PID {pid}: {result.stderr}")
        return CollectResult(logs=[(f"Sent SIG{signal} to PID {pid}", "INFO")], success=True)

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'count_card': {'metric': 'process_count', 'title': 'PROCESSES', 'format': 'int'},
                'top_cpu_card': {
                    'metric': 'top_cpu_pct', 'title': 'TOP CPU', 'format': 'percent1',
                    **({'color': {'warning': self.cpu_warning, 'threshold': self.cpu_threshold}}
                       if self._ranks_cpu else {}),
                },
            },
            'tables': {
                'table': {
                    'row_key': 'pid',
                    'tree': {'parent_field': 'ppid', 'column': 'command'},
                    'columns': [
                        {'name': 'command', 'label': 'COMMAND', 'field': 'command', 'sortable': True, 'align': 'left'},
                        {'name': 'pid', 'label': 'PID', 'field': 'pid', 'sortable': True, 'align': 'right'},
                        {'name': 'user', 'label': 'USER', 'field': 'user', 'sortable': True, 'align': 'left'},
                        {'name': 'cpu', 'label': 'CPU %', 'field': 'cpu', 'sortable': True, 'align': 'right'},
                        {'name': 'mem', 'label': 'MEM %', 'field': 'mem', 'sortable': True, 'align': 'right'},
                        {'name': 'own_cpu', 'label': 'SELF CPU %', 'field': 'own_cpu', 'sortable': True,
                         'align': 'right',
                         **({'cell_color_by': self._row_cpu_level} if self._ranks_cpu else {})},
                        {'name': 'own_mem', 'label': 'SELF MEM %', 'field': 'own_mem', 'sortable': True,
                         'align': 'right'},
                        {'name': 'procs', 'label': 'PROCS', 'field': 'procs', 'sortable': True, 'align': 'right'},
                    ],
                    'row_actions': [
                        {'id': 'kill_term', 'icon': 'cancel', 'color': 'warning',
                         'tooltip': 'SIGTERM (graceful)', 'kind': 'dispatch',
                         'params': {'pid': 'pid'}},
                        {'id': 'kill_kill', 'icon': 'dangerous', 'color': 'negative',
                         'tooltip': 'SIGKILL (force)', 'kind': 'dispatch',
                         'params': {'pid': 'pid'}},
                    ],
                },
            },
            'events': True,
        }

