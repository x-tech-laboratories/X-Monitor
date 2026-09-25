"""Exporter Engine.

Takes data from the Database Engine and presents it to external exporter
endpoints. Prometheus is a pull exporter (a pure ``render(db)`` function
served at ``/metrics`` by the UI Engine's API — see
``vigil/core/exporters/prometheus.py`` and ``vigil/core/ui/api.py``); InfluxDB
and MQTT are push exporters started as background tasks here.

``ExporterEngine`` is the facade the Coordination Engine owns: it reads
exporter settings from the Settings Engine and starts whichever push
exporters are configured. Pull exporters need no runtime object — they render
on demand — so this engine only manages the push side.
"""

import asyncio
import logging
from typing import Any, Callable, Iterable, List, Optional

from vigil.core.contracts import MetricsSource


class ExporterEngine:
    """Owns the configured push exporters (InfluxDB and MQTT). Constructed
    once by the Coordination Engine with the shared Database Engine and the
    ``exporters`` config block from the Settings Engine."""

    def __init__(self, db: MetricsSource, exporters_cfg: Optional[dict] = None):
        self._db = db
        self._cfg = exporters_cfg or {}
        self._tasks: List[asyncio.Task] = []
        self._exporters: List[Any] = []

    def start(self, monitors: Optional[Callable[[], Iterable[Any]]] = None) -> None:
        """Start every configured push exporter as a background task. Called
        from the Coordination Engine's run() once the event loop is live;
        `monitors` lists the live monitors for exporters that describe them."""
        influx_cfg = self._cfg.get('influxdb')
        if influx_cfg and influx_cfg.get('url'):
            # A broken exporter config must not stop the engine from starting.
            try:
                from vigil.core.exporters.influxdb import InfluxDBExporter
                exporter = InfluxDBExporter(self._db, influx_cfg)
                self._tasks.append(asyncio.create_task(exporter.run()))
                logging.info("InfluxDB exporter task started.")
            except Exception as e:
                logging.error(f"Failed to start InfluxDB exporter — metrics will not be pushed: {e}")
        mqtt_cfg = self._cfg.get('mqtt')
        if mqtt_cfg and mqtt_cfg.get('host'):
            # A missing aiomqtt or a broken MQTT config must not stop the engine from starting.
            try:
                from vigil.core.exporters.mqtt import MQTTExporter
                exporter = MQTTExporter(self._db, mqtt_cfg, monitors=monitors)
                exporter.start()
                self._exporters.append(exporter)
            except Exception as e:
                logging.error(f"Failed to start MQTT exporter — nothing will be published: {e}")

    def stop(self) -> None:
        """Stop every push exporter that start() began."""
        for exporter in self._exporters:
            exporter.stop()
        self._exporters.clear()
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()

    @staticmethod
    def render_prometheus(db: Any) -> str:
        """Pull-exporter entry point — pure render of the Prometheus text
        exposition format from current metrics/statuses. Served by the UI
        Engine's ``/metrics`` route."""
        from vigil.core.exporters import prometheus
        return prometheus.render(db)
