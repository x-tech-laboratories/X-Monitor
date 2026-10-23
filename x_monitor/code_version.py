"""A fingerprint of the X-Monitor code a process runs, so the server and an agent can tell whether they run the same plugins."""

import hashlib
from functools import lru_cache
from pathlib import Path

_PACKAGES = ('x_monitor', 'x_monitor_agent')


@lru_cache(maxsize=1)
def code_version() -> str:
    """A short hash over every Python source file of both packages, equal on two hosts exactly when they run the same code."""
    root = Path(__file__).resolve().parent.parent
    digest = hashlib.sha256()
    for package in _PACKAGES:
        for path in sorted((root / package).rglob('*.py')):
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()[:16]
