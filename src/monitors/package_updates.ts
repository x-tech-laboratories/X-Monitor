// Pending package updates and how many of them are security fixes, read from the package manager's existing cache so
// the check never refreshes metadata or needs root: `apt list --upgradable` (security by a `-security` origin),
// `dnf --cacheonly check-update` plus `updateinfo list --security`, or pacman's `checkupdates` (falling back to
// `pacman -Qu`) with `arch-audit` for security when it is installed. The manager is auto-detected unless `manager`
// names one. Each count ranks against its own optional warning/threshold, and a security update is warning by default;
// a host with none of the managers, such as NixOS (see nixos_upgrade), or a cache that cannot be read is unavailable.
// Config: manager, warning, threshold, security_warning, security_threshold.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import { log_level_of, worst_status, type Status } from "../shared/status.ts";
import type { CardSpec, ChartSpec, TableSpec } from "../shared/ui_spec.ts";
import { parse_duration, SCRIPT_SEP, type PluginConfig } from "./base/plugin_helpers.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";
import { parse_float, partition, split_lines, split_words } from "./base/text_parsing.ts";

export const MANAGERS = ["apt", "dnf", "pacman"] as const;

// How many security package names one log line lists before summarising the rest.
const logged_names = 10;

// `name/suite1,suite2 newver arch [upgradable from: oldver]` from apt list.
const apt_list_pattern = /^(\S+?)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/;
// `Inst name [oldver] (newver origin [arch])` from apt-get -s.
const apt_inst_pattern = /^Inst\s+(\S+)\s+(?:\[([^\]]+)\]\s+)?\((\S+)\s+([^[)]*)/;
// `name oldver -> newver` from checkupdates and pacman -Qu.
const pacman_pattern = /^(\S+)\s+(\S+)\s+->\s+(\S+)/;
// A dnf package NEVRA such as `curl-8.6.0-8.fc40.x86_64`.
const nevra_pattern = /^(.+)-([^-]+)-([^-]+)\.([^.\s]+)$/;

// One pending update, as the snapshot keeps it.
export interface PackageUpdate {
  name: string;
  current: string;
  new: string;
  security: boolean;
  origin: string;
}

// ── Probe ────────────────────────────────────────────────────────────────────

// One script that finds the package manager and reads its pending updates without touching the cache.
export function probe_script(manager: string | null): string {
  const forced = manager ? shell_quote(manager) : "''";
  return [
    `m=${forced}`,
    'if [ -z "$m" ]; then',
    "  if command -v apt-get >/dev/null 2>&1; then m=apt",
    "  elif command -v dnf >/dev/null 2>&1; then m=dnf",
    "  elif command -v pacman >/dev/null 2>&1; then m=pacman",
    "  fi",
    "fi",
    "upd=''; sec=''; cur=''; rc=''; src=''",
    'case "$m" in',
    "  apt)",
    "    if command -v apt >/dev/null 2>&1; then",
    "      src='apt list --upgradable'; upd=$(LC_ALL=C apt list --upgradable 2>/dev/null); rc=$?",
    "    else",
    "      src='apt-get -s dist-upgrade'; upd=$(LC_ALL=C apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>&1); rc=$?",
    "    fi ;;",
    "  dnf)",
    "    src='dnf check-update'; upd=$(dnf -q --cacheonly check-update 2>&1); rc=$?",
    "    sec=$(dnf -q --cacheonly updateinfo list --security 2>/dev/null)",
    "    cur=$(printf '%s\\n' \"$upd\" | awk '(NF==3 || NF==1) && $1 ~ /\\./ {print $1}' | xargs -r rpm -q --qf '%{NAME}.%{ARCH} %{VERSION}-%{RELEASE}\\n' 2>/dev/null) ;;",
    "  pacman)",
    "    if command -v checkupdates >/dev/null 2>&1; then",
    "      src='checkupdates'; upd=$(checkupdates 2>&1); rc=$?",
    "    fi",
    '    if [ -z "$src" ] || [ "$rc" = 1 ]; then',
    "      src='pacman -Qu'; upd=$(pacman -Qu 2>&1); rc=$?",
    "    fi",
    "    if command -v arch-audit >/dev/null 2>&1; then sec=$(arch-audit -u -q 2>/dev/null); fi ;;",
    "esac",
    'echo "manager=$m"',
    'echo "source=$src"',
    'echo "rc=$rc"',
    'if [ -e /etc/NIXOS ]; then echo "nixos=1"; fi',
    `echo "${SCRIPT_SEP}"`,
    "printf '%s\\n' \"$upd\"",
    `echo "${SCRIPT_SEP}"`,
    "printf '%s\\n' \"$sec\"",
    `echo "${SCRIPT_SEP}"`,
    "printf '%s\\n' \"$cur\"",
  ].join("\n");
}

interface ProbeFields {
  header: Record<string, string>;
  updates: string;
  security: string;
  installed: string;
}

// The header's key=value fields plus the updates, security and installed-version sections.
function split_output(stdout: string): ProbeFields {
  const parts = stdout.split(SCRIPT_SEP);
  while (parts.length < 4) parts.push("");
  const header: Record<string, string> = {};
  for (const line of split_lines(parts[0])) {
    const [key, separator, value] = partition(line, "=");
    if (separator) header[key.trim()] = value.trim();
  }
  const strip_newlines = (text: string): string => text.replace(/^\n+|\n+$/g, "");
  return { header, updates: strip_newlines(parts[1]), security: strip_newlines(parts[2]), installed: strip_newlines(parts[3]) };
}

function package_of(name: string, current: string, new_version: string, security: boolean, origin = ""): PackageUpdate {
  return { name, current, new: new_version, security, origin };
}

// ── Parsers ──────────────────────────────────────────────────────────────────

// Packages from `apt list --upgradable` or `apt-get -s` Inst lines, security meaning a -security origin.
export function parse_apt(text: string): PackageUpdate[] {
  const packages: PackageUpdate[] = [];
  for (const line of split_lines(text)) {
    const listed = apt_list_pattern.exec(line);
    if (listed) {
      const [, name, suites, new_version, current] = listed;
      packages.push(package_of(name, (current ?? "").trim(), new_version, suites.toLowerCase().includes("security"), suites));
      continue;
    }
    const simulated = apt_inst_pattern.exec(line);
    if (simulated) {
      const [, name, current, new_version, raw_origin] = simulated;
      const origin = raw_origin.trim();
      packages.push(package_of(name, current ?? "", new_version, origin.toLowerCase().includes("security"), origin));
    }
  }
  return packages;
}

// Packages from `dnf check-update`, with current versions from rpm and security from updateinfo.
export function parse_dnf(updates: string, security: string, installed: string): PackageUpdate[] {
  const current = new Map<string, string>();
  for (const line of split_lines(installed)) {
    const fields = split_words(line);
    if (fields.length === 2) current.set(fields[0], fields[1]);
  }
  const secure = new Set<string>();
  for (const line of split_lines(security)) {
    for (const token of split_words(line)) {
      const match = nevra_pattern.exec(token);
      if (match) secure.add(`${match[1]}.${match[4]}`);
    }
  }
  const packages: PackageUpdate[] = [];
  let wrapped: string | null = null;
  for (const line of split_lines(updates)) {
    // Everything after this header is an obsoleted package, already counted under its replacement.
    if (line.trim().toLowerCase().startsWith("obsoleting")) break;
    let fields = split_words(line);
    // dnf moves the version and repo of a long package name onto the next line.
    if (wrapped && fields.length === 2) {
      fields = [wrapped, ...fields];
      wrapped = null;
    } else if (fields.length === 1 && fields[0].includes(".") && !line.startsWith(" ")) {
      wrapped = fields[0];
      continue;
    }
    if (fields.length !== 3 || !fields[0].includes(".")) continue;
    const [name_arch, new_version, repo] = fields;
    const name = name_arch.slice(0, name_arch.lastIndexOf("."));
    packages.push(package_of(name, current.get(name_arch) ?? "", new_version, secure.has(name_arch), repo));
  }
  return packages;
}

// Packages from `checkupdates` or `pacman -Qu`, security meaning arch-audit lists them.
export function parse_pacman(updates: string, security: string): PackageUpdate[] {
  const secure = new Set<string>();
  for (const line of split_lines(security)) {
    const words = split_words(line);
    if (words.length === 0) continue;
    // arch-audit prints either bare names or "Package <name> is affected by ...".
    const token = words[0] === "Package" && words.length > 1 ? words[1] : words[0];
    secure.add(token.split(/[<>=:]/)[0]);
  }
  const packages: PackageUpdate[] = [];
  for (const line of split_lines(updates)) {
    const match = pacman_pattern.exec(line);
    if (match) {
      const [, name, current, new_version] = match;
      packages.push(package_of(name, current, new_version, secure.has(name), line.includes("[ignored]") ? "ignored" : ""));
    }
  }
  return packages;
}

// Why the manager's cache could not be read, or null when its exit code means success.
function read_error(manager: string, code: string, text: string): string | null {
  const ok: Record<string, string[]> = { apt: ["0"], dnf: ["0", "100"], pacman: ["0", "1", "2"] };
  if (ok[manager].includes(code)) return null;
  const detail = split_words(text).join(" ").slice(0, 200);
  return `${manager} could not read its package cache (exit ${code || "?"}): ${detail || "no output"}`;
}

// A count against whichever of its two bounds are configured.
function optional_level(value: number, warning: number | null, threshold: number | null): Status {
  if (threshold !== null && value >= threshold) return "failed";
  if (warning !== null && value >= warning) return "warning";
  return "online";
}

function bound(config: PluginConfig, key: string, fallback: number | null = null): number | null {
  const value = key in config ? config[key] : fallback;
  return value === null || value === undefined ? null : parse_float(value);
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Pending apt, dnf or pacman updates, normalised into one package list with a security flag, counted and ranked
// against the configured bounds.
export class PackageUpdates extends SignalPlugin {
  readonly manager: string | null;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly security_warning: number | null;
  readonly security_threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    // Reading a package cache every minute buys nothing, so this monitor defaults to hourly.
    this.interval = parse_duration(config.interval ?? "1h");
    const manager = String(config.manager || "").toLowerCase();
    this.manager = (MANAGERS as readonly string[]).includes(manager) ? manager : null;
    this.warning = bound(config, "warning");
    this.threshold = bound(config, "threshold");
    this.security_warning = bound(config, "security_warning", 1);
    this.security_threshold = bound(config, "security_threshold");
  }

  override commands(): Command[] {
    return [command(probe_script(this.manager))];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { stdout, stderr } = results[0];
    if (!stdout.includes(SCRIPT_SEP)) return CollectResult.unavailable(`Could not check for package updates: ${(stderr || stdout).trim().slice(0, 200)}`);

    const fields = split_output(stdout);
    const manager = fields.header.manager ?? "";
    if (!(MANAGERS as readonly string[]).includes(manager)) {
      if (fields.header.nixos) return CollectResult.unavailable("NixOS has no apt, dnf or pacman; use the nixos_upgrade monitor for this host");
      return CollectResult.unavailable("No supported package manager (apt, dnf or pacman) found");
    }

    const error = read_error(manager, fields.header.rc ?? "", fields.updates);
    if (error) return CollectResult.unavailable(error);

    let packages: PackageUpdate[];
    if (manager === "apt") packages = parse_apt(fields.updates);
    else if (manager === "dnf") packages = parse_dnf(fields.updates, fields.security, fields.installed);
    else packages = parse_pacman(fields.updates, fields.security);
    return this.assemble(manager, fields.header.source ?? "", packages);
  }

  private assemble(manager: string, source: string, packages: PackageUpdate[]): CollectResult {
    packages.sort((first, second) => Number(!first.security) - Number(!second.security) || (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
    const secure = packages.filter((each) => each.security).map((each) => each.name);
    const pending = packages.length;
    const security = secure.length;
    const status = worst_status([optional_level(pending, this.warning, this.threshold), optional_level(security, this.security_warning, this.security_threshold)]);
    let message = `${pending} update(s) pending, ${security} security (${source || manager})`;
    if (secure.length > 0) {
      const more = secure.length - logged_names;
      message += `: ${secure.slice(0, logged_names).join(", ")}` + (more > 0 ? ` and ${more} more` : "");
    }
    return new CollectResult({
      metrics: { updates_pending: pending, security_updates_pending: security },
      logs: [[message, log_level_of(status)]],
      status,
      snapshot: { manager, source, packages },
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private snapshot(): { manager?: string; source?: string; packages?: Partial<PackageUpdate>[] } {
    const snapshot = this.data ? this.data.latest_snapshot<Record<string, unknown>>({}) : {};
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? snapshot : {};
  }

  get manager_text(): string {
    return this.snapshot().manager || this.manager || "Detecting...";
  }

  get package_rows(): Record<string, string>[] {
    return (this.snapshot().packages ?? []).map((each, index) => ({
      id: `${index}-${each.name ?? ""}`,
      name: each.name ?? "",
      current: each.current || "--",
      new: each.new ?? "",
      security: each.security ? "yes" : "",
      origin: each.origin ?? "",
    }));
  }

  readonly updates_color = (value: number | null): Status | null => (value === null ? null : optional_level(value, this.warning, this.threshold));

  readonly security_color = (value: number | null): Status | null => (value === null ? null : optional_level(value, this.security_warning, this.security_threshold));

  // A security row, in the status a single security update earns, if any.
  readonly security_cell = (row: Record<string, unknown>): Status | null => {
    if (!row.security) return null;
    const level = optional_level(1, this.security_warning, this.security_threshold);
    return level === "online" ? null : level;
  };

  override cards(): Record<string, CardSpec> {
    return {
      manager_card: { title: "PACKAGE MANAGER", value_attr: "manager_text", refresh: true },
      updates_card: { metric: "updates_pending", title: "UPDATES", format: "int", color: this.updates_color },
      security_card: { metric: "security_updates_pending", title: "SECURITY", format: "int", color: this.security_color },
    };
  }

  override tables(): Record<string, TableSpec> {
    return {
      packages: {
        row_key: "id",
        rows_attr: "package_rows",
        columns: [
          { name: "name", label: "Package", field: "name", sortable: true, align: "left" },
          { name: "current", label: "Installed", field: "current", align: "left" },
          { name: "new", label: "Available", field: "new", align: "left" },
          { name: "security", label: "Security", field: "security", sortable: true, align: "left", cell_color_by: this.security_cell },
          { name: "origin", label: "Origin", field: "origin", align: "left" },
        ],
      },
    };
  }

  override charts(): Record<string, ChartSpec> {
    return {
      updates_chart: { metric: "updates_pending", title: "PENDING UPDATES" },
      security_chart: { metric: "security_updates_pending", title: "PENDING SECURITY UPDATES" },
    };
  }
}
