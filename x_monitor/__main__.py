"""X-Monitor entry point.

Builds the Coordination Engine (``XMonitorEngine``), loads plugins, configures
the theme, and hands off to the UI Engine (``init_gui``), which registers the
engine's polling loop as a NiceGUI startup hook so collection and the web
dashboard share one asyncio event loop.

``XMonitorEngine`` lives in ``x_monitor.core.coordination.engine``; it is re-exported
here so ``x_monitor.__main__.XMonitorEngine`` remains a stable import/patch target.
"""

import argparse
import logging
from x_monitor.core.coordination.engine import XMonitorEngine
import x_monitor.core.ui.theme as theme
from x_monitor.core.ui.main_dashboard import init_gui

__all__ = ["XMonitorEngine", "main"]


def main():
    """Parse the command line and start the X-Monitor server."""
    parser = argparse.ArgumentParser(description="X-Monitor")
    parser.add_argument("--config", default="config.yaml", help="Path to config file")
    parser.add_argument(
        "--db", help="Path to the SQLite database file (overrides config)"
    )
    parser.add_argument(
        "--port", type=int, default=8080, help="Port for the web dashboard / GUI"
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    engine = XMonitorEngine(args.config, db_path_override=args.db)
    engine.setup_modules()
    theme.configure(engine.config_loader.theme_settings)
    init_gui(engine=engine, port=args.port)


if __name__ == "__main__":
    main()
