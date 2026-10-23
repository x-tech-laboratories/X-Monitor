"""X-Monitor entry point.

Builds the Coordination Engine (``XMonitorEngine``), loads plugins, configures
the theme, and hands off to the UI Engine (``init_gui``), which registers the
engine's polling loop as a NiceGUI startup hook so collection and the web
dashboard share one asyncio event loop.

``x-monitor token new <name> --scope <scope>`` instead mints an API token for
``auth.tokens`` and exits without starting anything.

``XMonitorEngine`` lives in ``x_monitor.core.coordination.engine``; it is re-exported
here so ``x_monitor.__main__.XMonitorEngine`` remains a stable import/patch target.
"""

import argparse
import logging
import sys
from typing import List, Optional

from x_monitor.core.coordination.engine import XMonitorEngine
import x_monitor.core.ui.theme as theme
from x_monitor.core.ui.main_dashboard import init_gui
from x_monitor.core.ui.tokens import SCOPES, config_snippet, hash_token, new_token

__all__ = ["XMonitorEngine", "main"]


def _token_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="x-monitor token", description="Manage API tokens")
    commands = parser.add_subparsers(dest="action", required=True)
    mint = commands.add_parser("new", help="Mint a token and print the config entry for it")
    mint.add_argument("name", help="Who the token is for, shown in the audit log")
    mint.add_argument("--scope", choices=SCOPES, required=True, help="What the token may do")
    mint.add_argument(
        "--monitor", dest="monitors", action="append", metavar="ID",
        help="Limit a push token to this monitor id; repeat for more (default: every push monitor)",
    )
    return parser


def token_command(argv: List[str]) -> int:
    """Run ``x-monitor token ...``; prints a new token once, with the hash to configure."""
    parser = _token_parser()
    args = parser.parse_args(argv)
    if args.monitors and args.scope != "push":
        parser.error("--monitor only applies to --scope push")
    token = new_token()
    print(f"Token for {args.name} (shown once; X-Monitor keeps only its hash):\n\n  {token}\n")
    print("Add this to config.yaml:\n")
    print(config_snippet(args.name, hash_token(token), args.scope, args.monitors))
    return 0


def main(argv: Optional[List[str]] = None):
    """Parse the command line and start the X-Monitor server, or run a subcommand."""
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["token"]:
        sys.exit(token_command(argv[1:]))

    parser = argparse.ArgumentParser(
        description="X-Monitor", epilog="Run 'x-monitor token new --help' to mint an API token.",
    )
    parser.add_argument("--config", default="config.yaml", help="Path to config file")
    parser.add_argument(
        "--db", help="Path to the SQLite database file (overrides config)"
    )
    parser.add_argument(
        "--port", type=int, default=8080, help="Port for the web dashboard / GUI"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO)
    engine = XMonitorEngine(args.config, db_path_override=args.db, handle_signals=True)
    engine.setup_modules()
    theme.configure(engine.config_loader.theme_settings)
    init_gui(engine=engine, port=args.port)


if __name__ == "__main__":
    main()
