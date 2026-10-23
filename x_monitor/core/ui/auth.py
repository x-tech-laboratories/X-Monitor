"""Session-cookie authentication for the dashboard and API.

A browser signs in once at ``/login`` (see ``core/ui/login.py``) and is issued
a signed, expiring cookie; every later request carries it and no credential
prompt appears again. Machine callers — Prometheus scraping ``/metrics``, a
script hitting ``/api/...`` — cannot follow a form redirect, so they may still
present HTTP Basic credentials instead, or better a named API token from
``auth.tokens`` (see ``core/ui/tokens.py``) as ``Authorization: Bearer``. Any
one of an intact session cookie, a valid Basic header, or a token whose scope
covers the route lets a request through; a token never opens the dashboard.

The cookie is a self-contained token, ``v1.<payload>.<hmac>``, signed with a
key from ``auth.session_secret``/``session_secret_file`` or generated at
startup. Nothing about a session is stored server-side, so a restart without a
configured key invalidates every outstanding session.

This is a ``BaseHTTPMiddleware``, which Starlette runs for ``http`` scopes
only: the agent WebSocket (``/api/agent/ws``) and NiceGUI's own socket are not
covered, and the agent endpoint authenticates itself.
"""

import base64
import hmac
import json
import logging
import secrets
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from x_monitor.core.ui.tokens import TokenRegistry, bearer_token, build_tokens

COOKIE_NAME = 'x_monitor_session'
CSRF_COOKIE_NAME = 'x_monitor_csrf'
LOGIN_PATH = '/login'
LOGOUT_PATH = '/logout'

DEFAULT_SESSION_HOURS = 12
DEFAULT_REMEMBER_DAYS = 30

# Reachable without a session: the sign-in flow itself, the icon the login page
# draws, and the push endpoint, which checks its own per-monitor or push token.
_PUBLIC_PATHS = frozenset({LOGIN_PATH, LOGOUT_PATH, '/icon.svg', '/favicon.ico'})
_PUBLIC_PREFIXES = ('/api/push/',)

# Paths a script or scraper calls; these answer 401 rather than redirecting to
# a page the caller cannot render.
_MACHINE_PREFIXES = ('/api/', '/metrics')


@dataclass(frozen=True)
class AuthConfig:
    """The resolved ``auth:`` block: one operator account and its session policy."""

    username: str
    password: str
    secret: bytes
    session_seconds: int
    remember_seconds: int


def _read_value(settings: Dict[str, Any], key: str) -> Optional[str]:
    """Read ``key`` from the auth block, or ``<key>_file``'s stripped contents."""
    if key in settings and settings[key] is not None:
        return str(settings[key])
    path = settings.get(f'{key}_file')
    if not path:
        return None
    try:
        return Path(path).read_text(encoding='utf-8').strip()
    except OSError as e:
        logging.error(f"auth: could not read {key}_file {path}: {e}")
        return None


def _read_int(settings: Dict[str, Any], key: str, default: int) -> int:
    raw = settings.get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logging.warning(f"auth: invalid {key}={raw!r}; falling back to {default}")
        return default
    if value <= 0:
        logging.warning(f"auth: {key} must be positive (got {value}); falling back to {default}")
        return default
    return value


def build_config(auth_settings: Dict[str, Any]) -> Optional[AuthConfig]:
    """Resolve the ``auth:`` block, or None when auth is off or half-configured."""
    settings = auth_settings or {}
    username = _read_value(settings, 'username')
    password = _read_value(settings, 'password')

    if not username and not password:
        return None
    if not username or not password:
        logging.error(
            "auth: both 'username' and 'password'/'password_file' must be set — "
            "auth NOT enabled, dashboard and API are unauthenticated."
        )
        return None

    secret = _read_value(settings, 'session_secret')
    if not secret:
        secret = secrets.token_urlsafe(32)
        logging.info(
            "auth: no session_secret configured — generating one per start, so "
            "restarting X-Monitor signs everyone out."
        )

    return AuthConfig(
        username=username,
        password=password,
        secret=secret.encode('utf-8'),
        session_seconds=_read_int(settings, 'session_hours', DEFAULT_SESSION_HOURS) * 3600,
        remember_seconds=_read_int(settings, 'remember_days', DEFAULT_REMEMBER_DAYS) * 86400,
    )


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _sign(payload: str, secret: bytes) -> str:
    return _b64(hmac.new(secret, payload.encode('ascii'), sha256).digest())


def encode_next(path: str) -> str:
    """Wrap a post-login destination into one opaque, URL-safe query value."""
    return _b64(path.encode('utf-8'))


def decode_next(token: Optional[str]) -> str:
    """Unwrap a destination, falling back to the dashboard root for anything
    that is not a plain path on this host — an open redirect from the one page
    an unauthenticated visitor can reach would be a phishing lever."""
    if not token:
        return '/'
    try:
        target = _unb64(token).decode('utf-8')
    except (ValueError, UnicodeDecodeError):
        return '/'
    if not target.startswith('/') or target.startswith('//'):
        return '/'
    return target


def issue_session(config: AuthConfig, remember: bool) -> Tuple[str, int]:
    """Mint a signed session token and the seconds it stays valid for."""
    lifetime = config.remember_seconds if remember else config.session_seconds
    payload = _b64(json.dumps(
        {'u': config.username, 'exp': int(time.time()) + lifetime}, separators=(',', ':'),
    ).encode('utf-8'))
    return f"v1.{payload}.{_sign(payload, config.secret)}", lifetime


def read_session(token: Optional[str], config: AuthConfig) -> Optional[str]:
    """The username carried by a valid, unexpired token, else None."""
    if not token:
        return None
    version, _, rest = token.partition('.')
    payload, _, signature = rest.partition('.')
    if version != 'v1' or not payload or not signature:
        return None
    if not hmac.compare_digest(signature, _sign(payload, config.secret)):
        return None
    try:
        claims = json.loads(_unb64(payload))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(claims, dict) or float(claims.get('exp', 0)) < time.time():
        return None
    username = claims.get('u')
    # A token signed for a since-renamed account must not keep working.
    if not isinstance(username, str) or not hmac.compare_digest(username, config.username):
        return None
    return username


def check_credentials(config: AuthConfig, username: str, password: str) -> bool:
    """Constant-time comparison of a submitted username/password pair."""
    return (
        hmac.compare_digest(username, config.username)
        and hmac.compare_digest(password, config.password)
    )


def _check_basic(header_value: str, config: AuthConfig) -> bool:
    scheme, _, encoded = header_value.partition(' ')
    if scheme.lower() != 'basic' or not encoded:
        return False
    try:
        decoded = _b64_decode_basic(encoded)
    except (ValueError, UnicodeDecodeError):
        return False
    username, _, password = decoded.partition(':')
    return check_credentials(config, username, password)


def _b64_decode_basic(encoded: str) -> str:
    return base64.b64decode(encoded, validate=True).decode('utf-8')


def is_secure(request: Request) -> bool:
    """Whether the client reached X-Monitor over TLS, honouring a reverse proxy."""
    forwarded = request.headers.get('x-forwarded-proto', '')
    return request.url.scheme == 'https' or forwarded.split(',')[0].strip() == 'https'


def set_session_cookie(response: Response, token: str, max_age: Optional[int],
                       secure: bool) -> None:
    """Attach the session cookie; ``max_age`` None makes it last the browser session."""
    response.set_cookie(
        COOKIE_NAME, token, max_age=max_age, path='/',
        httponly=True, samesite='lax', secure=secure,
    )


def clear_session_cookie(response: Response) -> None:
    """Expire the session cookie, ending the session on this browser."""
    response.delete_cookie(COOKIE_NAME, path='/')


def _is_public(path: str) -> bool:
    return path in _PUBLIC_PATHS or path.startswith(_PUBLIC_PREFIXES)


def _wants_page(request: Request) -> bool:
    """Whether to redirect to the login page rather than answer 401."""
    if request.url.path.startswith(_MACHINE_PREFIXES):
        return False
    if request.method not in ('GET', 'HEAD'):
        return False
    return 'text/html' in request.headers.get('accept', '')


def acting_client(request: Request) -> Optional[str]:
    """Who made this request, for the audit trail: an account name, ``token '<name>'``, or None."""
    return getattr(request.state, 'x_monitor_client', None)


def _unauthorized() -> Response:
    # No WWW-Authenticate: a browser must land on X-Monitor's own login page,
    # not the native credential dialog this replaced.
    return JSONResponse({'error': 'authentication required'}, status_code=401)


class SessionAuthMiddleware(BaseHTTPMiddleware):
    """Gate every route on a session cookie, an API token, or Basic credentials for scripts."""

    def __init__(self, app: Any, config: AuthConfig, tokens: Optional[TokenRegistry] = None):
        super().__init__(app)
        self._config = config
        self._tokens = tokens or TokenRegistry()

    async def dispatch(self, request: Request, call_next):
        if _is_public(request.url.path):
            return await call_next(request)

        username = read_session(request.cookies.get(COOKIE_NAME), self._config)
        if username:
            request.state.x_monitor_client = username
            return await call_next(request)

        credentials = request.headers.get('authorization')
        presented = bearer_token(credentials)
        if presented is not None:
            return await self._dispatch_token(request, call_next, presented)

        if credentials and _check_basic(credentials, self._config):
            request.state.x_monitor_client = self._config.username
            return await call_next(request)

        if _wants_page(request):
            target = request.url.path
            if request.url.query:
                target = f"{target}?{request.url.query}"
            return RedirectResponse(f"{LOGIN_PATH}?next={encode_next(target)}", status_code=303)

        return _unauthorized()

    async def _dispatch_token(self, request: Request, call_next, presented: str):
        """Let a bearer token through to the API routes its scope covers, and nowhere else."""
        method, path = request.method, request.url.path
        token = self._tokens.match(presented)
        if token is None:
            logging.warning(f"auth: rejected an unknown API token for {method} {path}")
            return _unauthorized()
        if not token.allows_request(method, path):
            logging.warning(f"auth: token {token.name!r} ({token.scope}) refused {method} {path}")
            return JSONResponse({'error': f"token '{token.name}' may not {method} {path}"},
                                status_code=403)
        request.state.x_monitor_client = f"token '{token.name}'"
        # Reads are logged quietly, since a scraper makes one every few seconds.
        level = logging.DEBUG if method in ('GET', 'HEAD') else logging.INFO
        logging.log(level, f"auth: token {token.name!r} {method} {path}")
        return await call_next(request)


def register_auth(app: Any, auth_settings: Dict[str, Any],
                  tokens: Optional[TokenRegistry] = None) -> Optional[AuthConfig]:
    """Install the login routes and session gate when credentials are configured."""
    if tokens is None:
        tokens = build_tokens(auth_settings)
    config = build_config(auth_settings)
    if config is None:
        if any(t.scope != 'push' for t in tokens):
            logging.warning(
                "auth: read and control tokens have no effect without auth.username "
                "and auth.password — the dashboard and API are open to anyone."
            )
        return None

    from x_monitor.core.ui.login import register_login_routes
    register_login_routes(app, config)
    app.add_middleware(SessionAuthMiddleware, config=config, tokens=tokens)
    logging.info(f"auth: session login enabled for the dashboard and API, with {len(tokens)} API token(s)")
    return config
