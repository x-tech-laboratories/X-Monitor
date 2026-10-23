"""Agent configuration.

A deliberately small YAML file — the agent's job is to connect and obey, so
everything about *what* to watch comes from the server's subscription frames
rather than from local config. That keeps a fleet of agents identical and
means adding a monitor never requires touching the monitored host.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from x_monitor_agent import keys

DEFAULT_PATH = "/etc/x-monitor-agent.yaml"


def _read_key(key_file: str) -> Ed25519PrivateKey:
    """Load the agent's private key. An unreadable or wrong key is a hard
    failure rather than a silent fall-through to no key, which would otherwise
    show up as a confusing authentication rejection at the server."""
    try:
        return keys.load_private_key(key_file)
    except (OSError, ValueError, TypeError) as e:
        raise SystemExit(f"x-monitor-agent: could not load key_file {key_file}: {e}")


@dataclass
class AgentConfig:
    url: str
    """The server's agent endpoint, e.g. ws://x-monitor.lan:8080/api/agent/ws
    (or wss:// when the dashboard is behind TLS)."""
    agent_id: str
    """Must match an `id` in the server's `agents:` list."""
    key: Ed25519PrivateKey
    """The private half of the key pair whose public half the server lists for this `id`."""
    hostname: Optional[str] = None
    notify_only: bool = False
    """Refuse commands and event streams, and only show desktop notifications."""
    state_dir: Optional[str] = None
    """Where the agent keeps the monitors it runs itself and the records it has not synced yet."""

    @staticmethod
    def load(path: Optional[str] = None) -> "AgentConfig":
        """Read the config file, letting XMONITOR_AGENT_* environment variables
        override any field, so a container or a systemd unit can point at its
        key without a config file."""
        import yaml

        data = {}
        config_path = Path(path or os.environ.get('XMONITOR_AGENT_CONFIG', DEFAULT_PATH))
        if config_path.exists():
            try:
                loaded = yaml.safe_load(config_path.read_text(encoding='utf-8'))
                data = loaded if isinstance(loaded, dict) else {}
            except (OSError, yaml.YAMLError) as e:
                logging.error(f"could not read {config_path}: {e}")
        elif path:
            raise SystemExit(f"x-monitor-agent: config file not found: {config_path}")

        url = os.environ.get('XMONITOR_AGENT_URL') or data.get('url')
        agent_id = os.environ.get('XMONITOR_AGENT_ID') or data.get('id')
        key_file = os.environ.get('XMONITOR_AGENT_KEY_FILE') or data.get('key_file')
        hostname = os.environ.get('XMONITOR_AGENT_HOSTNAME') or data.get('hostname')
        notify_only = os.environ.get('XMONITOR_AGENT_NOTIFY_ONLY', data.get('notify_only', False))
        state_dir = os.environ.get('XMONITOR_AGENT_STATE_DIR') or data.get('state_dir')
        if isinstance(notify_only, str):
            notify_only = notify_only.strip().lower() in ('1', 'true', 'yes', 'on')

        missing = [n for n, v in (('url', url), ('id', agent_id), ('key_file', key_file)) if not v]
        if missing:
            raise SystemExit(
                f"x-monitor-agent: missing required setting(s): {', '.join(missing)} "
                f"(set them in {config_path} or as XMONITOR_AGENT_* environment variables)"
            )
        return AgentConfig(str(url), str(agent_id), _read_key(str(key_file)),
                           str(hostname) if hostname else None, bool(notify_only),
                           str(state_dir) if state_dir else None)
