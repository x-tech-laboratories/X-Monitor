// Nix garbage collection: whether the store is actually being reclaimed on this host. One cheap script per cycle reads
// the store filesystem and path count, every profile's generation links, the `nix-gc` unit and timer state, and the
// last collection's own summary line from the journal, so a collection that stopped running, failed, or was never
// scheduled reads as a failure rather than as a slowly filling disk. An unreadable store, a probe that returned
// nothing, or no record of any run at all is unavailable. The last run's epoch and yield are carried forward as metric
// metadata, so a journal that has since rotated past it does not erase what was already seen. The monitor only reads:
// collecting on demand is X-Nix's job. Config: unit, timer, store, max_age, stale_status, timer_status, warning,
// threshold (either null to turn that level off), max_generations, max_generation_age.

import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import { shell_quote } from "../core/shell.ts";
import { is_status, log_level_of, type Status } from "../shared/status.ts";
import type { LayoutRow, TableSpec, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { format_age, format_bytes, format_duration, level_for, limit_from, parse_duration, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";
import { json_dumps } from "./base/python_text.ts";

const default_layout: LayoutRow[] = [
  ["host_card", "last_gc_card", "freed_card", "next_gc_card"],
  ["store_card", "paths_card", "generations_card", "roots_card"],
  ["profiles"],
  ["chart"],
  ["events"],
];

// Metric carrying the last collection's epoch as its value and the rest of what was seen of that run as JSON
// metadata, so a rotated journal loses nothing.
const state_metric = "last_gc_epoch";

const summary_pattern = /(\d+)\s+store paths deleted,\s+([\d.]+)\s*(\w+)\s+freed/;

// systemd logs exactly one of these when a run ends, so the journal, not the unit's Result (which a daemon re-exec
// resets to success), decides the outcome.
const failed_mark = "Failed with result";
const finished_mark = "Finished ";

// Seconds a run's summary and error lines may sit from its outcome line and still be that run's.
const run_window = 300;

// The units nix renders a collection's yield in, as bytes.
const size_units: Record<string, number> = {
  b: 1, byte: 1, bytes: 1,
  kb: 1000 ** 1, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
  kib: 1024 ** 1, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  pib: 1024 ** 5,
};

const gib = 1024 ** 3;

// ── Parsing ──────────────────────────────────────────────────────────────────

const is_digits = (text: string): boolean => /^\d+$/.test(text);

// A count with "," grouping, as Python's "{:,}" writes it.
function grouped(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

// One script collecting every cheap fact about collection on this host.
export function probe_script(unit: string, timer: string, store: string): string {
  const [unit_word, timer_word, store_word] = [shell_quote(unit), shell_quote(timer), shell_quote(store)];
  return [
    'echo "hostname=$(uname -n)"',
    `echo "df=$(df -B1 --output=size,used,avail,target ${store_word} 2>/dev/null | tail -1)"`,
    `echo "paths=$(ls -U ${store_word} 2>/dev/null | wc -l)"`,
    'echo "roots=$(ls -U /nix/var/nix/gcroots/auto 2>/dev/null | wc -l)"',
    `echo "svc_state=$(systemctl show ${unit_word} -p ActiveState --value 2>/dev/null)"`,
    `echo "svc_result=$(systemctl show ${unit_word} -p Result --value 2>/dev/null)"`,
    `echo "svc_exit=$(systemctl show ${unit_word} --timestamp=unix -p InactiveEnterTimestamp --value 2>/dev/null)"`,
    `echo "timer_load=$(systemctl show ${timer_word} -p LoadState --value 2>/dev/null)"`,
    `echo "timer_state=$(systemctl show ${timer_word} -p ActiveState --value 2>/dev/null)"`,
    `echo "timer_next=$(systemctl show ${timer_word} --timestamp=unix -p NextElapseUSecRealtime --value 2>/dev/null)"`,
    `echo "summary=$(journalctl -u ${unit_word} -o short-unix --no-pager -n 1 -g 'store paths deleted' 2>/dev/null | tail -1)"`,
    `echo "outcome=$(journalctl -u ${unit_word} -o short-unix --no-pager -n 1 -g 'Finished |Failed with result' 2>/dev/null | tail -1)"`,
    `echo "error=$(journalctl -u ${unit_word} -o short-unix --no-pager -n 1 -g 'error:' 2>/dev/null | tail -1)"`,
    "for prof in /nix/var/nix/profiles/* /nix/var/nix/profiles/per-user/*/*; do",
    '  [ -L "$prof" ] || continue',
    '  target=$(readlink "$prof"); base=${prof##*/}',
    '  case "$target" in "$base"-*-link) ;; *) continue ;; esac',
    "  count=0; oldest=",
    '  for link in "$prof"-*-link; do',
    '    [ -L "$link" ] || continue',
    "    count=$((count + 1))",
    '    stamp=$(stat -c %Y "$link" 2>/dev/null)',
    '    if [ -n "$stamp" ] && { [ -z "$oldest" ] || [ "$stamp" -lt "$oldest" ]; }; then oldest=$stamp; fi',
    "  done",
    '  generation=${target#"$base"-}',
    '  echo "profile=$prof|${generation%-link}|$count|$oldest"',
    "done",
  ].join("\n");
}

export interface GcProbe {
  profile: string[];
  [key: string]: string | string[] | undefined;
}

// The probe's key=value lines as a record, with the repeated profile lines collected into a list.
export function parse_probe(stdout: string): GcProbe {
  const fields: GcProbe = { profile: [] };
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "profile") fields.profile.push(value);
    else fields[key] = value;
  }
  return fields;
}

function text_of(fields: GcProbe, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
}

// A systemd `--timestamp=unix` value ("@1788757200") as an epoch.
export function systemd_epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const digits = value.replace(/^@+/, "").split(".")[0];
  return is_digits(digits) ? Number(digits) : null;
}

// The epoch off a journalctl `-o short-unix` line.
export function log_epoch(line: string): number | null {
  const stamp = line ? line.split(" ")[0] : "";
  if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(stamp)) return null;
  return Math.trunc(Number(stamp));
}

// A journalctl line without its timestamp, host and unit prefix.
function log_message(line: string): string {
  const separator = line.indexOf(": ");
  const message = separator === -1 ? "" : line.slice(separator + 2);
  return (message || line).trim().slice(0, 200);
}

// Whether a journal line close to the run's own end belongs to that run.
function same_run(epoch: number | null, run_epoch: number): boolean {
  return epoch !== null && Math.abs(run_epoch - epoch) <= run_window;
}

// nix's rendered "44.4 GiB" yield in bytes.
export function bytes_from(amount: string, unit: string): number | null {
  const factor = size_units[unit.toLowerCase()];
  if (factor === undefined) return null;
  if (!/^\d*\.?\d*$/.test(amount) || amount === "." || amount === "") return null;
  return Number(amount) * factor;
}

// A configured status name, falling back on anything unrecognised.
function severity_of(value: unknown, fallback: Status): Status {
  const text = String(value);
  return is_status(text) ? text : fallback;
}

export interface ProfileRow {
  path: string;
  generation: number | null;
  count: number;
  oldest_epoch: number | null;
}

// One `path|generation|count|oldest` probe line as a row.
export function profile_row(raw: string): ProfileRow | null {
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  const [path, generation, count, oldest] = parts;
  if (!path) return null;
  return {
    path,
    generation: is_digits(generation) ? Number(generation) : null,
    count: is_digits(count) ? Number(count) : 0,
    oldest_epoch: is_digits(oldest) ? Number(oldest) : null,
  };
}

// What X-Monitor knows of the last collection.
export interface GcState {
  epoch?: number;
  deleted?: number | null;
  freed_bytes?: number | null;
  error?: string | null;
  succeeded?: boolean;
  [key: string]: unknown;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class NixGc extends Plugin {
  readonly unit: string;
  readonly timer: string;
  readonly store: string;
  readonly max_age: number;
  readonly stale_status: Status;
  readonly timer_status: Status;
  readonly warning: number | null;
  readonly threshold: number | null;
  readonly max_generations: number | null;
  readonly max_generation_age: number | null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.unit = String(config.unit ?? "nix-gc.service");
    this.timer = String(config.timer ?? "nix-gc.timer");
    this.store = String(config.store ?? "/nix/store");
    this.max_age = parse_duration(config.max_age ?? "2w");
    this.stale_status = severity_of(config.stale_status, "failed");
    this.timer_status = severity_of(config.timer_status, "warning");
    this.warning = limit_from(config, "warning", 80);
    this.threshold = limit_from(config, "threshold", 90);
    this.max_generations = config.max_generations !== undefined && config.max_generations !== null ? Math.trunc(Number(config.max_generations)) : null;
    this.max_generation_age = config.max_generation_age !== undefined && config.max_generation_age !== null ? parse_duration(config.max_generation_age) : null;
  }

  // ── Collection ───────────────────────────────────────────────────────────

  override commands(): Command[] {
    return [command(probe_script(this.unit, this.timer, this.store))];
  }

  // The last collection X-Monitor has seen, carried between cycles as metric metadata.
  state(): GcState {
    const metric = this.data ? this.data.latest_metric(state_metric) : null;
    if (metric === null || !metric.metadata) return {};
    try {
      const data: unknown = JSON.parse(metric.metadata);
      return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as GcState) : {};
    } catch {
      return {};
    }
  }

  override parse(results: CmdResult[]): CollectResult {
    if (results.length === 0) return CollectResult.unavailable("No probe result for this cycle");

    const probe = results[0];
    if (probe.exit_code !== 0 && !probe.stdout.trim()) {
      return CollectResult.unavailable(`Could not read the Nix store: ${(probe.stderr || probe.stdout).trim().slice(0, 200)}`);
    }

    const fields = parse_probe(probe.stdout);
    if (!text_of(fields, "df")) return CollectResult.unavailable(`${this.store} is unreadable — is Nix installed on this host?`);
    return this.assemble(fields, this.collection_state(fields));
  }

  // Folds what this cycle saw of the last collection into the stored state, keeping the older record whenever the
  // journal no longer has it.
  private collection_state(fields: GcProbe): GcState {
    const seen = this.observed_run(fields);
    const stored = this.state();
    if (seen === null) return stored;
    const stored_epoch = Math.trunc(Number(stored.epoch || 0));
    if (same_run(seen.epoch!, stored_epoch)) {
      // The same run seen again; a later cycle may have picked up lines the first one missed.
      return { ...stored, ...Object.fromEntries(Object.entries(seen).filter(([, value]) => value !== null && value !== undefined)) };
    }
    // A run recorded earlier, such as a manual collection, may be newer than the unit's own, so the newer record wins.
    return seen.epoch! > stored_epoch ? seen : stored;
  }

  // This cycle's reading of the last collection as one whole record, or null when nothing records that one ran.
  private observed_run(fields: GcProbe): GcState | null {
    const outcome = text_of(fields, "outcome");
    const summary = text_of(fields, "summary");
    const error = text_of(fields, "error");
    const outcome_epoch = log_epoch(outcome);
    const match = summary_pattern.exec(summary);
    const summary_epoch = match ? log_epoch(summary) : null;

    // The unit's own stop bounds the run when the journal has rotated past every line of it.
    const candidates = [outcome_epoch, summary_epoch, systemd_epoch(text_of(fields, "svc_exit"))].filter((value): value is number => value !== null);
    if (candidates.length === 0) return null;
    const epoch = Math.max(...candidates);

    const run: GcState = { epoch, deleted: null, freed_bytes: null, error: null };
    // A `Result` of success proves nothing, since systemd resets it on the daemon re-exec a NixOS switch does, so only
    // the journal may call a run failed.
    if (outcome.includes(failed_mark)) run.succeeded = false;
    else if (outcome.includes(finished_mark)) run.succeeded = true;
    else {
      const result = fields.svc_result;
      run.succeeded = result === undefined || result === "" || result === "success";
    }

    if (match && same_run(summary_epoch, epoch)) {
      run.deleted = Number(match[1]);
      run.freed_bytes = bytes_from(match[2], match[3]);
    }
    if (!run.succeeded && same_run(log_epoch(error), epoch)) run.error = log_message(error);
    return run;
  }

  // The probe's facts and the stored collection record as this cycle's metrics, log lines and worst-of status.
  private assemble(fields: GcProbe, state: GcState): CollectResult {
    const accumulator = new StatusAccumulator();
    const now = Math.trunc(Date.now() / 1000);
    const metrics: Record<string, number> = {};
    const logs: [string, string][] = [];

    Object.assign(metrics, this.store_metrics(fields, accumulator, logs));
    const profiles = fields.profile.map(profile_row).filter((row): row is ProfileRow => row !== null);
    Object.assign(metrics, this.profile_metrics(profiles, now, accumulator, logs));
    Object.assign(metrics, this.collection_metrics(fields, state, now, accumulator, logs));

    metrics[state_metric] = Number(state.epoch || 0);
    return new CollectResult({
      metrics,
      metadata: { [state_metric]: json_dumps(state) },
      logs,
      status: accumulator.status,
      snapshot: {
        hostname: fields.hostname ?? null,
        profiles,
        timer_load: fields.timer_load ?? null,
        timer_state: fields.timer_state ?? null,
        svc_state: fields.svc_state ?? null,
        svc_result: fields.svc_result ?? null,
      },
    });
  }

  // The store's filesystem usage, path count and auto GC root count.
  private store_metrics(fields: GcProbe, accumulator: StatusAccumulator, logs: [string, string][]): Record<string, number> {
    const metrics: Record<string, number> = {};
    const parts = text_of(fields, "df").split(/\s+/).filter(Boolean);
    if (parts.length >= 3 && parts.slice(0, 3).every(is_digits)) {
      const [size, used, avail] = parts.slice(0, 3).map(Number);
      const used_pct = size ? (used / size) * 100 : 0.0;
      metrics.store_used_pct = used_pct;
      metrics.store_size_gb = size / gib;
      metrics.store_used_gb = used / gib;
      metrics.store_avail_gb = avail / gib;
      const level = level_for(used_pct, this.warning, this.threshold);
      accumulator.escalate(level);
      logs.push([
        `${this.store} is ${used_pct.toFixed(1)}% full (${format_bytes(used, "B")} of ${format_bytes(size, "B")}, ${format_bytes(avail, "B")} free)`,
        level === "online" ? "INFO" : "WARNING",
      ]);
    }

    for (const [key, metric] of [["paths", "store_paths"], ["roots", "gc_roots"]] as const) {
      const value = text_of(fields, key);
      if (is_digits(value)) metrics[metric] = Number(value);
    }
    if ("store_paths" in metrics) {
      logs.push([`${grouped(metrics.store_paths)} store paths, ${grouped(metrics.gc_roots ?? 0)} indirect GC roots`, "INFO"]);
    }
    return metrics;
  }

  // Generation counts and the oldest generation still on disk, which `--delete-older-than` is meant to bound.
  private profile_metrics(profiles: ProfileRow[], now: number, accumulator: StatusAccumulator, logs: [string, string][]): Record<string, number> {
    if (profiles.length === 0) return {};
    const metrics: Record<string, number> = { profiles: profiles.length, generations: profiles.reduce((sum, row) => sum + row.count, 0) };

    const stamps = profiles.map((row) => row.oldest_epoch).filter((stamp): stamp is number => Boolean(stamp));
    if (stamps.length > 0) {
      const oldest = Math.min(...stamps);
      metrics.oldest_generation_epoch = oldest;
      const age = now - oldest;
      const stale = this.max_generation_age !== null && age > this.max_generation_age;
      if (stale) accumulator.escalate("warning");
      logs.push([
        `${Math.trunc(metrics.generations)} generations across ${profiles.length} profiles, oldest kept ${format_age(age)}` +
          (stale ? `, over the ${format_duration(this.max_generation_age!)} limit` : ""),
        stale ? "WARNING" : "INFO",
      ]);
    }

    const crowded = profiles.filter((row) => this.max_generations !== null && row.count > this.max_generations);
    if (crowded.length > 0) {
      accumulator.escalate("warning");
      logs.push([`Over the ${this.max_generations}-generation limit: ` + crowded.map((row) => `${row.path} (${row.count})`).join(", "), "WARNING"]);
    }
    return metrics;
  }

  // When collection last ran, what it yielded, and whether it is still scheduled to run again.
  private collection_metrics(fields: GcProbe, state: GcState, now: number, accumulator: StatusAccumulator, logs: [string, string][]): Record<string, number> {
    const metrics: Record<string, number> = {};
    const running = ["active", "activating", "reloading"].includes(text_of(fields, "svc_state"));
    if (running) logs.push([`${this.unit} is collecting now`, "INFO"]);

    const succeeded = state.succeeded ?? true;
    if (!succeeded) {
      accumulator.escalate("failed");
      const reason = state.error;
      logs.push(["The last collection failed" + (reason ? `: ${reason}` : ""), "ERROR"]);
    }
    metrics.last_gc_success = succeeded ? 1.0 : 0.0;

    const epoch = state.epoch;
    if (!epoch) {
      accumulator.escalate("unavailable");
      logs.push([`Could not tell when ${this.unit} last ran — no record in its journal and no timestamp on the unit`, "WARNING"]);
    } else {
      const age = now - Math.trunc(epoch);
      const stale = age > this.max_age && !running;
      if (stale) accumulator.escalate(this.stale_status);
      const yielded = state.freed_bytes ?? null;
      const detail = yielded !== null ? `, freeing ${format_bytes(yielded, "B")} across ${grouped(state.deleted || 0)} paths` : "";
      logs.push([
        `Last collected ${format_age(age)}${detail}` + (stale ? `, over the ${format_duration(this.max_age)} limit` : ""),
        stale ? log_level_of(this.stale_status) : "INFO",
      ]);
      if (yielded !== null) {
        metrics.last_gc_freed_gb = yielded / gib;
        metrics.last_gc_deleted = Number(state.deleted || 0);
      }
    }

    const scheduled = fields.timer_state === "active";
    metrics.timer_active = scheduled ? 1.0 : 0.0;
    if (!scheduled) {
      accumulator.escalate(this.timer_status);
      const missing = fields.timer_load !== "loaded";
      logs.push([`${this.timer} is ` + (missing ? "not installed" : "inactive") + " — nothing collects on a schedule here", log_level_of(this.timer_status)]);
    }
    const next_run = systemd_epoch(text_of(fields, "timer_next"));
    if (next_run) {
      metrics.next_gc_epoch = next_run;
      logs.push([`Next collection in ${format_duration(Math.max(next_run - now, 0))}`, "INFO"]);
    }
    return metrics;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private metric(name: string): number | null {
    return this.data.latest_metric(name)?.value ?? null;
  }

  private last_gc_pair(): [string, string | null] {
    const state = this.state();
    const epoch = state.epoch;
    if (!epoch) return ["UNKNOWN", "unavailable"];
    const age = Math.trunc(Date.now() / 1000) - Math.trunc(epoch);
    if (!(state.succeeded ?? true)) return [format_age(age), "failed"];
    return [format_age(age), age > this.max_age ? this.stale_status : "online"];
  }

  private next_gc_pair(): [string, string | null] {
    if ((this.metric("timer_active") || 0) < 0.5) return ["NOT SCHEDULED", this.timer_status];
    const epoch = this.metric("next_gc_epoch");
    if (!epoch) return ["--", null];
    return [format_duration(Math.max(Math.trunc(epoch) - Math.trunc(Date.now() / 1000), 0)), "online"];
  }

  get last_gc_text(): string {
    return this.last_gc_pair()[0];
  }

  get last_gc_color(): string | null {
    return this.last_gc_pair()[1];
  }

  get next_gc_text(): string {
    return this.next_gc_pair()[0];
  }

  get next_gc_color(): string | null {
    return this.next_gc_pair()[1];
  }

  get freed_text(): string {
    const state = this.state();
    const freed = state.freed_bytes;
    if (freed === null || freed === undefined) return "--";
    return `${format_bytes(freed, "B")} · ${grouped(state.deleted || 0)} paths`;
  }

  // One row per profile: where it is, which generation is live, how many are kept, and how far back the oldest goes.
  get profile_rows(): Record<string, string>[] {
    const snapshot = this.data.latest_snapshot<{ profiles?: Partial<ProfileRow>[] }>({}) ?? {};
    const now = Math.trunc(Date.now() / 1000);
    return (snapshot.profiles ?? []).map((row) => {
      const oldest = row.oldest_epoch;
      return {
        path: row.path ?? "--",
        generation: String(row.generation || "--"),
        count: String(row.count || 0),
        oldest: oldest ? format_age(now - Math.trunc(oldest)) : "--",
      };
    });
  }

  override get UI_SPEC(): UISpec {
    const profiles_table: TableSpec & { title: string } = {
      title: "Profiles",
      row_key: "path",
      rows_attr: "profile_rows",
      columns: [
        { name: "path", label: "Profile", field: "path", align: "left" },
        { name: "generation", label: "Current", field: "generation", align: "right" },
        { name: "count", label: "Generations", field: "count", align: "right" },
        { name: "oldest", label: "Oldest kept", field: "oldest", align: "right" },
      ],
    };
    return {
      layout: default_layout,
      cards: {
        last_gc_card: { title: "LAST COLLECTION", value_attr: "last_gc_text", color_attr: "last_gc_color" },
        freed_card: { title: "LAST YIELD", value_attr: "freed_text", refresh: true },
        next_gc_card: { title: "NEXT COLLECTION", value_attr: "next_gc_text", color_attr: "next_gc_color" },
        store_card: { kind: "gauge", metric: "store_used_pct", title: "STORE USED", format: "percent1", color: { warning: this.warning, threshold: this.threshold } },
        paths_card: { metric: "store_paths", title: "STORE PATHS", format: "count_comma" },
        generations_card: { metric: "generations", title: "GENERATIONS", format: "int" },
        roots_card: { metric: "gc_roots", title: "GC ROOTS", format: "count_comma" },
      },
      tables: { profiles: profiles_table },
      chart: { metric: "store_paths", title: `STORE PATHS — ${this.store}` },
      events: { title: "Events", limit: 100, full_height: true },
    };
  }
}

