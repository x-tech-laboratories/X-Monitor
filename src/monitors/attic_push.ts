// Whether the closures a host builds for the fleet are built from the flake's latest revision and pushed to an Attic
// binary cache. One script on the building host evaluates every tracked target from the flake, checks whether that
// store path is in the local store, and asks the cache which of the closure's own paths it lacks. Paths signed by an
// upstream cache are left out, since Attic never stores them. The script runs as a detached job on the target, so an
// X-Monitor restart or redeploy never kills a run in flight: a cycle with no job running launches it, later cycles poll
// it every `job_poll` instead of every interval, and the finished run's whole output becomes the new snapshot. While it
// runs the previous snapshot and status stay, and its output and progress show in the runs panel. A target whose
// evaluation fails is failed; one not yet built, or not fully pushed, is `pending_status`. Config: flake,
// configurations (nixosConfigurations names, tracked by their system toplevel), installables (name to flake attribute,
// for any other derivation), cache_url, upstream_keys, missing_limit, pending_status, nix_bin, nix_args, timeout (the
// longest a run may take before it is killed), job_poll, build_root_dir, build_links, drop_pushed.
//
// A target named in `drop_pushed` is kept only in the cache: X-Nix, which builds and pushes the targets, writes its
// closure's path list beside its build root (`build_root_dir`, under its name in `build_links`, else
// `<monitor id>-<target>`) as `<link>.closure` and removes the root once it is fully pushed. The check reads that list
// for a target no longer in the local store, so it still counts as built and its paths are still checked against the
// cache. A target absent from the local store whose root the cache already holds, because another host built and
// pushed it, counts as built and kept only in the cache. The monitor only reads: it never builds, pushes or writes to
// the build-root folder.

import { launch_command, parse_launch, parse_poll, poll_command, split_lines, stream_stderr, workdir_for } from "../core/connectors/job_commands.ts";
import { command, CollectResult, type CmdResult, type Command } from "../core/connectors/types.ts";
import type { JobDict } from "../core/state/records.ts";
import { shell_quote } from "../core/shell.ts";
import { is_status, log_level_of, type Status } from "../shared/status.ts";
import type { LayoutRow, TableSpec, UISpec } from "../shared/ui_spec.ts";
import { Plugin } from "./base/plugin_base.ts";
import { parse_duration, StatusAccumulator, type PluginConfig } from "./base/plugin_helpers.ts";

// ── Layout and defaults ──────────────────────────────────────────────────────

const default_layout: LayoutRow[] = [
  ["host_card", "built_card", "pushed_card", "revision_card"],
  ["targets"],
  ["missing"],
  ["jobs"],
  ["events"],
];

// The signing key name cache.nixos.org uses, which Attic skips by default.
const default_upstream_keys = ["cache.nixos.org-1"];

// The line key the script reports the flake's metadata under, never a target name.
const flake_key = "@flake";

// The kind the check's detached job is recorded under.
const job_kind = "check";

// ── Script ───────────────────────────────────────────────────────────────────

// Shell functions printing `name<TAB>key<TAB>value` lines about one target: `check` evaluates it, then `inspect` reads
// the closure at $out, using $list, the target's closure list, empty unless it is kept only in the cache.
function check_function(nix: string, cache_url: string, upstream_keys: readonly string[]): string {
  // nix pads the path column with spaces and then a tab, so the widest path has only the tab before its signatures.
  const keys = upstream_keys.map((key) => `${key}:`).join(" ");
  const skip_upstream = `BEGIN { n = split("${keys}", up, " ") } ` + "{ for (i = 2; i <= NF; i++) for (k = 1; k <= n; k++) if (index($i, up[k]) == 1) next; print $1 }";
  const own_paths = upstream_keys.length > 0 ? `${nix} path-info -r --sigs "$out" | awk ${shell_quote(skip_upstream)}` : `${nix} path-info -r "$out"`;
  return [
    'report() { printf "%s\\t%s\\t%s\\n" "$name" "$1" "$(printf "%s" "$2" | tr "\\t\\n" "  ")"; }',
    "check() {",
    "    name=$1 list=$3",
    // nix's stderr reaches the job's log as it evaluates, and is kept for the error report.
    "    out=$(" + stream_stderr(nix + ' eval --raw --no-write-lock-file $refresh "$2"', '"$t/rc"', { keep: '"$t/err"', to_stderr: true }) + ")",
    '    if [ "$(cat "$t/rc")" != 0 ]; then',
    '        report error "$(tail -c 400 "$t/err")"',
    "        return",
    "    fi",
    "    refresh=",
    '    report target "$out"',
    "    inspect",
    "}",
    "inspect() {",
    `    if ${nix} path-info "$out" >/dev/null 2>&1; then`,
    "        report built 1",
    `        ${own_paths} > "$t/own"`,
    // A target dropped from the store is judged by the closure list X-Nix wrote when it dropped it.
    '    elif [ -n "$list" ] && [ "$(head -n 1 "$list" 2>/dev/null)" = "$out" ]; then',
    "        report built 1",
    "        report local 0",
    '        tail -n +2 "$list" > "$t/own"',
    "    else",
    "        report built 0",
    '        echo "$out" > "$t/own"',
    "    fi",
    '    report own "$(wc -l < "$t/own")"',
    `    json=$(${nix} path-info --stdin --json --store ${shell_quote(cache_url)} < "$t/own" 2>"$t/err")`,
    '    if [ -z "$json" ]; then',
    '        report cache_error "$(tail -c 400 "$t/err")"',
    "        return",
    "    fi",
    `    printf "%s\\n" "$json" | grep -o '"/nix/store/[^"]*":null' | cut -d'"' -f2 > "$t/missing"`,
    '    while read -r path; do report missing "$path"; done < "$t/missing"',
    "}",
  ].join("\n");
}

// The `check` call for one target, with its closure list when it is kept only in the cache.
export function check_line(name: string, installable: string, closure_list = ""): string {
  const args = [name, installable, ...(closure_list ? [closure_list] : [])];
  return "check " + args.map(shell_quote).join(" ");
}

// Whether the flake is fetched rather than read from a local path, which needs --refresh to see a new commit.
function is_remote(flake: string): boolean {
  return !["/", ".", "path:", "git+file://", "file://"].some((prefix) => flake.startsWith(prefix));
}

// The whole cycle's script: each target in turn, then the flake's metadata; `closure_lists` maps a target kept only in
// the cache to its closure list.
export function check_script(flake: string, targets: readonly (readonly [string, string])[], cache_url: string, upstream_keys: readonly string[], nix: string, closure_lists: Record<string, string> | null = null): string {
  const lines = [
    "t=$(mktemp -d)",
    "trap 'rm -rf \"$t\"' EXIT",
    // Only the first evaluation refetches a remote flake, so every target is judged at the same revision.
    `refresh=${is_remote(flake) ? "--refresh" : ""}`,
    check_function(nix, cache_url, upstream_keys),
  ];
  for (const [name, installable] of targets) lines.push(check_line(name, installable, closure_lists?.[name] ?? ""));
  lines.push(`name=${shell_quote(flake_key)}; ` + `report metadata "$(${nix} flake metadata --json --no-write-lock-file ` + `${shell_quote(flake)} 2>/dev/null)"`);
  return lines.join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export type TargetFacts = Record<string, string | string[]> & { missing: string[] };

// Python's str.splitlines over the line breaks a report can hold.
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

// Groups the script's lines into per-target facts, plus the flake's metadata.
export function parse_report(stdout: string): [facts: Record<string, TargetFacts>, metadata: Record<string, unknown>] {
  const facts: Record<string, TargetFacts> = {};
  let metadata: Record<string, unknown> = {};
  for (const line of splitlines(stdout)) {
    const first = line.indexOf("\t");
    const second = first === -1 ? -1 : line.indexOf("\t", first + 1);
    if (second === -1) continue;
    const [name, key, value] = [line.slice(0, first), line.slice(first + 1, second), line.slice(second + 1)];
    if (name === flake_key) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(value);
      } catch {
        decoded = {};
      }
      metadata = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : {};
      continue;
    }
    const entry = (facts[name] ??= { missing: [] });
    if (key === "missing") entry.missing.push(value);
    else entry[key] = value;
  }
  return [facts, metadata];
}

function flake_revision(metadata: Record<string, unknown>): string | null {
  const raw_locked = metadata.locked;
  const locked = typeof raw_locked === "object" && raw_locked !== null && !Array.isArray(raw_locked) ? (raw_locked as Record<string, unknown>) : {};
  return ((metadata.revision || locked.rev || locked.dirtyRev) as string | undefined) || null;
}

// ── Monitor ──────────────────────────────────────────────────────────────────

export interface TargetRow {
  name: string;
  target: string;
  built: string;
  pushed: string;
  pushed_ok: boolean;
  missing_count: number;
  missing: string[];
  status: string;
  summary: string;
  local?: boolean;
}

export class AtticPush extends Plugin {
  readonly flake: string;
  readonly configurations: string[];
  readonly installables: Record<string, string>;
  readonly cache_url: string;
  readonly upstream_keys: string[];
  readonly missing_limit: number;
  readonly pending_status: Status;
  readonly nix_bin: string;
  readonly nix_args: string[];
  readonly build_root_dir: string | null;
  readonly build_links: Record<string, string>;
  readonly drop_pushed: string[];
  readonly workdir: string;
  private polling_job: JobDict | null = null;

  constructor(name: string, config: PluginConfig) {
    super(name, config);
    this.flake = String(config.flake ?? "/etc/nixos");
    this.configurations = ((config.configurations as unknown[] | null | undefined) || []).map(String);
    this.installables = Object.fromEntries(Object.entries((config.installables as Record<string, unknown> | null | undefined) || {}).map(([key, value]) => [String(key), String(value)]));
    this.cache_url = String(config.cache_url || "");
    this.upstream_keys = ((config.upstream_keys as unknown[] | undefined) ?? default_upstream_keys).map(String);
    this.missing_limit = Math.trunc(Number(config.missing_limit ?? 50));
    const pending = String(config.pending_status ?? "warning");
    if (!is_status(pending)) throw new Error(`'${pending}' is not a valid Status`);
    this.pending_status = pending;
    this.nix_bin = String(config.nix_bin ?? "nix");
    this.nix_args = [...((config.nix_args as unknown[] | undefined) ?? ["--extra-experimental-features", "nix-command flakes"])].map(String);
    this.timeout = parse_duration(config.timeout ?? "30m");
    this.job_poll_interval = parse_duration(config.job_poll ?? "30s");
    this.build_root_dir = (config.build_root_dir as string | null | undefined) || null;
    this.build_links = Object.fromEntries(Object.entries((config.build_links as Record<string, unknown> | null | undefined) || {}).map(([key, value]) => [String(key), String(value)]));
    this.drop_pushed = ((config.drop_pushed as unknown[] | null | undefined) || []).map(String);
    // One fixed directory per monitor, so finished runs never pile up on the target.
    this.workdir = workdir_for(`attic_push-${this.id}`);
  }

  // Every tracked [name, installable], configurations first.
  targets(): [string, string][] {
    const flake = this.flake;
    const tracked: [string, string][] = this.configurations.map((name) => [name, `${flake}#nixosConfigurations."${name}".config.system.build.toplevel`]);
    for (const [name, attribute] of Object.entries(this.installables)) tracked.push([name, `${flake}#${attribute}`]);
    return tracked;
  }

  // The closure list of a target kept only in the cache, beside its build root, else an empty string.
  private closure_list(name: string): string {
    if (!this.build_root_dir || !this.drop_pushed.includes(name)) return "";
    return `${this.build_root_dir.replace(/\/+$/, "")}/${this.build_links[name] ?? `${this.id}-${name}`}.closure`;
  }

  // ── Collection ───────────────────────────────────────────────────────────

  private get nix(): string {
    return [this.nix_bin, ...this.nix_args.map(shell_quote)].join(" ");
  }

  // The script one run executes on the building host.
  check_script(): string {
    const lists: Record<string, string> = {};
    for (const [name] of this.targets()) if (this.closure_list(name)) lists[name] = this.closure_list(name);
    return check_script(this.flake, this.targets(), this.cache_url, this.upstream_keys, this.nix, lists);
  }

  override commands(): Command[] {
    this.polling_job = null;
    if (!this.cache_url || this.targets().length === 0) return [];
    const job = this.jobs ? this.jobs.running() : null;
    if (job && job.pid && job.workdir) {
      // parse() must read the results the way they were requested, even if the job ends mid-cycle.
      this.polling_job = job;
      // Every poll reads the whole output, since the finished run is parsed from all of it.
      return [command(poll_command(job.workdir, job.pid, 0))];
    }
    return [command(launch_command(this.run_command(), this.workdir))];
  }

  // The script under `timeout`, which kills its whole process group once the run takes too long.
  private run_command(): string {
    return `timeout ${Math.trunc(this.timeout)} sh -c ${shell_quote(this.check_script())}`;
  }

  override parse(results: CmdResult[]): CollectResult {
    const job = this.polling_job;
    this.polling_job = null;
    if (!this.cache_url) return CollectResult.failed("No cache_url is configured");
    if (this.targets().length === 0) return CollectResult.failed("No configurations or installables are configured");
    if (results.length === 0) return CollectResult.unavailable("No result for this cycle");
    if (job !== null) return this.parse_job_poll(job, results[0]);
    return this.parse_job_launch(results[0]);
  }

  // Records the launched run as a job; until it finishes the previous snapshot stands.
  private parse_job_launch(result: CmdResult): CollectResult {
    const pid = result.exit_code === 0 ? parse_launch(result.stdout) : null;
    if (pid === null) return CollectResult.unavailable(`Could not start the check: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    const job_id = this.jobs!.create(job_kind, this.run_command(), this.workdir);
    this.jobs!.set_pid(job_id, pid);
    return new CollectResult();
  }

  // Advances the running check from one poll, and parses its whole output once it finishes.
  private parse_job_poll(job: JobDict, result: CmdResult): CollectResult {
    const jobs = this.jobs!;
    const job_id = job.id;
    // A poll that never reached the target says nothing about the job; only a real answer may finish it.
    if (result.exit_code !== 0 && !result.stdout.trim()) {
      return new CollectResult({ logs: [[`Could not poll the running check: ${(result.stderr || "").trim().slice(0, 200) || `exit ${result.exit_code}`}`, "WARNING"]] });
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
    const [facts, metadata] = parse_report(poll.new_output);
    jobs.set_progress(job_id, `${Object.keys(facts).length} of ${this.targets().length} targets evaluated`);

    if (!finished) return new CollectResult();
    if (poll.exit_code === null) {
      jobs.finish(job_id, "failed", -1, "Process ended without writing an exit code");
      return CollectResult.unavailable("The check ended before it finished");
    }
    const error = poll.exit_code ? `Exited with status ${poll.exit_code}` : null;
    jobs.finish(job_id, error ? "failed" : "succeeded", poll.exit_code, error);
    if (Object.keys(facts).length === 0) return CollectResult.unavailable(`Could not check the tracked targets: ${poll.new_output.trim().slice(-200) || error}`);
    const collected = this.collect(facts, metadata);
    if (error) collected.logs.push([`The check exited with status ${poll.exit_code}`, "WARNING"]);
    return collected;
  }

  // The finished run's rows, counts and status.
  private collect(facts: Record<string, TargetFacts>, metadata: Record<string, unknown>): CollectResult {
    const rows = this.targets().map(([name]) => this.row(name, facts[name] ?? null));
    return this.summarise(rows, flake_revision(metadata));
  }

  // The counts, status and snapshot for a whole set of rows.
  private summarise(rows: TargetRow[], revision: string | null): CollectResult {
    const accumulator = new StatusAccumulator();
    const logs: [string, string][] = [];
    for (const row of rows) {
      accumulator.escalate(row.status);
      if (row.status !== "online") logs.push([`${row.name}: ${row.summary}`, log_level_of(row.status as Status)]);
    }
    const built = rows.filter((row) => row.built === "Yes").length;
    const pushed = rows.filter((row) => row.pushed_ok).length;
    logs.unshift([`${built} of ${rows.length} targets built, ${pushed} fully pushed`, "INFO"]);
    return new CollectResult({
      metrics: {
        targets_total: rows.length, targets_built: built, targets_pushed: pushed,
        missing_paths: rows.reduce((total, row) => total + row.missing_count, 0),
      },
      logs,
      status: accumulator.status,
      snapshot: { revision, targets: rows },
    });
  }

  // One target's table row, with its status and a one-line summary.
  private row(name: string, fact: TargetFacts | null): TargetRow {
    const row: TargetRow = { name, target: "--", built: "--", pushed: "--", pushed_ok: false, missing_count: 0, missing: [], status: "unavailable", summary: "Not checked" };
    if (fact === null) return row;
    if ("error" in fact) return { ...row, status: "failed", summary: `Evaluation failed: ${String(fact.error).trim()}` };

    const missing = fact.missing ?? [];
    // A target another host built and pushed is absent from this store, but the cache holds its root.
    const built_elsewhere = fact.built === "0" && missing.length === 0 && !("cache_error" in fact);
    const is_built = fact.built === "1" || built_elsewhere;
    const is_local = fact.local !== "0" && !built_elsewhere;
    const own_text = String(fact.own ?? "");
    const own = /^\d+$/.test(own_text) ? Number(own_text) : 0;
    Object.assign(row, { target: (fact.target as string | undefined) ?? "--", built: is_built ? "Yes" : "No", local: is_local, missing_count: missing.length, missing: missing.slice(0, this.missing_limit) });
    if ("cache_error" in fact) return Object.assign(row, { pushed: "Unknown", status: "unavailable", summary: `Could not query the cache: ${String(fact.cache_error).trim()}` });

    // An unbuilt target was checked by its root path alone, so its count says nothing about the closure.
    if (!is_built) row.pushed = "No";
    else if (built_elsewhere) row.pushed = "Yes";
    else if (missing.length > 0) row.pushed = `${missing.length} of ${own} missing`;
    else row.pushed = `All ${own}`;
    row.pushed_ok = is_built && missing.length === 0;
    if (row.pushed_ok) Object.assign(row, { status: "online", summary: is_local ? "Built and pushed" : "Pushed, kept only in the cache" });
    else if (!is_built) Object.assign(row, { status: this.pending_status, summary: "Not built from the latest flake" });
    else Object.assign(row, { status: this.pending_status, summary: `${missing.length} of ${own} paths are not in the cache` });
    return row;
  }

  // ── Page ─────────────────────────────────────────────────────────────────

  private snapshot(): Record<string, unknown> {
    const snapshot = this.data ? this.data.latest_snapshot<unknown>({}) : {};
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>) : {};
  }

  get rows(): TargetRow[] {
    return [...((this.snapshot().targets as TargetRow[] | undefined) || [])];
  }

  get missing_rows(): { key: string; name: string; path: string }[] {
    return this.rows.flatMap((row) => (row.missing || []).map((path) => ({ key: `${row.name}:${path}`, name: row.name, path })));
  }

  private count_pair(field: "built" | "pushed_ok", good: (value: unknown) => boolean): [string, string | null] {
    const rows = this.rows;
    if (rows.length === 0) return ["--", null];
    const count = rows.filter((row) => good(row[field])).length;
    return [`${count} / ${rows.length}`, count === rows.length ? "online" : this.pending_status];
  }

  get built_text(): string {
    return this.count_pair("built", (value) => value === "Yes")[0];
  }

  get built_color(): string | null {
    return this.count_pair("built", (value) => value === "Yes")[1];
  }

  get pushed_text(): string {
    return this.count_pair("pushed_ok", Boolean)[0];
  }

  get pushed_color(): string | null {
    return this.count_pair("pushed_ok", Boolean)[1];
  }

  get revision_text(): string {
    const revision = this.snapshot().revision as string | null | undefined;
    return revision ? revision.slice(0, 12) : "--";
  }

  static row_color(row: Record<string, unknown>): Status | null {
    return (row.status as Status | undefined) ?? null;
  }

  built_cell(row: Record<string, unknown>): Status | null {
    if (row.built === "Yes") return "online";
    if (row.built === "No") return this.pending_status;
    return null;
  }

  pushed_cell(row: Record<string, unknown>): Status | null {
    if (row.pushed_ok) return "online";
    return row.built === "Yes" || row.built === "No" ? this.pending_status : null;
  }

  override get UI_SPEC(): UISpec {
    return {
      layout: default_layout,
      cards: {
        built_card: { title: "BUILT", value_attr: "built_text", color_attr: "built_color" },
        pushed_card: { title: "PUSHED", value_attr: "pushed_text", color_attr: "pushed_color" },
        revision_card: { title: "FLAKE REVISION", value_attr: "revision_text", refresh: true },
      },
      tables: {
        targets: {
          title: "Tracked targets",
          row_key: "name",
          rows_attr: "rows",
          columns: [
            { name: "name", label: "Target", field: "name", align: "left", cell_color_by: AtticPush.row_color },
            { name: "built", label: "Built", field: "built", align: "left", cell_color_by: (row) => this.built_cell(row) },
            { name: "pushed", label: "Pushed", field: "pushed", align: "left", cell_color_by: (row) => this.pushed_cell(row), sort_field: "missing_count" },
            { name: "summary", label: "State", field: "summary", align: "left" },
            { name: "target", label: "Store path", field: "target", align: "left" },
          ],
        } as TableSpec,
        missing: {
          title: "Paths not in the cache",
          row_key: "key",
          rows_attr: "missing_rows",
          columns: [
            { name: "name", label: "Target", field: "name", align: "left" },
            { name: "path", label: "Store path", field: "path", align: "left" },
          ],
        } as TableSpec,
      },
      job_panel: { widget: "jobs", title: "Runs", history_limit: 10 },
      events: { title: "Events", limit: 100 },
    };
  }
}
