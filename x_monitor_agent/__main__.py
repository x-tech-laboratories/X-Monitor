"""x-monitor-agent entry point."""

import argparse
import asyncio
import logging

from x_monitor_agent.client import AgentClient
from x_monitor_agent.config import AgentConfig


def main() -> None:
    """Parse the command line and run the agent's connection loop."""
    parser = argparse.ArgumentParser(
        prog="x-monitor-agent",
        description="X-Monitor agent — connects outward to a X-Monitor server and "
                    "serves it commands and live events.",
    )
    parser.add_argument("--config", help="Path to the agent config file")
    parser.add_argument("--verbose", action="store_true", help="Log every frame handled")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    config = AgentConfig.load(args.config)
    client = AgentClient(config.url, config.agent_id, config.key, config.hostname,
                         notify_only=config.notify_only, state_dir=config.state_dir)
    try:
        asyncio.run(client.run_forever())
    except KeyboardInterrupt:
        logging.info("x-monitor-agent stopped")


if __name__ == "__main__":
    main()
