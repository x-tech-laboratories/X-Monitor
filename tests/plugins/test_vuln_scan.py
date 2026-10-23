import time

import pytest

from x_monitor.plugins.vuln_scan import VulnScan
from x_monitor.core.connectors.types import CmdResult
from x_monitor.core.database.database import db, StatusHistory, Metric


BASE_CFG = {
    "name":       "test-vuln-scan",
    "id":         "test-vuln-scan",
    "interval":   86400,
    "scan_host":  "web-01.example.com",
    "ssh_config": {"host": "scanner.host"},
}


def _latest_status(plugin_id: str = "test-vuln-scan"):
    with db.connection_context():
        row = StatusHistory.select().where(
            StatusHistory.plugin_id == plugin_id
        ).order_by(StatusHistory.timestamp.desc()).first()
    return row.state if row else None


def _latest_metric(metric: str, plugin_id: str = "test-vuln-scan"):
    with db.connection_context():
        row = Metric.select().where(
            (Metric.plugin_id == plugin_id) & (Metric.metric_name == metric)
        ).order_by(Metric.timestamp.desc()).first()
    return row.value if row else None


# The vulns-library table nmap writes for a definite finding, as ssl-poodle renders it.
POODLE = """<script id="ssl-poodle" output="&#xa;  VULNERABLE:&#xa;  SSL POODLE information leak"><table key="CVE-2014-3566">
<elem key="title">SSL POODLE information leak</elem>
<elem key="state">VULNERABLE</elem>
<table key="ids"><elem>CVE:CVE-2014-3566</elem><elem>BID:70574</elem></table>
<table key="scores"><elem key="CVSS">4.3</elem></table>
<table key="description"><elem>The SSL protocol 3.0 uses nondeterministic CBC padding.</elem></table>
<table key="refs"><elem>https://www.openssl.org/~bodo/ssl-poodle.pdf</elem></table>
</table></script>"""

LIKELY = """<script id="http-slowloris-check" output="&#xa;  LIKELY VULNERABLE"><table key="CVE-2007-6750">
<elem key="title">Slowloris DOS attack</elem>
<elem key="state">LIKELY VULNERABLE</elem>
<table key="ids"><elem>CVE:CVE-2007-6750</elem></table>
</table></script>"""

NEGATIVE = """<script id="http-csrf" output="Couldn&apos;t find any CSRF vulnerabilities."></script>"""

PLAIN_POSITIVE = """<script id="ftp-vsftpd-backdoor" output="&#xa;  VULNERABLE:&#xa;  vsFTPd version 2.3.4 backdoor"></script>"""

VULNERS = """<script id="vulners" output="&#xa;  cpe:/a:openbsd:openssh:7.4: &#xa;    CVE-2018-15473 5.0"><table key="cpe:/a:openbsd:openssh:7.4">
<table><elem key="id">CVE-2018-15473</elem><elem key="type">cve</elem><elem key="is_exploit">false</elem><elem key="cvss">5.0</elem></table>
<table><elem key="id">CVE-2016-6515</elem><elem key="type">cve</elem><elem key="is_exploit">false</elem><elem key="cvss">7.8</elem></table>
<table><elem key="id">EDB-ID:45233</elem><elem key="type">exploitdb</elem><elem key="is_exploit">true</elem><elem key="cvss">0.0</elem></table>
</table></script>"""

HOSTSCRIPT = """<hostscript><script id="smb-vuln-ms17-010" output="VULNERABLE"><table key="CVE-2017-0143">
<elem key="title">Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)</elem>
<elem key="state">VULNERABLE</elem>
<table key="ids"><elem>CVE:CVE-2017-0143</elem></table>
</table></script></hostscript>"""


def _port(portid, name, scripts="", product=None, version=None, tunnel=None, state="open"):
    service = f'<service name="{name}"'
    if product:
        service += f' product="{product}"'
    if version:
        service += f' version="{version}"'
    if tunnel:
        service += f' tunnel="{tunnel}"'
    service += ' method="probed" conf="10"/>'
    return (f'<port protocol="tcp" portid="{portid}"><state state="{state}" reason="syn-ack" '
            f'reason_ttl="0"/>{service}{scripts}</port>')


def _scan(ports="", hostscript="", up=True, elapsed=42.5, ended=None) -> CmdResult:
    """The XML nmap writes to stdout with -oX - for a one-host scan."""
    ended = ended if ended is not None else int(time.time())
    if up:
        host = (f'<host starttime="{ended - 40}" endtime="{ended}"><status state="up" reason="syn-ack" '
                f'reason_ttl="0"/><address addr="192.0.2.10" addrtype="ipv4"/><hostnames>'
                f'</hostnames><ports>{ports}</ports>{hostscript}</host>')
        hosts = '<hosts up="1" down="0" total="1"/>'
    else:
        host = ('<host><status state="down" reason="no-response" reason_ttl="0"/>'
                '<address addr="192.0.2.10" addrtype="ipv4"/></host>')
        hosts = '<hosts up="0" down="1" total="1"/>'
    xml = (f'<?xml version="1.0" encoding="UTF-8"?><nmaprun scanner="nmap" version="7.99" '
           f'start="{ended - 45}">{host}<runstats><finished time="{ended}" elapsed="{elapsed}" '
           f'exit="success"/>{hosts}</runstats></nmaprun>')
    return CmdResult(0, xml, "")


@pytest.fixture
def plugin(make_plugin):
    return make_plugin(VulnScan, BASE_CFG)


def _poll(out, exit_code=None, alive=True):
    """The raw stdout one poll of the detached scan produces on the scanning host."""
    return CmdResult(0, (
        f"===XMONITOR_SIZE===\n{len(out)}\n"
        f"===XMONITOR_EXIT===\n{exit_code if exit_code is not None else ''}\n"
        f"===XMONITOR_ALIVE===\n{1 if alive else 0}\n"
        f"===XMONITOR_OUT===\n{out}"
    ), "")


def _cycle(plugin, result):
    """One cycle whose command answers with this result."""
    plugin.commands()
    parsed = plugin.parse([result])
    plugin.storage.apply(parsed)
    return parsed


def _launch(plugin, pid=4242):
    """One cycle with no job running: it launches the scan and records its pid."""
    return _cycle(plugin, CmdResult(0, f"{pid}\n", ""))


def _collect(plugin, result):
    """Launch the scan, then poll it once as finished with this result's output, its stderr marked as the run marks it."""
    _launch(plugin)
    errors = ''.join(f"@@nmap-stderr {line}\n" for line in result.stderr.splitlines())
    return _cycle(plugin, _poll(result.stdout + errors, result.exit_code, alive=False))


class TestCommand:
    async def test_scan_runs_nmap_against_scan_host_under_a_deadline(self, plugin):
        text = plugin._scan_command()
        assert text.startswith("timeout -k 5 1200 nmap -n -oX - --stats-every 30s -PS22,80,443 -sV --script vuln ")
        assert text.endswith(" web-01.example.com")

    async def test_options_reach_the_command_line(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "ports": "1-1024", "scripts": "vuln and not http-slowloris-check",
                                   "script_args": "vulns.showall=1", "nmap_args": ["-T4"],
                                   "discovery_ports": [], "service_detection": False,
                                   "require_sudo": True, "timeout": "5m"})
        text = p._scan_command()
        assert text.startswith("sudo -n timeout -k 5 300 nmap -n -oX - --stats-every 30s -Pn --script ")
        assert "'vuln and not http-slowloris-check'" in text
        assert "--script-args vulns.showall=1" in text
        assert "-p 1-1024" in text
        assert "-T4 web-01.example.com" in text
        assert "-sV" not in text

    async def test_monitor_is_labelled_with_the_scanned_host(self, plugin):
        assert plugin.display_target == "web-01.example.com"
        assert plugin.target == "web-01.example.com"
        assert plugin.scanner == "scanner.host"

    async def test_scanner_names_the_agent_when_one_is_set(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "agent": "monitor"})
        assert p.scanner == "monitor"

    async def test_scan_host_falls_back_to_target_host(self, make_plugin):
        cfg = {k: v for k, v in BASE_CFG.items() if k not in ("scan_host", "ssh_config")}
        p = make_plugin(VulnScan, {**cfg, "target_host": "db-01.example.com"})
        assert p.scan_host == "db-01.example.com"


class TestGrading:
    async def test_clean_host_is_online(self, plugin):
        _collect(plugin, _scan(_port(22, "ssh", product="OpenSSH", version="9.9") + _port(443, "http", NEGATIVE)))
        assert _latest_status() == "online"
        assert _latest_metric("vulnerable") == 0
        assert _latest_metric("open_ports") == 2
        assert _latest_metric("host_up") == 1
        assert _latest_metric("scan_seconds") == 42.5

    async def test_a_definite_finding_fails(self, plugin):
        _collect(plugin, _scan(_port(443, "https", POODLE)))
        assert _latest_status() == "failed"
        assert _latest_metric("vulnerable") == 1
        rows = plugin._finding_rows
        assert rows[0]["id"] == "CVE-2014-3566"
        assert rows[0]["title"] == "SSL POODLE information leak"
        assert rows[0]["cvss"] == "4.3"
        assert rows[0]["severity"] == "VULNERABLE"
        assert rows[0]["port"] == "443/tcp"

    async def test_a_likely_finding_warns(self, plugin):
        _collect(plugin, _scan(_port(80, "http", LIKELY)))
        assert _latest_status() == "warning"
        assert _latest_metric("suspected") == 1
        assert _latest_metric("vulnerable") == 0

    async def test_likely_status_is_configurable(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "likely_status": "online"})
        _collect(p, _scan(_port(80, "http", LIKELY)))
        assert _latest_status() == "online"

    async def test_a_host_script_finding_counts(self, plugin):
        _collect(plugin, _scan(_port(445, "microsoft-ds"), hostscript=HOSTSCRIPT))
        assert _latest_status() == "failed"
        assert plugin._finding_rows[0]["port"] == "host"

    async def test_plain_text_verdict_is_a_finding(self, plugin):
        _collect(plugin, _scan(_port(21, "ftp", PLAIN_POSITIVE)))
        assert _latest_status() == "failed"
        assert plugin._finding_rows[0]["title"] == "VULNERABLE:"

    async def test_service_fingerprints_are_not_findings(self, plugin):
        fingerprint = ('<script id="fingerprint-strings" output="DNSVersionBindReqTCP: ..."><table key="DNSVersionBindReqTCP">'
                       '<elem>\\x00\\x1e\\x00\\x06\\x01</elem></table></script>')
        _collect(plugin, _scan(_port(53, "domain", fingerprint)))
        assert _latest_status() == "online"
        assert _latest_metric("noted") == 0
        assert plugin._finding_rows == []

    async def test_nothing_found_text_is_ignored(self, plugin):
        _collect(plugin, _scan(_port(80, "http", NEGATIVE)))
        assert _latest_status() == "online"
        assert plugin._finding_rows == []

    async def test_vulners_advisories_grade_by_cvss(self, plugin):
        _collect(plugin, _scan(_port(22, "ssh", VULNERS, product="OpenSSH", version="7.4")))
        assert _latest_status() == "failed"
        assert _latest_metric("vulnerable") == 1
        assert _latest_metric("suspected") == 1
        assert _latest_metric("noted") == 1
        rows = plugin._finding_rows
        assert [r["id"] for r in rows] == ["CVE-2016-6515", "CVE-2018-15473", "EDB-ID:45233"]
        assert rows[2]["state"] == "CVSS 0.0 · exploit"

    async def test_cvss_thresholds_are_configurable(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "warning_cvss": 9.0, "threshold_cvss": 9.5})
        _collect(p, _scan(_port(22, "ssh", VULNERS)))
        assert _latest_status() == "online"
        assert _latest_metric("noted") == 3

    async def test_cvss_warning_only_never_fails(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "threshold_cvss": None})
        _collect(p, _scan(_port(22, "ssh", VULNERS)))
        assert _latest_status() == "warning"
        assert _latest_metric("vulnerable") == 0
        assert _latest_metric("suspected") == 2

    async def test_cvss_failure_only_never_warns(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "warning_cvss": None, "threshold_cvss": 9.0})
        _collect(p, _scan(_port(22, "ssh", VULNERS)))
        assert _latest_status() == "online"
        assert _latest_metric("noted") == 3
        p = make_plugin(VulnScan, {**BASE_CFG, "warning_cvss": None})
        _collect(p, _scan(_port(22, "ssh", VULNERS)))
        assert _latest_status() == "failed"
        assert _latest_metric("suspected") == 0

    async def test_findings_table_is_capped_but_counts_are_not(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "max_findings": 1})
        _collect(p, _scan(_port(22, "ssh", VULNERS)))
        assert _latest_metric("noted") == 1
        assert _latest_metric("vulnerable") == 1
        assert len(p._finding_rows) == 1


class TestPorts:
    async def test_open_ports_are_listed_with_their_service(self, plugin):
        _collect(plugin, _scan(_port(22, "ssh", product="OpenSSH", version="10.5")
                               + _port(22000, "snapenetio", tunnel="ssl")
                               + _port(80, "http", state="closed")))
        rows = plugin._port_rows
        assert [r["port"] for r in rows] == ["22/tcp", "22000/tcp"]
        assert rows[0]["product"] == "OpenSSH" and rows[0]["version"] == "10.5"
        assert rows[1]["service"] == "snapenetio/ssl"


class TestFailures:
    async def test_host_down_is_unavailable(self, plugin):
        _collect(plugin, _scan(up=False))
        assert _latest_status() == "unavailable"
        assert _latest_metric("host_up") == 0

    async def test_nmap_missing_is_unavailable(self, plugin):
        _collect(plugin, CmdResult(127, "", "sh: nmap: command not found"))
        assert _latest_status() == "unavailable"

    async def test_truncated_output_is_unavailable(self, plugin):
        _collect(plugin, CmdResult(124, '<?xml version="1.0"?><nmaprun><host>', ""))
        assert _latest_status() == "unavailable"

    async def test_lost_launch_reply_is_unavailable(self, plugin):
        _cycle(plugin, CmdResult(-1, "", "not connected"))
        assert _latest_status() == "unavailable"
        assert plugin._last_scan_color == "unavailable"

    async def test_nmap_warnings_around_the_xml_are_ignored(self, plugin):
        scan = _scan(_port(443, "https", POODLE))
        _collect(plugin, CmdResult(0, scan.stdout, "Warning: giving up on port because retransmission cap hit\n"))
        assert _latest_status() == "failed"

    async def test_last_scan_card_reads_the_scan_time(self, plugin):
        assert plugin._last_scan_text == "NEVER"
        _collect(plugin, _scan(_port(22, "ssh"), ended=int(time.time()) - 3600))
        assert plugin._last_scan_text.endswith(" ago")
        assert plugin._last_scan_color == "online"


class TestDetachedJob:
    def test_is_never_sampled_on_the_agent(self):
        assert VulnScan.SAMPLED is False

    def test_a_cycle_without_a_job_launches_the_scan(self, plugin):
        [cmd] = plugin.commands()
        assert "setsid" in cmd.text and "vuln_scan-test-vuln-scan" in cmd.text
        assert "timeout -k 5 1200 nmap" in cmd.text

    def test_stderr_is_marked_as_it_is_written_and_keeps_nmaps_status(self, make_plugin, tmp_path):
        import os
        import subprocess
        nmap = tmp_path / "nmap"
        nmap.write_text("#!/bin/sh\necho '<?xml version=\"1.0\"?>'\necho 'Warning: cap hit' >&2\n"
                        "echo '<nmaprun></nmaprun>'\nexit 2\n")
        nmap.chmod(0o755)
        p = make_plugin(VulnScan, {**BASE_CFG, "nmap_bin": str(nmap), "require_sudo": False})
        env = {**os.environ, "HOME": str(tmp_path)}
        run = subprocess.run(["sh", "-c", f'mkdir -p "{p.workdir}" && {p._run_command()}'],
                             capture_output=True, text=True, env=env)
        assert run.returncode == 2
        assert "@@nmap-stderr Warning: cap hit" in run.stdout.splitlines()
        assert "<nmaprun></nmaprun>" in run.stdout

    async def test_a_warning_inside_the_xml_is_kept_out_of_it(self, plugin):
        scan = _scan(_port(443, "https", POODLE)).stdout
        middle = scan.index("<host")
        _launch(plugin)
        _cycle(plugin, _poll(scan[:middle] + "\n@@nmap-stderr Warning: cap hit\n" + scan[middle:], 0, alive=False))
        assert _latest_status() == "failed"

    async def test_a_scan_with_no_xml_names_nmaps_error(self, plugin):
        _collect(plugin, CmdResult(1, "", "nmap: command not found"))
        events = [e["message"] for e in plugin.data.plugin_events(plugin.id)]
        assert any("nmap did not run: nmap: command not found" in e for e in events)

    def test_launching_records_a_running_job(self, plugin):
        result = _launch(plugin, pid=1234)
        job = plugin.jobs.running()
        assert job["kind"] == "scan" and job["pid"] == 1234
        assert result.status is None and result.snapshot is None

    def test_a_failed_launch_is_unavailable_and_records_no_job(self, plugin):
        result = _cycle(plugin, CmdResult(-1, "", "agent offline"))
        assert result.status == "unavailable"
        assert plugin.jobs.running() is None

    def test_a_running_job_is_polled_instead_of_relaunched(self, plugin):
        _launch(plugin)
        text = plugin.commands()[0].text
        assert "kill -0 4242" in text and "setsid" not in text
        assert "tail -c +1 " in text

    def test_a_running_scan_keeps_the_previous_snapshot(self, plugin):
        _collect(plugin, _scan(_port(443, "https", POODLE)))
        before = plugin.data.latest_snapshot()
        _launch(plugin)
        partial = ('<?xml version="1.0"?>\n<nmaprun scanner="nmap">\n'
                   '<taskprogress task="NSE" time="1" percent="45.00" remaining="120" etc="2"/>\n')
        result = _cycle(plugin, _poll(partial))
        assert result.status is None and result.snapshot is None
        assert plugin.data.latest_snapshot() == before
        assert _latest_status() == "failed"
        assert plugin.jobs.running()["progress"] == "NSE: 45% done, about 2 Minutes left"

    def test_progress_names_a_task_that_began(self, plugin):
        _launch(plugin)
        _cycle(plugin, _poll('<nmaprun>\n<taskbegin task="Service scan" time="1"/>\n'))
        assert plugin.jobs.running()["progress"] == "Service scan running"

    def test_output_reaches_the_job_log_once(self, plugin, db_manager):
        _launch(plugin)
        first = "<nmaprun>\n"
        _cycle(plugin, _poll(first))
        _cycle(plugin, _poll(first + '<taskbegin task="NSE" time="1"/>\n'))
        job_id = plugin.jobs.running()["id"]
        lines = [row["message"] for row in db_manager.job_output(job_id, limit=0)]
        assert lines == ["<nmaprun>", '<taskbegin task="NSE" time="1"/>']

    def test_a_finished_scan_is_parsed_from_its_whole_output(self, plugin):
        _launch(plugin)
        _cycle(plugin, _poll("<?xml"))
        result = _cycle(plugin, _poll(_scan(_port(80, "http", LIKELY)).stdout, 0, alive=False))
        assert result.status == "warning"
        assert plugin.jobs.running() is None
        assert plugin.jobs.recent()[0]["state"] == "succeeded"

    def test_a_scan_that_timed_out_fails_its_job(self, plugin):
        _launch(plugin)
        result = _cycle(plugin, _poll('<?xml version="1.0"?><nmaprun><host>', 124, alive=False))
        assert plugin.jobs.recent()[0]["state"] == "failed"
        assert result.status == "unavailable"
        assert "did not finish within 20 Minutes" in result.logs[0][0]

    def test_a_vanished_scan_fails_its_job(self, plugin):
        _launch(plugin)
        result = _cycle(plugin, _poll("", None, alive=False))
        assert plugin.jobs.recent()[0]["state"] == "failed"
        assert result.status == "unavailable"

    def test_an_unanswered_poll_leaves_the_job_running(self, plugin):
        _launch(plugin)
        result = _cycle(plugin, CmdResult(-1, "", "Agent 'x' is not connected"))
        assert plugin.jobs.running() is not None
        assert result.status is None
        assert any("Could not poll" in message for message, _ in result.logs)

    def test_a_restarted_monitor_adopts_the_running_scan(self, make_plugin, plugin):
        _launch(plugin, pid=777)
        restarted = make_plugin(VulnScan, BASE_CFG)
        assert "kill -0 777" in restarted.commands()[0].text

    def test_a_running_scan_is_polled_sooner_than_the_interval(self, plugin):
        assert plugin.next_cycle_in() is None
        _launch(plugin)
        assert plugin.next_cycle_in() == 30

    def test_job_poll_is_configurable(self, make_plugin):
        p = make_plugin(VulnScan, {**BASE_CFG, "job_poll": "10s"})
        assert "--stats-every 10s" in p._scan_command()
        _launch(p)
        assert p.next_cycle_in() == 10


class TestUiSpec:
    def test_scan_runs_have_a_job_panel(self, plugin):
        assert plugin.UI_SPEC['job_panel']['title'] == 'Scan runs'
        assert ['jobs'] in plugin.UI_SPEC['layout']

    def test_findings_table_has_a_title(self, plugin):
        assert plugin.UI_SPEC['tables']['findings']['title'] == 'Findings'

    async def test_finding_counts_share_one_bar(self, plugin):
        findings = plugin.UI_SPEC['cards']['vulnerable_card']
        assert findings['kind'] == 'share'
        assert [(p['metric'], p['color']) for p in findings['parts']] == [
            ('vulnerable', 'failed'), ('suspected', 'warning'), ('noted', 'neutral')]

    async def test_every_card_is_laid_out_and_every_cell_defined(self, plugin):
        spec = plugin.UI_SPEC
        laid_out = {cell for row in spec['layout'] for cell in row}
        defined = set(spec['cards']) | set(spec['tables']) | {'host_card', 'chart', 'jobs', 'events'}
        assert set(spec['cards']) <= laid_out
        assert laid_out <= defined
