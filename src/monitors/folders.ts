// Sizes of configured folders, measured with one `du -sb` per folder (with a single folder that one command is
// agent-sampled; more than one keeps the poll, since only single-command plugins form a sample stream). Config: folders
// (a list of {path, warning, threshold} with limits in GB) and timeout for each du. A folder at or above its own warning
// or threshold makes the status warning or failed; a du timeout, failure or unparseable output means that folder went
// unmeasured, which reads as unavailable unless another folder measured worse.

import { parse_int } from "@x-tech-laboratories/x-libs/python_text";

import { command, CollectResult, type CmdResult, type Command, type LogEntry } from "../core/connectors/types.ts";
import { log_level_of, severity, type Status } from "../shared/status.ts";
import type { LayoutRow, UISpec } from "../shared/ui_spec.ts";
import { du_command, parse_du, path_key } from "./base/disk_usage.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_bytes, type PluginConfig } from "./base/plugin_helpers.ts";

const default_layout: LayoutRow[] = [["host_card", "count_card"], ["folders"], ["events"]];

export interface FolderConfig {
  path?: string;
  warning?: number | string | null;
  threshold?: number | string | null;
}

// A size against one folder's own limits.
function folder_level(gb: number, folder: FolderConfig): "online" | "warning" | "failed" {
  const { threshold, warning } = folder;
  if (threshold !== null && threshold !== undefined && gb >= Number(threshold)) return "failed";
  if (warning !== null && warning !== undefined && gb >= Number(warning)) return "warning";
  return "online";
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Folders extends Plugin {
  override readonly SAMPLED = true;
  readonly folders: FolderConfig[];
  readonly du_timeout: number;
  private readonly by_key: Map<string, FolderConfig>;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.folders = (config.folders as FolderConfig[] | null | undefined) || [];
    this.du_timeout = parse_int(config.timeout ?? 60);
    this.by_key = new Map(this.valid_folders().map((folder) => [path_key(folder.path!), folder]));
  }

  private valid_folders(): FolderConfig[] {
    return this.folders.filter((folder) => folder.path);
  }

  override commands(): Command[] {
    return this.valid_folders().map((folder) => command(du_command(folder.path!, this.du_timeout)));
  }

  override parse(results: CmdResult[]): CollectResult {
    if (this.folders.length === 0) return CollectResult.unavailable("No folders configured");

    const folders = this.valid_folders();
    let worst_level: Status = "online";
    let worst_gb = 0;
    let any_error = false;
    const metrics: Record<string, number> = {};
    const logs: LogEntry[] = [];

    for (let index = 0; index < Math.min(folders.length, results.length); index++) {
      const path = folders[index].path!;
      const [size_bytes, error] = parse_du(results[index], this.du_timeout);
      if (size_bytes === null) {
        logs.push([`${path}: ${error}`, "ERROR"]);
        any_error = true;
        continue;
      }
      const gb = size_bytes / 1024 ** 3;
      metrics[`folder_${path_key(path)}_gb`] = gb;
      const level = folder_level(gb, folders[index]);
      worst_gb = Math.max(worst_gb, gb);
      if (severity(level) > severity(worst_level)) worst_level = level;
      logs.push([`${path}: ${format_bytes(gb)}`, log_level_of(level)]);
    }
    metrics.worst_folder_gb = worst_gb;

    let status: Status = worst_level;
    if (any_error && severity("unavailable") > severity(worst_level)) status = "unavailable";
    return new CollectResult({ metrics, logs, status });
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  readonly item_color = (item: Record<string, unknown>): "online" | "warning" | "failed" =>
    folder_level(Number(item.value) || 0, this.by_key.get(String(item.key ?? "")) ?? {});

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        count_card: { title: "FOLDERS", value: String(this.folders.length) },
        folders: {
          title: "SIZES",
          repeat: {
            source: "metrics_prefix",
            metrics_prefix: "folder_",
            metrics_suffix: "_gb",
            metrics_exclude: ["worst_folder_gb"],
            item_format: "bytes_gb",
            item_color_by: this.item_color,
            label_transform: "slashes",
            container: "bars",
            bar_max: "largest",
            empty_text: "No folders configured",
          },
        },
      },
      events: true,
    };
  }
}
