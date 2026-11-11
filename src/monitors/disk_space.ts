// Disk usage of one filesystem path, read with df, sampled on the host by the agent where there is one. Config: path
// (default /), warning (percent used, default off) and threshold (percent used, default 90), either set to null to turn
// that level off; usage at or above a limit is that level, and a df or parse error is unavailable.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { df_command, parse_df } from "./base/disk_usage.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_bytes, level_for, limit_from, limits_text, type PluginConfig } from "./base/plugin_helpers.ts";

const columns = ["size", "used", "avail", "pcent"];

const default_layout: LayoutRow[] = [
  ["host_card", "path_card", "threshold_card"],
  ["usage_card", "avail_card", "total_card"],
  ["chart"],
  ["events"],
];

// ── Monitor ──────────────────────────────────────────────────────────────────

export class DiskSpace extends Plugin {
  override readonly SAMPLED = true;
  readonly path: string;
  readonly warning: number | null;
  readonly threshold: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.path = String(config.path ?? "/");
    this.warning = limit_from(config, "warning");
    this.threshold = limit_from(config, "threshold", 90);
  }

  override commands(): Command[] {
    return [command(`${df_command(columns, { path: this.path, byte_blocks: true })} | tail -1`)];
  }

  override parse(results: CmdResult[]): CollectResult {
    const { exit_code, stdout, stderr } = results[0];
    if (exit_code !== 0) return CollectResult.unavailable(`df failed for '${this.path}': ${stderr}`);

    const rows = parse_df(stdout, columns, false);
    if (rows.length === 0) return CollectResult.unavailable(`Failed to parse df output '${stdout.trim()}'`);
    const row = rows[0];
    const used_pct = row.pcent;
    const size_gb = row.size / 1024 ** 3;
    const used_gb = row.used / 1024 ** 3;
    const avail_gb = row.avail / 1024 ** 3;

    const status = level_for(used_pct, this.warning, this.threshold);
    return new CollectResult({
      metrics: { used_pct, size_gb, used_gb, avail_gb },
      logs: [[
        `${this.path}: ${used_pct.toFixed(1)}% used (${format_bytes(used_gb)} of ${format_bytes(size_gb)}, ${format_bytes(avail_gb)} free, ${limits_text(this.warning, this.threshold, "%")})`,
        status === "online" ? "INFO" : "WARNING",
      ]],
      status,
    });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  // The limits card's text, such as "warn 80% / fail 90%".
  get limits_label(): string {
    return limits_text(this.warning, this.threshold, "%");
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        path_card: { title: "PATH", value_attr: "path" },
        threshold_card: { title: "LIMITS", value_attr: "limits_label" },
        usage_card: {
          kind: "gauge", metric: "used_pct", title: "USAGE", format: "percent1",
          color: { warning: this.warning ?? this.threshold, threshold: this.threshold },
        },
        avail_card: { metric: "avail_gb", title: "AVAILABLE", format: "bytes_gb" },
        total_card: { metric: "size_gb", title: "TOTAL SIZE", format: "bytes_gb" },
      },
      chart: { metric: "used_pct", title: `USAGE HISTORY — ${this.path} (%)` },
      events: true,
    };
  }
}
