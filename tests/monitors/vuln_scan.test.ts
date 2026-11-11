import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launch_command, parse_launch } from "../../src/core/connectors/job_commands.ts";
import { cmd_result, type CmdResult, type CollectResult } from "../../src/core/connectors/types.ts";
import { DatabaseManager } from "../../src/core/database/database.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { VulnScan } from "../../src/monitors/vuln_scan.ts";
import { make_plugin, make_test_plugin, run_cycle, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-vuln-scan",
  id: "test-vuln-scan",
  interval: 86400,
  scan_host: "web-01.example.com",
  ssh_config: { host: "scanner.host" },
};

const latest_status = (plugin: VulnScan) => store_of(plugin).store.statuses.get(plugin.id)?.state ?? null;
const latest_metric = (plugin: VulnScan, name: string) => store_of(plugin).latest_metric(plugin.id, name)?.value ?? null;

// The vulns-library table nmap writes for a definite finding, as ssl-poodle renders it.
const poodle = `<script id="ssl-poodle" output="&#xa;  VULNERABLE:&#xa;  SSL POODLE information leak"><table key="CVE-2014-3566">
<elem key="title">SSL POODLE information leak</elem>
<elem key="state">VULNERABLE</elem>
<table key="ids"><elem>CVE:CVE-2014-3566</elem><elem>BID:70574</elem></table>
<table key="scores"><elem key="CVSS">4.3</elem></table>
<table key="description"><elem>The SSL protocol 3.0 uses nondeterministic CBC padding.</elem></table>
<table key="refs"><elem>https://www.openssl.org/~bodo/ssl-poodle.pdf</elem></table>
</table></script>`;

const likely = `<script id="http-slowloris-check" output="&#xa;  LIKELY VULNERABLE"><table key="CVE-2007-6750">
<elem key="title">Slowloris DOS attack</elem>
<elem key="state">LIKELY VULNERABLE</elem>
<table key="ids"><elem>CVE:CVE-2007-6750</elem></table>
</table></script>`;

const negative = `<script id="http-csrf" output="Couldn&apos;t find any CSRF vulnerabilities."></script>`;

const plain_positive = `<script id="ftp-vsftpd-backdoor" output="&#xa;  VULNERABLE:&#xa;  vsFTPd version 2.3.4 backdoor"></script>`;

const vulners = `<script id="vulners" output="&#xa;  cpe:/a:openbsd:openssh:7.4: &#xa;    CVE-2018-15473 5.0"><table key="cpe:/a:openbsd:openssh:7.4">
<table><elem key="id">CVE-2018-15473</elem><elem key="type">cve</elem><elem key="is_exploit">false</elem><elem key="cvss">5.0</elem></table>
<table><elem key="id">CVE-2016-6515</elem><elem key="type">cve</elem><elem key="is_exploit">false</elem><elem key="cvss">7.8</elem></table>
<table><elem key="id">EDB-ID:45233</elem><elem key="type">exploitdb</elem><elem key="is_exploit">true</elem><elem key="cvss">0.0</elem></table>
</table></script>`;

const hostscript = `<hostscript><script id="smb-vuln-ms17-010" output="VULNERABLE"><table key="CVE-2017-0143">
<elem key="title">Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)</elem>
<elem key="state">VULNERABLE</elem>
<table key="ids"><elem>CVE:CVE-2017-0143</elem></table>
</table></script></hostscript>`;

function port(portid: number, name: string, scripts = "", options: { product?: string; version?: string; tunnel?: string; state?: string } = {}): string {
  let service = `<service name="${name}"`;
  if (options.product) service += ` product="${options.product}"`;
  if (options.version) service += ` version="${options.version}"`;
  if (options.tunnel) service += ` tunnel="${options.tunnel}"`;
  service += ' method="probed" conf="10"/>';
  return `<port protocol="tcp" portid="${portid}"><state state="${options.state ?? "open"}" reason="syn-ack" ` + `reason_ttl="0"/>${service}${scripts}</port>`;
}

// The XML nmap writes to stdout with -oX - for a one-host scan.
function scan(ports = "", options: { hostscript?: string; up?: boolean; elapsed?: number; ended?: number } = {}): CmdResult {
  const ended = options.ended ?? Math.trunc(Date.now() / 1000);
  const elapsed = options.elapsed ?? 42.5;
  let host: string;
  let hosts: string;
  if (options.up ?? true) {
    host = `<host starttime="${ended - 40}" endtime="${ended}"><status state="up" reason="syn-ack" ` + `reason_ttl="0"/><address addr="192.0.2.10" addrtype="ipv4"/><hostnames>` + `</hostnames><ports>${ports}</ports>${options.hostscript ?? ""}</host>`;
    hosts = '<hosts up="1" down="0" total="1"/>';
  } else {
    host = '<host><status state="down" reason="no-response" reason_ttl="0"/>' + '<address addr="192.0.2.10" addrtype="ipv4"/></host>';
    hosts = '<hosts up="0" down="1" total="1"/>';
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><nmaprun scanner="nmap" version="7.99" ` + `start="${ended - 45}">${host}<runstats><finished time="${ended}" elapsed="${elapsed}" ` + `exit="success"/>${hosts}</runstats></nmaprun>`;
  return cmd_result(0, xml, "");
}

function vuln(extra: PluginConfig = {}, db?: DatabaseManager): VulnScan {
  return make_plugin(VulnScan, { ...base_config, ...extra }, db);
}

// The raw stdout one poll of the detached scan produces on the scanning host.
function poll(out: string, exit_code: number | null = null, alive = true): CmdResult {
  return cmd_result(0, `===XMONITOR_SIZE===\n${out.length}\n` + `===XMONITOR_EXIT===\n${exit_code ?? ""}\n` + `===XMONITOR_ALIVE===\n${alive ? 1 : 0}\n` + `===XMONITOR_OUT===\n${out}`, "");
}

// One cycle whose command answers with this result.
function cycle(plugin: VulnScan, result: CmdResult): CollectResult {
  return run_cycle(plugin, () => result);
}

function launch(plugin: VulnScan, pid = 4242): CollectResult {
  return cycle(plugin, cmd_result(0, `${pid}\n`, ""));
}

// Launches the scan, then polls it once as finished with this result's output, its stderr marked as the run marks it.
function collect(plugin: VulnScan, result: CmdResult): CollectResult {
  launch(plugin);
  const errors = result.stderr.split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1).map((line) => `@@nmap-stderr ${line}\n`).join("");
  return cycle(plugin, poll(result.stdout + errors, result.exit_code, false));
}

function temp_dir(): string {
  return mkdtempSync(join(tmpdir(), "vuln-"));
}

function fake_nmap(folder: string, text: string): string {
  const path = join(folder, "nmap");
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

describe("command", () => {
  it("runs nmap against scan_host under a deadline", () => {
    const text = vuln().scan_command();
    expect(text.startsWith("timeout -k 5 1200 nmap -n -oX - --stats-every 30s -PS22,80,443 -sV --script vuln ")).toBe(true);
    expect(text.endsWith(" web-01.example.com")).toBe(true);
  });

  it("carries the options onto the command line", () => {
    const text = vuln({
      ports: "1-1024", scripts: "vuln and not http-slowloris-check", script_args: "vulns.showall=1", nmap_args: ["-T4"],
      discovery_ports: [], service_detection: false, require_sudo: true, timeout: "5m",
    }).scan_command();
    expect(text.startsWith("sudo -n timeout -k 5 300 nmap -n -oX - --stats-every 30s -Pn --script ")).toBe(true);
    expect(text).toContain("'vuln and not http-slowloris-check'");
    expect(text).toContain("--script-args vulns.showall=1");
    expect(text).toContain("-p 1-1024");
    expect(text).toContain("-T4 web-01.example.com");
    expect(text).not.toContain("-sV");
  });

  it("labels the monitor with the scanned host", () => {
    const plugin = vuln();
    expect(plugin.display_target).toBe("web-01.example.com");
    expect(plugin.target).toBe("web-01.example.com");
    expect(plugin.scanner).toBe("scanner.host");
  });

  it("names the agent as the scanner when one is set", () => {
    expect(vuln({ agent: "monitor" }).scanner).toBe("monitor");
  });

  it("falls back on target_host for the scan host", () => {
    const { scan_host: _scan_host, ssh_config: _ssh_config, ...rest } = base_config;
    const plugin = make_plugin(VulnScan, { ...rest, ssh_config: undefined, target_host: "db-01.example.com" });
    expect(plugin.scan_host).toBe("db-01.example.com");
  });
});

describe("grading", () => {
  it("calls a clean host online", () => {
    const plugin = vuln();
    collect(plugin, scan(port(22, "ssh", "", { product: "OpenSSH", version: "9.9" }) + port(443, "http", negative)));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "vulnerable")).toBe(0);
    expect(latest_metric(plugin, "open_ports")).toBe(2);
    expect(latest_metric(plugin, "host_up")).toBe(1);
    expect(latest_metric(plugin, "scan_seconds")).toBe(42.5);
  });

  it("fails a definite finding", () => {
    const plugin = vuln();
    collect(plugin, scan(port(443, "https", poodle)));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "vulnerable")).toBe(1);
    const rows = plugin.finding_rows;
    expect(rows[0].id).toBe("CVE-2014-3566");
    expect(rows[0].title).toBe("SSL POODLE information leak");
    expect(rows[0].cvss).toBe("4.3");
    expect(rows[0].severity).toBe("VULNERABLE");
    expect(rows[0].port).toBe("443/tcp");
  });

  it("warns on a likely finding", () => {
    const plugin = vuln();
    collect(plugin, scan(port(80, "http", likely)));
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "suspected")).toBe(1);
    expect(latest_metric(plugin, "vulnerable")).toBe(0);
  });

  it("takes a configured likely status", () => {
    const plugin = vuln({ likely_status: "online" });
    collect(plugin, scan(port(80, "http", likely)));
    expect(latest_status(plugin)).toBe("online");
  });

  it("counts a host script finding", () => {
    const plugin = vuln();
    collect(plugin, scan(port(445, "microsoft-ds"), { hostscript }));
    expect(latest_status(plugin)).toBe("failed");
    expect(plugin.finding_rows[0].port).toBe("host");
  });

  it("takes a plain-text verdict as a finding", () => {
    const plugin = vuln();
    collect(plugin, scan(port(21, "ftp", plain_positive)));
    expect(latest_status(plugin)).toBe("failed");
    expect(plugin.finding_rows[0].title).toBe("VULNERABLE:");
  });

  it("never takes a service fingerprint as a finding", () => {
    const plugin = vuln();
    const fingerprint = '<script id="fingerprint-strings" output="DNSVersionBindReqTCP: ..."><table key="DNSVersionBindReqTCP">' + "<elem>\\x00\\x1e\\x00\\x06\\x01</elem></table></script>";
    collect(plugin, scan(port(53, "domain", fingerprint)));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "noted")).toBe(0);
    expect(plugin.finding_rows).toEqual([]);
  });

  it("ignores nothing-found text", () => {
    const plugin = vuln();
    collect(plugin, scan(port(80, "http", negative)));
    expect(latest_status(plugin)).toBe("online");
    expect(plugin.finding_rows).toEqual([]);
  });

  it("grades vulners advisories by cvss", () => {
    const plugin = vuln();
    collect(plugin, scan(port(22, "ssh", vulners, { product: "OpenSSH", version: "7.4" })));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "vulnerable")).toBe(1);
    expect(latest_metric(plugin, "suspected")).toBe(1);
    expect(latest_metric(plugin, "noted")).toBe(1);
    const rows = plugin.finding_rows;
    expect(rows.map((row) => row.id)).toEqual(["CVE-2016-6515", "CVE-2018-15473", "EDB-ID:45233"]);
    expect(rows[2].state).toBe("CVSS 0.0 · exploit");
  });

  it("takes configured cvss thresholds", () => {
    const plugin = vuln({ warning_cvss: 9.0, threshold_cvss: 9.5 });
    collect(plugin, scan(port(22, "ssh", vulners)));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "noted")).toBe(3);
  });

  it("never fails with a cvss warning only", () => {
    const plugin = vuln({ threshold_cvss: null });
    collect(plugin, scan(port(22, "ssh", vulners)));
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "vulnerable")).toBe(0);
    expect(latest_metric(plugin, "suspected")).toBe(2);
  });

  it("never warns with a cvss failure only", () => {
    let plugin = vuln({ warning_cvss: null, threshold_cvss: 9.0 });
    collect(plugin, scan(port(22, "ssh", vulners)));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "noted")).toBe(3);
    plugin = vuln({ warning_cvss: null });
    collect(plugin, scan(port(22, "ssh", vulners)));
    expect(latest_status(plugin)).toBe("failed");
    expect(latest_metric(plugin, "suspected")).toBe(0);
  });

  it("caps the findings table but not the counts", () => {
    const plugin = vuln({ max_findings: 1 });
    collect(plugin, scan(port(22, "ssh", vulners)));
    expect(latest_metric(plugin, "noted")).toBe(1);
    expect(latest_metric(plugin, "vulnerable")).toBe(1);
    expect(plugin.finding_rows).toHaveLength(1);
  });
});

describe("ports", () => {
  it("lists open ports with their service", () => {
    const plugin = vuln();
    collect(plugin, scan(port(22, "ssh", "", { product: "OpenSSH", version: "10.5" }) + port(22000, "snapenetio", "", { tunnel: "ssl" }) + port(80, "http", "", { state: "closed" })));
    const rows = plugin.port_rows;
    expect(rows.map((row) => row.port)).toEqual(["22/tcp", "22000/tcp"]);
    expect(rows[0].product).toBe("OpenSSH");
    expect(rows[0].version).toBe("10.5");
    expect(rows[1].service).toBe("snapenetio/ssl");
  });
});

describe("failures", () => {
  it("calls a host that is down unavailable", () => {
    const plugin = vuln();
    collect(plugin, scan("", { up: false }));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(latest_metric(plugin, "host_up")).toBe(0);
  });

  it("calls a missing nmap unavailable", () => {
    const plugin = vuln();
    collect(plugin, cmd_result(127, "", "sh: nmap: command not found"));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls truncated output unavailable", () => {
    const plugin = vuln();
    collect(plugin, cmd_result(124, '<?xml version="1.0"?><nmaprun><host>', ""));
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls a lost launch reply unavailable", () => {
    const plugin = vuln();
    cycle(plugin, cmd_result(-1, "", "not connected"));
    expect(latest_status(plugin)).toBe("unavailable");
    expect(plugin.last_scan_color).toBe("unavailable");
  });

  it("ignores nmap warnings around the xml", () => {
    const plugin = vuln();
    const result = scan(port(443, "https", poodle));
    collect(plugin, cmd_result(0, result.stdout, "Warning: giving up on port because retransmission cap hit\n"));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("reads the scan time on the last scan card", () => {
    const plugin = vuln();
    expect(plugin.last_scan_text).toBe("NEVER");
    collect(plugin, scan(port(22, "ssh"), { ended: Math.trunc(Date.now() / 1000) - 3600 }));
    expect(plugin.last_scan_text.endsWith(" ago")).toBe(true);
    expect(plugin.last_scan_color).toBe("online");
  });
});

describe("detached job", () => {
  it("is never sampled on the agent", () => {
    expect(vuln().SAMPLED).toBe(false);
  });

  it("launches the scan when no job runs", () => {
    const [launched] = vuln().commands();
    expect(launched.text).toContain("setsid");
    expect(launched.text).toContain("vuln_scan-test-vuln-scan");
    expect(launched.text).toContain("timeout -k 5 1200 nmap");
  });

  it("marks stderr as it is written and keeps nmap's status", () => {
    const folder = temp_dir();
    const nmap = fake_nmap(folder, "#!/bin/sh\necho '<?xml version=\"1.0\"?>'\necho 'Warning: cap hit' >&2\n" + "echo '<nmaprun></nmaprun>'\nexit 2\n");
    const plugin = vuln({ nmap_bin: nmap, require_sudo: false });
    const done = spawnSync("sh", ["-c", `mkdir -p "${plugin.workdir}" && ${plugin.run_command()}`], { encoding: "utf8", env: { ...process.env, HOME: folder } });
    expect(done.status).toBe(2);
    expect(done.stdout.split("\n")).toContain("@@nmap-stderr Warning: cap hit");
    expect(done.stdout).toContain("<nmaprun></nmaprun>");
  });

  it("writes a launched scan's exit code for the poll", async () => {
    const folder = temp_dir();
    const nmap = fake_nmap(folder, "#!/bin/sh\necho '<nmaprun></nmaprun>'\nexit 2\n");
    const plugin = vuln({ nmap_bin: nmap, require_sudo: false });
    const launched = spawnSync("sh", ["-c", launch_command(plugin.run_command(), plugin.workdir)], { encoding: "utf8", env: { ...process.env, HOME: folder } });
    const pid = parse_launch(launched.stdout);
    const exit_file = join(folder, ".cache/x_monitor/jobs/vuln_scan-test-vuln-scan/exit");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(exit_file) || !existsSync(`/proc/${pid}`)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(exit_file, "utf8").trim()).toBe("2");
  });

  it("keeps a warning inside the xml out of it", () => {
    const plugin = vuln();
    const text = scan(port(443, "https", poodle)).stdout;
    const middle = text.indexOf("<host");
    launch(plugin);
    cycle(plugin, poll(text.slice(0, middle) + "\n@@nmap-stderr Warning: cap hit\n" + text.slice(middle), 0, false));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("names nmap's error when a scan has no xml", () => {
    const plugin = vuln();
    collect(plugin, cmd_result(1, "", "nmap: command not found"));
    const events = plugin.data.plugin_events(plugin.id).map((event) => event.message);
    expect(events.some((message) => message.includes("nmap did not run: nmap: command not found"))).toBe(true);
  });

  it("records a running job on launch", () => {
    const plugin = vuln();
    const result = launch(plugin, 1234);
    const job = plugin.jobs!.running()!;
    expect(job.kind).toBe("scan");
    expect(job.pid).toBe(1234);
    expect(result.status).toBeNull();
    expect(result.snapshot).toBeNull();
  });

  it("calls a failed launch unavailable and records no job", () => {
    const plugin = vuln();
    const result = cycle(plugin, cmd_result(-1, "", "agent offline"));
    expect(result.status).toBe("unavailable");
    expect(plugin.jobs!.running()).toBeNull();
  });

  it("polls a running job instead of relaunching it", () => {
    const plugin = vuln();
    launch(plugin);
    const text = plugin.commands()[0].text;
    expect(text).toContain("kill -0 4242");
    expect(text).not.toContain("setsid");
    expect(text).toContain("tail -c +1 ");
  });

  it("keeps the previous snapshot while a scan runs", () => {
    const plugin = vuln();
    collect(plugin, scan(port(443, "https", poodle)));
    const before = plugin.data.latest_snapshot();
    launch(plugin);
    const partial = '<?xml version="1.0"?>\n<nmaprun scanner="nmap">\n' + '<taskprogress task="NSE" time="1" percent="45.00" remaining="120" etc="2"/>\n';
    const result = cycle(plugin, poll(partial));
    expect(result.status).toBeNull();
    expect(result.snapshot).toBeNull();
    expect(plugin.data.latest_snapshot()).toEqual(before);
    expect(latest_status(plugin)).toBe("failed");
    expect(plugin.jobs!.running()!.progress).toBe("NSE: 45% done, about 2 Minutes left");
  });

  it("names a task that began in the progress", () => {
    const plugin = vuln();
    launch(plugin);
    cycle(plugin, poll('<nmaprun>\n<taskbegin task="Service scan" time="1"/>\n'));
    expect(plugin.jobs!.running()!.progress).toBe("Service scan running");
  });

  it("copies output into the job log once", () => {
    const { plugin, db } = make_test_plugin(VulnScan, base_config);
    launch(plugin);
    const first = "<nmaprun>\n";
    cycle(plugin, poll(first));
    cycle(plugin, poll(first + '<taskbegin task="NSE" time="1"/>\n'));
    const job_id = plugin.jobs!.running()!.id;
    expect(db.job_output(job_id, -1, 0).map((row) => row.message)).toEqual(["<nmaprun>", '<taskbegin task="NSE" time="1"/>']);
  });

  it("parses a finished scan from its whole output", () => {
    const plugin = vuln();
    launch(plugin);
    cycle(plugin, poll("<?xml"));
    const result = cycle(plugin, poll(scan(port(80, "http", likely)).stdout, 0, false));
    expect(result.status).toBe("warning");
    expect(plugin.jobs!.running()).toBeNull();
    expect(plugin.jobs!.recent()[0].state).toBe("succeeded");
  });

  it("fails the job of a scan that timed out", () => {
    const plugin = vuln();
    launch(plugin);
    const result = cycle(plugin, poll('<?xml version="1.0"?><nmaprun><host>', 124, false));
    expect(plugin.jobs!.recent()[0].state).toBe("failed");
    expect(result.status).toBe("unavailable");
    expect(result.logs[0][0]).toContain("did not finish within 20 Minutes");
  });

  it("fails the job of a vanished scan", () => {
    const plugin = vuln();
    launch(plugin);
    const result = cycle(plugin, poll("", null, false));
    expect(plugin.jobs!.recent()[0].state).toBe("failed");
    expect(result.status).toBe("unavailable");
  });

  it("leaves the job running after an unanswered poll", () => {
    const plugin = vuln();
    launch(plugin);
    const result = cycle(plugin, cmd_result(-1, "", "Agent 'x' is not connected"));
    expect(plugin.jobs!.running()).not.toBeNull();
    expect(result.status).toBeNull();
    expect(result.logs.some(([message]) => message.includes("Could not poll"))).toBe(true);
  });

  it("adopts the running scan after a restart", () => {
    const db = new DatabaseManager();
    launch(vuln({}, db), 777);
    expect(vuln({}, db).commands()[0].text).toContain("kill -0 777");
  });

  it("polls a running scan sooner than the interval", () => {
    const plugin = vuln();
    expect(plugin.next_cycle_in()).toBeNull();
    launch(plugin);
    expect(plugin.next_cycle_in()).toBe(30);
  });

  it("takes a configured job poll", () => {
    const plugin = vuln({ job_poll: "10s" });
    expect(plugin.scan_command()).toContain("--stats-every 10s");
    launch(plugin);
    expect(plugin.next_cycle_in()).toBe(10);
  });
});

describe("page", () => {
  it("gives scan runs a job panel", () => {
    const spec = vuln().UI_SPEC;
    expect(spec.job_panel!.title).toBe("Scan runs");
    expect(spec.layout).toContainEqual(["jobs"]);
  });

  it("titles the findings table", () => {
    expect((vuln().UI_SPEC.tables!.findings as { title?: string }).title).toBe("Findings");
  });

  it("shares one bar between the finding counts", () => {
    const findings = vuln().UI_SPEC.cards!.vulnerable_card;
    expect(findings.kind).toBe("share");
    expect(findings.parts!.map((part) => [part.metric, part.color])).toEqual([["vulnerable", "failed"], ["suspected", "warning"], ["noted", "neutral"]]);
  });

  it("lays out every card and defines every cell", () => {
    const spec = vuln().UI_SPEC;
    const laid_out = new Set(spec.layout!.flat().map((cell) => (typeof cell === "string" ? cell : cell.widget)));
    const defined = new Set([...Object.keys(spec.cards!), ...Object.keys(spec.tables!), "host_card", "chart", "jobs", "events"]);
    for (const card of Object.keys(spec.cards!)) expect(laid_out.has(card)).toBe(true);
    for (const cell of laid_out) expect(defined.has(cell)).toBe(true);
  });
});
