// SMART health of every physical disk, via smartctl. A disk reporting FAILED is failed; a disk whose verdict could not
// be read, a host with no disks, or a script that could not run is unavailable, never healthy.

import { format_fixed, format_grouped, parse_float, partition, split_lines, split_words } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import type { Status } from "../shared/status.ts";
import type { CardSpec, LayoutRow } from "../shared/ui_spec.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

// Classifies by positive assertion, so any output other than an explicit PASSED or FAILED verdict reads as a check that
// did not run; it filters out zram, zvols and loop, md and device-mapper nodes, which lsblk calls disks but have no
// SMART, and reads ATA attribute column 10 or NVMe's labelled lines for temperature and power-on hours.
export const SMART_SCRIPT = "command -v smartctl >/dev/null 2>&1 || { echo 'ERROR smartctl not found'; exit 1; }; disks=$(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2==\"disk\"{print $1}'   | grep -Ev '^(zram|zd|loop|md|dm-|sr|fd|ram)' | sed 's|^|/dev/|'); [ -z \"$disks\" ] && exit 0; for d in $disks; do   transport=$(lsblk -no TRAN \"$d\" 2>/dev/null || echo '');   if [ \"$transport\" = 'usb' ]; then     result=$(sudo smartctl -H -A -d sat \"$d\" 2>&1 || true);   else     result=$(sudo smartctl -H -A \"$d\" 2>&1 || true);   fi;   readings=$(echo \"$result\" | awk '/Temperature_Celsius/ {t=$10} /Airflow_Temperature_Cel/ && t == \"\" {t=$10} /^Temperature:/ {t=$2} /Power_On_Hours/ {h=$10} /^Power On Hours:/ {h=$4} END {sub(/[^0-9].*/, \"\", t); gsub(/,/, \"\", h); sub(/[^0-9].*/, \"\", h); if (t != \"\") printf \" temp=%s\", t; if (h != \"\") printf \" hours=%s\", h}');   if echo \"$result\" | grep -iq 'test result: *PASSED'; then echo \"PASS $d$readings\";   elif echo \"$result\" | grep -iqE 'test result: *FAILED|SMART Health Status: *FAIL'; then echo \"FAIL $d$readings\";   elif echo \"$result\" | grep -iqE 'does not support SMART|Unable to detect device type|Operation not supported'; then     echo \"SKIP $d\";   else echo \"UNKNOWN $d $(echo \"$result\" | tr '\\n' ' ' | cut -c1-160)\"; fi; done";

const verdicts: Record<string, string> = { PASS: "PASSED", FAIL: "FAILED", UNKNOWN: "unknown" };
const health_colors: Record<string, Status> = { PASSED: "online", FAILED: "failed", unknown: "unavailable" };

// One disk as the snapshot keeps it for its tile.
export interface DiskItem {
  label: string;
  health: string;
  temperature: number | null;
  power_on_hours: number | null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// One numeric reading from a line's key=value fields, or null when it is missing or garbled.
function reading(fields: Map<string, string>, name: string): number | null {
  const value = fields.get(name);
  if (value === undefined) return null;
  try {
    return parse_float(value);
  } catch {
    return null;
  }
}

// One disk's tile data from a script line: its name, verdict and any readings it carried.
function disk_item(result: string, rest: string): DiskItem {
  const [disk, , tail] = partition(rest, " ");
  const fields = new Map<string, string>();
  if (result !== "UNKNOWN") {
    for (const token of split_words(tail)) {
      if (!token.includes("=")) continue;
      const [key, , value] = partition(token, "=");
      fields.set(key, value);
    }
  }
  return {
    label: disk.startsWith("/dev/") ? disk.slice("/dev/".length) : disk,
    health: verdicts[result],
    temperature: reading(fields, "temp"),
    power_on_hours: reading(fields, "hours"),
  };
}

// ── Page text ────────────────────────────────────────────────────────────────

// A disk tile's caption: its verdict, then its temperature and power-on hours when known.
export function disk_caption(item: Record<string, unknown>): string {
  const parts = [String(item.health || "unknown")];
  if (item.temperature !== null && item.temperature !== undefined) parts.push(`${format_fixed(Number(item.temperature), 0)}°C`);
  if (item.power_on_hours !== null && item.power_on_hours !== undefined) parts.push(`${format_grouped(Number(item.power_on_hours), 0)} h`);
  return parts.join(" · ");
}

// A disk tile's color: PASSED is online, FAILED failed and an unread verdict unavailable.
export function disk_color(item: Record<string, unknown>): Status | null {
  return health_colors[String(item.health)] ?? null;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Per-disk SMART overall-health verdicts counted into healthy, failed and unreadable. A disk whose health could not be
// read counts as unavailable, not healthy, so "I cannot tell" and "it is fine" never look alike; each disk's verdict,
// temperature and power-on hours are kept in the snapshot.
export class Smart extends SignalPlugin {
  override readonly SAMPLED = true;

  override commands(): Command[] {
    return [command(SMART_SCRIPT)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`SMART check script failed: ${stdout || stderr}`);

    let passed = 0;
    let failed = 0;
    let unknown = 0;
    const logs: LogEntry[] = [];
    const disks: DiskItem[] = [];
    for (const line of split_lines(stdout)) {
      const parts = split_words(line.trim(), 1);
      if (parts.length !== 2 || !["PASS", "FAIL", "UNKNOWN", "SKIP"].includes(parts[0])) continue;
      const [result, rest] = parts;
      if (result === "SKIP") continue;
      disks.push(disk_item(result, rest));
      if (result === "FAIL") {
        failed += 1;
        logs.push([`SMART failure detected on ${split_words(rest)[0]}`, "ERROR"]);
      } else if (result === "UNKNOWN") {
        unknown += 1;
        const [disk, , detail] = partition(rest, " ");
        logs.push([`Could not read SMART health for ${disk}: ${detail || "no usable output"}`, "ERROR"]);
      } else {
        passed += 1;
        logs.push([`SMART OK on ${split_words(rest)[0]}`, "INFO"]);
      }
    }

    const total = passed + failed + unknown;
    if (total === 0) {
      const result = CollectResult.unavailable("No physical disks found");
      result.snapshot = [];
      return result;
    }
    return new CollectResult({
      metrics: { disks_total: total, disks_ok: passed, disks_failed: failed, disks_unknown: unknown },
      logs,
      status: failed > 0 ? "failed" : unknown > 0 ? "unavailable" : "online",
      snapshot: disks,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      smart_total_card: { metric: "disks_total", title: "DISKS", format: "int" },
      smart_failed_card: {
        kind: "share", title: "DISK HEALTH", format: "int",
        parts: [
          { metric: "disks_ok", label: "Healthy", color: "online" },
          { metric: "disks_failed", label: "Failed", color: "failed" },
          { metric: "disks_unknown", label: "Unreadable", color: "neutral" },
        ],
      },
      smart_disk_tiles: {
        title: "DISK STATE",
        repeat: { source: "snapshot", container: "tiles", item_format_fn: disk_caption, item_color_by: disk_color, empty_text: "No physical disks found" },
      },
    };
  }

  override card_row(): string[] {
    return ["smart_total_card", "smart_failed_card"];
  }

  override rows(): LayoutRow[] {
    return [["smart_disk_tiles"]];
  }
}
