"""The monitor graph: monitors and groups form a DAG, shown through one or more views.

A monitor is defined once, under the group its config nests it in. Any other
group, or a view's top level, can also hold it through a link — a `ref:` entry
naming its id — so one monitor can sit under several parents. Each view is a
separate set of roots over the same monitors, so the dashboard can show the
same fleet as host → domain and as domain → host. A link may carry its own
`name`, which labels that edge only: the monitor keeps its id, status and page.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set

# ----------------------------------------------------------------------
# Graph pieces
# ----------------------------------------------------------------------

@dataclass
class Link:
    """A placeholder for a `ref:` entry, replaced by the monitor it names once every view has loaded."""
    ref: str
    label: Optional[str] = None
    children: tuple = ()


@dataclass
class View:
    """One named way of arranging the monitors: its own roots, which may define monitors or link to them."""
    name: str
    children: List[Any] = field(default_factory=list)
    links: Dict[str, Optional[str]] = field(default_factory=dict)


def child_label(parent: Any, child: Any) -> str:
    """The name a child shows under this parent: the link's own label, or the monitor's name."""
    links = getattr(parent, 'links', None) or {}
    return links.get(child.id) or child.name


def is_link(parent: Any, child: Any) -> bool:
    """True when the child sits under this parent through a link rather than its own definition."""
    return child.id in (getattr(parent, 'links', None) or {})


# ----------------------------------------------------------------------
# Walking
# ----------------------------------------------------------------------

def iter_monitors(roots: Iterable[Any]) -> Iterator[Any]:
    """Every monitor reachable from these roots once each, parents before children, in config order."""
    seen: Set[int] = set()

    def walk(plugins: Iterable[Any]) -> Iterator[Any]:
        for plugin in plugins:
            if id(plugin) in seen:
                continue
            seen.add(id(plugin))
            yield plugin
            yield from walk(plugin.children)

    yield from walk(roots)


def view_roots(engine: Any) -> List[Any]:
    """The roots of every view, the primary view first, for walks that must reach every monitor."""
    views = getattr(engine, 'views', None)
    if not isinstance(views, list) or not views:
        return list(engine.plugins)
    return [root for view in views for root in view.children]


def all_monitors(engine: Any) -> List[Any]:
    """Every monitor in every view, once each."""
    return list(iter_monitors(view_roots(engine)))


def find_monitor(engine: Any, monitor_id: str) -> Optional[Any]:
    """The monitor with this id in any view, or None."""
    return next((p for p in iter_monitors(view_roots(engine)) if p.id == monitor_id), None)


def parent_ids(roots: Iterable[Any]) -> Dict[str, Set[str]]:
    """Each monitor's id mapped to the ids of every group it sits directly under, through a definition or a link."""
    parents: Dict[str, Set[str]] = {}
    for plugin in iter_monitors(roots):
        for child in plugin.children:
            parents.setdefault(child.id, set()).add(plugin.id)
    return parents


# ----------------------------------------------------------------------
# Resolving links
# ----------------------------------------------------------------------

def _definitions(views: List[View]) -> List[Any]:
    """Every monitor defined in any view, reached through definitions only, once each."""
    found: List[Any] = []
    seen: Set[int] = set()
    stack = [c for view in reversed(views) for c in reversed(view.children)]
    while stack:
        plugin = stack.pop()
        if isinstance(plugin, Link) or id(plugin) in seen:
            continue
        seen.add(id(plugin))
        found.append(plugin)
        stack.extend(reversed(plugin.children))
    return found


def _reaches(start: Any, goal: Any) -> bool:
    """True when goal is start itself or sits anywhere beneath it."""
    stack, seen = [start], set()
    while stack:
        node = stack.pop()
        if node is goal:
            return True
        if id(node) in seen:
            continue
        seen.add(id(node))
        stack.extend(c for c in node.children if not isinstance(c, Link))
    return False


def _resolve_owner(owner: Any, registry: Dict[str, Any], where: str) -> None:
    """Swap each Link under this owner for the monitor it names, dropping a link to an unknown id or one that makes a cycle."""
    resolved = []
    for position, child in enumerate(owner.children):
        if not isinstance(child, Link):
            resolved.append(child)
            continue
        target = registry.get(child.ref)
        if target is None:
            logging.error(f"{where}: link to unknown monitor id {child.ref!r} ignored")
        elif not isinstance(owner, View) and _reaches(target, owner):
            logging.error(f"{where}: link to {child.ref!r} would make a cycle and is ignored")
        else:
            resolved.append(target)
            owner.links[target.id] = child.label
        # Later links' cycle checks must see the links accepted so far.
        owner.children = resolved + list(owner.children[position + 1:])
    owner.children = resolved


def resolve_links(views: List[View]) -> None:
    """Replace every link in every view with the monitor it names, keeping each view acyclic."""
    definitions = _definitions(views)
    registry: Dict[str, Any] = {}
    for plugin in definitions:
        registry.setdefault(plugin.id, plugin)
    for owner in [*views, *definitions]:
        if any(isinstance(c, Link) for c in owner.children):
            where = f"view {owner.name!r}" if isinstance(owner, View) else f"group {owner.id!r}"
            _resolve_owner(owner, registry, where)
