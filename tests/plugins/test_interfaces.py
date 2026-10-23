import json
import shutil
import subprocess

import pytest

from x_monitor.plugins.interfaces import (
    Interfaces, _merge, _parse_ip_json, _parse_ip_text, _parse_sysfs, _probe_script, is_up,
)
from x_monitor.plugins.base.plugin_helpers import SCRIPT_SEP
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric

CFG = {"name": "test-ifaces", "id": "test-ifaces", "ssh_config": {"host": "test.host"}}


def _link(name, operstate="UP", flags=("BROADCAST", "UP", "LOWER_UP"), mac="52:54:00:00:00:01",
          addrs=(), link_type="ether", mtu=1500):
    return {
        "ifname": name, "flags": list(flags), "mtu": mtu, "operstate": operstate,
        "link_type": link_type, "address": mac,
        "addr_info": [dict(a) for a in addrs],
    }


def _v4(address, prefix=24):
    return {"family": "inet", "local": address, "prefixlen": prefix}


def _v6(address, prefix=64, temporary=False):
    info = {"family": "inet6", "local": address, "prefixlen": prefix}
    if temporary:
        info["temporary"] = True
    return info


LO = _link("lo", "UNKNOWN", ("LOOPBACK", "UP", "LOWER_UP"), "00:00:00:00:00:00",
           [_v4("127.0.0.1", 8), _v6("::1", 128)], "loopback", 65536)


def _sysfs_line(name, state="up", carrier="1", mtu="1500", mac="52:54:00:00:00:01",
                speed="1000", link_type="1"):
    return "\t".join([name, state, carrier, mtu, mac, speed, link_type])


def _output(links, sysfs=None, text=""):
    ip_json = json.dumps(links) if links is not None else ""
    if sysfs is None:
        sysfs = [_sysfs_line("lo", "unknown", "1", "65536", "00:00:00:00:00:00", "", "772")]
        for link in links or []:
            if link["ifname"] != "lo":
                up = "LOWER_UP" in link["flags"]
                sysfs.append(_sysfs_line(link["ifname"], link["operstate"].lower(),
                                         "1" if up else "0", mac=link["address"]))
    return f"{ip_json}\n{SCRIPT_SEP}\n{text}\n{SCRIPT_SEP}\n" + "\n".join(sysfs) + "\n"


def _eth0(address="192.0.2.10", operstate="UP", lower_up=True, extra=()):
    flags = ("BROADCAST", "UP", "LOWER_UP") if lower_up else ("NO-CARRIER", "BROADCAST", "UP")
    return _link("eth0", operstate, flags, addrs=[_v4(address), _v6("fe80::1"), *extra])


def _latest_status():
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == "test-ifaces"
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == "test-ifaces") & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(Interfaces, CFG)


@pytest.fixture
def expecting(make_plugin):
    return make_plugin(Interfaces, {**CFG, "expect_up": ["eth0"]})


def _run(plugin, run_cycle, stdout, rc=0, stderr=""):
    return run_cycle(plugin, lambda c: CmdResult(rc, stdout, stderr))


TEXT = """1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host
2: eth0@if7: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default
    link/ether 52:54:00:00:00:01 brd ff:ff:ff:ff:ff:ff
    inet 192.0.2.10/24 brd 192.0.2.255 scope global dynamic eth0
    inet6 2001:db8::1234/64 scope global temporary dynamic
    inet6 2001:db8::1/64 scope global dynamic mngtmpaddr
3: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN group default
    link/none
    inet 10.0.0.2/24 scope global wg0
4: eth1: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc fq_codel state DOWN group default
    link/ether 52:54:00:00:00:02 brd ff:ff:ff:ff:ff:ff
"""


class TestParsers:
    def test_ip_json(self):
        interfaces = _parse_ip_json(json.dumps([LO, _eth0(extra=[_v6("2001:db8::99", temporary=True)])]))
        assert interfaces["lo"]["loopback"]
        eth0 = interfaces["eth0"]
        assert eth0["ipv4"] == ["192.0.2.10/24"]
        assert eth0["ipv6"] == ["fe80::1/64"]
        assert eth0["ipv6_temporary"] == ["2001:db8::99/64"]
        assert eth0["carrier"] is True and eth0["state"] == "up"

    def test_ip_json_garbage_is_empty(self):
        assert _parse_ip_json("not json") == {}

    def test_ip_text(self):
        interfaces = _parse_ip_text(TEXT)
        assert set(interfaces) == {"lo", "eth0", "wg0", "eth1"}
        assert interfaces["eth0"]["ipv4"] == ["192.0.2.10/24"]
        assert interfaces["eth0"]["ipv6"] == ["2001:db8::1/64"]
        assert interfaces["eth0"]["ipv6_temporary"] == ["2001:db8::1234/64"]
        assert interfaces["eth0"]["mac"] == "52:54:00:00:00:01"
        assert interfaces["wg0"]["mac"] == "" and interfaces["wg0"]["state"] == "unknown"
        assert interfaces["eth1"]["carrier"] is False and interfaces["eth1"]["state"] == "down"
        assert interfaces["lo"]["loopback"]

    def test_sysfs(self):
        interfaces = _parse_sysfs(
            _sysfs_line("eth0", speed="2500") + "\n" + _sysfs_line("eth1", "down", "", speed="-1")
            + "\nbad line\n")
        assert interfaces["eth0"]["speed"] == 2500 and interfaces["eth0"]["carrier"] is True
        assert interfaces["eth1"]["speed"] is None and interfaces["eth1"]["carrier"] is None

    def test_merge_prefers_sysfs_state_and_fills_carrier_from_ip(self):
        sysfs = _parse_sysfs(_sysfs_line("eth1", "down", "", speed=""))
        merged = _merge(sysfs, _parse_ip_text(TEXT))
        assert merged["eth1"]["carrier"] is False
        assert merged["eth0"]["ipv4"] == ["192.0.2.10/24"]

    def test_is_up(self):
        assert is_up({"state": "up", "carrier": True})
        assert is_up({"state": "unknown", "carrier": True})
        assert not is_up({"state": "unknown", "carrier": None})
        assert not is_up({"state": "lowerlayerdown", "carrier": False})


class TestInventory:
    def test_counts_exclude_loopback_by_default(self, plugin, run_cycle):
        result = _run(plugin, run_cycle, _output([LO, _eth0()]))
        assert _latest_status() == "online"
        assert _latest_metric("interfaces_total") == 1.0
        assert _latest_metric("interfaces_up") == 1.0
        assert [row["name"] for row in result.snapshot] == ["eth0"]

    def test_include_loopback(self, make_plugin, run_cycle):
        p = make_plugin(Interfaces, {**CFG, "include_loopback": True})
        _run(p, run_cycle, _output([LO, _eth0()]))
        assert _latest_metric("interfaces_total") == 2.0

    def test_include_and_exclude_globs(self, make_plugin, run_cycle):
        links = [_eth0(), _link("eth1"), _link("veth12ab"), _link("docker0")]
        p = make_plugin(Interfaces, {**CFG, "include": ["eth*", "veth*"], "exclude": ["veth*"]})
        result = _run(p, run_cycle, _output(links))
        assert [row["name"] for row in result.snapshot] == ["eth0", "eth1"]

    def test_down_interface_counts_but_does_not_fail_unless_expected(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output([_eth0(operstate="DOWN", lower_up=False)]))
        assert _latest_status() == "online"
        assert _latest_metric("interfaces_up") == 0.0

    def test_text_fallback(self, plugin, run_cycle):
        sysfs = [_sysfs_line("eth0"), _sysfs_line("wg0", "unknown", "1", link_type="65534")]
        result = _run(plugin, run_cycle, _output(None, sysfs=sysfs, text=TEXT))
        rows = {row["name"]: row for row in result.snapshot}
        assert rows["eth0"]["ipv4"] == ["192.0.2.10/24"]
        assert rows["eth1"]["up"] is False
        assert _latest_metric("interfaces_up") == 2.0

    def test_nothing_found_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, _output(None, sysfs=[]))
        assert _latest_status() == "unavailable"

    def test_unreachable_is_unavailable(self, plugin, run_cycle):
        _run(plugin, run_cycle, "", rc=-1, stderr="connection refused")
        assert _latest_status() == "unavailable"


class TestExpectUp:
    def test_expected_up_is_online(self, expecting, run_cycle):
        _run(expecting, run_cycle, _output([_eth0()]))
        assert _latest_status() == "online"
        assert _latest_metric("interface_eth0_up") == 1.0

    def test_expected_without_carrier_fails(self, expecting, run_cycle):
        result = _run(expecting, run_cycle, _output([_eth0(operstate="DOWN", lower_up=False)]))
        assert _latest_status() == "failed"
        assert "eth0 has no carrier" in result.logs[0][0]
        assert _latest_metric("interface_eth0_up") == 0.0

    def test_expected_missing_fails(self, expecting, run_cycle):
        result = _run(expecting, run_cycle, _output([_link("eth1")]))
        assert _latest_status() == "failed"
        assert "eth0 is missing" in result.logs[0][0]

    def test_expected_interface_shows_even_when_excluded(self, make_plugin, run_cycle):
        p = make_plugin(Interfaces, {**CFG, "expect_up": ["eth0"], "exclude": ["eth*"]})
        result = _run(p, run_cycle, _output([_eth0(), _link("eth1")]))
        assert [row["name"] for row in result.snapshot] == ["eth0"]
        assert result.snapshot[0]["expected"]

    def test_address_change_warns_once_and_logs_both(self, expecting, run_cycle):
        _run(expecting, run_cycle, _output([_eth0("192.0.2.10")]))
        assert _latest_status() == "online"
        result = _run(expecting, run_cycle, _output([_eth0("192.0.2.11")]))
        assert _latest_status() == "warning"
        change = [msg for msg, _ in result.logs if "changed:" in msg][0]
        assert "192.0.2.10/24" in change and "192.0.2.11/24" in change
        _run(expecting, run_cycle, _output([_eth0("192.0.2.11")]))
        assert _latest_status() == "online"

    def test_temporary_ipv6_rotation_is_not_a_change(self, expecting, run_cycle):
        _run(expecting, run_cycle, _output([_eth0(extra=[_v6("2001:db8::aa", temporary=True)])]))
        _run(expecting, run_cycle, _output([_eth0(extra=[_v6("2001:db8::bb", temporary=True)])]))
        assert _latest_status() == "online"

    def test_link_bounce_with_same_address_is_not_a_change(self, expecting, run_cycle):
        _run(expecting, run_cycle, _output([_eth0()]))
        down = _link("eth0", "DOWN", ("NO-CARRIER", "UP"))
        _run(expecting, run_cycle, _output([down]))
        assert _latest_status() == "failed"
        _run(expecting, run_cycle, _output([_eth0()]))
        assert _latest_status() == "online"

    def test_address_change_on_unexpected_interface_is_ignored(self, expecting, run_cycle):
        _run(expecting, run_cycle, _output([_eth0(), _link("eth1", addrs=[_v4("198.51.100.1")])]))
        _run(expecting, run_cycle, _output([_eth0(), _link("eth1", addrs=[_v4("198.51.100.2")])]))
        assert _latest_status() == "online"


class TestCards:
    def test_rows_and_expected_card(self, expecting, run_cycle):
        assert expecting._expected_text == "--"
        _run(expecting, run_cycle, _output([_eth0(), _link("eth1", "DOWN", ("UP",))]))
        rows = {row["name"]: row for row in expecting._interface_rows}
        assert rows["eth0"]["ipv4"] == "192.0.2.10/24"
        assert rows["eth0"]["speed"] == "1000 Mb/s"
        assert Interfaces._state_color(rows["eth0"]) == "online"
        assert Interfaces._state_color(rows["eth1"]) is None
        assert expecting._expected_text == "1/1 UP"
        assert expecting._expected_color == "online"

    def test_no_expectations(self, plugin):
        assert plugin._expected_text == "NONE SET"
        assert plugin._expected_color is None


@pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")
def test_probe_script_runs_on_this_host(make_plugin):
    out = subprocess.run(["sh", "-c", _probe_script()], capture_output=True, text=True)
    assert out.stdout.count(SCRIPT_SEP) == 2
