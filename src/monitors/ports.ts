// Reachability and latency of TCP ports and HTTP URLs as seen from the target host itself: one shell script (curl for
// URLs, /dev/tcp for ports), sampled locally by the agent on agent-backed hosts, so each check is measured from the
// target's own vantage point. Config: checks (a list of {url} or {host, port} entries, optionally named) and timeout
// per probe. Every check reachable is online; any check down is failed, with no warning tier. The target itself being
// unreachable, so the probe never ran, is unavailable: nothing was measured.

import { python_repr } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { CardSpec, ChartSpec, LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";

const fail_word = "FAIL";

export type PortCheck = Record<string, unknown> & { name?: string; metric?: string; url?: string; host?: string; port?: unknown };

// ── Script ───────────────────────────────────────────────────────────────────

// A label as a metric name: lower case, every other character an underscore, trimmed of underscores.
export function safe_metric_name(label: string): string {
  const name = [...label.toLowerCase()].map((character) => (/[\p{L}\p{N}]/u.test(character) ? character : "_")).join("").replace(/^_+|_+$/g, "");
  return name || "check";
}

function python_str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function build_probe_script(checks: PortCheck[], timeout: number): string {
  const lines = ["set +e"];
  checks.forEach((check, index) => {
    const url = check.url;
    if (url) {
      lines.push(
        `code=$(curl -o /dev/null -s -m ${timeout} -w "%{http_code}:%{time_total}" ` +
          `${python_repr(String(url))} 2>/dev/null); ` +
          `case "$code" in 2*|3*) echo "${index} $(echo "$code" | cut -d: -f2 | ` +
          `awk '{printf "%.0f", $1*1000}')";; *) echo "${index} ${fail_word}";; esac`,
      );
    } else {
      const host = python_str(check.host ?? "localhost");
      if (!("port" in check)) throw new Error("KeyError: 'port'");
      const port = python_str(check.port);
      lines.push(
        "start=$(date +%s%3N); " +
          `if timeout ${timeout} bash -c "echo > /dev/tcp/${host}/${port}" 2>/dev/null; ` +
          `then end=$(date +%s%3N); echo "${index} $((end - start))"; ` +
          `else echo "${index} ${fail_word}"; fi`,
      );
    }
  });
  return lines.join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// A number as Python's float() reads it, or null.
function try_float(value: string): number | null {
  const text = value.trim().replaceAll(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return Number.NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  return Number(text);
}

// Each check's latency by index, null for a check that failed or never answered.
export function parse_results(stdout: string, count: number): Map<number, number | null> {
  const results = new Map<number, number | null>();
  for (let index = 0; index < count; index++) results.set(index, null);
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    const parts = line.split(/\s+/).filter((part) => part !== "");
    if (parts.length !== 2) continue;
    if (!/^[+-]?\d+$/.test(parts[0])) continue;
    const index = Number(parts[0]);
    if (!results.has(index)) continue;
    results.set(index, parts[1] === fail_word ? null : try_float(parts[1]));
  }
  return results;
}

// Gives each check its name and metric, naming an unnamed one by its url or host:port.
function name_check(check: PortCheck): void {
  if (!("name" in check)) check.name = check.url ? String(check.url) : `${python_str(check.host ?? "localhost")}:${python_str(check.port)}`;
  check.metric = safe_metric_name(String(check.name));
}

function named_checks(checks: PortCheck[]): PortCheck[] {
  return checks.map((check) => {
    const copy = { ...check };
    name_check(copy);
    return copy;
  });
}

const default_layout: LayoutRow[] = [
  ["host_card", "up_card", "down_card"],
  ["events"],
];

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Ports extends Plugin {
  override readonly SAMPLED = true;
  readonly checks: PortCheck[];

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.timeout = Math.trunc(Number(config.timeout ?? 5));
    this.checks = (config.checks as PortCheck[] | undefined) ?? [];
    for (const check of this.checks) name_check(check);
  }

  override commands(): Command[] {
    if (this.checks.length === 0) return [];
    return [command(build_probe_script(this.checks, this.timeout))];
  }

  override parse(results: CmdResult[]): CollectResult {
    if (this.checks.length === 0) return CollectResult.unavailable("No checks configured");

    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`Probe script failed to run: ${stderr}`);

    const parsed = parse_results(stdout, this.checks.length);
    const metrics: Record<string, number> = {};
    const down: string[] = [];
    this.checks.forEach((check, index) => {
      const latency = parsed.get(index) ?? null;
      const up = latency !== null;
      metrics[`${check.metric}_up`] = up ? 1.0 : 0.0;
      if (up) metrics[`${check.metric}_latency_ms`] = latency;
      else down.push(String(check.name));
    });

    if (down.length > 0) {
      return new CollectResult({ metrics, logs: [[`${down.length} check(s) down: ${down.join(", ")}`, "ERROR"]], status: "failed" });
    }
    return new CollectResult({ metrics, logs: [[`All ${this.checks.length} check(s) reachable`, "INFO"]], status: "online" });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private get configured_checks(): PortCheck[] {
    return named_checks((this.config.checks as PortCheck[] | undefined) ?? []);
  }

  private check_counts(): [up: number, down: number] | null {
    const checks = this.configured_checks;
    if (checks.length === 0) return null;
    let up = 0;
    let down = 0;
    for (const check of checks) {
      const metric = this.data.latest_metric(`${check.metric}_up`);
      if (metric === null) continue;
      if (metric.value >= 1.0) up += 1;
      else down += 1;
    }
    return up + down ? [up, down] : null;
  }

  get up_text(): string {
    const counts = this.check_counts();
    if (counts === null) return "--";
    const [up, down] = counts;
    return `${up}/${up + down}`;
  }

  get down_text(): string {
    const counts = this.check_counts();
    return counts === null ? "--" : String(counts[1]);
  }

  get down_color(): string | null {
    const counts = this.check_counts();
    if (counts === null) return null;
    return counts[1] ? "failed" : "online";
  }

  override get UI_SPEC(): UISpec {
    const checks = this.configured_checks;
    const strips: Record<string, CardSpec> = checks.length > 0
      ? { strips: { kind: "strip", title: "AVAILABILITY", rows: checks.map((check) => ({ metric: `${check.metric}_up`, label: String(check.name) })) } }
      : {};
    const charts: Record<string, ChartSpec> = Object.fromEntries(
      checks.map((check) => [`chart_${check.metric}`, { metric: `${check.metric}_latency_ms`, title: `${check.name} LATENCY (ms)` }]),
    );
    // Every check's uptime strip shares one panel above the latency charts.
    const check_rows: LayoutRow[] = [...(checks.length > 0 ? [["strips"]] : []), ...checks.map((check) => [`chart_${check.metric}`])];
    return {
      layout: [default_layout[0], ...check_rows, default_layout[1]],
      cards: {
        up_card: { title: "REACHABLE", value_attr: "up_text", refresh: true },
        down_card: { title: "DOWN", value_attr: "down_text", color_attr: "down_color" },
        ...strips,
      },
      charts,
      events: true,
    };
  }
}
