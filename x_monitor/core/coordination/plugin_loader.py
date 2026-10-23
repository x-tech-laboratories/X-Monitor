"""Finds the Plugin class for a monitor's `type`, in X-Monitor's own plugins or in the directories `plugin_paths` names."""

import importlib
import importlib.util
import inspect
import logging
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from x_monitor.plugins.base.plugin_base import Plugin

log = logging.getLogger(__name__)

BUILTIN_PACKAGE = 'x_monitor.plugins'
# The package external plugin modules are imported under, so they never collide with X-Monitor's own.
EXTERNAL_PACKAGE = 'x_monitor_external'


def _defined_in(cls: type, module_path: str) -> bool:
    """True for a class defined in the plugin module itself or, for a plugin package, in one of its own submodules."""
    return cls.__module__ == module_path or cls.__module__.startswith(module_path + '.')


def _plugin_class(module, module_path: str) -> type:
    """The Plugin subclass a plugin module defines, ignoring the bases it imports."""
    candidates = [obj for _, obj in inspect.getmembers(module, inspect.isclass)
                  if issubclass(obj, Plugin) and _defined_in(obj, module_path)
                  and not inspect.isabstract(obj)]
    if not candidates:
        raise ValueError(f"{module_path} defines no concrete Plugin subclass")
    if len(candidates) > 1:
        raise ValueError(
            f"{module_path} defines more than one Plugin subclass "
            f"({[c.__name__ for c in candidates]}) — a plugin module must define exactly one")
    return candidates[0]


@dataclass(frozen=True)
class PluginPath:
    """One `plugin_paths` directory; with override its plugins win over a built-in of the same name."""
    directory: Path
    override: bool = False


def parse_plugin_paths(entries: Any, base: Path) -> List[PluginPath]:
    """Read `plugin_paths`: each entry a directory, or a mapping with `path` and `override`, relative to the config file."""
    paths = []
    for entry in entries or []:
        if isinstance(entry, dict):
            raw, override = entry.get('path'), bool(entry.get('override', False))
        else:
            raw, override = entry, False
        if not raw:
            log.warning(f"plugin_paths: entry {entry!r} names no directory, ignored")
            continue
        directory = Path(str(raw)).expanduser()
        if not directory.is_absolute():
            directory = base / directory
        if not directory.is_dir():
            log.warning(f"plugin_paths: {directory} is not a directory, ignored")
            continue
        paths.append(PluginPath(directory, override))
    return paths


def _external_file(directory: Path, name: str) -> Optional[Path]:
    """The module file for a plugin type in one directory: `<name>.py`, or `<name>/__init__.py` for a package."""
    single = directory / f"{name}.py"
    if single.is_file():
        return single
    package = directory / name / '__init__.py'
    if package.is_file():
        return package
    return None


def _builtin_exists(name: str) -> bool:
    try:
        return importlib.util.find_spec(f"{BUILTIN_PACKAGE}.{name}") is not None
    except (ImportError, ValueError):
        return False


def _ensure_external_package() -> None:
    if EXTERNAL_PACKAGE not in sys.modules:
        package = types.ModuleType(EXTERNAL_PACKAGE)
        package.__path__ = []
        sys.modules[EXTERNAL_PACKAGE] = package


class PluginLoader:
    """Resolves plugin types to classes, importing each at most once per loader."""

    def __init__(self, paths: Optional[List[PluginPath]] = None):
        self.paths: List[PluginPath] = list(paths or [])
        self._classes: Dict[str, type] = {}

    def resolve(self, name: str) -> type:
        """The Plugin class for a monitor type, raising ValueError with the reason when there is none."""
        if name in self._classes:
            return self._classes[name]
        if not name or not str(name).isidentifier():
            raise ValueError(f"plugin type {name!r} is not a valid module name")
        cls = self._load(name)
        self._classes[name] = cls
        return cls

    def _load(self, name: str) -> type:
        external = self._find_external(name)
        builtin = _builtin_exists(name)
        if external is not None and builtin:
            path, file = external
            if path.override:
                log.warning(f"plugin type {name!r}: {file} overrides X-Monitor's built-in plugin")
                return self._import_external(name, file)
            log.warning(f"plugin type {name!r}: {file} is shadowed by X-Monitor's built-in plugin and ignored; "
                        f"give its plugin_paths entry `override: true` to use it instead")
        if builtin:
            module_path = f"{BUILTIN_PACKAGE}.{name}"
            return _plugin_class(importlib.import_module(module_path), module_path)
        if external is not None:
            return self._import_external(name, external[1])
        searched = ', '.join(str(p.directory) for p in self.paths) or 'none configured'
        raise ValueError(f"no plugin type {name!r}: it is not one of X-Monitor's plugins and is not in "
                         f"plugin_paths ({searched})")

    def _find_external(self, name: str):
        for path in self.paths:
            file = _external_file(path.directory, name)
            if file is not None:
                return path, file
        return None

    @staticmethod
    def _import_external(name: str, file: Path) -> type:
        """Import an external plugin module fresh under x_monitor_external, so a reload picks up an edited file."""
        _ensure_external_package()
        module_path = f"{EXTERNAL_PACKAGE}.{name}"
        search = [str(file.parent)] if file.name == '__init__.py' else None
        spec = importlib.util.spec_from_file_location(module_path, file, submodule_search_locations=search)
        if spec is None or spec.loader is None:
            raise ValueError(f"cannot import plugin type {name!r} from {file}")
        module = importlib.util.module_from_spec(spec)
        previous = sys.modules.get(module_path)
        for loaded in [m for m in sys.modules if m.startswith(module_path + '.')]:
            del sys.modules[loaded]
        sys.modules[module_path] = module
        try:
            spec.loader.exec_module(module)
        except Exception as e:
            if previous is not None:
                sys.modules[module_path] = previous
            else:
                sys.modules.pop(module_path, None)
            raise ValueError(f"plugin type {name!r} from {file} failed to import: {type(e).__name__}: {e}") from e
        return _plugin_class(module, module_path)
