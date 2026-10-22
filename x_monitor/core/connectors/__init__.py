"""Connector package. The engine itself lives in ``connectors/engine.py``;
these re-exports keep ``from x_monitor.core.connectors import ConnectorEngine``
working. ``ExecContext`` carries whichever transport (SSH or agent) reaches a
plugin's target."""

from x_monitor.core.connectors.engine import ConnectorEngine, ExecContext

__all__ = ["ConnectorEngine", "ExecContext"]
