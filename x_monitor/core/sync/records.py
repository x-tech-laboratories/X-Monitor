"""Encoding and decoding of an agent's records.

A record is one write the agent made: a collection result, one step of a
detached job, or a setting. Each encodes to a (kind, payload) pair of plain
JSON values, stored in the agent's outbox and sent to the server as is.
Encoding is pure, so the agent and the server share it."""

from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from x_monitor.core.connectors.types import CollectResult

RESULT = 'result'
JOB = 'job'
SETTING = 'setting'

# The job steps a record can carry, matching the database's job writes.
JOB_CREATE, JOB_PID, JOB_PROGRESS, JOB_OUTPUT, JOB_OUTPUT_SEQ, JOB_FINISH = (
    'create', 'pid', 'progress', 'output', 'output_seq', 'finish')


def encode_result(target: str, plugin_id: str, plugin_name: str, result: CollectResult,
                  now: Optional[datetime] = None) -> Tuple[str, Dict[str, Any]]:
    """A collection result as a record, stamped with when it was observed."""
    observed = result.timestamp or now or datetime.now()
    return RESULT, {
        'target': target,
        'plugin_id': plugin_id,
        'plugin_name': plugin_name,
        'ts': observed.isoformat(),
        'metrics': dict(result.metrics),
        'metadata': dict(result.metadata),
        'logs': [list(entry) for entry in result.logs],
        'log_lines': [list(entry) for entry in result.log_lines],
        'status': result.status,
        'snapshot': result.snapshot,
        'settings': dict(result.settings),
    }


def decode_result(payload: Dict[str, Any]) -> Tuple[str, str, str, CollectResult]:
    """A result record back as (target, plugin id, plugin name, CollectResult) carrying its original time."""
    result = CollectResult(
        metrics={str(k): float(v) for k, v in (payload.get('metrics') or {}).items()},
        metadata={str(k): str(v) for k, v in (payload.get('metadata') or {}).items()},
        logs=[(str(message), str(level)) for message, level in payload.get('logs') or []],
        log_lines=[(str(level), str(message), log_time)
                   for level, message, log_time in payload.get('log_lines') or []],
        status=payload.get('status'),
        snapshot=payload.get('snapshot'),
        settings={str(k): str(v) for k, v in (payload.get('settings') or {}).items()},
        timestamp=datetime.fromisoformat(payload['ts']),
    )
    return payload['target'], payload['plugin_id'], payload['plugin_name'], result


def encode_job(step: str, job_id: int, now: Optional[datetime] = None, **fields: Any) -> Tuple[str, Dict[str, Any]]:
    """One step of a detached job as a record, under the agent's own job id."""
    return JOB, {'step': step, 'job_id': job_id, 'ts': (now or datetime.now()).isoformat(), **fields}


def encode_setting(key: str, value: str) -> Tuple[str, Dict[str, Any]]:
    """A setting the agent wrote, such as a scheduled run's outcome, as a record."""
    return SETTING, {'key': key, 'value': value}
