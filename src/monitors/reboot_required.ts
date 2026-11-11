// Whether a host needs a reboot to run what is installed, by every check that applies to it: Debian's
// /var/run/reboot-required flag (and its .pkgs list), RHEL's `needs-restarting -r`, NixOS's booted vs current kernel,
// initrd, modules and systemd, and on any other host a running kernel whose module directory is gone. A reboot any
// check asks for is reboot_status (warning by default); a host where no check applies is unavailable.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { log_level_of, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, TableSpec } from "../shared/ui_spec.ts";
import { boot_parts_script, changed_parts, reboot_required } from "./base/nixos_boot.ts";
import type { PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { partition, split_lines } from "./base/text_parsing.ts";

const severities: readonly string[] = ["online", "warning", "failed"];

// The package lines needs-restarting -r prints under "Core libraries or services have been updated".
const rhel_package_pattern = /^\s*\*\s*(\S+)/;

const repeated = ["booted_part", "current_part", "debian_pkg", "rhel_out"] as const;

type Fields = Record<string, string> & { booted_part: string[]; current_part: string[]; debian_pkg: string[]; rhel_out: string[] } & Record<string, string | string[]>;

interface Check {
  check: string;
  required: boolean;
  reason: string;
  packages: string[];
}

// What the latest cycle found, kept as the snapshot for the cards and the details table.
export interface RebootSnapshot {
  required: boolean;
  kernel: string;
  checks: string[];
  reasons: string[];
  packages: string[];
}

// ── Probe ────────────────────────────────────────────────────────────────────

// One script running every reboot check the host supports, as key=value lines.
export function probe_script(): string {
  return [
    'echo "kernel=$(uname -r)"',
    "if [ -e /run/booted-system ]; then",
    '  echo "nixos=1"',
    ...boot_parts_script().map((line) => `  ${line}`),
    "fi",
    "if [ -d /var/lib/dpkg ]; then",
    '  echo "debian=1"',
    '  if [ -f /var/run/reboot-required ]; then echo "debian_flag=1"; fi',
    "  sed 's/^/debian_pkg=/' /var/run/reboot-required.pkgs 2>/dev/null",
    "fi",
    "if command -v needs-restarting >/dev/null 2>&1; then",
    '  out=$(needs-restarting -r 2>&1); echo "rhel_rc=$?"',
    "  printf '%s\\n' \"$out\" | sed 's/^/rhel_out=/'",
    "elif command -v dnf >/dev/null 2>&1; then",
    '  out=$(dnf -q needs-restarting -r 2>&1); echo "rhel_rc=$?"',
    "  printf '%s\\n' \"$out\" | sed 's/^/rhel_out=/'",
    "fi",
    "for dir in /usr/lib/modules /lib/modules; do",
    '  if [ -d "$dir" ]; then',
    '    if [ -d "$dir/$(uname -r)" ]; then echo "modules=present"; else echo "modules=missing"; fi',
    "    break",
    "  fi",
    "done",
  ].join("\n");
}

// The probe's key=value lines, collecting the repeated keys into lists.
export function parse_probe(stdout: string): Fields {
  const fields = Object.fromEntries(repeated.map((key) => [key, [] as string[]])) as unknown as Fields;
  for (const line of split_lines(stdout)) {
    const [key, separator, value] = partition(line, "=");
    if (!separator) continue;
    if ((repeated as readonly string[]).includes(key)) (fields[key] as string[]).push(value.trim());
    else fields[key] = value.trim();
  }
  return fields;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

// needs-restarting's verdict: exit 0 means no reboot, exit 1 with its reboot message means one is needed.
function rhel_check(fields: Fields): Check | null {
  const code = fields.rhel_rc;
  const lines = fields.rhel_out;
  const text = lines.join("\n").toLowerCase();
  if (code === "0") return { check: "rhel", required: false, reason: "needs-restarting reports no reboot needed", packages: [] };
  // Exit 1 is also how dnf reports a command it does not have, so the message must mention a reboot.
  if (code === "1" && text.includes("reboot")) {
    const packages = unique(lines.map((line) => rhel_package_pattern.exec(line)?.[1] ?? ""));
    return { check: "rhel", required: true, reason: "needs-restarting reports core packages updated since boot", packages };
  }
  return null;
}

// Every check that could run on this host, each with its verdict, reason and packages.
function checks_of(fields: Fields): Check[] {
  const checks: Check[] = [];

  if (fields.nixos) {
    const booted = fields.booted_part;
    const current = fields.current_part;
    const verdict = reboot_required(booted, current);
    if (verdict !== null) {
      const parts = changed_parts(booted, current);
      checks.push({ check: "nixos", required: verdict, reason: verdict ? `booted ${parts.join(", ")} differ from the current system` : "booted system matches the current one", packages: parts });
    }
  }

  if (fields.debian) {
    const required = Boolean(fields.debian_flag);
    checks.push({
      check: "debian", required,
      reason: required ? "/var/run/reboot-required is present" : "no /var/run/reboot-required flag",
      packages: required ? unique(fields.debian_pkg) : [],
    });
  }

  const rhel = rhel_check(fields);
  if (rhel !== null) checks.push(rhel);

  const modules = fields.modules as string | undefined;
  // NixOS keeps no /lib/modules tree, so its own check stands in for this one.
  if (modules && !fields.nixos) {
    const required = modules === "missing";
    const kernel = (fields.kernel as string | undefined) || "?";
    checks.push({ check: "kernel", required, reason: required ? `running kernel ${kernel} has no module directory` : `running kernel ${kernel} is still installed`, packages: [] });
  }
  return checks;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Whether the host must reboot to run its installed kernel and core libraries, from whichever distro checks it supports.
export class RebootRequired extends SignalPlugin {
  override readonly SAMPLED = true;
  readonly reboot_status: Status;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    const status = String(config.reboot_status ?? "warning").toLowerCase();
    this.reboot_status = (severities.includes(status) ? status : "warning") as Status;
  }

  override commands(): Command[] {
    return [command(probe_script())];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0 && !stdout.trim()) return CollectResult.unavailable(`Could not run the reboot checks: ${stderr.trim().slice(0, 200)}`);

    const fields = parse_probe(stdout);
    const checks = checks_of(fields);
    if (checks.length === 0) {
      return CollectResult.unavailable("No reboot check applies to this host (no reboot-required flag, needs-restarting, NixOS boot links or kernel module directory)");
    }

    const required = checks.filter((check) => check.required);
    const packages = unique(required.flatMap((check) => check.packages));
    const snapshot: RebootSnapshot = {
      required: required.length > 0,
      kernel: (fields.kernel as string | undefined) ?? "",
      checks: checks.map((check) => check.check),
      reasons: (required.length > 0 ? required : checks).map((check) => check.reason),
      packages,
    };
    const metrics = { reboot_required: required.length > 0 ? 1 : 0 };
    if (required.length === 0) {
      return new CollectResult({ metrics, snapshot, status: "online", logs: [[`No reboot required (${snapshot.reasons.join("; ")})`, "INFO"]] });
    }
    let message = `Reboot required: ${snapshot.reasons.join("; ")}`;
    if (packages.length > 0) message += ` (packages: ${packages.join(", ")})`;
    return new CollectResult({ metrics, snapshot, status: this.reboot_status, logs: [[message, log_level_of(this.reboot_status)]] });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private snapshot(): Partial<RebootSnapshot> {
    const snapshot = this.data ? this.data.latest_snapshot<Partial<RebootSnapshot>>({}) : {};
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? snapshot : {};
  }

  get reboot_text(): string {
    const metric = this.data.latest_metric("reboot_required");
    if (metric === null) return "--";
    return metric.value >= 1 ? "REQUIRED" : "NOT NEEDED";
  }

  get reboot_color(): Status | null {
    const metric = this.data.latest_metric("reboot_required");
    if (metric === null) return null;
    return metric.value >= 1 ? this.reboot_status : "online";
  }

  get kernel_text(): string {
    return this.snapshot().kernel || "--";
  }

  get checks_text(): string {
    return (this.snapshot().checks ?? []).join(", ") || "--";
  }

  get reason_rows(): { id: string; kind: string; detail: string }[] {
    const snapshot = this.snapshot();
    return [
      ...(snapshot.reasons ?? []).map((reason, index) => ({ id: `reason-${index}`, kind: "Reason", detail: reason })),
      ...(snapshot.packages ?? []).map((name, index) => ({ id: `package-${index}`, kind: "Package", detail: name })),
    ];
  }

  override cards(): Record<string, CardSpec> {
    return {
      reboot_card: { title: "REBOOT", value_attr: "reboot_text", color_attr: "reboot_color", refresh: true },
      kernel_card: { title: "RUNNING KERNEL", value_attr: "kernel_text", refresh: true },
      checks_card: { title: "CHECKED BY", value_attr: "checks_text", refresh: true },
    };
  }

  override tables(): Record<string, TableSpec> {
    return {
      details: {
        row_key: "id",
        rows_attr: "reason_rows",
        columns: [
          { name: "kind", label: "Kind", field: "kind", align: "left" },
          { name: "detail", label: "Detail", field: "detail", align: "left" },
        ],
      },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return { reboot_chart: { metric: "reboot_required", title: "REBOOT REQUIRED" } };
  }
}
