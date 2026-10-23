"""How long each monitor's recent collection cycles took, kept in memory for the self-monitor to read."""

import threading
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional, Tuple

# How many recent cycles the average and maximum cover.
CYCLE_WINDOW = 20


@dataclass(frozen=True)
class CycleTiming:
    """One monitor's recent cycle durations in seconds, and how long its SSH commands queued for a channel."""
    last_seconds: float
    avg_seconds: float
    max_seconds: float
    last_wait_seconds: float
    avg_wait_seconds: float
    cycles: int


class CycleStats:
    """A short window of cycle durations per monitor; written on the event loop and read from worker threads."""

    def __init__(self, window: int = CYCLE_WINDOW):
        self._window = window
        self._samples: Dict[str, Deque[Tuple[float, float]]] = {}
        self._lock = threading.Lock()

    def record(self, plugin_id: str, seconds: float, wait_seconds: float = 0.0) -> None:
        with self._lock:
            samples = self._samples.get(plugin_id)
            if samples is None:
                samples = self._samples[plugin_id] = deque(maxlen=self._window)
            samples.append((seconds, wait_seconds))

    def get(self, plugin_id: str) -> Optional[CycleTiming]:
        with self._lock:
            samples = list(self._samples.get(plugin_id) or ())
        if not samples:
            return None
        durations = [s for s, _ in samples]
        waits = [w for _, w in samples]
        return CycleTiming(
            last_seconds=durations[-1],
            avg_seconds=sum(durations) / len(durations),
            max_seconds=max(durations),
            last_wait_seconds=waits[-1],
            avg_wait_seconds=sum(waits) / len(waits),
            cycles=len(samples),
        )

    def forget(self, plugin_id: str) -> None:
        with self._lock:
            self._samples.pop(plugin_id, None)
