"""The pure half of a config reload: what a reload did, which settings need a restart, and how monitors compare."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Settings read once at startup, as (section, key); a None key compares the whole section.
_RESTART_SETTINGS = (
    ('database', 'path'),
    ('database', 'write_batch_seconds'),
    ('memory', None),
    ('auth', None),
    ('theme', None),
)


@dataclass
class ReloadResult:
    """The outcome of one reload: the monitor ids it touched, or why it was refused."""
    source: str
    ok: bool = True
    added: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)
    changed: List[str] = field(default_factory=list)
    restart_required: List[str] = field(default_factory=list)
    error: Optional[str] = None

    def summary(self) -> str:
        if not self.ok:
            return f"Config reload ({self.source}) failed, still running the previous config: {self.error}"
        text = (f"Config reloaded ({self.source}): {len(self.added)} added, "
                f"{len(self.removed)} removed, {len(self.changed)} changed")
        if self.restart_required:
            text += f"; restart required for: {', '.join(self.restart_required)}"
        return text

    def as_dict(self) -> Dict[str, Any]:
        return {'ok': self.ok, 'source': self.source, 'added': self.added, 'removed': self.removed,
                'changed': self.changed, 'restart_required': self.restart_required,
                'error': self.error, 'summary': self.summary()}


def _setting(config: Dict[str, Any], section: str, key: Optional[str]) -> Any:
    value = config.get(section) or {}
    if key is None:
        return value
    return value.get(key) if isinstance(value, dict) else None


def restart_required(old: Dict[str, Any], new: Dict[str, Any], db_path_overridden: bool = False) -> List[str]:
    """The startup-only settings that differ between two configs, named as section or section.key."""
    names = []
    for section, key in _RESTART_SETTINGS:
        if db_path_overridden and (section, key) == ('database', 'path'):
            continue
        if _setting(old, section, key) != _setting(new, section, key):
            names.append(section if key is None else f"{section}.{key}")
    return names


def section_changed(old: Dict[str, Any], new: Dict[str, Any], *keys: str) -> bool:
    """Whether any of these top-level sections differ between two configs."""
    return any(old.get(k) != new.get(k) for k in keys)


def monitor_signature(config: Dict[str, Any], cls: type) -> tuple:
    """What decides whether a monitor is unchanged: its class and its effective config, not counting its children."""
    own = {k: v for k, v in config.items() if k != 'children'}
    return cls.__module__, cls.__qualname__, own


def same_monitor(existing: Any, config: Dict[str, Any], cls: type) -> bool:
    """Whether a running monitor already matches this config and class, so a reload can keep it as it is."""
    return monitor_signature(existing.config, type(existing)) == monitor_signature(config, cls)
