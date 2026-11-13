// mdadm array health, read from /proc/mdstat. A degraded array is failed and a rebuilding one warning; an unreadable
// /proc/mdstat or a host with no arrays is unavailable.

import { format_fixed, parse_float, parse_int } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import type { Status } from "../shared/status.ts";
import type { CardSpec, LayoutRow } from "../shared/ui_spec.ts";
import { SignalPlugin } from "./base/signal_plugin.ts";

const array_pattern = /^(md\d+)\s*:\s*(\S+)\s+(\S+)/gm;
const level_pattern = /\b(raid\d+|linear|multipath|faulty|container)\b/;
const state_pattern = /\[(\d+)\/(\d+)\]\s*\[([U_]+)\]/;
const recovery_pattern = /(recovery|resync|reshape|check)\s*=\s*([\d.]+)%/;

const state_colors: Record<string, Status> = { clean: "online", resyncing: "warning", degraded: "failed" };

// One array as the snapshot keeps it for its tile.
export interface ArrayItem {
  label: string;
  level: string | null;
  state: "clean" | "resyncing" | "degraded";
  action: string | null;
  progress: number | null;
}

// ── Page text ────────────────────────────────────────────────────────────────

// An array tile's caption: its RAID level, then its state or its rebuild progress.
export function array_caption(item: Record<string, unknown>): string {
  const parts: string[] = item.level ? [String(item.level)] : [];
  const action = item.action;
  const progress = item.progress;
  const rebuild = action && progress !== null && progress !== undefined ? `${String(action)} ${format_fixed(Number(progress), 0)}%` : null;
  if (item.state === "degraded") {
    parts.push("degraded");
    if (rebuild) parts.push(rebuild);
  } else {
    parts.push(rebuild || String(item.state ?? "--"));
  }
  return parts.join(" · ");
}

// An array tile's color: clean is online, resyncing warning and degraded failed.
export function array_color(item: Record<string, unknown>): Status | null {
  return state_colors[String(item.state)] ?? null;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

// Linux software RAID health, the mdadm sibling of the zfs monitor: counts arrays that are clean, degraded or
// rebuilding and keeps each array's level, state and rebuild progress in the snapshot.
export class Md extends SignalPlugin {
  override readonly SAMPLED = true;

  override commands(): Command[] {
    return [command("cat /proc/mdstat 2>&1")];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0 && !stdout.trim()) return CollectResult.unavailable(`Failed to read /proc/mdstat: ${stderr}`);

    let ok = 0;
    let degraded = 0;
    let recovering = false;
    const logs: LogEntry[] = [];
    const arrays: ArrayItem[] = [];

    for (const match of stdout.matchAll(array_pattern)) {
      const device = match[1];
      const start = match.index;
      const header_end = stdout.indexOf("\n", start);
      const header = header_end < 0 ? stdout.slice(start) : stdout.slice(start, header_end);
      const level = level_pattern.exec(header);
      let block = stdout.slice(start + match[0].length);
      const next_blank = block.indexOf("\n\n");
      if (next_blank >= 0) block = block.slice(0, next_blank);

      const state = state_pattern.exec(block);
      const recovery = recovery_pattern.exec(block);
      const array: ArrayItem = {
        label: device,
        level: level ? level[1] : null,
        state: "clean",
        action: recovery ? recovery[1] : null,
        progress: recovery ? parse_float(recovery[2]) : null,
      };
      arrays.push(array);

      if (state) {
        const [expected, active, flags] = [parse_int(state[1]), parse_int(state[2]), state[3]];
        if (flags.includes("_") || active < expected) {
          degraded += 1;
          array.state = "degraded";
          logs.push([`${device}: DEGRADED [${active}/${expected}] [${flags}]`, "ERROR"]);
          continue;
        }
      }

      if (recovery) {
        recovering = true;
        array.state = "resyncing";
        logs.push([`${device}: ${recovery[1]} ${recovery[2]}% in progress`, "WARNING"]);
        ok += 1;
        continue;
      }

      ok += 1;
      logs.push([`${device}: clean`, "INFO"]);
    }

    if (ok + degraded === 0) {
      const result = CollectResult.unavailable("No RAID arrays found in /proc/mdstat");
      result.snapshot = [];
      return result;
    }

    const status: Status = degraded ? "failed" : recovering ? "warning" : "online";
    return new CollectResult({
      metrics: { arrays_total: ok + degraded, arrays_ok: ok, arrays_degraded: degraded },
      logs,
      status,
      snapshot: arrays,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  override cards(): Record<string, CardSpec> {
    return {
      md_total_card: { metric: "arrays_total", title: "ARRAYS", format: "int" },
      md_degraded_card: {
        kind: "share", title: "ARRAY HEALTH", format: "int",
        parts: [
          { metric: "arrays_ok", label: "Clean", color: "online" },
          { metric: "arrays_degraded", label: "Degraded", color: "failed" },
        ],
      },
      md_array_tiles: {
        title: "ARRAY STATE",
        repeat: { source: "snapshot", container: "tiles", item_format_fn: array_caption, item_color_by: array_color, empty_text: "No RAID arrays found" },
      },
    };
  }

  override card_row(): string[] {
    return ["md_total_card", "md_degraded_card"];
  }

  override rows(): LayoutRow[] {
    return [["md_array_tiles"]];
  }
}
