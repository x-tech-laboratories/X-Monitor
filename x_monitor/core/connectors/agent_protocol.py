"""Re-export of the agent wire protocol.

The definitions live in ``x_monitor_agent.protocol`` so the agent package stays
installable on a monitored host without the server's dependencies; this alias
keeps the server-side import path alongside the rest of the transport code.
"""

from x_monitor_agent.protocol import (  # noqa: F401
    CHALLENGE, DISMISS, EVENT, EXEC, HELLO, INHIBIT, NOTIFY, PING, PONG, PROTOCOL_VERSION, RESULT,
    SUBSCRIBE, WELCOME, StreamSpec, challenge, decode, dismiss, encode, event, exec_request,
    exec_result, hello, inhibit, notify, subscribe, welcome,
)
