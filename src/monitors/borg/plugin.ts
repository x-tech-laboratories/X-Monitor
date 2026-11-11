// Borg backup repository freshness and size, collected by running borg over SSH on the target: `borg list --json` each
// cycle, `borg info --json` when collect_stats is on, and a detached `borg create` job that actions launch and later
// cycles poll to completion. The poll calls go out as one command that runs them in sequence and frames their output,
// because separate commands are dispatched concurrently and would contend for the repo's chunks cache lock.
// Config: repo, max_age, passphrase / passphrase_file / passphrase_command, borg_bin, ssh_key / rsh, require_sudo,
// list_archives, collect_stats, cache_dir, lock_wait / backup_lock_wait, the backup set (source_paths, exclude*,
// one_file_system, compression, archive_prefix), and allow_purge / purge_match. A borg error, an empty repo, or a newest
// archive older than max_age is failed; an unreachable host, a missing borg binary, a repo the SSH user cannot read, a
// lock borg gave up waiting for, or unparseable output is unavailable. This monitor has no warning tier.
// Optional extras: a restore canary (canary_path, canary_interval) extracted from the newest archive and compared with
// the live file; check freshness (check_units, check_max_age) read from those units' journal; actions to preview a
// prune (keep_*, prune_match), list an archive's folders for the browser (browse_limit), restore paths into
// restore_dir, diff an archive with the one before it, and run check, compact, prune and archive deletion as detached
// jobs, the destructive ones only with allow_delete. With allow_purge, Purge Excluded rewrites existing archives without
// whatever the exclude set now drops and compacts the space away, and Purge Preview lists what that would be.
// Scheduled backups: prune_after_backup / compact_after_backup chain onto a real backup; skip_when_unreachable /
// skip_while_active skip a job that would not get through; job_nice, job_io_idle, inhibit_sleep and job_lock wrap every
// job; and check_kinds holds each kind of Check to a maximum age.

import { readFileSync } from "node:fs";

import { launch_command, parse_launch, parse_poll, poll_command, split_lines, workdir_for } from "../../core/connectors/job_commands.ts";
import { action_plan, cmd_result, command, CollectResult, type ActionOutcome, type ActionPlan, type ActionPlanResult, type CmdResult, type Command, type LogEntry } from "../../core/connectors/types.ts";
import { shell_quote } from "../../core/shell.ts";
import type { JobDict } from "../../core/state/records.ts";
import type { ActionButtonSpec, LayoutRow, TableSpec, UISpec } from "../../shared/ui_spec.ts";
import { Plugin, type ActionState, type CustomView } from "../base/plugin_base.ts";
import { format_age, format_duration, KILL_GRACE_SECONDS, parse_duration, type PluginConfig } from "../base/plugin_helpers.ts";
import { json_dumps, py_repr } from "../base/python_text.ts";
import { browser_view_data } from "./browser.ts";
import {
  canary_verdict, CHECK_KINDS, check_job_kind, check_unit_script, covered_by_check_job, merge_unit, observed_unit, parse_check_units,
  TRACKED_CHECKS, type CheckState,
} from "./checks.ts";
import { children_filter, decode_json, format_size, is_object, LIST_FORMAT, parse_listing, PRUNE_LINE, RepoView, type ArchiveEntry, type ListingEntry, type RepositoryInfo } from "./parsing.ts";
import {
  archive_member, as_list, CUT_SHORT, failure_hint, frame_line, list_unavailable, POLL_BASE_DIR_VAR, POLL_DEADLINE_VAR, POLL_LEFT_FN, POLL_RC_VAR,
  preflight_script, redact, skip_reason, split_poll, splitlines, ssh_endpoint, STEP_MARK, then_steps, with_preflight, wrap_job,
} from "./shell.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const keep_options = ["keep_within", "keep_last", "keep_secondly", "keep_minutely", "keep_hourly", "keep_daily", "keep_weekly", "keep_monthly", "keep_yearly"];

// Actions that start a detached job, which interpret_action records from the pid the launch prints.
const launched = ["run_backup", "dry_run_backup", "restore_archive", "check_repo", "compact_repo", "prune_repo", "delete_archive", "purge_preview", "purge_excluded"];

// Keeps only the "Processing" lines and the top-most excluded path of each dropped tree from `borg recreate --list`, then exits with borg's own status.
const topmost_excluded =
  "awk '/^__x_monitor_rc=/ { rc = substr($0, 12); next } " +
  '/^x / { p = substr($0, 3); if (top != "" && index(p, top "/") == 1) next; top = p; print; next } ' +
  "{ top = \"\"; print } END { exit rc }'";

// How many listed folders the browser keeps before forgetting the least recently used.
const listing_cache = 256;

const default_layout: LayoutRow[] = [
  ["host_card", "repo_card", "maxage_card", "state_card"],
  ["size_card", "dedup_card", "count_card", "age_card"],
  ["canary_card", "checks_card"],
  ["archives"],
  ["browser"],
  ["jobs"],
  ["events"],
];

type ValueColor = [text: string, color: string | null];

// A pending launch: the job kind, its redacted command, its working folder and the tail of its started message.
type PendingLaunch = [kind: string, redacted: string, workdir: string, started: string];

function now_seconds(): number {
  return Math.trunc(Date.now() / 1000);
}

// Python's str.capitalize: the first character upper-cased and the rest lower-cased.
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

// A local time as "%Y-%m-%dT%H:%M:%S".
function local_stamp(moment: Date): string {
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())}T${two(moment.getHours())}:${two(moment.getMinutes())}:${two(moment.getSeconds())}`;
}

// A UTC time as "%Y%m%dT%H%M%S".
function utc_compact_stamp(moment: Date): string {
  return `${moment.getUTCFullYear()}${two(moment.getUTCMonth() + 1)}${two(moment.getUTCDate())}T${two(moment.getUTCHours())}${two(moment.getUTCMinutes())}${two(moment.getUTCSeconds())}`;
}

function listing_key(archive: string, member: string): string {
  return JSON.stringify([archive, member]);
}

function text_of(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export class Borg extends Plugin {
  static readonly DEFAULT_TIMEOUT = 180.0;

  readonly repo: string | null;
  readonly max_age: number;
  passphrase: string | null;
  readonly passphrase_file: string | null;
  readonly passphrase_command: string | null;
  readonly borg_bin: string;
  readonly lock_wait: unknown;
  readonly require_sudo: boolean;
  readonly list_archives: number;
  readonly collect_stats: boolean;
  readonly ssh_key: string | null;
  readonly rsh: string | null;

  readonly source_paths: string[];
  readonly exclude: string[];
  readonly exclude_from: string | null;
  readonly exclude_caches: boolean;
  readonly exclude_if_present: string[];
  readonly one_file_system: boolean;
  readonly compression: string;
  readonly archive_prefix: string;
  readonly cache_dir: string | null;
  // Only an explicitly configured dir is known-writable on a monitor-only target, so polls fall back to mktemp under the default.
  readonly cache_dir_configured: boolean;
  readonly backup_lock_wait: unknown;
  readonly canary_path: string | null;
  readonly canary_interval: number;
  readonly check_units: string[];
  readonly check_max_age: number;
  readonly restore_dir: string;
  readonly browse_limit: number;
  readonly retention: [key: string, value: unknown][];
  readonly prune_match: string;
  readonly allow_delete: boolean;
  readonly check_verify_data: boolean;
  readonly allow_purge: boolean;
  // Unset means every archive, since archives X-Monitor created share the repo with the owning tool's under a different prefix.
  readonly purge_match: string | null;

  readonly prune_after_backup: boolean;
  readonly compact_after_backup: boolean;
  readonly skip_when_unreachable: boolean;
  readonly skip_while_active: string[];
  readonly job_nice: number | null;
  readonly job_io_idle: boolean;
  readonly inhibit_sleep: boolean;
  readonly job_lock: string | null;
  readonly check_kinds: Map<string, number>;

  private polling_job: JobDict | null = null;
  // The names of the calls the last commands() planned, in the order they run.
  poll_calls: string[] = [];
  // Archives never change once written, so a folder listed once stays true until the archive is deleted.
  listings = new Map<string, { archive: string; entries: ListingEntry[] }>();
  private pending_launch: PendingLaunch | null = null;

  constructor(name: string, raw_config: PluginConfig) {
    const config: PluginConfig = { timeout: Borg.DEFAULT_TIMEOUT, ...raw_config };
    super(name, config);
    this.repo = text_of(config.repo);
    this.max_age = parse_duration(config.max_age ?? "1d");
    this.passphrase = text_of(config.passphrase);
    this.passphrase_file = text_of(config.passphrase_file);
    this.passphrase_command = text_of(config.passphrase_command);
    this.borg_bin = String(config.borg_bin ?? "borg");
    this.lock_wait = config.lock_wait ?? 30;
    this.require_sudo = Boolean(config.require_sudo ?? false);
    this.list_archives = Math.max(1, Math.trunc(Number(config.list_archives ?? 10)));
    this.collect_stats = Boolean(config.collect_stats ?? true);
    this.ssh_key = text_of(config.ssh_key);
    this.rsh = text_of(config.rsh);

    this.source_paths = as_list(config.source_paths);
    this.exclude = as_list(config.exclude);
    this.exclude_from = text_of(config.exclude_from);
    this.exclude_caches = Boolean(config.exclude_caches ?? true);
    this.exclude_if_present = as_list(config.exclude_if_present);
    this.one_file_system = Boolean(config.one_file_system ?? true);
    this.compression = String(config.compression ?? "zstd");
    this.archive_prefix = String(config.archive_prefix ?? name);
    this.cache_dir = "cache_dir" in config ? text_of(config.cache_dir) : "/var/cache/x-monitor-borg";
    this.cache_dir_configured = Boolean(config.cache_dir);
    this.backup_lock_wait = config.backup_lock_wait ?? 600;
    this.canary_path = text_of(config.canary_path);
    this.canary_interval = parse_duration(config.canary_interval ?? "1d");
    this.check_units = as_list(config.check_units);
    this.check_max_age = parse_duration(config.check_max_age ?? "8d");
    this.restore_dir = String(config.restore_dir ?? "/var/tmp/x-monitor-restore");
    this.browse_limit = Math.max(1, Math.trunc(Number(config.browse_limit ?? 2000)));
    this.retention = keep_options
      .filter((key) => ![null, undefined, "", 0, false].includes(config[key] as never))
      .map((key) => [key, config[key]]);
    this.prune_match = String(config.prune_match ?? `${this.archive_prefix}-*`);
    this.allow_delete = Boolean(config.allow_delete ?? false);
    this.check_verify_data = Boolean(config.check_verify_data ?? false);
    this.allow_purge = Boolean(config.allow_purge ?? false);
    this.purge_match = text_of(config.purge_match);

    this.prune_after_backup = Boolean(config.prune_after_backup ?? false);
    this.compact_after_backup = Boolean(config.compact_after_backup ?? false);
    if (this.prune_after_backup && this.retention.length === 0) throw new Error("prune_after_backup needs a keep_* retention policy");
    this.skip_when_unreachable = Boolean(config.skip_when_unreachable ?? true);
    this.skip_while_active = as_list(config.skip_while_active);
    this.job_nice = config.job_nice !== null && config.job_nice !== undefined ? Math.trunc(Number(config.job_nice)) : null;
    this.job_io_idle = Boolean(config.job_io_idle ?? false);
    this.inhibit_sleep = Boolean(config.inhibit_sleep ?? false);
    this.job_lock = text_of(config.job_lock);
    this.check_kinds = new Map(Object.entries((config.check_kinds as Record<string, unknown> | null | undefined) || {}).map(([kind, age]) => [String(kind), parse_duration(age)]));
    const unknown = [...this.check_kinds.keys()].filter((kind) => !(TRACKED_CHECKS as readonly string[]).includes(kind)).sort();
    if (unknown.length > 0) throw new Error(`check_kinds has unknown kinds ${py_repr(unknown)}; use repository, archives, data or extract`);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  private read_passphrase_file(): string | null {
    try {
      return readFileSync(this.passphrase_file!, "utf8").replace(/\n+$/, "");
    } catch {
      return null;
    }
  }

  private env_prefix(persistent_cache = false): string[] {
    const env: string[] = [];
    if (this.passphrase !== null) {
      env.push("BORG_PASSPHRASE=" + shell_quote(this.passphrase));
    } else if (this.passphrase_file !== null) {
      const secret = this.read_passphrase_file();
      if (secret !== null) env.push("BORG_PASSPHRASE=" + shell_quote(secret));
    } else if (this.passphrase_command !== null) {
      env.push("BORG_PASSCOMMAND=" + shell_quote(this.passphrase_command));
    }
    env.push("BORG_RELOCATED_REPO_ACCESS_IS_OK=no");

    if (this.rsh || this.ssh_key) {
      const rsh = this.rsh || "ssh -i " + shell_quote(this.ssh_key!) + " -o IdentitiesOnly=yes -o BatchMode=yes";
      env.push("BORG_RSH=" + shell_quote(rsh));
    }

    if (persistent_cache && this.cache_dir) env.push("BORG_BASE_DIR=" + shell_quote(this.cache_dir));
    else env.push(`BORG_BASE_DIR="$${POLL_BASE_DIR_VAR}"`);
    return env;
  }

  private build(args: string[], options: { persistent_cache?: boolean; bounded?: boolean; wrapped?: boolean } = {}): string {
    const persistent_cache = options.persistent_cache ?? false;
    const prefix = this.require_sudo ? ["sudo", "-n"] : [];
    const env = this.env_prefix(persistent_cache);
    // Polls only: a backup is launched detached so it outlives the collect cycle, and must not inherit its deadline; it
    // goes after env, because sudo reads leading VAR=val as assignments and runs the first non-assignment.
    const deadline = options.bounded ? this.poll_deadline() : [];
    const command_text = [...prefix, ...env, ...deadline, ...args.map(shell_quote)].join(" ");
    if (!(options.wrapped ?? true) || (persistent_cache && this.cache_dir)) return command_text;
    // The trap is what keeps the throwaway dir throwaway, since borg builds a full chunks cache in it on every poll.
    return `${POLL_BASE_DIR_VAR}=$(mktemp -d); trap 'rm -rf "$${POLL_BASE_DIR_VAR}"' EXIT; ${command_text}`;
  }

  // Argv bounding a poll call by what is left of the whole poll's deadline, which the sequence sets.
  private poll_deadline(): string[] {
    if (!this.timeout || this.timeout <= 0) return [];
    return ["timeout", "-k", String(KILL_GRACE_SECONDS), `"$(${POLL_LEFT_FN})"`];
  }

  // The named calls this poll makes, in the order they run.
  poll_plan(): [name: string, command: string][] {
    const calls: [string, string][] = [["list", this.list_command()]];
    if (this.collect_stats) calls.push(["info", this.info_command()]);
    const archive = this.canary_archive();
    if (archive && this.canary_due()) calls.push(...this.canary_calls(archive));
    if (this.check_units.length > 0) calls.push(["checks", check_unit_script(this.check_units)]);
    return calls;
  }

  // The poll as one command: run as separate commands the calls would be dispatched concurrently and contend for this
  // repo's chunks cache lock.
  poll_command_text(): string {
    return this.sequence_command(this.poll_plan().map(([, call]) => call));
  }

  // Runs calls one after another under one deadline and frames each one's output; `filters` pipes a call's stdout
  // through a shell filter and `limits` then caps it at that many lines; `live` prints each call's stdout as it is
  // written, for a detached job whose log is read while it runs, its exit code following in the frame opening its stderr.
  sequence_command(calls: string[], options: { limits?: Record<number, number> | null; filters?: Record<number, string> | null; live?: boolean } = {}): string {
    const limits = options.limits ?? {};
    const filters = options.filters ?? {};
    const base = `$${POLL_BASE_DIR_VAR}`;
    const parts = [`${POLL_BASE_DIR_VAR}=$(mktemp -d)`, `trap 'rm -rf "${base}"' EXIT`];
    if (this.timeout && this.timeout > 0) {
      // One deadline for the poll rather than one per call, so that running them in sequence cannot outlast the monitor's interval.
      parts.push(`${POLL_DEADLINE_VAR}=$(( $(date +%s) + ${Math.trunc(this.timeout)} ))`);
      parts.push(
        `${POLL_LEFT_FN}() { __x_monitor_left=$(( ${POLL_DEADLINE_VAR} - $(date +%s) )); ` +
        `[ "$__x_monitor_left" -lt 1 ] && __x_monitor_left=1; printf %s "$__x_monitor_left"; }`,
      );
    }
    calls.forEach((call, index) => {
      if (options.live) {
        parts.push(...Borg.live_call(index, call, limits[index] ?? null, filters[index] ?? null));
        return;
      }
      parts.push(`${call} >"${base}/${index}.out" 2>"${base}/${index}.err"; ${POLL_RC_VAR}=$?`);
      for (const stream of ["out", "err"]) {
        const marker = frame_line(index, stream, `$${POLL_RC_VAR}`);
        // The closing newline is what keeps output with no trailing one from running into the next marker.
        parts.push(`printf '%s\\n' "${marker}"`);
        const limit = stream === "out" ? limits[index] : undefined;
        const keep = stream === "out" ? filters[index] : undefined;
        const reader = keep ? `${keep} "${base}/${index}.${stream}"` : `cat "${base}/${index}.${stream}"`;
        parts.push(limit ? `${reader} | head -n ${Math.trunc(limit)}` : reader);
        parts.push("printf '\\n'");
      }
    });
    return parts.join("; ");
  }

  // One call of a live sequence: its stdout printed as it comes, then its stderr under a frame carrying its exit code.
  static live_call(index: number, call: string, limit: number | null, keep: string | null): string[] {
    const base = `$${POLL_BASE_DIR_VAR}`;
    let reader = keep ? ` | ${keep}` : "";
    // awk keeps reading past the limit, so the call never dies of a closed pipe.
    reader += limit ? ` | awk 'NR <= ${Math.trunc(limit)}'` : "";
    return [
      `printf '%s\\n' "${frame_line(index, "out", "-")}"`,
      `{ ${call} 2>"${base}/${index}.err"; echo $? >"${base}/${index}.rc"; }${reader}`,
      `${POLL_RC_VAR}=$(cat "${base}/${index}.rc")`,
      "printf '\\n'",
      `printf '%s\\n' "${frame_line(index, "err", `$${POLL_RC_VAR}`)}"`,
      `cat "${base}/${index}.err"`,
      "printf '\\n'",
    ];
  }

  // Never add --bypass-lock to a read: borg rewrites the index on open, and unlocked mid-compaction that corrupts it.
  list_command(): string {
    return this.build([this.borg_bin, "list", "--last", String(this.list_archives), "--json", "--lock-wait", String(this.lock_wait), this.repo ?? ""],
      { persistent_cache: this.cache_dir_configured, bounded: true, wrapped: false });
  }

  info_command(): string {
    return this.build([this.borg_bin, "info", "--json", "--last", String(this.list_archives), "--lock-wait", String(this.lock_wait), this.repo ?? ""],
      { persistent_cache: this.cache_dir_configured, bounded: true, wrapped: false });
  }

  backup_command(archive_name: string | null = null, dry_run = false): string {
    const name = archive_name || this.default_archive_name();
    const args = [this.borg_bin, "create", "--log-json", "--progress", "--compression", this.compression];
    args.push(dry_run ? "--dry-run" : "--stats");
    if (this.one_file_system) args.push("--one-file-system");
    args.push(...this.exclude_args());
    args.push("--lock-wait", String(this.backup_lock_wait));
    args.push(`${this.repo}::${name}`);
    args.push(...this.source_paths);
    return this.build(args, { persistent_cache: true });
  }

  // The exclusion options a backup applies, which a purge also uses to rewrite existing archives to match.
  private exclude_args(): string[] {
    const args: string[] = [];
    if (this.exclude_caches) args.push("--exclude-caches");
    for (const marker of this.exclude_if_present) args.push("--exclude-if-present", marker);
    for (const pattern of this.exclude) args.push("--exclude", pattern);
    if (this.exclude_from) args.push("--exclude-from", this.exclude_from);
    return args;
  }

  // The prefix and the X-Monitor host's local time, matching the names borgmatic and Vorta give their archives.
  default_archive_name(): string {
    return `${this.archive_prefix}-${local_stamp(new Date())}`;
  }

  // ── Collection ───────────────────────────────────────────────────────────

  // While a backup runs, the cycle polls the detached job with one plain command instead of listing the repo.
  override commands(): Command[] {
    const job = this.running_job();
    // parse() must read the results the way they were requested, even if a job starts or ends mid-cycle.
    this.polling_job = job;
    if (job !== null) return [command(poll_command(job.workdir!, job.pid!, job.output_seq))];
    if (!this.repo) return [];
    const plan = this.poll_plan();
    this.poll_calls = plan.map(([name]) => name);
    return [command(this.sequence_command(plan.map(([, call]) => call)))];
  }

  private running_job(): JobDict | null {
    const job = this.jobs ? this.jobs.running() : null;
    if (job && job.pid && job.workdir) return job;
    return null;
  }

  override parse(results: CmdResult[]): CollectResult {
    const job = this.polling_job;
    this.polling_job = null;
    if (job !== null) return this.parse_job_poll(job, results[0]);

    if (!this.repo) return CollectResult.failed("No 'repo' configured for borg monitor");

    // One command carried the whole poll, so unpack its transcript before reading the calls back.
    const names = this.poll_calls.length > 0 ? this.poll_calls : this.collect_stats ? ["list", "info"] : ["list"];
    const split = split_poll(results[0], names.length);
    const by_name = new Map(names.map((name, index) => [name, split[index]]));
    const list_result = by_name.get("list")!;
    const { stdout, stderr, exit_code } = list_result;
    const logs: LogEntry[] = [[`Running: ${redact(this.list_command())}`, "INFO"]];

    if (exit_code !== 0) {
      const detail = (stderr || stdout).trim();
      logs.push([`borg list failed (exit ${exit_code}): ${detail}`, "ERROR"]);
      const hint = failure_hint(detail);
      if (hint) logs.push([hint, "ERROR"]);
      return new CollectResult({ logs, status: list_unavailable(exit_code, detail) ? "unavailable" : "failed" });
    }

    const view = RepoView.from_stdout(stdout);
    if (!view.valid) {
      logs.push(["Could not parse borg output — no archive timestamps found", "ERROR"]);
      const snippet = (stdout || stderr || "").trim().slice(0, 500);
      if (snippet) logs.push([`Raw output was: ${snippet}`, "ERROR"]);
      return new CollectResult({ logs, status: "unavailable" });
    }

    logs.push(...this.repo_detail_logs(view));
    const metrics: Record<string, number> = { archive_count: view.raw_count, last_backup_epoch: view.newest_epoch };
    const metadata: Record<string, string> = {};
    if (view.archives.length > 0) {
      metrics.archive_list = view.archives.length;
      metadata.archive_list = json_dumps({ archives: view.archives, repository: view.info });
    }

    if (view.raw_count === 0 || view.newest_epoch === 0) {
      logs.push(["No archives in repository", "WARNING"]);
      return new CollectResult({ metrics, metadata, logs, status: "failed" });
    }

    const age = now_seconds() - view.newest_epoch;
    let status: string;
    if (age > this.max_age) {
      logs.push([`Last archive was ${format_age(age)}, exceeds max_age of ${format_duration(this.max_age)}`, "WARNING"]);
      status = "failed";
    } else {
      logs.push([`Last archive ${format_age(age)}`, "INFO"]);
      status = "online";
    }

    if (this.collect_stats && by_name.has("info")) {
      const [stats_metrics, stats_metadata, stats_logs, merged_archives] = this.parse_repo_stats(by_name.get("info")!, view.archives);
      Object.assign(metrics, stats_metrics);
      Object.assign(metadata, stats_metadata);
      logs.push(...stats_logs);
      if (merged_archives !== null) {
        metrics.archive_list = merged_archives.length;
        metadata.archive_list = json_dumps({ archives: merged_archives, repository: view.info });
      }
    }

    const extra = [this.fold_canary(by_name, metrics, metadata, logs), this.fold_checks(by_name, metrics, metadata, logs)];
    if (extra.includes("failed")) status = "failed";
    return new CollectResult({ metrics, metadata, logs, status });
  }

  // ── Restore canary ───────────────────────────────────────────────────────

  // The newest archive the last poll saw, which the canary is restored from.
  private canary_archive(): string | null {
    if (!this.canary_path || !this.data) return null;
    const [archives] = this.cached_archives();
    return archives.length > 0 ? (archives[0].name ?? null) : null;
  }

  private canary_due(): boolean {
    const checked = this.data ? this.data.latest_metric("canary_checked_epoch") : null;
    return checked === null || Date.now() / 1000 - checked.value >= this.canary_interval;
  }

  // Extracts the canary from `archive` to stdout, then reads the live file it should match.
  canary_calls(archive: string): [name: string, command: string][] {
    const canary_path = this.canary_path ?? "";
    const extract = this.build([this.borg_bin, "extract", "--stdout", "--lock-wait", String(this.lock_wait), `${this.repo}::${archive}`, archive_member(canary_path) || canary_path],
      { persistent_cache: this.cache_dir_configured, bounded: true, wrapped: false });
    const path = shell_quote(canary_path);
    // A canary is normally world-readable, and sudo rules allowing only borg would refuse `sudo cat`; the braces let the
    // sequence's output redirect cover both reads, not just the fallback.
    const live = this.require_sudo ? `{ cat ${path} 2>/dev/null || sudo -n cat ${path}; }` : `cat ${path}`;
    return [["canary", extract], ["canary_live", live]];
  }

  // Records this poll's restore check if one ran, and returns "failed" while the last verdict stands failed.
  private fold_canary(by_name: Map<string, CmdResult>, metrics: Record<string, number>, metadata: Record<string, string>, logs: LogEntry[]): string | null {
    if (by_name.has("canary")) {
      const [verdict, detail] = canary_verdict(by_name.get("canary")!, by_name.get("canary_live") ?? cmd_result(1, "", CUT_SHORT));
      if (verdict === null) {
        logs.push([`Restore check skipped: ${detail}`, "WARNING"]);
      } else {
        metrics.canary_ok = verdict ? 1.0 : 0.0;
        metrics.canary_checked_epoch = now_seconds();
        metadata.canary_ok = detail;
        logs.push([`Restore check ${verdict ? "passed" : "failed"}: ${detail}`, verdict ? "INFO" : "ERROR"]);
        return verdict ? null : "failed";
      }
    }
    if (!this.canary_path || !this.data) return null;
    const last = this.data.latest_metric("canary_ok");
    return last !== null && last.value < 0.5 ? "failed" : null;
  }

  // ── Check freshness ──────────────────────────────────────────────────────

  stored_checks(): Record<string, CheckState> {
    const metric = this.data ? this.data.latest_metric("check_ok_epoch") : null;
    if (metric === null || !metric.metadata) return {};
    try {
      const data: unknown = JSON.parse(metric.metadata);
      return is_object(data) ? (data as Record<string, CheckState>) : {};
    } catch {
      return {};
    }
  }

  // Folds the check units' journal into the stored record and returns "failed" when any check is failed or stale.
  private fold_checks(by_name: Map<string, CmdResult>, metrics: Record<string, number>, metadata: Record<string, string>, logs: LogEntry[]): string | null {
    if (this.check_units.length === 0 && this.check_kinds.size === 0) return null;
    const states = this.stored_checks();
    if (by_name.has("checks")) {
      const result = by_name.get("checks")!;
      const seen = parse_check_units(result.stdout);
      if (seen.size === 0) {
        logs.push([`Could not read the check units' journal: ${(result.stderr || "no output").trim().slice(0, 200)}`, "WARNING"]);
        if (this.check_kinds.size === 0) return null;
      } else {
        for (const unit of this.check_units) states[unit] = merge_unit(states[unit] ?? {}, observed_unit(seen.get(unit), this.repo ?? ""));
      }
    }
    const [judged, problems] = this.judge_checks(states, metadata, logs);
    Object.assign(metrics, judged);
    return problems.length > 0 ? "failed" : null;
  }

  // Every check this monitor holds to an age, by its stored name: [label, max age, setting it comes from].
  private expected_checks(): Map<string, [label: string, max_age: number, setting: string]> {
    const expected = new Map<string, [string, number, string]>(this.check_units.map((unit) => [unit, [unit, this.check_max_age, "check_max_age"]]));
    for (const [kind, max_age] of this.check_kinds) expected.set(kind, [`${kind} check`, max_age, `check_kinds.${kind}`]);
    return expected;
  }

  // Judges every expected check against its maximum age, storing all the records and logging each problem.
  private judge_checks(states: Record<string, CheckState>, metadata: Record<string, string>, logs: LogEntry[]): [Record<string, number>, string[]] {
    const now = now_seconds();
    const problems: string[] = [];
    const oks: number[] = [];
    for (const [name, [label, max_age, setting]] of this.expected_checks()) {
      const state = states[name] ?? {};
      if (this.check_kinds.has(name) && !state.ok && !state.failed) {
        // A kind X-Monitor has never run gets one max age from when it was first expected, so a new schedule has time to reach it.
        const since = state.since || now;
        states[name] = { ...state, since };
        if (now - since <= max_age) logs.push([`Repository check: ${label} has not run yet`, "INFO"]);
        else problems.push(`${label} has not run within ${setting} of ${format_duration(max_age)}`);
        continue;
      }
      oks.push(state.ok || 0);
      if (state.failed) problems.push(`${label} last run failed: ${state.error || "see its journal"}`);
      else if (!state.ok) problems.push(`${label} has no successful run on record`);
      else if (now - state.ok > max_age) problems.push(`${label} last succeeded ${format_age(now - state.ok)}, exceeds ${setting} of ${format_duration(max_age)}`);
    }
    metadata.check_ok_epoch = json_dumps(states);
    for (const problem of problems) logs.push([`Repository check: ${problem}`, "ERROR"]);
    if (oks.length > 0 && problems.length === 0) logs.push([`Repository checks passed, oldest ${format_age(now - Math.min(...oks))}`, "INFO"]);
    const metrics = { check_ok_epoch: oks.length > 0 ? Math.min(...oks) : 0.0, checks_ok: problems.length > 0 ? 0.0 : 1.0 };
    return [metrics, problems];
  }

  private repo_detail_logs(view: RepoView): LogEntry[] {
    const { archives, info } = view;
    const logs: LogEntry[] = [];
    if (Object.keys(info).length > 0) {
      const parts: string[] = [];
      if (info.location) parts.push(`location=${info.location}`);
      if (info.encryption) parts.push(`encryption=${info.encryption}`);
      if (info.last_modified) parts.push(`last_modified=${info.last_modified}`);
      if (parts.length > 0) logs.push(["Repository: " + parts.join(", "), "INFO"]);
    }
    if (archives.length === 0) return logs;
    logs.push([`${archives.length} most recent archive(s):`, "INFO"]);
    for (const archive of archives) {
      const age = archive.epoch ? format_age(now_seconds() - archive.epoch) : "unknown age";
      logs.push([`  ${archive.name} (${age})`, "INFO"]);
    }
    return logs;
  }

  // Reads `borg info` output into metrics, metadata, logs and the archives with their sizes merged in, or null.
  private parse_repo_stats(info_result: CmdResult, archives: ArchiveEntry[]): [Record<string, number>, Record<string, string>, LogEntry[], ArchiveEntry[] | null] {
    const { exit_code, stdout, stderr } = info_result;
    if (exit_code !== 0) return [{}, {}, [[`borg info failed (exit ${exit_code}): ${(stderr || stdout).trim().slice(0, 200)}`, "WARNING"]], null];

    const data = decode_json(stdout);
    const sizes = Borg.parse_archive_sizes(data);
    let merged: ArchiveEntry[] | null = null;
    if (sizes.size > 0 && archives.length > 0) {
      merged = archives.map((archive) => ({ ...archive, ...sizes.get(archive.name) }));
    }

    const stats = Borg.parse_stats(data);
    if (Object.keys(stats).length === 0) return [{}, {}, [["Could not parse borg info output", "WARNING"]], merged];

    const metrics: Record<string, number> = { ...stats };
    const logs: LogEntry[] = [];
    const original = stats.original_size ?? 0;
    const deduplicated = stats.deduplicated_size ?? 0;
    if (original && deduplicated) {
      const ratio = original / deduplicated;
      metrics.dedup_ratio = ratio;
      logs.push([`Repo size: ${format_size(deduplicated)} on disk for ${format_size(original)} of data (${ratio.toFixed(1)}x reduction)`, "INFO"]);
    }
    return [metrics, {}, logs, merged];
  }

  private static parse_stats(data: Record<string, unknown>): Record<string, number> {
    const cache = data.cache;
    const stats = is_object(cache) ? cache.stats : null;
    if (!is_object(stats)) return {};
    const out: Record<string, number> = {};
    for (const [source, destination] of [["total_size", "original_size"], ["total_csize", "compressed_size"], ["unique_csize", "deduplicated_size"], ["total_chunks", "total_chunks"], ["total_unique_chunks", "unique_chunks"]]) {
      const value = stats[source];
      if (typeof value === "number") out[destination] = value;
    }
    return out;
  }

  private static parse_archive_sizes(data: Record<string, unknown>): Map<string, Partial<ArchiveEntry>> {
    const out = new Map<string, Partial<ArchiveEntry>>();
    for (const archive of (Array.isArray(data.archives) ? data.archives : []) as unknown[]) {
      if (!is_object(archive)) continue;
      const name = archive.name;
      const stats = archive.stats;
      if (!name || !is_object(stats)) continue;
      const entry: Record<string, number> = {};
      for (const [source, destination] of [["original_size", "original"], ["compressed_size", "compressed"], ["deduplicated_size", "deduplicated"], ["nfiles", "nfiles"]]) {
        const value = stats[source];
        if (typeof value === "number") entry[destination] = value;
      }
      if (Object.keys(entry).length > 0) out.set(String(name), entry);
    }
    return out;
  }

  // The archives the last poll listed, newest first, and the repository's details.
  cached_archives(): [ArchiveEntry[], RepositoryInfo] {
    const metric = this.data.latest_metric("archive_list");
    if (metric === null || !metric.metadata) return [[], {}];
    let data: unknown;
    try {
      data = JSON.parse(metric.metadata);
    } catch {
      return [[], {}];
    }
    if (!is_object(data)) return [[], {}];
    return [(data.archives as ArchiveEntry[]) || [], (data.repository as RepositoryInfo) || {}];
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  override get_actions(): ActionButtonSpec[] {
    const actions: ActionButtonSpec[] = [];
    if (this.source_paths.length > 0) {
      actions.push(
        { name: "Run Backup", action_id: "run_backup", job: "backup", variant: "primary", icon: "backup" },
        { name: "Dry Run", action_id: "dry_run_backup", job: "dry-run", variant: "secondary", icon: "fact_check" },
      );
    }
    if (this.canary_path) actions.push({ name: "Verify Restore", action_id: "verify_restore", more: true, variant: "secondary", icon: "verified", detached: true });
    if (this.repo) {
      actions.push(
        { name: "Check", action_id: "check_repo", job: Object.keys(CHECK_KINDS).map(check_job_kind), variant: "secondary", icon: "health_and_safety" },
        { name: "Compact", action_id: "compact_repo", job: "compact", variant: "secondary", icon: "compress" },
      );
    }
    if (this.retention.length > 0) {
      actions.push({ name: "Prune Preview", action_id: "prune_preview", kind: "dialog", more: true, dialog: "prune_preview", variant: "secondary", icon: "content_cut" });
    }
    if (this.allow_delete && this.retention.length > 0) {
      actions.push({
        name: "Prune", action_id: "prune_repo", job: "prune", more: true, variant: "danger", icon: "delete_sweep",
        confirm: `Prune ${this.repo} by its retention policy? Archives it drops are gone for good — run Prune Preview first to see which. Space is freed by a Compact afterwards.`,
      });
    }
    if (this.allow_purge) {
      actions.push(
        { name: "Purge Preview", action_id: "purge_preview", job: "purge-preview", more: true, variant: "secondary", icon: "filter_alt" },
        {
          name: "Purge Excluded", action_id: "purge_excluded", job: "purge", more: true, variant: "danger", icon: "cleaning_services",
          confirm: `Rewrite every archive in ${this.repo} without the files its exclude patterns now drop, then compact? Those files are gone from every archive for good — run Purge Preview first to see which. It holds the repository lock for the whole run, so backups wait until it ends.`,
        },
      );
    }
    if (this.allow_delete) {
      actions.push({
        name: "Break Lock", action_id: "break_lock", more: true, variant: "danger", icon: "lock_open",
        confirm: `Break the locks on ${this.repo}? Only do this when no borg process is using it; breaking a live lock can corrupt the repository.`,
      });
    }
    return actions;
  }

  // Break Lock greys out while a job runs, since that job holds the lock it would break.
  override action_state(action: ActionButtonSpec): ActionState {
    if (action.action_id === "break_lock" && this.running_job() !== null) return "disabled";
    return super.action_state(action);
  }

  override plan_action(action_id: string, args: Record<string, unknown> = {}): ActionPlanResult {
    switch (action_id) {
      case "run_backup":
      case "dry_run_backup":
        return this.plan_backup(action_id);
      case "prune_preview":
        return this.plan_prune_preview();
      case "verify_restore":
        return this.plan_verify_restore();
      case "browse_archive":
        return this.plan_browse(text_of(args.archive), text_of(args.path));
      case "restore_archive":
        return this.plan_restore(text_of(args.archive), text_of(args.path), (args.paths as string[] | null | undefined) ?? null);
      case "check_repo":
        return this.plan_check(text_of(args.kind));
      case "compact_repo":
        return this.plan_compact();
      case "prune_repo":
        return this.plan_prune();
      case "delete_archive":
        return this.plan_delete(text_of(args.archive));
      case "break_lock":
        return this.plan_break_lock();
      case "purge_preview":
      case "purge_excluded":
        return this.plan_purge(action_id);
      case "diff_archive":
        return this.plan_diff(text_of(args.archive));
      default:
        return null;
    }
  }

  override interpret_action(action_id: string, raw_result: unknown, args: Record<string, unknown> = {}): ActionOutcome {
    const result = raw_result as CmdResult;
    switch (action_id) {
      case "prune_preview":
        return this.interpret_prune_preview(result);
      case "verify_restore":
        return this.interpret_verify_restore(result);
      case "browse_archive":
        return this.interpret_browse(result, text_of(args.archive), text_of(args.path));
      case "break_lock":
        return this.interpret_break_lock(result);
      case "diff_archive":
        return this.interpret_diff(result, text_of(args.archive));
    }
    if (!launched.includes(action_id)) return result.exit_code === 0;

    const [kind, redacted, workdir, started] = this.pending_launch ?? ["job", "", "", ""];
    this.pending_launch = null;

    const skipped = result.exit_code === 0 ? skip_reason(result.stdout) : null;
    if (skipped !== null) {
      const message = `${capitalize(kind)} skipped: ${skipped}`;
      return new CollectResult({ logs: [[message, "WARNING"]], metadata: { content: message }, success: true });
    }

    const pid = result.exit_code === 0 ? parse_launch(result.stdout) : null;
    if (pid === null) return CollectResult.failed(`Failed to launch ${kind}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);

    const job_id = this.jobs!.create(kind, redacted, workdir);
    this.jobs!.set_pid(job_id, pid);
    const message = `${capitalize(kind)} started (pid ${pid})${started}`;
    return new CollectResult({ logs: [[message, "INFO"]], metadata: { content: message }, success: true });
  }

  // An action outcome that reports a problem without touching the monitor's status.
  private static refused(message: string): CollectResult {
    return new CollectResult({ logs: [[message, "WARNING"]], metadata: { content: message }, success: false });
  }

  // A single framed borg call as an action, bounded like a poll.
  private run_one(call: string, limit: number | null = null, keep: string | null = null): ActionPlan {
    return action_plan(this.sequence_command([call], { limits: limit ? { 0: limit } : null, filters: keep ? { 0: keep } : null }), { timeout: this.timeout || null });
  }

  // Framed borg calls as a detached action whose output reaches its log as it is written; the sequence's own deadline
  // bounds it by `timeout`.
  private run_detached(calls: string[], limit: number | null = null): ActionPlan {
    return action_plan(this.sequence_command(calls, { limits: limit ? { 0: limit } : null, live: true }), { detached: true });
  }

  // Launches `command` as a detached job; interpret_action records the pid it prints and creates the job row.
  private launch(kind: string, command_text: string, started = ""): ActionPlan {
    const token = `${this.id}-${now_seconds()}`;
    const workdir = workdir_for(token);
    const wrapped = wrap_job(command_text, this.job_wrappers(kind), this.job_lock);
    this.pending_launch = [kind, redact(wrapped), workdir, started];
    return action_plan(with_preflight(this.preflight(), launch_command(wrapped, workdir)));
  }

  // The argv every job runs under: the shared job lock, the sleep inhibitor, then the lowered priority.
  private job_wrappers(kind: string): string[] {
    const argv: string[] = [];
    if (this.job_lock) argv.push("flock", this.job_lock);
    if (this.inhibit_sleep) argv.push("systemd-inhibit", "--who=X-Monitor", "--what=sleep:shutdown", `--why=X-Monitor borg ${kind} for ${this.name}`);
    if (this.job_nice !== null) argv.push("nice", "-n", String(this.job_nice));
    if (this.job_io_idle) argv.push("ionice", "-c", "3");
    return argv;
  }

  // Shell that finds a reason to skip a job before it starts, such as a repository server that is not answering.
  private preflight(): string | null {
    const endpoint = this.skip_when_unreachable ? ssh_endpoint(this.repo) : null;
    return preflight_script(endpoint, this.skip_while_active);
  }

  // The refusal for starting a job without a repo or while another one runs, else null.
  private job_refusal(what: string): CollectResult | null {
    if (!this.repo) return Borg.refused(`Cannot ${what}: no 'repo' configured`);
    if (this.running_job() !== null) return Borg.refused("A job is already running for this monitor");
    return null;
  }

  private plan_backup(action_id: string): ActionPlanResult {
    if (!this.repo) return CollectResult.failed("Cannot back up: no 'repo' configured");
    if (this.source_paths.length === 0) return CollectResult.failed("Cannot back up: no 'source_paths' configured");
    if (this.running_job() !== null) {
      const refused = CollectResult.failed("A backup is already running for this monitor", "WARNING");
      refused.status = null;
      return refused;
    }
    if (action_id === "dry_run_backup") return this.launch("dry-run", this.backup_command(null, true));
    const steps: [string, string][] = [];
    if (this.prune_after_backup) steps.push(["Pruning", this.maintenance_command([...this.prune_args(), this.repo])]);
    if (this.compact_after_backup) steps.push(["Compacting", this.maintenance_command(["compact", "--progress", this.repo])]);
    return this.launch("backup", then_steps(this.backup_command(), steps));
  }

  // ── Prune preview ────────────────────────────────────────────────────────

  private retention_args(): string[] {
    return this.retention.flatMap(([key, value]) => ["--" + key.replaceAll("_", "-"), String(value)]);
  }

  private prune_command(): string {
    const args = [this.borg_bin, "prune", "--dry-run", "--list", "--lock-wait", String(this.lock_wait), "--glob-archives", this.prune_match, ...this.retention_args(), this.repo ?? ""];
    return this.build(args, { persistent_cache: this.cache_dir_configured, bounded: true, wrapped: false });
  }

  private plan_prune_preview(): ActionPlanResult {
    if (!this.repo) return Borg.refused("Cannot preview a prune: no 'repo' configured");
    if (this.retention.length === 0) return Borg.refused("Cannot preview a prune: no keep_* retention configured");
    return this.run_one(this.prune_command());
  }

  private interpret_prune_preview(result: CmdResult): CollectResult {
    const call = split_poll(result, 1)[0];
    const text = [call.stdout, call.stderr].filter((part) => part).join("\n");
    if (call.exit_code !== 0) {
      const hint = failure_hint(text);
      return Borg.refused(`borg prune --dry-run failed (exit ${call.exit_code}): ${text.trim().slice(0, 300)}` + (hint ? `\n${hint}` : ""));
    }
    const keep: string[] = [];
    const prune: string[] = [];
    for (const line of splitlines(text)) {
      const match = PRUNE_LINE.exec(line.trim());
      if (!match?.groups) continue;
      const { rule, name, date } = match.groups;
      if (match.groups.prune) prune.push(`  ${name}  ${date}`);
      else keep.push(`  ${name}  ${date}  (${rule})`);
    }
    const policy = this.retention.map(([key, value]) => `--${key.replaceAll("_", "-")} ${String(value)}`).join(" ");
    const lines = [`Policy: ${policy}`, `Archives matching: ${this.prune_match}`, ""];
    lines.push(`Would prune ${prune.length} of ${prune.length + keep.length} archive(s):`);
    lines.push(...(prune.length > 0 ? prune : ["  (none)"]));
    lines.push("", `Keeping ${keep.length}:`, ...(keep.length > 0 ? keep : ["  (none)"]));
    return new CollectResult({ logs: [[`Prune preview: would prune ${prune.length}, keep ${keep.length}`, "INFO"]], metadata: { content: lines.join("\n") }, success: true });
  }

  // ── Verify restore ───────────────────────────────────────────────────────

  private plan_verify_restore(): ActionPlanResult {
    if (!this.canary_path) return Borg.refused("Cannot verify a restore: no 'canary_path' configured");
    const archive = this.canary_archive();
    if (!archive) return Borg.refused("Cannot verify a restore: no archive has been listed yet");
    return this.run_detached(this.canary_calls(archive).map(([, call]) => call));
  }

  private interpret_verify_restore(result: CmdResult): CollectResult {
    const split = split_poll(result, 2);
    const by_name = new Map([["canary", split[0]], ["canary_live", split[1]]]);
    const metrics: Record<string, number> = {};
    const metadata: Record<string, string> = {};
    const logs: LogEntry[] = [];
    this.fold_canary(by_name, metrics, metadata, logs);
    const message = logs.length > 0 ? logs.at(-1)![0] : "Restore check reached no verdict";
    return new CollectResult({ metrics, metadata: { ...metadata, content: message }, logs, success: metrics.canary_ok === 1.0 });
  }

  // ── Browse ───────────────────────────────────────────────────────────────

  // The children of `path` in `archive` as last listed, or null when that folder has not been listed yet.
  listing(archive: string, path: string): ListingEntry[] | null {
    const key = listing_key(archive, archive_member(path) || "");
    const cached = this.listings.get(key);
    if (cached === undefined) return null;
    this.listings.delete(key);
    this.listings.set(key, cached);
    return cached.entries;
  }

  private plan_browse(archive: string | null, path: string | null): ActionPlanResult {
    const member = archive_member(path || "");
    if (!this.repo || !archive) return Borg.refused("Cannot browse: no archive given");
    if (member === null) return Borg.refused("A path may not contain '.' or '..' components");
    const cached = this.listing(archive, member);
    if (cached !== null) return this.listing_result(archive, member, cached);
    const args = [this.borg_bin, "list", "--format", LIST_FORMAT, "--lock-wait", String(this.lock_wait), `${this.repo}::${archive}`];
    if (member) args.push(member);
    const call = this.build(args, { persistent_cache: this.cache_dir_configured, bounded: true, wrapped: false });
    return this.run_one(call, this.browse_limit + 1, children_filter(member));
  }

  private interpret_browse(result: CmdResult, archive: string | null, path: string | null): CollectResult {
    const call = split_poll(result, 1)[0];
    if (call.exit_code !== 0) {
      const detail = (call.stderr || call.stdout).trim();
      const hint = failure_hint(detail);
      return Borg.refused(`borg list failed (exit ${call.exit_code}): ${detail.slice(0, 300)}` + (hint ? `\n${hint}` : ""));
    }
    const member = archive_member(path || "") || "";
    const entries = parse_listing(call.stdout);
    this.remember_listing(archive ?? "None", member, entries);
    return this.listing_result(archive ?? "None", member, entries);
  }

  // A listing longer than browse_limit is kept one entry over it, which is how the browser knows it was cut short.
  private remember_listing(archive: string, member: string, entries: ListingEntry[]): void {
    this.listings.set(listing_key(archive, member), { archive, entries });
    while (this.listings.size > listing_cache) this.listings.delete(this.listings.keys().next().value!);
  }

  // A folder's listing as the dialog's text, and as data the server's copy of this monitor caches when its agent listed it.
  private listing_result(archive: string, member: string, entries: ListingEntry[]): CollectResult {
    const listing = json_dumps({ archive, member, entries });
    return new CollectResult({ metadata: { content: this.listing_text(archive, member, entries), listing }, success: true });
  }

  // Caches a folder listing the monitor's agent made, so the archive browser on the server can show it.
  override absorb_remote_action(action_id: string, metadata: Record<string, string>): void {
    if (action_id !== "browse_archive" || !metadata.listing) return;
    const listing = JSON.parse(metadata.listing) as { archive: unknown; member: unknown; entries: ListingEntry[] };
    this.remember_listing(String(listing.archive), String(listing.member), [...listing.entries]);
  }

  private listing_text(archive: string, member: string, entries: ListingEntry[]): string {
    const where = `${archive}:/${member}`;
    if (entries.length === 0) return `${where} — nothing at that path`;
    let header = `${where} — ${entries.length} entries`;
    let shown = entries;
    if (entries.length > this.browse_limit) {
      shown = entries.slice(0, this.browse_limit);
      header = `${where} — first ${this.browse_limit} entries (raise browse_limit for more)`;
    }
    const lines = shown.map((entry) => (entry.dir ? `${entry.name}/` : `${entry.name}  ${format_size(entry.size || 0)}  ${entry.mtime}`));
    return [header, "", ...lines].join("\n");
  }

  // ── Restore ──────────────────────────────────────────────────────────────

  // Creates a fresh directory under restore_dir and extracts the paths into it, never over live files.
  private restore_command(archive: string, members: string[], destination: string): string {
    const extract = this.build([this.borg_bin, "extract", "--log-json", "--progress", "--lock-wait", String(this.backup_lock_wait), `${this.repo}::${archive}`, ...members], { persistent_cache: true });
    const mkdir = (this.require_sudo ? "sudo -n " : "") + "mkdir -p " + shell_quote(destination);
    return `${mkdir} && cd ${shell_quote(destination)} && ${extract}`;
  }

  private plan_restore(archive: string | null, path: string | null, paths: string[] | null): ActionPlanResult {
    const members = [...(path ? [path] : []), ...(paths ?? [])].map((each) => archive_member(each));
    if (!this.repo || !archive) return Borg.refused("Cannot restore: no archive given");
    if (members.some((member) => member === null)) return Borg.refused("A path may not contain '.' or '..' components");
    if (members.length === 0 || !members.every((member) => member)) return Borg.refused("Give the path to restore — a whole archive is not restored from here");
    const refusal = this.job_refusal("restore");
    if (refusal) return refusal;
    const destination = `${this.restore_dir.replace(/\/+$/, "")}/${archive}-${utc_compact_stamp(new Date())}`;
    return this.launch("restore", this.restore_command(archive, members as string[], destination), ` into ${destination}`);
  }

  // ── Maintenance ──────────────────────────────────────────────────────────

  private maintenance_command(args: string[]): string {
    return this.build([this.borg_bin, ...args, "--log-json", "--lock-wait", String(this.backup_lock_wait)], { persistent_cache: true });
  }

  private plan_check(requested: string | null): ActionPlanResult {
    const kind = requested || (this.check_verify_data ? "data" : "all");
    if (!Object.hasOwn(CHECK_KINDS, kind)) return Borg.refused(`Unknown check kind ${py_repr(kind)}: use ${Object.keys(CHECK_KINDS).join(", ")}`);
    const refusal = this.job_refusal("check the repository");
    if (refusal) return refusal;
    if (kind === "extract") {
      const [archives] = this.cached_archives();
      const newest = archives.length > 0 ? archives[0].name : null;
      if (!newest) return Borg.refused("Cannot run an extract check: no archive listed yet");
      const command_text = this.maintenance_command(["extract", "--dry-run", "--progress", `${this.repo}::${newest}`]);
      return this.launch(check_job_kind(kind), command_text, ` on ${newest}`);
    }
    const args = ["check", "--progress", ...CHECK_KINDS[kind][0]];
    return this.launch(check_job_kind(kind), this.maintenance_command([...args, this.repo!]));
  }

  private plan_compact(): ActionPlanResult {
    const refusal = this.job_refusal("compact the repository");
    if (refusal) return refusal;
    return this.launch("compact", this.maintenance_command(["compact", "--progress", this.repo!]));
  }

  private plan_prune(): ActionPlanResult {
    if (!this.allow_delete) return Borg.refused("Pruning is off for this monitor — set allow_delete: true to enable it");
    if (this.retention.length === 0) return Borg.refused("Cannot prune: no keep_* retention configured");
    const refusal = this.job_refusal("prune");
    if (refusal) return refusal;
    return this.launch("prune", this.maintenance_command([...this.prune_args(), this.repo!]));
  }

  // The prune that applies the retention policy for real, shared by the Prune action and the one that follows a backup.
  private prune_args(): string[] {
    return ["prune", "--list", "--stats", "--glob-archives", this.prune_match, ...this.retention_args()];
  }

  private plan_delete(archive: string | null): ActionPlanResult {
    if (!this.allow_delete) return Borg.refused("Deleting archives is off for this monitor — set allow_delete: true to enable it");
    const [archives] = this.cached_archives();
    // Only an archive the monitor has listed may be deleted, so a stale or hand-typed name cannot reach borg.
    if (!archive || !archives.some((each) => each.name === archive)) return Borg.refused(`Cannot delete ${archive || "an unnamed archive"}: it is not in the archive list`);
    const refusal = this.job_refusal("delete an archive");
    if (refusal) return refusal;
    for (const [key, value] of this.listings) if (value.archive === archive) this.listings.delete(key);
    return this.launch("delete", this.maintenance_command(["delete", "--stats", `${this.repo}::${archive}`]), ` for ${archive}`);
  }

  // The refusal for a purge this monitor is not set up for, else null.
  private purge_refusal(): CollectResult | null {
    if (!this.allow_purge) return Borg.refused("Purging is off for this monitor — set allow_purge: true to enable it");
    if (!(this.exclude.length > 0 || this.exclude_from || this.exclude_if_present.length > 0 || this.exclude_caches)) return Borg.refused("Cannot purge: no exclude patterns configured");
    return this.job_refusal("purge excluded files");
  }

  private plan_purge(action_id: string): ActionPlanResult {
    const refusal = this.purge_refusal();
    if (refusal) return refusal;
    const scope = this.purge_match ? ["--glob-archives", this.purge_match] : [];
    if (action_id === "purge_preview") {
      const recreate = this.build([this.borg_bin, "recreate", "--dry-run", "--list", "--filter=x", ...scope, ...this.exclude_args(), "--lock-wait", String(this.backup_lock_wait), this.repo!], { persistent_cache: true });
      return this.launch("purge-preview", `{ ${recreate} 2>&1; echo "__x_monitor_rc=$?"; } | ${topmost_excluded}`);
    }
    // An interrupted recreate leaves a <name>.recreate archive behind that makes the next attempt fail at once.
    const leftovers = this.maintenance_command(["delete", "--glob-archives", "*.recreate", this.repo!]);
    const recreate = this.maintenance_command(["recreate", "--info", "--stats", "--progress", ...scope, ...this.exclude_args(), this.repo!]);
    const compact = this.maintenance_command(["compact", "--progress", this.repo!]);
    // A plain `exit` would leave the job's shell before it records the status, so a subshell carries the failure instead.
    return this.launch("purge", `${leftovers}; ${recreate}; rc=$?; if [ "$rc" -le 1 ]; then ${compact}; else (exit "$rc"); fi`);
  }

  private plan_break_lock(): ActionPlanResult {
    if (!this.allow_delete) return Borg.refused("Breaking locks is off for this monitor — set allow_delete: true to enable it");
    const refusal = this.job_refusal("break the lock");
    if (refusal) return refusal;
    return this.run_one(this.build([this.borg_bin, "break-lock", this.repo!], { persistent_cache: true, bounded: true, wrapped: false }));
  }

  private interpret_break_lock(result: CmdResult): CollectResult {
    const call = split_poll(result, 1)[0];
    if (call.exit_code !== 0) return Borg.refused(`borg break-lock failed (exit ${call.exit_code}): ${(call.stderr || call.stdout).trim().slice(0, 300)}`);
    const message = "Broke the repository and cache locks";
    return new CollectResult({ logs: [[message, "WARNING"]], metadata: { content: message }, success: true });
  }

  // ── Diff ─────────────────────────────────────────────────────────────────

  // The listed archive just older than `archive`, which a diff compares it against.
  private previous_archive(archive: string | null): string | null {
    const names = this.cached_archives()[0].map((each) => each.name);
    const index = archive === null ? -1 : names.indexOf(archive);
    if (index === -1) return null;
    return index + 1 < names.length ? names[index + 1] : null;
  }

  private plan_diff(archive: string | null): ActionPlanResult {
    if (!this.repo || !archive) return Borg.refused("Cannot diff: no archive given");
    const older = this.previous_archive(archive);
    if (older === null) return Borg.refused(`${archive} is the oldest listed archive — there is nothing before it to compare`);
    const call = this.build([this.borg_bin, "diff", "--lock-wait", String(this.lock_wait), `${this.repo}::${older}`, archive], { persistent_cache: this.cache_dir_configured, bounded: true, wrapped: false });
    return this.run_detached([call], this.browse_limit + 1);
  }

  private interpret_diff(result: CmdResult, archive: string | null): CollectResult {
    const call = split_poll(result, 1)[0];
    if (call.exit_code !== 0) {
      const detail = (call.stderr || call.stdout).trim();
      const hint = failure_hint(detail);
      return Borg.refused(`borg diff failed (exit ${call.exit_code}): ${detail.slice(0, 300)}` + (hint ? `\n${hint}` : ""));
    }
    let lines = splitlines(call.stdout).filter((line) => line.trim());
    // A run a restart adopted has lost its archive argument, so it names no archives.
    const span = archive ? `from ${this.previous_archive(archive) ?? "None"} to ${archive}` : "in the archive";
    let header = `Changes ${span}: ${lines.length}`;
    if (lines.length > this.browse_limit) {
      lines = lines.slice(0, this.browse_limit);
      header = `${header.slice(0, header.lastIndexOf(":"))}: first ${this.browse_limit} (raise browse_limit for more)`;
    }
    return new CollectResult({ logs: [[header, "INFO"]], metadata: { content: [header, "", ...(lines.length > 0 ? lines : ["(no changes)"])].join("\n") }, success: true });
  }

  // ── Job polling ──────────────────────────────────────────────────────────

  // Advances a running detached job from one poll's output: appends new output lines, updates the progress summary, and
  // on completion finishes the job row and returns the outcome.
  private parse_job_poll(job: JobDict, result: CmdResult): CollectResult {
    const job_id = job.id;
    // A poll that never reached the target says nothing about the job; only a real answer may finish it.
    if (result.exit_code !== 0 && !result.stdout.trim()) {
      return new CollectResult({ logs: [[`Could not poll the running ${job.kind}: ${(result.stderr || "").trim().slice(0, 200) || `exit ${result.exit_code}`}`, "WARNING"]] });
    }
    const poll = parse_poll(result.stdout);

    const [lines, consumed] = split_lines(poll.new_output);
    if (lines.length > 0) {
      this.jobs!.append_output(job_id, lines);
      this.jobs!.bump_output_seq(job_id, job.output_seq + consumed);
      const summary = Borg.progress_from_lines(lines);
      if (summary) this.jobs!.set_progress(job_id, summary);
    }

    if (poll.exit_code === null && poll.alive) return new CollectResult();

    // Completed, or the process vanished with no exit file, as when the target rebooted mid-job, which counts as failed.
    const kind = job.kind;
    if (poll.exit_code === null) {
      this.jobs!.finish(job_id, "failed", -1, "Process ended without writing an exit code");
      return CollectResult.failed(`${capitalize(kind)} ended unexpectedly`);
    }

    const exit_code = poll.exit_code;
    const state = exit_code === 0 || exit_code === 1 ? "succeeded" : "failed";
    this.jobs!.finish(job_id, state, exit_code, state === "succeeded" ? null : `Exited with status ${exit_code}`);

    let outcome: CollectResult;
    if (exit_code === 0) outcome = new CollectResult({ logs: [[`${capitalize(kind)} completed successfully`, "INFO"]], success: true });
    else if (exit_code === 1) outcome = new CollectResult({ logs: [[`${capitalize(kind)} completed with warnings (exit 1)`, "WARNING"]], success: true });
    else outcome = CollectResult.failed(`${capitalize(kind)} failed (exit ${exit_code})`);
    this.record_check_job(kind, state === "succeeded", exit_code, outcome);
    return outcome;
  }

  // Stores a finished Check's outcome against every tracked check it covers, so check_kinds can judge their age.
  private record_check_job(kind: string, succeeded: boolean, exit_code: number, outcome: CollectResult): void {
    const covered = covered_by_check_job(kind);
    if (covered.length === 0) return;
    const now = now_seconds();
    const states = this.stored_checks();
    for (const name of covered) {
      const state: CheckState = { ...states[name] };
      Object.assign(state, { end: now, failed: !succeeded, error: succeeded ? null : `${kind} exited with status ${exit_code}` });
      if (succeeded) state.ok = now;
      states[name] = state;
    }
    Object.assign(outcome.metrics, this.judge_checks(states, outcome.metadata, outcome.logs)[0]);
  }

  // The latest human progress summary from borg --log-json progress records in a batch of newly read output lines.
  static progress_from_lines(lines: string[]): string | null {
    let summary: string | null = null;
    for (const text of lines) {
      // A chained job names each step it starts, and recreate prints which archive it is on as plain text, even under --log-json.
      if (text.startsWith(STEP_MARK)) {
        summary = text.slice(STEP_MARK.length).trim();
        continue;
      }
      if (text.startsWith("Processing ")) {
        summary = text.trim();
        continue;
      }
      if (!text.startsWith("{")) continue;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        continue;
      }
      if (!is_object(record)) continue;
      if (record.type === "progress_message" || record.type === "progress_percent") {
        if (record.message && !record.finished) summary = String(record.message).trim();
        continue;
      }
      if (record.type !== "archive_progress" || record.finished) continue;
      const original = Number(record.original_size || 0);
      const deduplicated = Number(record.deduplicated_size || 0);
      const nfiles = record.nfiles || 0;
      if (!(original || deduplicated || nfiles)) continue;
      const path = record.path || "";
      summary = `${String(nfiles)} files, ${format_size(original)} read, ${format_size(deduplicated)} new`;
      if (path) summary += ` — ${String(path)}`;
    }
    return summary;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private epoch(): number | null {
    const metric = this.data.latest_metric("last_backup_epoch");
    return metric !== null ? metric.value : null;
  }

  // The text and color of the current-state card.
  state_pair(): ValueColor {
    const epoch = this.epoch();
    if (epoch === null) return ["UNKNOWN", "unavailable"];
    if (Math.trunc(epoch) === 0) return ["NO ARCHIVES", "failed"];
    const age = now_seconds() - Math.trunc(epoch);
    return age <= this.max_age ? ["OK", "online"] : ["STALE", "failed"];
  }

  // The text and color of the last-archive card.
  age_pair(): ValueColor {
    const epoch = this.epoch();
    if (epoch === null) return ["--", "failed"];
    if (Math.trunc(epoch) === 0) return ["Never", "failed"];
    const age = now_seconds() - Math.trunc(epoch);
    return [format_age(age), age <= this.max_age ? "online" : "failed"];
  }

  get state_text(): string {
    return this.state_pair()[0];
  }

  get state_color(): string | null {
    return this.state_pair()[1];
  }

  get last_archive_age_text(): string {
    return this.age_pair()[0];
  }

  get last_archive_age_color(): string | null {
    return this.age_pair()[1];
  }

  // The text and color of the restore-check card.
  canary_pair(): ValueColor {
    if (!this.canary_path) return ["Not configured", null];
    const ok = this.data.latest_metric("canary_ok");
    const checked = this.data.latest_metric("canary_checked_epoch");
    if (ok === null || checked === null) return ["Pending", "unavailable"];
    const when = format_age(now_seconds() - Math.trunc(checked.value));
    return ok.value >= 0.5 ? [`Passed ${when}`, "online"] : [`Failed ${when}`, "failed"];
  }

  // The text and color of the repository-checks card.
  checks_pair(): ValueColor {
    if (this.expected_checks().size === 0) return ["Not configured", null];
    const ok = this.data.latest_metric("checks_ok");
    const oldest = this.data.latest_metric("check_ok_epoch");
    if (ok === null || oldest === null) return ["Pending", "unavailable"];
    if (ok.value < 0.5) return [Object.values(this.stored_checks()).some((state) => state.failed) ? "Failed" : "Stale", "failed"];
    if (!oldest.value) return ["Pending", "unavailable"];
    return [`Passed ${format_age(now_seconds() - Math.trunc(oldest.value))}`, "online"];
  }

  get canary_text(): string {
    return this.canary_pair()[0];
  }

  get canary_color(): string | null {
    return this.canary_pair()[1];
  }

  get checks_text(): string {
    return this.checks_pair()[0];
  }

  get checks_color(): string | null {
    return this.checks_pair()[1];
  }

  // This repository's backup health in one flat record, for the /api/backups roll-up.
  backup_summary(): Record<string, unknown> {
    const now = now_seconds();
    const epoch = this.epoch();
    const newest = epoch ? Math.trunc(epoch) : null;
    const canary_ok = this.canary_path ? this.data.latest_metric("canary_ok") : null;
    const canary_at = this.canary_path ? this.data.latest_metric("canary_checked_epoch") : null;
    const tracked = this.expected_checks().size > 0;
    const checks_ok = tracked ? this.data.latest_metric("checks_ok") : null;
    const check_at = tracked ? this.data.latest_metric("check_ok_epoch") : null;
    return {
      repo: this.repo,
      newest_archive_epoch: newest,
      newest_archive_age: newest ? now - newest : null,
      max_age: this.max_age,
      fresh: Boolean(newest) && now - newest! <= this.max_age,
      restore_check: canary_ok === null ? null : canary_ok.value >= 0.5,
      restore_checked_epoch: canary_at ? Math.trunc(canary_at.value) : null,
      repo_checks: checks_ok === null ? null : checks_ok.value >= 0.5,
      repo_checked_epoch: check_at && check_at.value ? Math.trunc(check_at.value) : null,
    };
  }

  // The archive browser drawn into the page's "browser" cell beside the declarative widgets.
  override custom_view(): CustomView {
    return { kind: "borg_browser", data: browser_view_data(this) };
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        repo_card: { title: "REPO", value: this.repo || "--" },
        maxage_card: { title: "MAX AGE", value: format_duration(this.max_age) },
        state_card: { title: "CURRENT STATE", value_attr: "state_text", color_attr: "state_color" },
        size_card: { metric: "deduplicated_size", title: "REPO SIZE", format: "bytes_gb" },
        dedup_card: { metric: "dedup_ratio", title: "DEDUP RATIO", format: "dedup_ratio" },
        count_card: { metric: "archive_count", title: "ARCHIVES", format: "int" },
        age_card: { title: "LAST ARCHIVE", value_attr: "last_archive_age_text", color_attr: "last_archive_age_color" },
        canary_card: { title: "RESTORE CHECK", value_attr: "canary_text", color_attr: "canary_color" },
        checks_card: { title: "REPO CHECKS", value_attr: "checks_text", color_attr: "checks_color" },
      },
      dialogs: {
        prune_preview: { kind: "read", title: "Prune preview: {plugin.name}", action_id: "prune_preview", render: "textarea_readonly" },
        diff: { kind: "read", title: "Changes in {row[name]}", action_id: "diff_archive", params: { archive: "name" }, render: "textarea_readonly" },
        restore: {
          kind: "form", title: "Restore from {row[name]}", action_id: "restore_archive", params: { archive: "name" }, submit_label: "Restore",
          fields: [{ name: "path", label: "Path to restore", placeholder: `Extracted into a new folder under ${this.restore_dir}` }],
        },
      },
      tables: {
        archives: {
          title: "Archives",
          row_key: "name",
          rows_attr: "archive_rows",
          columns: [
            { name: "name", label: "Archive", field: "name", align: "left", sortable: true },
            { name: "created", label: "Created", field: "created", align: "left", sortable: true },
            { name: "age", label: "Age", field: "age", align: "left" },
            { name: "size", label: "Size", field: "size", align: "right", sortable: true },
            { name: "added", label: "Added", field: "added", align: "right", sortable: true },
            { name: "files", label: "Files", field: "files", align: "right", sortable: true },
          ],
          row_actions: [
            { id: "diff", icon: "difference", tooltip: "Changes since the previous archive", kind: "dialog", dialog: "diff" },
            { id: "restore", icon: "restore", tooltip: "Restore a path", kind: "dialog", dialog: "restore" },
            {
              id: "delete", icon: "delete", tooltip: "Delete archive", color: "negative", action_id: "delete_archive", params: { archive: "name" },
              visible_if: (plugin) => (plugin as Borg).allow_delete, confirm: "Delete archive {row[name]}? It cannot be recovered.",
            },
          ],
        } as TableSpec,
      },
      job_panel: { widget: "jobs", title: "Jobs", history_limit: 10 },
      events: { title: "Events", limit: 100, full_height: true },
    };
  }

  // The archive table's rows, newest first.
  get archive_rows(): Record<string, string>[] {
    const [archives] = this.cached_archives();
    const now = now_seconds();
    return archives.map((archive) => ({
      name: archive.name ?? "?",
      created: archive.epoch ? created_text(archive.epoch) : "unknown",
      age: archive.epoch ? format_age(now - archive.epoch) : "unknown",
      size: "original" in archive && archive.original !== undefined ? format_size(archive.original) : "--",
      added: "deduplicated" in archive && archive.deduplicated !== undefined ? format_size(archive.deduplicated) : "--",
      files: "nfiles" in archive && archive.nfiles !== undefined ? Math.trunc(archive.nfiles).toLocaleString("en-US") : "--",
    }));
  }
}

// An epoch as local "%Y-%m-%d %H:%M".
function created_text(epoch: number): string {
  const moment = new Date(epoch * 1000);
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())} ${two(moment.getHours())}:${two(moment.getMinutes())}`;
}
