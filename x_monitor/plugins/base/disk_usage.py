"""The df and du commands the filesystem monitors (filesystems, disk_space,
folders) run, and the pure parsers for their output: one df builder and parser
for any --output column list, one du builder and parser, and the metric key a
path is stored under."""

import shlex
from typing import Any, Dict, List, Optional, Sequence, Tuple

from x_monitor.core.connectors.types import CmdResult

# Pseudo and in-memory filesystem types a listing of real filesystems leaves out.
PSEUDO_FS_TYPES = ('tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs',
                   'cgroup', 'cgroup2', 'devpts', 'mqueue', 'debugfs',
                   'tracefs', 'ramfs', 'efivarfs', 'configfs', 'fusectl',
                   'securityfs', 'pstore', 'autofs', 'binfmt_misc', 'nsfs')

# df columns printed as a percentage, which parse to a float.
_PERCENT_COLUMNS = {'pcent', 'ipcent'}


def path_key(path: str) -> str:
    """The metric-name fragment for a path: 'root' for /, otherwise non-alphanumerics become underscores."""
    s = path.strip('/')
    if not s:
        return 'root'
    return ''.join(c if c.isalnum() else '_' for c in s)


def df_command(columns: Sequence[str], path: Optional[str] = None, byte_blocks: bool = False,
               exclude_types: Sequence[str] = ()) -> str:
    """A df command printing the given --output columns, for one path or for every filesystem."""
    parts = ['df']
    if byte_blocks:
        parts.append('-B1')
    parts += [f'-x {t}' for t in exclude_types]
    parts.append('--output=' + ','.join(columns))
    if path is not None:
        parts.append(shlex.quote(path))
    return ' '.join(parts)


def parse_df(block: str, columns: Sequence[str], header: bool = True) -> List[Dict[str, Any]]:
    """Parse df --output rows into dicts keyed by column, skipping any row that does not parse.

    Only a leading 'target' column may contain spaces, so the other columns are
    read from the right and whatever is left over is the mount point."""
    has_target = columns[0] == 'target'
    values = columns[1:] if has_target else columns
    lines = block.splitlines()[1:] if header else block.splitlines()
    rows: List[Dict[str, Any]] = []
    for line in lines:
        fields = line.split()
        if len(fields) < len(values) + (1 if has_target else 0):
            continue
        tail = fields[len(fields) - len(values):]
        try:
            row: Dict[str, Any] = {
                col: float(raw.rstrip('%')) if col in _PERCENT_COLUMNS else int(raw)
                for col, raw in zip(values, tail)
            }
        except ValueError:
            continue
        if has_target:
            row['target'] = ' '.join(fields[:len(fields) - len(values)])
        rows.append(row)
    return rows


def du_command(path: str, timeout: int) -> str:
    """A du command printing the apparent size in bytes of everything under path, cut off after timeout seconds."""
    return f"timeout {timeout} du -sb {shlex.quote(path)}"


def parse_du(result: CmdResult, timeout: int) -> Tuple[Optional[int], Optional[str]]:
    """Returns (size_bytes, error_message) for one du_command result."""
    if result.exit_code == 124:
        return None, f"du timed out after {timeout}s"
    if result.exit_code != 0:
        return None, f"du failed: {result.stderr.strip()}"
    try:
        return int(result.stdout.split()[0]), None
    except (ValueError, IndexError):
        return None, f"could not parse du output {result.stdout.strip()!r}"
