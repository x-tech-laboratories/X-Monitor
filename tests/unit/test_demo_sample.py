"""The sample-data demo's readings: every sampled type yields metrics and a valid status, and
the sample fleet config builds a monitor for each of its entries."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

DEMO = Path(__file__).resolve().parents[2] / 'dev' / 'demo'


@pytest.fixture(scope='module')
def sample():
    spec = importlib.util.spec_from_file_location('demo_sample', DEMO / 'sample.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stand_in(kind):
    return SimpleNamespace(config={'type': kind}, warning=70, threshold=90, max_age=86400,
                           checks=[{'metric': 'web'}, {'metric': 'ssh'}])


class TestSamples:
    def test_every_sampled_type_yields_metrics_and_a_status(self, sample):
        for kind, reading in sample.SAMPLES.items():
            for tick in range(0, 80, 7):
                metrics, status = reading(stand_in(kind), tick, seed=101)
                assert metrics, kind
                assert all(isinstance(v, float) for v in metrics.values()), kind
                assert status in ('online', 'warning', 'failed'), kind

    def test_a_flaky_monitor_goes_down_now_and_then(self, sample):
        states = {sample.uptime(stand_in('uptime'), tick, seed=3)[1] for tick in range(40)}
        assert states == {'online', 'failed'}

    def test_a_reading_past_the_threshold_fails(self, sample):
        assert sample.thresholds(stand_in('cpu'), 95.0) == 'failed'

    def test_a_ports_reading_covers_every_check(self, sample):
        metrics, _ = sample.ports(stand_in('ports'), 0, seed=1)
        assert {'web_up', 'ssh_up', 'web_latency_ms', 'ssh_latency_ms'} <= set(metrics)


class TestSampleFleet:
    def test_every_monitor_in_the_sample_fleet_has_a_sample_or_is_a_group(self, sample):
        import yaml
        config = yaml.safe_load((DEMO / 'sample.yaml').read_text())

        def kinds(nodes):
            for node in nodes:
                yield node['type']
                yield from kinds(node.get('children', []))

        assert set(kinds(config['plugins'])) - {'group'} <= set(sample.SAMPLES)
