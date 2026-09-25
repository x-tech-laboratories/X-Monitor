"""Runtime control of Python logging verbosity, for the whole process or one named logger."""

import logging
import threading
from typing import Dict, List, Mapping, Optional

# The levels an operator may pick, most verbose first.
LEVELS = ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')

# The name that stands for the root logger, which every unconfigured logger inherits from.
ROOT = 'root'

# Its own explicit level keeps every change visible however quiet the rest of logging is set.
_announce = logging.getLogger('vigil.log_levels')
_announce.setLevel(logging.WARNING)


def normalize_level(level: str) -> str:
    """The canonical name of a level, raising ValueError for one Vigil does not offer."""
    name = str(level).strip().upper()
    if name not in LEVELS:
        raise ValueError(f"unknown log level {level!r}; use one of {', '.join(LEVELS)}")
    return name


def _logger(name: str) -> logging.Logger:
    return logging.getLogger() if name in ('', ROOT) else logging.getLogger(name)


class LogLevels:
    """The process's log levels: set from config at startup and on reload, and changed by hand at runtime."""

    def __init__(self):
        self._lock = threading.Lock()
        self._baseline = logging.getLevelName(logging.getLogger().level)
        self._named: set = set()
        self._from_config: set = set()

    def configure(self, level: Optional[str], levels: Mapping[str, str]) -> None:
        """Apply config's `logging.level` and `logging.levels`, undoing what a previous config set and this one drops."""
        wanted = {ROOT: level or self._baseline, **levels}
        for name in sorted(self._from_config - set(levels)):
            self.set_level(name, None, source='config')
        for name, value in wanted.items():
            # A bad entry is reported and skipped so the rest still apply.
            try:
                if logging.getLevelName(_logger(name).level) != normalize_level(value):
                    self.set_level(name, value, source='config')
            except ValueError as e:
                _announce.warning(f"logging.levels: {name}: {e}")
        self._from_config = set(levels) - {ROOT}

    def set_level(self, name: Optional[str], level: Optional[str], source: str = 'runtime') -> Dict[str, str]:
        """Set one logger's level, or with no level return a named logger to inheriting; returns the new levels."""
        name = (name or ROOT).strip() or ROOT
        if level in (None, '') and name == ROOT:
            raise ValueError("the root logger always has a level")
        new = None if level in (None, '') else normalize_level(level)
        with self._lock:
            logger = _logger(name)
            old = logging.getLevelName(logger.level) if (name == ROOT or logger.level) else 'inherited'
            logger.setLevel(new or logging.NOTSET)
            if name != ROOT:
                if new is None:
                    self._named.discard(name)
                else:
                    self._named.add(name)
        _announce.warning(f"Log level for {name} changed from {old} to {new or 'inherited'} ({source})")
        return self.levels()

    def step(self, more_verbose: bool, source: str) -> str:
        """Move the root level one step more or less verbose, stopping at either end; returns the new level."""
        current = logging.getLevelName(logging.getLogger().level)
        index = LEVELS.index(current) if current in LEVELS else LEVELS.index('INFO')
        index = max(0, index - 1) if more_verbose else min(len(LEVELS) - 1, index + 1)
        if LEVELS[index] != current:
            self.set_level(ROOT, LEVELS[index], source=source)
        return LEVELS[index]

    def levels(self) -> Dict[str, str]:
        """The root level plus every logger given a level of its own."""
        with self._lock:
            named = sorted(self._named)
        out = {ROOT: logging.getLevelName(logging.getLogger().level)}
        for name in named:
            out[name] = logging.getLevelName(logging.getLogger(name).level)
        return out

    @staticmethod
    def known_loggers() -> List[str]:
        """Every Vigil logger created so far, for picking one to change."""
        return sorted(name for name in logging.root.manager.loggerDict
                      if name == 'vigil' or name.startswith('vigil.') or name == 'asyncssh')
