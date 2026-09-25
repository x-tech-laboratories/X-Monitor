"""HTTP API endpoints: JSON status, control routes, Prometheus scrape and health checks."""
import hmac
import logging
from typing import Any, Optional

from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse

from vigil.core.connectors.types import CollectResult
from vigil.core.exporters import prometheus
from vigil.core.contracts import EngineLike, PushablePlugin
from vigil.core.ui.auth import acting_client
from vigil.core.ui.tokens import TokenRegistry, bearer_token


def _tokens_match(given: str, expected: str) -> bool:
    return hmac.compare_digest(given, expected)


def _flatten(plugins):
    for p in plugins:
        yield p
        yield from _flatten(p.children)


def _by(request: Request) -> str:
    """The audit suffix naming who made a request, empty when auth is off."""
    client = acting_client(request)
    return f" by {client}" if client else ""


def _action_ids(plugin: Any) -> list:
    get_actions = getattr(plugin, 'get_actions', None)
    return [a['action_id'] for a in get_actions()] if callable(get_actions) else []


def _register_notification_routes(app: Any, engine: EngineLike) -> None:
    """Mount the endpoint that sends a test notification through one channel."""
    @app.post('/api/notifications/{channel_id}/test')
    async def notification_test(channel_id: str, request: Request):
        if channel_id not in engine.notifications.channels:
            return JSONResponse({'error': 'no such channel'}, status_code=404)
        logging.info(f"api: test notification through {channel_id!r} requested{_by(request)}")
        # A failed delivery is the answer the caller asked for, not a server error.
        try:
            await engine.notifications.send_test(channel_id)
        except Exception as e:
            return JSONResponse({'sent': False, 'error': str(e)}, status_code=502)
        return JSONResponse({'sent': True})


def _register_control_routes(app: Any, engine: EngineLike) -> None:
    """Mount the routes that do what a monitor page's header buttons do: poll now and run an action."""
    def _find(monitor_id: str):
        return next((p for p in _flatten(engine.plugins) if p.id == monitor_id), None)

    def _audit(plugin: Any, message: str) -> None:
        engine.apply(plugin, CollectResult(logs=[(message, 'INFO')]))

    @app.post('/api/monitors/{monitor_id}/poll')
    async def monitor_poll(monitor_id: str, request: Request):
        plugin = _find(monitor_id)
        if plugin is None:
            return JSONResponse({'error': 'not found'}, status_code=404)
        _audit(plugin, f"Poll requested through the API{_by(request)}")
        return JSONResponse({'polled': bool(await plugin.run_cycle())})

    @app.post('/api/monitors/{monitor_id}/actions/{action_id}')
    async def monitor_action(monitor_id: str, action_id: str, request: Request):
        plugin = _find(monitor_id)
        if plugin is None:
            return JSONResponse({'error': 'not found'}, status_code=404)
        # Only the header's buttons are reachable, never an action that needs a dialog's parameters.
        if action_id not in _action_ids(plugin):
            return JSONResponse({'error': 'no such action'}, status_code=404)
        _audit(plugin, f"Action {action_id!r} requested through the API{_by(request)}")
        try:
            success, content = await plugin.run_action(action_id)
        except Exception as e:
            logging.error(f"api: action {action_id!r} on {monitor_id!r} raised: {e}")
            return JSONResponse({'success': False, 'error': str(e)}, status_code=500)
        return JSONResponse({'success': bool(success), 'content': content})


def _register_push_routes(app: Any, engine: EngineLike, tokens: TokenRegistry) -> None:
    """Mount the push endpoint, reached with a monitor's own token or a push-scoped API token."""
    def _find_pushable(monitor_id: str) -> Optional[PushablePlugin]:
        plugin = next((p for p in _flatten(engine.plugins) if p.id == monitor_id), None)
        return plugin if isinstance(plugin, PushablePlugin) else None

    def _record(plugin: PushablePlugin, status: str, msg: Optional[str],
                value: Optional[float], source: Optional[str] = None):
        if status not in ('up', 'down'):
            return JSONResponse({'error': "status must be 'up' or 'down'"}, status_code=400)
        ok = plugin.record_push(status=status, msg=msg, value=value, source=source)
        return JSONResponse({'success': ok})

    @app.get('/api/push/{monitor_id}/{token}')
    @app.post('/api/push/{monitor_id}/{token}')
    def push(monitor_id: str, token: str, status: str = 'up',
             msg: Optional[str] = None, value: Optional[float] = None):
        plugin = _find_pushable(monitor_id)
        if plugin is None:
            return JSONResponse({'error': 'not found'}, status_code=404)
        if not plugin.token or not _tokens_match(token, plugin.token):
            return JSONResponse({'error': 'invalid token'}, status_code=401)
        return _record(plugin, status, msg, value)

    # A named token travels only in the header, so it never lands in a proxy's access log.
    @app.get('/api/push/{monitor_id}')
    @app.post('/api/push/{monitor_id}')
    def push_with_bearer(monitor_id: str, request: Request, status: str = 'up',
                         msg: Optional[str] = None, value: Optional[float] = None):
        plugin = _find_pushable(monitor_id)
        if plugin is None:
            return JSONResponse({'error': 'not found'}, status_code=404)
        token = tokens.match(bearer_token(request.headers.get('authorization')))
        if token is None:
            return JSONResponse({'error': 'invalid token'}, status_code=401)
        if not token.covers_monitor(monitor_id):
            logging.warning(f"api: token {token.name!r} ({token.scope}) refused a push to {monitor_id!r}")
            return JSONResponse({'error': f"token '{token.name}' may not push to {monitor_id}"},
                                status_code=403)
        return _record(plugin, status, msg, value, source=f"token '{token.name}'")


def register_api(app: Any, engine: EngineLike, tokens: Optional[TokenRegistry] = None) -> None:
    """Mount the JSON status, control, push and Prometheus/health endpoints on the FastAPI app."""
    db = engine.db

    def _monitor_summary(statuses):
        out = []
        for p in _flatten(engine.plugins):
            out.append({
                'id': p.id,
                'name': p.name,
                'type': p.config.get('type'),
                'target': getattr(p, 'target', None),
                'status': statuses.get(p.id, 'unavailable'),
                'is_group': bool(p.children),
            })
        return out

    @app.get('/api/health')
    def health():
        return JSONResponse({'status': 'ok'})

    @app.get('/api/summary')
    def summary():
        """Counts of leaf monitors by status, for a dashboard tile that cannot aggregate a list itself."""
        statuses = db.latest_statuses()
        counts = {'online': 0, 'warning': 0, 'failed': 0, 'offline': 0, 'unavailable': 0}
        for p in _flatten(engine.plugins):
            if p.children:
                continue
            state = statuses.get(p.id, 'unavailable')
            counts[state] = counts.get(state, 0) + 1
        total = sum(counts.values())
        return JSONResponse({'total': total, **counts, 'unhealthy': total - counts['online']})

    @app.get('/api/backups')
    def backups():
        """Every backup monitor's health in one list, stalest first, for a dashboard tile or a daily digest."""
        statuses = db.latest_statuses()
        rows = []
        for p in _flatten(engine.plugins):
            summarize = getattr(p, 'backup_summary', None)
            if p.children or not callable(summarize):
                continue
            rows.append({'id': p.id, 'name': p.name, 'target': getattr(p, 'target', None),
                         'status': statuses.get(p.id, 'unavailable'), **summarize()})
        rows.sort(key=lambda r: -(r['newest_archive_age'] if r['newest_archive_age'] is not None else float('inf')))
        healthy = sum(1 for r in rows if r['status'] == 'online')
        return JSONResponse({'total': len(rows), 'healthy': healthy, 'unhealthy': len(rows) - healthy,
                             'repositories': rows})

    @app.get('/api/monitors')
    def monitors():
        return JSONResponse(_monitor_summary(db.latest_statuses()))

    @app.get('/api/monitors/{monitor_id}')
    def monitor_detail(monitor_id: str):
        statuses = db.latest_statuses()
        target = next((p for p in _flatten(engine.plugins) if p.id == monitor_id), None)
        if target is None:
            return JSONResponse({'error': 'not found'}, status_code=404)
        metrics = [m for m in db.latest_metrics() if m['plugin_id'] == target.id]
        return JSONResponse({
            'id': target.id,
            'name': target.name,
            'type': target.config.get('type'),
            'target': getattr(target, 'target', None),
            'status': statuses.get(target.id, 'unavailable'),
            'metrics': metrics,
            'actions': _action_ids(target),
        })

    @app.get('/api/metrics')
    def metrics():
        return JSONResponse(db.latest_metrics())

    @app.get('/api/events')
    def events(level: Optional[str] = None, target: Optional[str] = None,
               search: Optional[str] = None, limit: int = 200):
        limit = max(1, min(int(limit), 2000))
        return JSONResponse(db.recent_events(limit=limit, level=level, target=target, search=search))

    _register_notification_routes(app, engine)
    _register_control_routes(app, engine)

    @app.get('/metrics')
    def prometheus_metrics():
        return PlainTextResponse(prometheus.render(db),
                                 media_type='text/plain; version=0.0.4; charset=utf-8')

    _register_push_routes(app, engine, tokens or TokenRegistry())
