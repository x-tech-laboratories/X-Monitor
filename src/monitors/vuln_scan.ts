// Network vulnerability exposure: one `nmap --script vuln` sweep of a host per cycle. The scan runs wherever this
// monitor's agent (or SSH target) lives and is pointed at `scan_host`, so it sees the host the way a network peer does,
// through its firewall, rather than over loopback, where a host's own firewall lets everything through. Every finding
// the NSE vuln scripts report is one row: a definite `VULNERABLE` state fails the monitor, a `LIKELY VULNERABLE` one
// warns, and a `vulners` version match is graded by its CVSS score against `warning_cvss` / `threshold_cvss`, either
// null to turn it off. Open ports and their detected services are kept alongside so a new exposure is visible even when
// no script objects to it.
//
// The scan runs as a detached job on the scanning host, so an X-Monitor restart or redeploy never kills a scan in
// flight: a cycle with no job running launches it, later cycles poll it every `job_poll` instead of every interval, and
// the finished scan's whole XML output becomes the new snapshot. While it runs the previous snapshot and status stay,
// and its output and progress show in the scan runs panel. The engine asks the agent on `scan_host` to hold an idle
// inhibitor while a cycle runs, keyed on the `scan_host` config key; the monitor itself sends nothing.
//
// A host that does not answer discovery, a scan that overruns `timeout`, or a scanning host without nmap measured
// nothing and is unavailable. Config: scan_host, ports, scripts, script_args, service_detection, discovery_ports,
// nmap_args, warning_cvss, threshold_cvss, likely_status, max_findings, require_sudo, nmap_bin, timeout (the longest a
// scan may take before it is killed), job_poll. The monitor is labelled with `scan_host`, not with the agent it runs on,
// and a card names the scanner.

import { launch_command, parse_launch, parse_poll, poll_command, split_lines, stream_stderr, workdir_for } from "../core/connectors/job_commands.ts";
import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { JobDict } from "../core/state/records.ts";
import { shell_quote } from "../core/shell.ts";
import { is_status, log_level_of, type Status } from "../shared/status.ts";
import type { LayoutRow, TableSpec, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { deadline_prefix, format_age, format_duration, level_for, limit_from, parse_duration, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "scanner_card", "last_scan_card", "duration_card"],
  ["vulnerable_card", "open_ports_card"],
  ["findings"],
  ["ports"],
  ["chart"],
  ["jobs"],
  ["events"],
];

// The kind the scan's detached job is recorded under.
const job_kind = "scan";

// Starts each line nmap writes to stderr, which reaches the job's log as it is written and is kept out of the XML.
const err_prefix = "@@nmap-stderr ";

// The NSE vulns library's states: the VULNERABLE ones are definite, LIKELY VULNERABLE is a suspicion.
const likely_state = "LIKELY VULNERABLE";

// Finding grades, named after the status each one escalates the monitor to.
const failed_grade = "failed";
const warning_grade = "warning";
const noted_grade = "online";
const grade_label: Record<string, string> = { [failed_grade]: "VULNERABLE", [warning_grade]: "LIKELY", [noted_grade]: "NOTE" };

// Service-detection output nmap attaches as a script when it cannot identify a service; never a finding.
const ignored_scripts = ["fingerprint-strings"];

// The output a script leaves when it found nothing; a plain-text result that reads like this is not a finding.
const negative_phrases = ["couldn't find", "could not find", "no vulnerabilities", "not vulnerable", "no exploitable", "nothing found"];

// ── XML ──────────────────────────────────────────────────────────────────────

// One element as ElementTree holds it: its text is what comes before its first child.
export interface XmlElement {
  tag: string;
  attrib: Record<string, string>;
  text: string | null;
  children: XmlElement[];
}

export class XmlParseError extends Error {}

const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function unescape_xml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    if (Object.hasOwn(entities, name)) return entities[name];
    throw new XmlParseError(`undefined entity ${whole}`);
  });
}

// Parses one XML document as ElementTree.fromstring does, throwing XmlParseError on anything malformed or unfinished.
export function parse_xml(source: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  const add_text = (text: string): void => {
    const current = stack.at(-1);
    if (current === undefined) {
      if (text.trim()) throw new XmlParseError("text outside the document element");
      return;
    }
    if (current.children.length === 0) current.text = (current.text ?? "") + unescape_xml(text);
  };
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      add_text(source.slice(index));
      break;
    }
    if (open > index) add_text(source.slice(index, open));
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open);
      if (end === -1) throw new XmlParseError("unclosed processing instruction");
      index = end + 2;
    } else if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      if (end === -1) throw new XmlParseError("unclosed comment");
      index = end + 3;
    } else if (source.startsWith("<!", open)) {
      const end = source.indexOf(">", open);
      if (end === -1) throw new XmlParseError("unclosed declaration");
      index = end + 1;
    } else if (source.startsWith("</", open)) {
      const end = source.indexOf(">", open);
      if (end === -1) throw new XmlParseError("unclosed end tag");
      const tag = source.slice(open + 2, end).trim();
      const current = stack.pop();
      if (current === undefined || current.tag !== tag) throw new XmlParseError(`mismatched tag ${tag}`);
      index = end + 1;
    } else {
      const tag_match = /^<([A-Za-z_:][\w:.-]*)/.exec(source.slice(open, open + 200));
      if (tag_match === null) throw new XmlParseError("not well-formed");
      let cursor = open + tag_match[0].length;
      const attrib: Record<string, string> = {};
      const attribute = /\s*([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
      let self_closing = false;
      for (;;) {
        attribute.lastIndex = cursor;
        const found = attribute.exec(source);
        if (found !== null) {
          attrib[found[1]] = unescape_xml((found[3] ?? found[4]).replace(/[\t\n\r]/g, " "));
          cursor = attribute.lastIndex;
          continue;
        }
        const rest = /\s*(\/?)>/y;
        rest.lastIndex = cursor;
        const closing = rest.exec(source);
        if (closing === null) throw new XmlParseError("not well-formed");
        self_closing = closing[1] === "/";
        cursor = rest.lastIndex;
        break;
      }
      const element: XmlElement = { tag: tag_match[1], attrib, text: null, children: [] };
      const parent = stack.at(-1);
      if (parent !== undefined) parent.children.push(element);
      else if (root !== null) throw new XmlParseError("junk after document element");
      else root = element;
      if (!self_closing) stack.push(element);
      index = cursor;
    }
  }
  if (root === null) throw new XmlParseError("no element found");
  if (stack.length > 0) throw new XmlParseError("no element found");
  return root;
}

function step_matches(element: XmlElement, step: string): boolean {
  const match = /^([^[]+)(?:\[@([^=]+)='([^']*)'\])?$/.exec(step)!;
  if (match[1] !== element.tag) return false;
  return match[2] === undefined || element.attrib[match[2]] === match[3];
}

// Every element a simple ElementTree path such as "ports/port" or "elem[@key='state']" reaches from `element`.
export function xml_findall(element: XmlElement, path: string): XmlElement[] {
  let current = [element];
  for (const step of path.split("/")) current = current.flatMap((each) => each.children.filter((child) => step_matches(child, step)));
  return current;
}

export function xml_find(element: XmlElement, path: string): XmlElement | null {
  return xml_findall(element, path)[0] ?? null;
}

// ── Grading ──────────────────────────────────────────────────────────────────

// Reads a configured status name, falling back on anything unrecognised.
function severity_of(value: unknown, fallback: Status): Status {
  const text = String(value);
  return is_status(text) ? text : fallback;
}

// The text of the `<elem key=...>` directly under a table, if present.
function elem_text(table: XmlElement, key: string): string | null {
  const elem = xml_find(table, `elem[@key='${key}']`);
  return elem !== null && elem.text ? elem.text.trim() : null;
}

// The texts listed in a `<table key=...>` under a table.
function table_items(table: XmlElement, key: string): string[] {
  const inner = xml_find(table, `table[@key='${key}']`);
  if (inner === null) return [];
  return xml_findall(inner, "elem").filter((elem) => elem.text).map((elem) => elem.text!.trim());
}

// Python's float() of a word, or null when it is not a number.
function to_float(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

// The CVSS score a vulns-library table carries under `scores`.
function cvss_of(table: XmlElement): number | null {
  const scores = xml_find(table, "table[@key='scores']");
  if (scores === null) return null;
  for (const key of ["CVSS", "CVSSv3", "CVSSv2"]) {
    const value = elem_text(scores, key);
    if (value) {
      const score = to_float(value.split(/\s+/)[0]);
      if (score !== null) return score;
    }
  }
  return null;
}

// The grade a vulns-library state earns, or null for one that says nothing.
function grade_state(state: string, likely_status: string): string | null {
  if (state.startsWith("VULNERABLE")) return failed_grade;
  if (state === likely_state) return likely_status;
  return null;
}

// The grade a version-matched advisory earns from its CVSS score.
function grade_cvss(cvss: number | null, warning: number | null, threshold: number | null): string {
  if (cvss === null) return noted_grade;
  const level = level_for(cvss, warning, threshold);
  return level === "failed" ? failed_grade : level === "warning" ? warning_grade : noted_grade;
}

// Whether a script's plain output declares a vulnerability outright.
function looks_vulnerable(text: string): boolean {
  return text.includes("VULNERABLE") && !text.includes("NOT VULNERABLE");
}

// Whether a script's plain output is one of the stock nothing-found lines.
function looks_negative(text: string): boolean {
  const lowered = text.toLowerCase();
  return negative_phrases.some((phrase) => lowered.includes(phrase));
}

// A running scan's progress line, read from the last task nmap reported in its XML.
export function progress_of(output: string): string {
  let tasks: XmlElement[];
  try {
    tasks = output.split(/\r?\n/).filter((line) => /^<(taskbegin|taskprogress|taskend)/.test(line.trim())).map((line) => parse_xml(line.trim()));
  } catch (error) {
    if (!(error instanceof XmlParseError)) throw error;
    tasks = [];
  }
  if (tasks.length === 0) return "Scan started";
  const task = tasks.at(-1)!;
  const name = task.attrib.task ?? "scan";
  if (task.tag === "taskprogress") {
    const remaining = task.attrib.remaining;
    const left = remaining && /^\d+$/.test(remaining) ? `, about ${format_duration(Number(remaining))} left` : "";
    return `${name}: ${Number(task.attrib.percent || 0).toFixed(0)}% done${left}`;
  }
  if (task.tag === "taskbegin") return `${name} running`;
  return `${name} done`;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export interface Finding {
  port: string;
  service: string;
  script: string;
  id: string;
  title: string;
  state: string;
  cvss: number | null;
  grade: string;
}

export interface OpenPort {
  port: string;
  service: string;
  product: string;
  version: string;
}

export class VulnScan extends Plugin {
  override readonly RUNS_ON_AGENT = false;
  static readonly DEFAULT_TIMEOUT = "20m";
  readonly scan_host: string;
  readonly ports: string | null;
  readonly scripts: string;
  readonly script_args: string | null;
  readonly service_detection: boolean;
  readonly discovery_ports: number[];
  readonly nmap_args: string[];
  readonly warning_cvss: number | null;
  readonly threshold_cvss: number | null;
  readonly likely_status: Status;
  readonly max_findings: number;
  readonly require_sudo: boolean;
  readonly nmap_bin: string;
  readonly scanner: string;
  readonly workdir: string;
  private polling_job: JobDict | null = null;

  constructor(name: string, config: PluginConfig) {
    const merged: PluginConfig = { timeout: VulnScan.DEFAULT_TIMEOUT, ...config };
    super(name, merged);
    this.scan_host = String(merged.scan_host || merged.target_host || "localhost");
    this.ports = merged.ports ? String(merged.ports) : null;
    this.scripts = String(merged.scripts ?? "vuln");
    this.script_args = merged.script_args ? String(merged.script_args) : null;
    this.service_detection = Boolean(merged.service_detection ?? true);
    this.discovery_ports = ((merged.discovery_ports as unknown[] | undefined) ?? [22, 80, 443]).map((port) => Math.trunc(Number(port)));
    this.nmap_args = ((merged.nmap_args as unknown[] | undefined) ?? []).map(String);
    this.warning_cvss = limit_from(merged, "warning_cvss", 4.0);
    this.threshold_cvss = limit_from(merged, "threshold_cvss", 7.0);
    this.likely_status = severity_of(merged.likely_status, "warning");
    this.max_findings = Math.trunc(Number(merged.max_findings ?? 200));
    this.require_sudo = Boolean(merged.require_sudo ?? false);
    this.nmap_bin = String(merged.nmap_bin ?? "nmap");
    // The monitor is about the scanned host; the agent or SSH host is only where nmap runs.
    this.display_target = this.scan_host;
    this.scanner = String(merged.agent || (merged.ssh_config ?? {}).host || "localhost");
    this.job_poll_interval = parse_duration(merged.job_poll ?? "30s");
    // One fixed directory per monitor, so finished scans never pile up on the scanning host.
    this.workdir = workdir_for(`vuln_scan-${this.id}`);
  }

  // ── Collection ───────────────────────────────────────────────────────────

  // The nmap invocation, bounded by a deadline placed inside any sudo.
  scan_command(): string {
    // Progress lines in the XML let a running scan report how far it has got.
    const argv = [this.nmap_bin, "-n", "-oX", "-", "--stats-every", `${Math.trunc(this.job_poll_interval!)}s`];
    if (this.discovery_ports.length > 0) argv.push("-PS" + this.discovery_ports.join(","));
    else argv.push("-Pn");
    if (this.service_detection) argv.push("-sV");
    argv.push("--script", this.scripts);
    if (this.script_args) argv.push("--script-args", this.script_args);
    if (this.ports) argv.push("-p", this.ports);
    argv.push(...this.nmap_args, this.scan_host);
    const prefix = this.require_sudo ? ["sudo", "-n"] : [];
    return [...prefix, ...deadline_prefix(Math.trunc(this.timeout)), ...argv.map(shell_quote)].join(" ");
  }

  // The scan with each stderr line marked as it is written, so a warning shows at once and is told apart from the XML.
  run_command(): string {
    const status = `"${this.workdir}/status"`;
    // A subshell, since a bare exit would end the launcher's shell before it records the exit file.
    return stream_stderr(this.scan_command(), status, { prefix: err_prefix }) + `; (exit "$(cat ${status})")`;
  }

  override commands(): Command[] {
    this.polling_job = null;
    const job = this.jobs ? this.jobs.running() : null;
    if (job && job.pid && job.workdir) {
      // parse() must read the results the way they were requested, even if the job ends mid-cycle.
      this.polling_job = job;
      // Every poll reads the whole output, since the finished scan is parsed from all of it.
      return [command(poll_command(job.workdir, job.pid, 0))];
    }
    return [command(launch_command(this.run_command(), this.workdir))];
  }

  override parse(results: CmdResult[]): CollectResult {
    const job = this.polling_job;
    this.polling_job = null;
    if (results.length === 0) return CollectResult.unavailable("No scan result for this cycle");
    if (job !== null) return this.parse_job_poll(job, results[0]);
    return this.parse_job_launch(results[0]);
  }

  // Records the launched scan as a job; until it finishes the previous snapshot stands.
  private parse_job_launch(result: CmdResult): CollectResult {
    const pid = result.exit_code === 0 ? parse_launch(result.stdout) : null;
    if (pid === null) {
      const reason = (result.stderr || result.stdout).trim().slice(0, 200) || `exit ${result.exit_code}`;
      return CollectResult.unavailable(`Could not start the scan: ${reason}`);
    }
    const job_id = this.jobs!.create(job_kind, this.run_command(), this.workdir);
    this.jobs!.set_pid(job_id, pid);
    return new CollectResult();
  }

  // Advances the running scan from one poll, and parses its whole output once it finishes.
  private parse_job_poll(job: JobDict, result: CmdResult): CollectResult {
    const jobs = this.jobs!;
    const job_id = job.id;
    // A poll that never reached the scanning host says nothing about the job; only a real answer may finish it.
    if (result.exit_code !== 0 && !result.stdout.trim()) {
      return new CollectResult({ logs: [[`Could not poll the running scan: ${(result.stderr || "").trim().slice(0, 200) || `exit ${result.exit_code}`}`, "WARNING"]] });
    }
    const poll = parse_poll(result.stdout);
    const finished = poll.exit_code !== null || !poll.alive;

    // output_seq counts the characters of the output already copied into the job's log.
    const fresh = poll.new_output.slice(job.output_seq);
    const [lines] = split_lines(fresh);
    let consumed = lines.length > 0 ? fresh.lastIndexOf("\n") + 1 : 0;
    if (finished && fresh.slice(consumed)) {
      lines.push(fresh.slice(consumed));
      consumed = fresh.length;
    }
    if (lines.length > 0) {
      jobs.append_output(job_id, lines);
      jobs.bump_output_seq(job_id, job.output_seq + consumed);
    }
    jobs.set_progress(job_id, progress_of(poll.new_output));

    if (!finished) return new CollectResult();
    if (poll.exit_code === null) {
      jobs.finish(job_id, "failed", -1, "Process ended without writing an exit code");
      return CollectResult.unavailable("The scan ended before it finished");
    }
    const error = poll.exit_code ? `Exited with status ${poll.exit_code}` : null;
    jobs.finish(job_id, error ? "failed" : "succeeded", poll.exit_code, error);
    return this.parse_scan(poll.new_output, poll.exit_code);
  }

  // Turns a finished scan's whole output into the cycle's result.
  private parse_scan(raw_output: string, exit_code: number): CollectResult {
    const lines = raw_output.split("\n");
    const errors = lines.filter((line) => line.startsWith(err_prefix)).map((line) => line.slice(err_prefix.length)).join("\n");
    const output = lines.filter((line) => !line.startsWith(err_prefix)).join("\n");
    if (!output.includes("<nmaprun")) {
      const reason = (errors || output).trim().slice(-200) || `exit ${exit_code}`;
      return CollectResult.unavailable(`nmap did not run: ${reason}`);
    }
    let start = output.indexOf("<?xml");
    start = start >= 0 ? start : output.indexOf("<nmaprun");
    const end = output.indexOf("</nmaprun>", start);
    const xml = end >= 0 ? output.slice(start, end + "</nmaprun>".length) : output.slice(start);
    let root: XmlElement;
    try {
      root = parse_xml(xml);
    } catch (error) {
      if (!(error instanceof XmlParseError)) throw error;
      return CollectResult.unavailable(`The scan of ${this.scan_host} did not finish within ${format_duration(Math.trunc(this.timeout))}`);
    }

    const host = xml_find(root, "host");
    const status = host !== null ? xml_find(host, "status") : null;
    if (host === null || status === null || status.attrib.state !== "up") {
      const probe = this.discovery_ports.length > 0 ? this.discovery_ports.join(", ") : "no discovery";
      return new CollectResult({ metrics: { host_up: 0.0 }, logs: [[`${this.scan_host} did not answer on ports ${probe}; nothing scanned`, "WARNING"]], status: "unavailable" });
    }
    return this.assemble(root, host);
  }

  // Turns a completed scan into metrics, one row per open port and per finding, and the worst grade any finding earned.
  private assemble(root: XmlElement, host: XmlElement): CollectResult {
    const accumulator = new StatusAccumulator();
    const open_ports = VulnScan.open_ports(host);
    const findings = this.findings(host);
    for (const finding of findings) accumulator.escalate(finding.grade);

    const count = (grade: string): number => findings.filter((finding) => finding.grade === grade).length;
    const counts = { failed: count(failed_grade), warning: count(warning_grade), noted: count(noted_grade) };
    const finished = xml_find(root, "runstats/finished");
    const elapsed = finished !== null ? Number(finished.attrib.elapsed || 0) : 0.0;
    const ended = host.attrib.endtime || (finished !== null ? finished.attrib.time : undefined);
    const scanned_at = ended && /^\d+$/.test(ended) ? Number(ended) : Math.trunc(Date.now() / 1000);
    const address = xml_find(host, "address");
    const addr = address !== null ? (address.attrib.addr ?? null) : this.scan_host;

    const summary = `${this.scan_host} (${addr ?? "None"}): ${open_ports.length} open ports, ` + `${counts.failed} vulnerable, ${counts.warning} likely, ` + `${counts.noted} noted, scanned in ${format_duration(Math.trunc(elapsed))}`;
    const logs: [string, string][] = [[summary, accumulator.log_level]];
    for (const finding of findings) {
      if (finding.grade === noted_grade) continue;
      logs.push([`${finding.port} ${finding.service}: ${finding.title} [${finding.script}] ${finding.state}`, log_level_of(finding.grade as Status)]);
    }

    return new CollectResult({
      metrics: {
        vulnerable: counts.failed, suspected: counts.warning, noted: counts.noted, open_ports: open_ports.length,
        scan_seconds: elapsed, host_up: 1.0, last_scan_epoch: scanned_at,
      },
      logs,
      status: accumulator.status,
      snapshot: {
        host: this.scan_host, address: addr, scanned_at, elapsed, nmap_version: root.attrib.version ?? null,
        open_ports, findings: findings.slice(0, this.max_findings),
      },
    });
  }

  // One row per open port, with whatever service detection learned.
  static open_ports(host: XmlElement): OpenPort[] {
    const rows: OpenPort[] = [];
    for (const port of xml_findall(host, "ports/port")) {
      const state = xml_find(port, "state");
      if (state === null || state.attrib.state !== "open") continue;
      const service = xml_find(port, "service");
      const attributes = service !== null ? service.attrib : {};
      rows.push({
        port: `${port.attrib.portid ?? "None"}/${port.attrib.protocol ?? "None"}`,
        service: (attributes.name ?? "") + (attributes.tunnel === "ssl" ? "/ssl" : ""),
        product: attributes.product ?? "",
        version: [attributes.version, attributes.extrainfo].filter((value) => value).join(" "),
      });
    }
    return rows;
  }

  // Every finding the scripts reported, on ports and against the host.
  private findings(host: XmlElement): Finding[] {
    const findings: Finding[] = [];
    for (const port of xml_findall(host, "ports/port")) {
      const service = xml_find(port, "service");
      const label = `${port.attrib.portid ?? "None"}/${port.attrib.protocol ?? "None"}`;
      const name = service !== null ? (service.attrib.name ?? "") : "";
      for (const script of xml_findall(port, "script")) findings.push(...this.script_findings(script, label, name));
    }
    for (const script of xml_findall(host, "hostscript/script")) findings.push(...this.script_findings(script, "host", ""));
    const order: Record<string, number> = { [failed_grade]: 0, [warning_grade]: 1, [noted_grade]: 2 };
    const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    findings.sort((left, right) => order[left.grade] - order[right.grade] || compare(left.port, right.port) || compare(left.script, right.script) || compare(left.id, right.id));
    return findings;
  }

  // The findings one script's result holds: vulns-library tables, a vulners advisory list, or a plain-text verdict.
  private script_findings(script: XmlElement, port: string, service: string): Finding[] {
    const script_id = script.attrib.id ?? "";
    if (ignored_scripts.includes(script_id)) return [];
    const base = { port, service, script: script_id };
    if (script_id === "vulners") return this.vulners_findings(script, base);

    const findings: Finding[] = [];
    for (const table of xml_findall(script, "table")) {
      const state = elem_text(table, "state");
      if (state === null) continue;
      const grade = grade_state(state, this.likely_status);
      if (grade === null) continue;
      const ids = table_items(table, "ids");
      findings.push({
        ...base,
        id: ids.length > 0 ? ids[0].split(":").slice(ids[0].includes(":") ? 1 : 0).join(":") : (table.attrib.key ?? ""),
        title: elem_text(table, "title") || (table.attrib.key ?? script_id),
        state,
        cvss: cvss_of(table),
        grade,
      });
    }
    if (findings.length > 0) return findings;

    const text = (script.attrib.output || "").trim();
    if (!text || looks_negative(text)) return [];
    const first_line = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line) ?? script_id;
    if (looks_vulnerable(text)) return [{ ...base, id: script_id, title: first_line.slice(0, 120), state: "VULNERABLE", cvss: null, grade: failed_grade }];
    if (xml_find(script, "table") !== null || xml_find(script, "elem") !== null) {
      return [{ ...base, id: script_id, title: first_line.slice(0, 120), state: "reported", cvss: null, grade: noted_grade }];
    }
    return [];
  }

  // One finding per advisory vulners matched to a detected version.
  private vulners_findings(script: XmlElement, base: { port: string; service: string; script: string }): Finding[] {
    const findings: Finding[] = [];
    for (const cpe_table of xml_findall(script, "table")) {
      for (const entry of xml_findall(cpe_table, "table")) {
        const advisory = elem_text(entry, "id");
        if (!advisory) continue;
        const cvss_text = elem_text(entry, "cvss");
        const cvss = cvss_text ? to_float(cvss_text) : null;
        const exploit = (elem_text(entry, "is_exploit") || "").toLowerCase() === "true";
        findings.push({
          ...base,
          id: advisory,
          title: `${cpe_table.attrib.key ?? ""} matches ${advisory}`,
          state: (cvss !== null ? `CVSS ${cvss.toFixed(1)}` : "unscored") + (exploit ? " · exploit" : ""),
          cvss,
          grade: grade_cvss(cvss, this.warning_cvss, this.threshold_cvss),
        });
      }
    }
    return findings;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private metric(name: string): number | null {
    return this.data.latest_metric(name)?.value ?? null;
  }

  private last_scan_pair(): [string, string | null] {
    const epoch = this.metric("last_scan_epoch");
    if (!epoch) return ["NEVER", "unavailable"];
    const age = Math.trunc(Date.now() / 1000) - Math.trunc(epoch);
    // A second interval passing without a fresh scan means the sweeps have stopped landing.
    return [format_age(age), age > 2 * this.interval ? "warning" : "online"];
  }

  get last_scan_text(): string {
    return this.last_scan_pair()[0];
  }

  get last_scan_color(): string | null {
    return this.last_scan_pair()[1];
  }

  get duration_text(): string {
    const seconds = this.metric("scan_seconds");
    return seconds === null ? "--" : format_duration(Math.trunc(seconds));
  }

  private snapshot(): Record<string, unknown> {
    const snapshot = this.data.latest_snapshot<Record<string, unknown>>({});
    return snapshot || {};
  }

  get finding_rows(): Record<string, string>[] {
    const findings = (this.snapshot().findings as Partial<Finding>[] | undefined) || [];
    return findings.map((finding, index) => {
      const cvss = finding.cvss;
      return {
        key: `${index}-${finding.id ?? ""}`,
        severity: grade_label[finding.grade ?? ""] ?? "NOTE",
        grade: finding.grade ?? noted_grade,
        port: finding.port ?? "",
        service: finding.service ?? "",
        script: finding.script ?? "",
        id: finding.id ?? "",
        title: finding.title ?? "",
        cvss: typeof cvss === "number" ? cvss.toFixed(1) : "--",
        state: finding.state ?? "",
      };
    });
  }

  get port_rows(): OpenPort[] {
    const ports = (this.snapshot().open_ports as Partial<OpenPort>[] | undefined) || [];
    return ports.map((row) => ({ port: row.port ?? "", service: row.service ?? "", product: row.product ?? "", version: row.version ?? "" }));
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        scanner_card: { title: "SCANNED FROM", value: this.scanner },
        vulnerable_card: {
          kind: "share",
          title: "FINDINGS",
          format: "int",
          parts: [
            { metric: "vulnerable", label: "Vulnerable", color: "failed" },
            { metric: "suspected", label: "Likely", color: "warning" },
            { metric: "noted", label: "Noted", color: "neutral" },
          ],
        },
        last_scan_card: { title: "LAST SCAN", value_attr: "last_scan_text", color_attr: "last_scan_color", refresh: true },
        duration_card: { title: "SCAN TIME", value_attr: "duration_text", refresh: true },
        open_ports_card: { metric: "open_ports", title: "OPEN PORTS", format: "int" },
      },
      tables: {
        findings: {
          title: "Findings",
          row_key: "key",
          rows_attr: "finding_rows",
          columns: [
            { name: "severity", label: "Severity", field: "severity", align: "left", cell_color_by: (row) => (row.grade as Status | undefined) ?? null },
            { name: "port", label: "Port", field: "port", align: "left" },
            { name: "service", label: "Service", field: "service", align: "left" },
            { name: "id", label: "ID", field: "id", align: "left" },
            { name: "title", label: "Finding", field: "title", align: "left" },
            { name: "cvss", label: "CVSS", field: "cvss", align: "right" },
            { name: "state", label: "State", field: "state", align: "left" },
            { name: "script", label: "Script", field: "script", align: "left" },
          ],
        } as TableSpec,
        ports: {
          row_key: "port",
          rows_attr: "port_rows",
          columns: [
            { name: "port", label: "Port", field: "port", align: "left" },
            { name: "service", label: "Service", field: "service", align: "left" },
            { name: "product", label: "Product", field: "product", align: "left" },
            { name: "version", label: "Version", field: "version", align: "left" },
          ],
        },
      },
      chart: { metric: "vulnerable", title: `VULNERABILITIES — ${this.scan_host}` },
      job_panel: { widget: "jobs", title: "Scan runs", history_limit: 10 },
      events: { title: "Events", limit: 100, full_height: true },
    };
  }
}
