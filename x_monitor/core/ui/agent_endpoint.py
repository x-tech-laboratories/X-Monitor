"""WebSocket endpoint agents dial into.

Mounted on the same FastAPI app (and therefore the same port) as the
dashboard and REST API, so deploying an agent needs no extra listener,
certificate, or firewall rule beyond what the dashboard already uses.

The dashboard's HTTP Basic middleware does not apply here — it is a
``BaseHTTPMiddleware``, which Starlette runs only for ``http`` scopes — so
this endpoint does its own authentication: it sends a fresh nonce, and the
agent signs it with the private key whose public half ``agents:`` lists for
its id. The server holds no agent secrets.
"""

import logging
import time
from typing import Any

from x_monitor.core.connectors import agent_protocol as proto
from x_monitor.core.connectors.agent_connector import AgentRegistry
from x_monitor_agent import keys

log = logging.getLogger(__name__)


def register_agent_endpoint(app: Any, registry: AgentRegistry) -> None:
    """Mount the /api/agent/ws websocket that agents connect to."""
    from fastapi import WebSocket, WebSocketDisconnect

    @app.websocket('/api/agent/ws')
    async def agent_socket(websocket: WebSocket):
        await websocket.accept()
        conn = None
        try:
            nonce = keys.new_nonce()
            await websocket.send_text(proto.encode(proto.challenge(nonce)))
            hello = proto.decode(await websocket.receive_text())
            if hello.get('t') != proto.HELLO:
                await websocket.close(code=1002, reason='Expected a hello frame')
                return

            agent_id = str(hello.get('agent') or '')
            public_key = registry.public_key_for(agent_id)
            signature = str(hello.get('sig') or '')
            if not agent_id or not keys.verify(public_key, agent_id, nonce, signature):
                log.warning(
                    f"agent endpoint: rejected connection claiming id {agent_id!r} "
                    f"from {websocket.client.host if websocket.client else 'unknown'}"
                )
                await websocket.close(code=1008, reason='Authentication failed')
                return

            conn = registry.require(agent_id)
            conn.attach(websocket, hello)
            await websocket.send_text(proto.encode(
                proto.welcome([s.to_wire() for s in conn.streams])
            ))
            # Only now is this agent's transport usable, so this is the point
            # at which its monitors can meaningfully collect.
            registry.notify_connected(agent_id)

            await _serve(websocket, registry, conn, agent_id)
        except WebSocketDisconnect:
            pass
        # One misbehaving connection (bad frame, mid-handshake drop) must not take the endpoint down.
        except Exception as e:
            log.warning(f"agent endpoint: connection ended with an error: {e}")
        finally:
            if conn is not None:
                conn.detach(websocket)


async def _serve(websocket: Any, registry: AgentRegistry, conn: Any, agent_id: str) -> None:
    """The per-connection receive loop. Every frame is dispatched by tag;
    unknown tags are ignored so a newer agent can send frames this server does
    not implement without breaking the link."""
    while True:
        frame = proto.decode(await websocket.receive_text())
        tag = frame.get('t')

        if tag == proto.RESULT:
            request_id = frame.get('id')
            if isinstance(request_id, int):
                conn.resolve(
                    request_id,
                    int(frame.get('rc', -1)),
                    str(frame.get('out', '')),
                    str(frame.get('err', '')),
                )
        elif tag == proto.EVENT:
            payload = frame.get('payload')
            registry.dispatch_event(
                agent_id,
                str(frame.get('stream') or ''),
                float(frame.get('ts') or time.time()),
                payload if isinstance(payload, dict) else {},
            )
        elif tag == proto.PING:
            await websocket.send_text(proto.encode({'t': proto.PONG, 'id': frame.get('id')}))
