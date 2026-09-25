"""Named API tokens: one bearer credential per client, each with a scope.

Every entry in ``auth.tokens`` names a client (a Prometheus scraper, a CI job,
a backup script) and grants it one scope:

- ``read``: ``GET``/``HEAD`` on ``/api/...`` and ``/metrics``.
- ``control``: everything ``read`` allows, plus the API's write routes (poll
  now, run an action, send a test notification).
- ``push``: the push endpoint, for every push monitor or only those listed
  under ``monitors``.

A client sends ``Authorization: Bearer <token>``. Only a SHA-256 digest of each
token is kept, and a presented token is matched by comparing its digest
against every configured one in constant time. The tokens are 256-bit random
values, so a fast unsalted hash is enough: there is no dictionary to guess
from, and a slow KDF would only cost every scrape and API call.
"""

import hmac
import json
import logging
import re
import secrets
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, FrozenSet, Iterable, List, Optional

SCOPES = ('read', 'control', 'push')
TOKEN_PREFIX = 'vgl_'
HASH_PREFIX = 'sha256:'

# A shorter plaintext token is refused, since its digest could be brute-forced.
MIN_TOKEN_LENGTH = 16

# The routes a read or control token may reach; the dashboard is never among them.
API_PREFIXES = ('/api/', '/metrics')
PUSH_PREFIX = '/api/push/'

_HEX_DIGEST = re.compile(r'[0-9a-f]{64}')


@dataclass(frozen=True)
class ApiToken:
    """One configured client: its name, the digest of its secret, and what it may do."""

    name: str
    digest: bytes
    scope: str
    monitors: Optional[FrozenSet[str]] = None

    def allows_request(self, method: str, path: str) -> bool:
        """Whether this token may make an API request with this method and path."""
        if not path.startswith(API_PREFIXES) or path.startswith(PUSH_PREFIX):
            return False
        if self.scope == 'control':
            return True
        return self.scope == 'read' and method in ('GET', 'HEAD')

    def covers_monitor(self, monitor_id: str) -> bool:
        """Whether this token may push heartbeats for this monitor."""
        if self.scope != 'push':
            return False
        return self.monitors is None or monitor_id in self.monitors


def new_token() -> str:
    """A fresh random token, prefixed so a secret scanner can recognise a leaked one."""
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """The ``token_hash`` value to put in config for this token."""
    return HASH_PREFIX + sha256(token.encode('utf-8')).hexdigest()


def bearer_token(header_value: Optional[str]) -> Optional[str]:
    """The token in an ``Authorization: Bearer`` header, or None for any other header."""
    if not header_value:
        return None
    scheme, _, token = header_value.partition(' ')
    token = token.strip()
    if scheme.lower() != 'bearer' or not token:
        return None
    return token


class TokenRegistry:
    """The configured tokens, looked up by the secret a client presents."""

    def __init__(self, tokens: Iterable[ApiToken] = ()):
        self._tokens = list(tokens)

    def __len__(self) -> int:
        return len(self._tokens)

    def __iter__(self):
        return iter(self._tokens)

    def match(self, presented: Optional[str]) -> Optional[ApiToken]:
        """The token whose digest matches ``presented``, checking all of them so timing reveals nothing."""
        if not presented:
            return None
        digest = sha256(presented.encode('utf-8')).digest()
        found = None
        for token in self._tokens:
            if hmac.compare_digest(digest, token.digest) and found is None:
                found = token
        return found


def _read_secret(entry: Dict[str, Any], name: str) -> Optional[str]:
    """The plaintext token from ``token`` or ``token_file``, or None when neither is set."""
    if entry.get('token') is not None:
        logging.warning(
            f"auth: token {name!r} is written in plaintext in the config; "
            f"use token_hash (from 'vigil token new') or token_file instead."
        )
        return str(entry['token'])
    path = entry.get('token_file')
    if not path:
        return None
    try:
        return Path(path).read_text(encoding='utf-8').strip()
    except OSError as e:
        logging.error(f"auth: could not read token_file {path} for token {name!r}: {e}")
        return None


def _parse_digest(value: Any) -> Optional[bytes]:
    """The raw digest from a ``token_hash`` of the form ``sha256:<64 hex digits>``."""
    text = str(value).strip().lower()
    if text.startswith(HASH_PREFIX):
        text = text[len(HASH_PREFIX):]
    if not _HEX_DIGEST.fullmatch(text):
        return None
    return bytes.fromhex(text)


def _digest_for(entry: Dict[str, Any], name: str) -> Optional[bytes]:
    """The digest an entry is matched against, from whichever of its three forms is set."""
    if entry.get('token_hash') is not None:
        digest = _parse_digest(entry['token_hash'])
        if digest is None:
            logging.error(f"auth: token {name!r} has a malformed token_hash; expected sha256:<64 hex digits>")
        return digest
    secret = _read_secret(entry, name)
    if secret is None:
        logging.error(f"auth: token {name!r} needs token_hash, token_file or token")
        return None
    if len(secret) < MIN_TOKEN_LENGTH:
        logging.error(f"auth: token {name!r} is shorter than {MIN_TOKEN_LENGTH} characters")
        return None
    return sha256(secret.encode('utf-8')).digest()


def _monitors_for(entry: Dict[str, Any], name: str, scope: str) -> Optional[FrozenSet[str]]:
    """The monitor ids a push token is limited to, or None for all of them."""
    monitors = entry.get('monitors')
    if monitors is None:
        return None
    if scope != 'push':
        logging.warning(f"auth: token {name!r} lists monitors, which only a push token uses; ignoring them")
        return None
    if isinstance(monitors, str):
        monitors = [monitors]
    return frozenset(str(m) for m in monitors)


def _build_token(entry: Any, seen_names: set, seen_digests: set) -> Optional[ApiToken]:
    """One validated token, or None after logging why the entry was skipped."""
    if not isinstance(entry, dict):
        logging.error(f"auth: each entry in auth.tokens must be a mapping, got {entry!r}")
        return None
    name = str(entry.get('name') or '').strip()
    if not name:
        logging.error("auth: an auth.tokens entry has no name; skipping it")
        return None
    if name in seen_names:
        logging.error(f"auth: token name {name!r} is used twice; skipping the second")
        return None
    scope = str(entry.get('scope') or '').strip()
    if scope not in SCOPES:
        logging.error(f"auth: token {name!r} has scope {scope!r}; expected one of {', '.join(SCOPES)}")
        return None
    digest = _digest_for(entry, name)
    if digest is None:
        return None
    if digest in seen_digests:
        logging.error(f"auth: token {name!r} has the same secret as another token; skipping it")
        return None
    seen_names.add(name)
    seen_digests.add(digest)
    return ApiToken(name=name, digest=digest, scope=scope,
                    monitors=_monitors_for(entry, name, scope))


def build_tokens(auth_settings: Optional[Dict[str, Any]]) -> TokenRegistry:
    """Resolve ``auth.tokens``, skipping (and logging) any entry that is not usable."""
    entries = (auth_settings or {}).get('tokens') or []
    if not isinstance(entries, list):
        logging.error("auth: auth.tokens must be a list; no API tokens are enabled")
        return TokenRegistry()
    seen_names: set = set()
    seen_digests: set = set()
    tokens: List[ApiToken] = []
    for entry in entries:
        token = _build_token(entry, seen_names, seen_digests)
        if token is not None:
            tokens.append(token)
    return TokenRegistry(tokens)


def config_snippet(name: str, token_hash: str, scope: str,
                   monitors: Optional[List[str]] = None) -> str:
    """The ``auth.tokens`` entry to paste into config.yaml for a minted token."""
    lines = [
        'auth:',
        '  tokens:',
        f'    - name: {json.dumps(name)}',
        f'      scope: {scope}',
        f'      token_hash: {json.dumps(token_hash)}',
    ]
    # JSON strings and lists are valid YAML, so this quotes any name safely.
    if monitors:
        lines.append(f'      monitors: {json.dumps(list(monitors))}')
    return '\n'.join(lines)
