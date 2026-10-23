"""The database an agent runs its monitors on: the server's own database, plus an outbox of every write for the server to collect."""

import json
import threading
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.core.connectors.types import CollectResult
from x_monitor.core.sync import records

from .database import DatabaseManager, _writer
from .models import AGENT_MODELS, OutboxRecord, db

# How many unacknowledged records an agent keeps before it drops the oldest result records to make room.
DEFAULT_OUTBOX_LIMIT = 200_000


class AgentDatabase(DatabaseManager):
    """A DatabaseManager whose result, job and setting writes each also land in the outbox as a numbered record.

    Plugins and the engine use it exactly as they use the server's database. Records keep the
    order the writes happened in, and stay until acknowledge() is given a sequence number at or
    past theirs."""

    def __init__(self, db_path: str, outbox_limit: int = DEFAULT_OUTBOX_LIMIT, **kwargs: Any):
        super().__init__(db_path, **kwargs)
        self.outbox_limit = outbox_limit
        self._seq_lock = threading.Lock()
        with db.connection_context():
            db.create_tables(AGENT_MODELS)
            last = OutboxRecord.select(OutboxRecord.seq).order_by(OutboxRecord.seq.desc()).first()
        self._next_seq = (last.seq if last else 0) + 1

    # ===== Recording =====

    def _record(self, kind: str, payload: Dict[str, Any]) -> int:
        """Queue one record behind the write it describes, numbered in the order the writes happened."""
        with self._seq_lock:
            seq = self._next_seq
            self._next_seq += 1
        body = json.dumps(payload)
        _writer.submit(lambda: OutboxRecord.insert(seq=seq, kind=kind, payload=body).execute())
        return seq

    def apply_result(self, target: str, plugin_id: str, plugin_name: str, result: CollectResult) -> None:
        super().apply_result(target, plugin_id, plugin_name, result)
        self._record(*records.encode_result(target, plugin_id, plugin_name, result))

    def create_job(self, plugin_id: str, target: str, kind: str, command: str,
                   workdir: Optional[str] = None) -> int:
        job_id = super().create_job(plugin_id, target, kind, command, workdir)
        self._record(*records.encode_job(records.JOB_CREATE, job_id, plugin_id=plugin_id, target=target,
                                         kind=kind, command=command, workdir=workdir))
        return job_id

    def set_job_pid(self, job_id: int, pid: int) -> None:
        super().set_job_pid(job_id, pid)
        self._record(*records.encode_job(records.JOB_PID, job_id, pid=pid))

    def set_job_progress(self, job_id: int, progress: str) -> None:
        super().set_job_progress(job_id, progress)
        self._record(*records.encode_job(records.JOB_PROGRESS, job_id, progress=progress))

    def append_job_output(self, job_id: int, lines, stream: str = "stdout") -> None:
        super().append_job_output(job_id, lines, stream)
        self._record(*records.encode_job(records.JOB_OUTPUT, job_id, lines=list(lines), stream=stream))

    def bump_job_output_seq(self, job_id: int, new_seq: int) -> None:
        super().bump_job_output_seq(job_id, new_seq)
        self._record(*records.encode_job(records.JOB_OUTPUT_SEQ, job_id, output_seq=new_seq))

    def finish_job(self, job_id: int, state: str, exit_code: Optional[int] = None,
                   error: Optional[str] = None) -> None:
        super().finish_job(job_id, state, exit_code=exit_code, error=error)
        self._record(*records.encode_job(records.JOB_FINISH, job_id, state=state, exit_code=exit_code, error=error))

    def set_setting(self, key: str, value: str):
        super().set_setting(key, value)
        self._record(*records.encode_setting(key, value))

    # ===== Collecting =====

    def pending(self, after: int = 0, limit: int = 500) -> List[Tuple[int, str, Dict[str, Any]]]:
        """The stored records numbered past `after`, oldest first, as (seq, kind, payload)."""
        with db.connection_context():
            rows = (OutboxRecord.select()
                    .where(OutboxRecord.seq > after)
                    .order_by(OutboxRecord.seq)
                    .limit(limit))
            return [(row.seq, row.kind, json.loads(row.payload)) for row in rows]

    def acknowledge(self, through: int) -> None:
        """Forget every record up to and including `through`, which the server has stored."""
        _writer.submit(lambda: OutboxRecord.delete().where(OutboxRecord.seq <= through).execute())

    def trim(self) -> int:
        """Drop the oldest result records past the outbox limit, keeping job and setting records, and return how many went."""
        with db.connection_context():
            excess = OutboxRecord.select().count() - self.outbox_limit
            if excess <= 0:
                return 0
            oldest = (OutboxRecord.select(OutboxRecord.seq)
                      .where(OutboxRecord.kind == records.RESULT)
                      .order_by(OutboxRecord.seq)
                      .limit(excess))
            return OutboxRecord.delete().where(OutboxRecord.seq.in_(oldest)).execute()
