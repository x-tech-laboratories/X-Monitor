"""Agent authentication by ed25519 key.

The agent holds a private key and the server holds only the matching public
key, so the server keeps no secret that could impersonate an agent. On each
connection the server sends a fresh random nonce, the agent signs it, and the
server checks the signature. The signed message names its purpose and the
agent's id, so a signature made for anything else never verifies here.
"""

import base64
import binascii
import secrets
from pathlib import Path
from typing import Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_ssh_private_key, load_ssh_public_key

NONCE_BYTES = 32

# Keeps the project's former name, because changing it locks out every agent not yet redeployed.
_DOMAIN = b"vigil-agent-auth-v1\0"


def new_nonce() -> str:
    """A fresh random nonce, base64-encoded for the challenge frame."""
    return base64.b64encode(secrets.token_bytes(NONCE_BYTES)).decode('ascii')


def _message(agent_id: str, nonce: str) -> bytes:
    """The exact bytes an agent signs for one challenge."""
    return _DOMAIN + agent_id.encode('utf-8') + b"\0" + base64.b64decode(nonce, validate=True)


def load_private_key(path: str) -> Ed25519PrivateKey:
    """Read an unencrypted OpenSSH ed25519 private key, as `ssh-keygen -t ed25519 -N ""` writes."""
    key = load_ssh_private_key(Path(path).read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError(f"{path} is not an ed25519 key")
    return key


def load_public_key(line: str) -> Ed25519PublicKey:
    """Parse a one-line OpenSSH ed25519 public key, such as `ssh-ed25519 AAAA... comment`."""
    key = load_ssh_public_key(line.strip().encode('utf-8'))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("not an ed25519 public key")
    return key


def sign(key: Ed25519PrivateKey, agent_id: str, nonce: str) -> str:
    """The agent's base64 signature over one challenge."""
    return base64.b64encode(key.sign(_message(agent_id, nonce))).decode('ascii')


def verify(key: Optional[Ed25519PublicKey], agent_id: str, nonce: str, signature: str) -> bool:
    """Whether `signature` is this agent's signature over `nonce`."""
    if key is None or not signature:
        return False
    try:
        key.verify(base64.b64decode(signature, validate=True), _message(agent_id, nonce))
    except (InvalidSignature, binascii.Error, ValueError):
        return False
    return True
