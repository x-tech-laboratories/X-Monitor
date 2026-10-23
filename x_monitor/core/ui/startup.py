"""The answer every HTTP request gets while the engine is still loading its saved state, in place of a proxy's Bad Gateway."""

from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import HTMLResponse, JSONResponse

# Seconds a browser or client waits before asking again.
RETRY_AFTER = 5

_PASS_THROUGH = ('/_nicegui', '/icon.svg')
_MACHINE_PATHS = ('/api/', '/metrics')

_TOKENS_CSS = (Path(__file__).parent / 'static' / 'halon-tokens.css').read_text()

# Plain HTML, since nothing behind the dashboard is up yet; the colors come from the same Halon token sheet.
STARTING_PAGE = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="{RETRY_AFTER}">
<title>X-Monitor starting</title>
<link rel="icon" href="/icon.svg">
<style>
{_TOKENS_CSS}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: var(--space-6);
         background: var(--surface-root); color: var(--text-body);
         font-family: var(--font-family-interface); font-size: var(--text-prose); line-height: var(--line-height-body); }}
  main {{ max-width: 28rem; text-align: center; }}
  img {{ display: block; margin: 0 auto var(--space-5); }}
  h1 {{ font-size: var(--text-h2); font-weight: 600; color: var(--text-heading); margin: 0 0 var(--space-4); }}
  p {{ margin: 0; color: var(--text-secondary); }}
</style>
</head>
<body>
<main>
<img src="/icon.svg" alt="" width="64" height="64">
<h1>X-Monitor is starting</h1>
<p>Loading saved history. This page reloads by itself.</p>
</main>
</body>
</html>
"""


class StartingUpMiddleware(BaseHTTPMiddleware):
    """Answers 503 until `engine.ready`: a page that reloads itself for browsers, JSON for the API and exporters."""

    def __init__(self, app, engine):
        super().__init__(app)
        self.engine = engine

    async def dispatch(self, request, call_next):
        path = request.url.path
        if self.engine.ready or path.startswith(_PASS_THROUGH):
            return await call_next(request)
        headers = {'Retry-After': str(RETRY_AFTER)}
        if path.startswith(_MACHINE_PATHS):
            return JSONResponse({'status': 'starting'}, status_code=503, headers=headers)
        return HTMLResponse(STARTING_PAGE, status_code=503, headers=headers)
