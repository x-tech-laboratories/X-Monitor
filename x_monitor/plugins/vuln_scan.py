"""Network vulnerability exposure: one `nmap --script vuln` sweep of a host per
cycle. The scan runs wherever this monitor's agent (or SSH target) lives and is
pointed at `scan_host`, so it sees the host the way a network peer does —
through its firewall — rather than over loopback, where a host's own firewall
lets everything through. Every finding the NSE vuln scripts report is one row:
a definite `VULNERABLE` state fails the monitor, a `LIKELY VULNERABLE` one
warns, and a `vulners` version match is graded by its CVSS score against
`warning_cvss` / `threshold_cvss`, either null to turn it off. Open ports and
their detected services are kept alongside so a new exposure is visible even
when no script objects to it.
The scan runs as a detached job on the scanning host, so an X-Monitor restart
or redeploy never kills a scan in flight: a cycle with no job running launches
it, later cycles poll it every `job_poll` instead of every interval, and the
finished scan's whole XML output becomes the new snapshot. While it runs the
previous snapshot and status stay, and its output and progress show in the
scan runs panel.
A host that does not answer discovery, a scan that overruns `timeout`, or a
scanning host without nmap measured nothing and is unavailable.
Config: scan_host, ports, scripts, script_args, service_detection,
discovery_ports, nmap_args, warning_cvss, threshold_cvss, likely_status,
max_findings, require_sudo, nmap_bin, timeout (the longest a scan may take
before it is killed), job_poll. The monitor is labelled with `scan_host`, not
with the agent it runs on, and a card names the scanner."""

import shlex
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

from x_monitor.plugins.base.plugin_base import Plugin
from x_monitor.core.connectors import ssh_connector as detached
from x_monitor.core.connectors.types import CmdResult, Command, CollectResult, Status
from x_monitor.plugins.base.plugin_helpers import (
    StatusAccumulator, deadline_prefix, format_age, format_duration, level_for, limit_from,
    parse_duration,
)


_DEFAULT_LAYOUT = [
    ['host_card', 'scanner_card', 'last_scan_card', 'duration_card'],
    ['vulnerable_card', 'open_ports_card'],
    ['findings'],
    ['ports'],
    ['chart'],
    ['jobs'],
    ['events'],
]

# The kind the scan's detached job is recorded under.
_JOB_KIND = 'scan'

# Starts each line nmap writes to stderr, which reaches the job's log as it is written and is kept out of the XML.
_ERR_PREFIX = '@@nmap-stderr '

# The NSE vulns library's states: VULNERABLE, VULNERABLE (Exploitable) and VULNERABLE (DoS) are definite, LIKELY VULNERABLE is a suspicion.
_LIKELY_STATE = 'LIKELY VULNERABLE'

# Finding grades, named after the status each one escalates the monitor to.
_FAILED, _WARNING, _NOTED = 'failed', 'warning', 'online'
_GRADE_LABEL = {_FAILED: 'VULNERABLE', _WARNING: 'LIKELY', _NOTED: 'NOTE'}

# Service-detection output nmap attaches as a script when it cannot identify a service; never a finding.
_IGNORED_SCRIPTS = ('fingerprint-strings',)

# The output a script leaves when it found nothing; a plain-text result that reads like this is not a finding.
_NEGATIVE_PHRASES = ("couldn't find", 'could not find', 'no vulnerabilities', 'not vulnerable',
                     'no exploitable', 'nothing found')


def _severity(value, default: str) -> str:
    """Read a configured status name, falling back on anything unrecognised."""
    try:
        return str(Status(str(value)))
    except ValueError:
        return default


def _elem_text(table: ET.Element, key: str) -> Optional[str]:
    """The text of the `<elem key=...>` directly under a table, if present."""
    elem = table.find(f"elem[@key='{key}']")
    return elem.text.strip() if elem is not None and elem.text else None


def _table_items(table: ET.Element, key: str) -> List[str]:
    """The texts listed in a `<table key=...>` under a table."""
    inner = table.find(f"table[@key='{key}']")
    if inner is None:
        return []
    return [e.text.strip() for e in inner.findall('elem') if e.text]


def _cvss_of(table: ET.Element) -> Optional[float]:
    """The CVSS score a vulns-library table carries under `scores`."""
    scores = table.find("table[@key='scores']")
    if scores is None:
        return None
    for key in ('CVSS', 'CVSSv3', 'CVSSv2'):
        value = _elem_text(scores, key)
        if value:
            try:
                return float(value.split()[0])
            except ValueError:
                continue
    return None


def _grade_state(state: str, likely_status: str) -> Optional[str]:
    """The grade a vulns-library state earns, or None for one that says nothing."""
    if state.startswith('VULNERABLE'):
        return _FAILED
    if state == _LIKELY_STATE:
        return likely_status
    return None


def _grade_cvss(cvss: Optional[float], warning: Optional[float],
                threshold: Optional[float]) -> str:
    """The grade a version-matched advisory earns from its CVSS score."""
    if cvss is None:
        return _NOTED
    return {'failed': _FAILED, 'warning': _WARNING}.get(level_for(cvss, warning, threshold), _NOTED)


def _looks_vulnerable(text: str) -> bool:
    """Whether a script's plain output declares a vulnerability outright."""
    return 'VULNERABLE' in text and 'NOT VULNERABLE' not in text


def _looks_negative(text: str) -> bool:
    """Whether a script's plain output is one of the stock nothing-found lines."""
    lowered = text.lower()
    return any(phrase in lowered for phrase in _NEGATIVE_PHRASES)


def _progress(output: str) -> str:
    """A running scan's progress line, read from the last task nmap reported in its XML."""
    try:
        tasks = [ET.fromstring(line.strip()) for line in output.splitlines()
                 if line.strip().startswith(('<taskbegin', '<taskprogress', '<taskend'))]
    except ET.ParseError:
        tasks = []
    if not tasks:
        return 'Scan started'
    task = tasks[-1]
    name = task.get('task', 'scan')
    if task.tag == 'taskprogress':
        remaining = task.get('remaining')
        left = f", about {format_duration(int(remaining))} left" if remaining and remaining.isdigit() else ''
        return f"{name}: {float(task.get('percent') or 0):.0f}% done{left}"
    if task.tag == 'taskbegin':
        return f"{name} running"
    return f"{name} done"


class VulnScan(Plugin):
    RUNS_ON_AGENT = False
    DEFAULT_TIMEOUT = '20m'

    def __init__(self, name: str, config):
        config = {'timeout': self.DEFAULT_TIMEOUT, **config}
        super().__init__(name, config)
        self.scan_host = str(config.get('scan_host') or config.get('target_host') or 'localhost')
        self.ports = str(config['ports']) if config.get('ports') else None
        self.scripts = str(config.get('scripts', 'vuln'))
        self.script_args = str(config['script_args']) if config.get('script_args') else None
        self.service_detection = bool(config.get('service_detection', True))
        self.discovery_ports = [int(p) for p in config.get('discovery_ports', [22, 80, 443])]
        self.nmap_args = [str(a) for a in config.get('nmap_args', [])]
        self.warning_cvss = limit_from(config, 'warning_cvss', 4.0)
        self.threshold_cvss = limit_from(config, 'threshold_cvss', 7.0)
        self.likely_status = _severity(config.get('likely_status'), 'warning')
        self.max_findings = int(config.get('max_findings', 200))
        self.require_sudo = bool(config.get('require_sudo', False))
        self.nmap_bin = str(config.get('nmap_bin', 'nmap'))
        # The monitor is about the scanned host; the agent or SSH host is only where nmap runs.
        self.display_target = self.scan_host
        self.scanner = str(config.get('agent') or config.get('ssh_config', {}).get('host') or 'localhost')
        self.job_poll_interval = parse_duration(config.get('job_poll', '30s'))
        # One fixed directory per monitor, so finished scans never pile up on the scanning host.
        self.workdir = detached.workdir_for(f'vuln_scan-{self.id}')
        self._polling_job = None

    # --- collection ---

    def _scan_command(self) -> str:
        """The nmap invocation, bounded by a deadline placed inside any sudo."""
        # Progress lines in the XML let a running scan report how far it has got.
        argv = [self.nmap_bin, '-n', '-oX', '-', '--stats-every', f'{int(self.job_poll_interval)}s']
        if self.discovery_ports:
            argv.append('-PS' + ','.join(str(p) for p in self.discovery_ports))
        else:
            argv.append('-Pn')
        if self.service_detection:
            argv.append('-sV')
        argv += ['--script', self.scripts]
        if self.script_args:
            argv += ['--script-args', self.script_args]
        if self.ports:
            argv += ['-p', self.ports]
        argv += self.nmap_args
        argv.append(self.scan_host)
        prefix = ['sudo', '-n'] if self.require_sudo else []
        return ' '.join(prefix + deadline_prefix(int(self.timeout)) + [shlex.quote(a) for a in argv])

    def _run_command(self) -> str:
        """The scan with each stderr line marked as it is written, so a warning shows at once and is told apart from the XML."""
        status = f'"{self.workdir}/status"'
        return (detached.stream_stderr(self._scan_command(), status, prefix=_ERR_PREFIX)
                + f'; exit "$(cat {status})"')

    def commands(self) -> List[Command]:
        self._polling_job = None
        job = self.jobs.running() if self.jobs else None
        if job and job.get('pid') and job.get('workdir'):
            # parse() must read the results the way they were requested, even if the job ends mid-cycle.
            self._polling_job = job
            # Every poll reads the whole output, since the finished scan is parsed from all of it.
            return [Command(detached.poll_command(job['workdir'], job['pid'], 0))]
        return [Command(detached.launch_command(self._run_command(), self.workdir))]

    def parse(self, results: List[CmdResult]) -> CollectResult:
        job, self._polling_job = self._polling_job, None
        if not results:
            return CollectResult.unavailable('No scan result for this cycle')
        if job is not None:
            return self._parse_poll(job, results[0])
        return self._parse_launch(results[0])

    def _parse_launch(self, result: CmdResult) -> CollectResult:
        """Record the launched scan as a job; until it finishes the previous snapshot stands."""
        pid = detached.parse_launch(result.stdout) if result.exit_code == 0 else None
        if pid is None:
            reason = (result.stderr or result.stdout).strip()[:200] or f'exit {result.exit_code}'
            return CollectResult.unavailable(f"Could not start the scan: {reason}")
        job_id = self.jobs.create(_JOB_KIND, self._run_command(), self.workdir)
        self.jobs.set_pid(job_id, pid)
        return CollectResult()

    def _parse_poll(self, job: dict, result: CmdResult) -> CollectResult:
        """Advance the running scan from one poll, and parse its whole output once it finishes."""
        job_id = job['id']
        # A poll that never reached the scanning host says nothing about the job; only a real answer may finish it.
        if result.exit_code != 0 and not result.stdout.strip():
            return CollectResult(logs=[(
                f"Could not poll the running scan: "
                f"{(result.stderr or '').strip()[:200] or f'exit {result.exit_code}'}", 'WARNING')])
        poll = detached.parse_poll(result.stdout)
        finished = poll.exit_code is not None or not poll.alive

        # output_seq counts the characters of the output already copied into the job's log.
        fresh = poll.new_output[job['output_seq']:]
        lines, consumed = detached.split_lines(fresh)
        if finished and fresh[consumed:]:
            lines.append(fresh[consumed:])
            consumed = len(fresh)
        if lines:
            self.jobs.append_output(job_id, lines)
            self.jobs.bump_output_seq(job_id, job['output_seq'] + consumed)
        self.jobs.set_progress(job_id, _progress(poll.new_output))

        if not finished:
            return CollectResult()
        if poll.exit_code is None:
            self.jobs.finish(job_id, 'failed', exit_code=-1,
                             error='Process ended without writing an exit code')
            return CollectResult.unavailable('The scan ended before it finished')
        error = f"Exited with status {poll.exit_code}" if poll.exit_code else None
        self.jobs.finish(job_id, 'failed' if error else 'succeeded', exit_code=poll.exit_code, error=error)
        return self._parse_scan(poll.new_output, poll.exit_code)

    def _parse_scan(self, output: str, exit_code: int) -> CollectResult:
        """Turn a finished scan's whole output into the cycle's result."""
        lines = output.split('\n')
        errors = '\n'.join(line[len(_ERR_PREFIX):] for line in lines if line.startswith(_ERR_PREFIX))
        output = '\n'.join(line for line in lines if not line.startswith(_ERR_PREFIX))
        if '<nmaprun' not in output:
            reason = (errors or output).strip()[-200:] or f'exit {exit_code}'
            return CollectResult.unavailable(f"nmap did not run: {reason}")
        start = output.find('<?xml')
        start = start if start >= 0 else output.find('<nmaprun')
        end = output.find('</nmaprun>', start)
        xml = output[start:end + len('</nmaprun>')] if end >= 0 else output[start:]
        try:
            root = ET.fromstring(xml)
        except ET.ParseError:
            return CollectResult.unavailable(
                f"The scan of {self.scan_host} did not finish within "
                f"{format_duration(int(self.timeout))}")

        host = root.find('host')
        status = host.find('status') if host is not None else None
        if host is None or status is None or status.get('state') != 'up':
            probe = (', '.join(str(p) for p in self.discovery_ports)
                     if self.discovery_ports else 'no discovery')
            return CollectResult(
                metrics={'host_up': 0.0},
                logs=[(f"{self.scan_host} did not answer on ports {probe}; nothing scanned",
                       'WARNING')],
                status=str(Status.UNAVAILABLE))

        return self._assemble(root, host)

    def _assemble(self, root: ET.Element, host: ET.Element) -> CollectResult:
        """Turn a completed scan into metrics, one row per open port and per
        finding, and the worst grade any finding earned."""
        acc = StatusAccumulator()
        open_ports = self._open_ports(host)
        findings = self._findings(host)
        for finding in findings:
            acc.escalate(finding['grade'])

        counts = {grade: sum(1 for f in findings if f['grade'] == grade)
                  for grade in (_FAILED, _WARNING, _NOTED)}
        finished = root.find('runstats/finished')
        elapsed = float(finished.get('elapsed') or 0) if finished is not None else 0.0
        ended = host.get('endtime') or (finished.get('time') if finished is not None else None)
        scanned_at = int(ended) if ended and ended.isdigit() else int(time.time())
        address = host.find('address')
        addr = address.get('addr') if address is not None else self.scan_host

        summary = (f"{self.scan_host} ({addr}): {len(open_ports)} open ports, "
                   f"{counts[_FAILED]} vulnerable, {counts[_WARNING]} likely, "
                   f"{counts[_NOTED]} noted, scanned in {format_duration(int(elapsed))}")
        logs: List[Tuple[str, str]] = [(summary, acc.log_level)]
        for finding in findings:
            if finding['grade'] == _NOTED:
                continue
            logs.append((
                f"{finding['port']} {finding['service']}: {finding['title']} "
                f"[{finding['script']}] {finding['state']}",
                Status(finding['grade']).log_level))

        metrics = {
            'vulnerable': float(counts[_FAILED]),
            'suspected': float(counts[_WARNING]),
            'noted': float(counts[_NOTED]),
            'open_ports': float(len(open_ports)),
            'scan_seconds': elapsed,
            'host_up': 1.0,
            'last_scan_epoch': float(scanned_at),
        }
        return CollectResult(
            metrics=metrics, logs=logs, status=str(acc.status),
            snapshot={'host': self.scan_host, 'address': addr, 'scanned_at': scanned_at,
                      'elapsed': elapsed, 'nmap_version': root.get('version'),
                      'open_ports': open_ports, 'findings': findings[:self.max_findings]},
        )

    @staticmethod
    def _open_ports(host: ET.Element) -> List[Dict[str, Any]]:
        """One row per open port, with whatever service detection learned."""
        rows = []
        for port in host.findall('ports/port'):
            state = port.find('state')
            if state is None or state.get('state') != 'open':
                continue
            service = port.find('service')
            svc = service.attrib if service is not None else {}
            rows.append({
                'port': f"{port.get('portid')}/{port.get('protocol')}",
                'service': svc.get('name', '') + ('/ssl' if svc.get('tunnel') == 'ssl' else ''),
                'product': svc.get('product', ''),
                'version': ' '.join(v for v in (svc.get('version'), svc.get('extrainfo')) if v),
            })
        return rows

    def _findings(self, host: ET.Element) -> List[Dict[str, Any]]:
        """Every finding the scripts reported, on ports and against the host."""
        findings: List[Dict[str, Any]] = []
        for port in host.findall('ports/port'):
            service = port.find('service')
            label = f"{port.get('portid')}/{port.get('protocol')}"
            name = service.get('name', '') if service is not None else ''
            for script in port.findall('script'):
                findings += self._script_findings(script, label, name)
        for script in host.findall('hostscript/script'):
            findings += self._script_findings(script, 'host', '')
        order = {_FAILED: 0, _WARNING: 1, _NOTED: 2}
        findings.sort(key=lambda f: (order[f['grade']], f['port'], f['script'], f['id']))
        return findings

    def _script_findings(self, script: ET.Element, port: str, service: str) -> List[Dict[str, Any]]:
        """The findings one script's result holds: vulns-library tables, a
        vulners advisory list, or a plain-text verdict."""
        script_id = script.get('id', '')
        if script_id in _IGNORED_SCRIPTS:
            return []
        base = {'port': port, 'service': service, 'script': script_id}
        if script_id == 'vulners':
            return self._vulners_findings(script, base)

        findings = []
        for table in script.findall('table'):
            state = _elem_text(table, 'state')
            if state is None:
                continue
            grade = _grade_state(state, self.likely_status)
            if grade is None:
                continue
            ids = _table_items(table, 'ids')
            cvss = _cvss_of(table)
            findings.append({
                **base,
                'id': (ids[0].split(':', 1)[-1] if ids else table.get('key', '')),
                'title': _elem_text(table, 'title') or table.get('key', script_id),
                'state': state,
                'cvss': cvss,
                'grade': grade,
            })
        if findings:
            return findings

        text = (script.get('output') or '').strip()
        if not text or _looks_negative(text):
            return []
        first_line = next((line.strip() for line in text.splitlines() if line.strip()), script_id)
        if _looks_vulnerable(text):
            return [{**base, 'id': script_id, 'title': first_line[:120], 'state': 'VULNERABLE',
                     'cvss': None, 'grade': _FAILED}]
        if script.find('table') is not None or script.find('elem') is not None:
            return [{**base, 'id': script_id, 'title': first_line[:120], 'state': 'reported',
                     'cvss': None, 'grade': _NOTED}]
        return []

    def _vulners_findings(self, script: ET.Element, base: Dict[str, str]) -> List[Dict[str, Any]]:
        """One finding per advisory vulners matched to a detected version."""
        findings = []
        for cpe_table in script.findall('table'):
            for entry in cpe_table.findall('table'):
                advisory = _elem_text(entry, 'id')
                if not advisory:
                    continue
                cvss_text = _elem_text(entry, 'cvss')
                try:
                    cvss = float(cvss_text) if cvss_text else None
                except ValueError:
                    cvss = None
                exploit = (_elem_text(entry, 'is_exploit') or '').lower() == 'true'
                findings.append({
                    **base,
                    'id': advisory,
                    'title': f"{cpe_table.get('key', '')} matches {advisory}",
                    'state': (f"CVSS {cvss:.1f}" if cvss is not None else 'unscored')
                             + (' · exploit' if exploit else ''),
                    'cvss': cvss,
                    'grade': _grade_cvss(cvss, self.warning_cvss, self.threshold_cvss),
                })
        return findings

    # --- UI ---

    def _metric(self, name: str) -> Optional[float]:
        metric = self.data.latest_metric(name)
        return metric.value if metric is not None else None

    def _last_scan_pair(self) -> Tuple[str, Optional[str]]:
        epoch = self._metric('last_scan_epoch')
        if not epoch:
            return 'NEVER', 'unavailable'
        age = int(time.time()) - int(epoch)
        # A second interval passing without a fresh scan means the sweeps have stopped landing.
        return format_age(age), 'warning' if age > 2 * self.interval else 'online'

    @property
    def _last_scan_text(self) -> str:
        return self._last_scan_pair()[0]

    @property
    def _last_scan_color(self) -> Optional[str]:
        return self._last_scan_pair()[1]

    @property
    def _duration_text(self) -> str:
        seconds = self._metric('scan_seconds')
        return '--' if seconds is None else format_duration(int(seconds))

    @property
    def _finding_rows(self) -> List[Dict[str, str]]:
        snapshot = self.data.latest_snapshot(default={}) or {}
        rows = []
        for index, finding in enumerate(snapshot.get('findings') or []):
            cvss = finding.get('cvss')
            rows.append({
                'key': f"{index}-{finding.get('id', '')}",
                'severity': _GRADE_LABEL.get(finding.get('grade'), 'NOTE'),
                'grade': finding.get('grade', _NOTED),
                'port': finding.get('port', ''),
                'service': finding.get('service', ''),
                'script': finding.get('script', ''),
                'id': finding.get('id', ''),
                'title': finding.get('title', ''),
                'cvss': f"{cvss:.1f}" if isinstance(cvss, (int, float)) else '--',
                'state': finding.get('state', ''),
            })
        return rows

    @property
    def _port_rows(self) -> List[Dict[str, str]]:
        snapshot = self.data.latest_snapshot(default={}) or {}
        return [{
            'port': row.get('port', ''),
            'service': row.get('service', ''),
            'product': row.get('product', ''),
            'version': row.get('version', ''),
        } for row in snapshot.get('open_ports') or []]

    @property
    def UI_SPEC(self):
        return {
            'layout': _DEFAULT_LAYOUT,
            'cards': {
                'scanner_card': {'title': 'SCANNED FROM', 'value': self.scanner},
                'vulnerable_card': {
                    'kind': 'share', 'title': 'FINDINGS', 'format': 'int',
                    'parts': [
                        {'metric': 'vulnerable', 'label': 'Vulnerable', 'color': 'failed'},
                        {'metric': 'suspected', 'label': 'Likely', 'color': 'warning'},
                        {'metric': 'noted', 'label': 'Noted', 'color': 'neutral'},
                    ],
                },
                'last_scan_card': {'title': 'LAST SCAN', 'value_attr': '_last_scan_text',
                                   'color_attr': '_last_scan_color', 'refresh': True},
                'duration_card': {'title': 'SCAN TIME', 'value_attr': '_duration_text',
                                  'refresh': True},
                'open_ports_card': {'metric': 'open_ports', 'title': 'OPEN PORTS',
                                    'format': 'int'},
            },
            'tables': {
                'findings': {
                    'title': 'Findings',
                    'row_key': 'key',
                    'rows_attr': '_finding_rows',
                    'columns': [
                        {'name': 'severity', 'label': 'Severity', 'field': 'severity',
                         'align': 'left', 'cell_color_by': lambda row: row.get('grade')},
                        {'name': 'port', 'label': 'Port', 'field': 'port', 'align': 'left'},
                        {'name': 'service', 'label': 'Service', 'field': 'service', 'align': 'left'},
                        {'name': 'id', 'label': 'ID', 'field': 'id', 'align': 'left'},
                        {'name': 'title', 'label': 'Finding', 'field': 'title', 'align': 'left'},
                        {'name': 'cvss', 'label': 'CVSS', 'field': 'cvss', 'align': 'right'},
                        {'name': 'state', 'label': 'State', 'field': 'state', 'align': 'left'},
                        {'name': 'script', 'label': 'Script', 'field': 'script', 'align': 'left'},
                    ],
                },
                'ports': {
                    'row_key': 'port',
                    'rows_attr': '_port_rows',
                    'columns': [
                        {'name': 'port', 'label': 'Port', 'field': 'port', 'align': 'left'},
                        {'name': 'service', 'label': 'Service', 'field': 'service', 'align': 'left'},
                        {'name': 'product', 'label': 'Product', 'field': 'product', 'align': 'left'},
                        {'name': 'version', 'label': 'Version', 'field': 'version', 'align': 'left'},
                    ],
                },
            },
            'chart': {'metric': 'vulnerable', 'title': f'VULNERABILITIES — {self.scan_host}'},
            'job_panel': {'widget': 'jobs', 'title': 'Scan runs', 'history_limit': 10},
            'events': {'title': 'Events', 'limit': 100, 'full_height': True},
        }
