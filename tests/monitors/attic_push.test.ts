import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cmd_result, type CmdResult, type CollectResult } from "../../src/core/connectors/types.ts";
import { DatabaseManager } from "../../src/core/database/database.ts";
import { AtticPush, check_script, parse_report, type TargetRow } from "../../src/monitors/attic_push.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { make_plugin, make_test_plugin, run_cycle } from "../harness.ts";

const config: PluginConfig = {
  flake: "github:owner/fleet",
  configurations: ["Alpha", "Beta"],
  installables: { kernel: "packages.aarch64-linux.kernel" },
  cache_url: "https://cache.example/fleet",
};

const alpha = "/nix/store/aaaa-nixos-system-Alpha";
const beta = "/nix/store/bbbb-nixos-system-Beta";
const kernel = "/nix/store/kkkk-linux";
const metadata = '@flake\tmetadata\t{"revision": "0123456789abcdef0123", "locked": {}}';

function attic(extra: PluginConfig = {}, db?: DatabaseManager): AtticPush {
  return make_plugin(AtticPush, { ...config, ...extra }, db);
}

function report(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

// The raw stdout one poll of the detached check produces on the target.
function poll(out: string, exit_code: number | null = null, alive = true): CmdResult {
  return cmd_result(0, `===XMONITOR_SIZE===\n${out.length}\n` + `===XMONITOR_EXIT===\n${exit_code ?? ""}\n` + `===XMONITOR_ALIVE===\n${alive ? 1 : 0}\n` + `===XMONITOR_OUT===\n${out}`, "");
}

// One cycle with no job running: it launches the check and records its pid.
function launch(plugin: AtticPush, pid = 4242): CollectResult {
  return run_cycle(plugin, () => cmd_result(0, `${pid}\n`, ""));
}

// Launches the check, then polls it once as finished with this output.
function run(plugin: AtticPush, stdout: string, exit_code = 0): CollectResult {
  launch(plugin);
  return run_cycle(plugin, () => poll(stdout, exit_code, false));
}

function rows(plugin: AtticPush): Record<string, TargetRow> {
  const snapshot = plugin.data.latest_snapshot<{ targets: TargetRow[] }>({ targets: [] })!;
  return Object.fromEntries(snapshot.targets.map((row) => [row.name, row]));
}

function temp_dir(): string {
  return mkdtempSync(join(tmpdir(), "attic-"));
}

function executable(path: string, text: string): string {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

function sh(script: string): { stdout: string; stderr: string } {
  const done = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  return { stdout: done.stdout, stderr: done.stderr };
}

describe("script", () => {
  it("checks every target in one script", () => {
    const text = attic().check_script();
    expect(text).toContain("check Alpha 'github:owner/fleet#nixosConfigurations.\"Alpha\".config.system.build.toplevel'");
    expect(text).toContain("check kernel 'github:owner/fleet#packages.aarch64-linux.kernel'");
    expect(text).toContain("--store https://cache.example/fleet");
    expect(text).toContain("refresh=--refresh");
  });

  it("never refreshes a local flake", () => {
    expect(check_script("/etc/nixos", [["A", "/etc/nixos#x"]], "https://c", [], "nix")).toContain("refresh=\n");
  });

  it("leaves upstream paths out", () => {
    const script = check_script("/f", [["A", "/f#x"]], "https://c", ["cache.nixos.org-1", "other-1"], "nix");
    expect(script).toContain('split("cache.nixos.org-1: other-1:", up, " ")');
  });

  it("checks nothing without a cache", () => {
    expect(attic({ cache_url: "" }).commands()).toEqual([]);
  });

  it("reports through a fake nix", () => {
    const nix = executable(join(temp_dir(), "nix"),
      "#!/bin/sh\n" +
      'case "$*" in\n' +
      "  *eval*Broken*) echo 'error: no such attribute' >&2; exit 1 ;;\n" +
      `  *eval*) echo -n ${alpha} ;;\n` +
      "  *'path-info --stdin'*) cat >/dev/null; " +
      `echo '{"${alpha}":{"ca":null},"/nix/store/dddd-dep":null}' ;;\n` +
      `  *'path-info -r --sigs'*) printf '${alpha}      \\tultimate\\n` +
      "/nix/store/dddd-dep\\tultimate\\n" +
      "/nix/store/eeee-glibc   \\tcache.nixos.org-1:abc\\n" +
      "/nix/store/ffff-zlib\\tcache.nixos.org-1:def\\n' ;;\n" +
      "  *path-info*) exit 0 ;;\n" +
      "  *metadata*) echo '{\"revision\":\"abc\"}' ;;\n" +
      "esac\n");
    const script = check_script("/f", [["Alpha", "/f#a"], ["Broken", "/f#Broken"]], "https://c", ["cache.nixos.org-1"], nix);
    const done = sh(script);
    const [facts, flake] = parse_report(done.stdout);
    expect(facts.Alpha).toEqual({ target: alpha, built: "1", own: "2", missing: ["/nix/store/dddd-dep"] });
    expect(facts.Broken.error).toBe("error: no such attribute");
    expect(flake).toEqual({ revision: "abc" });
    // The evaluation's stderr is copied to the job's log as it runs, not only into the report.
    expect(done.stderr).toBe("error: no such attribute\n");
  });
});

describe("kept only in the cache", () => {
  // A fake nix whose store holds the Alpha closure when `local`, and whose cache lacks `missing`.
  function fake_nix(folder: string, local = true, missing = ""): string {
    const absent = missing ? `,"${missing}":null` : "";
    return executable(join(folder, "nix"),
      "#!/bin/sh\n" +
      'case "$*" in\n' +
      `  *eval*) echo -n ${alpha} ;;\n` +
      "  *'path-info --stdin'*) cat >/dev/null; " +
      `echo '{"${alpha}":{}${absent}}' ;;\n` +
      `  *'path-info -r'*) printf '${alpha}\\n/nix/store/dddd-dep\\n' ;;\n` +
      `  *path-info*) exit ${local ? 0 : 1} ;;\n` +
      "esac\n");
  }

  function check(nix: string, closure_list: string) {
    const script = check_script("/f", [["Alpha", "/f#a"]], "https://c", [], nix, { Alpha: closure_list });
    return parse_report(sh(script).stdout)[0].Alpha;
  }

  it("never drops a fully pushed root", () => {
    const folder = temp_dir();
    const link = join(folder, "alpha");
    const closure_list = join(folder, "alpha.closure");
    symlinkSync(alpha, link);
    const fact = check(fake_nix(folder), closure_list);
    expect(fact).toEqual({ target: alpha, built: "1", own: "2", missing: [] });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(closure_list)).toBe(false);
    expect(readdirSync(folder).sort()).toEqual(["alpha", "nix"]);
  });

  it("judges a dropped target by its list", () => {
    const folder = temp_dir();
    const closure_list = join(folder, "alpha.closure");
    writeFileSync(closure_list, `${alpha}\n${alpha}\n/nix/store/dddd-dep\n`);
    const fact = check(fake_nix(folder, false, "/nix/store/dddd-dep"), closure_list);
    expect(fact).toEqual({ target: alpha, built: "1", local: "0", own: "2", missing: ["/nix/store/dddd-dep"] });
  });

  it("counts a list for an older closure for nothing", () => {
    const folder = temp_dir();
    const closure_list = join(folder, "alpha.closure");
    writeFileSync(closure_list, `${beta}\n${beta}\n`);
    const fact = check(fake_nix(folder, false), closure_list);
    expect(fact.built).toBe("0");
    expect("local" in fact).toBe(false);
  });

  it("reads a closure list only for named targets", () => {
    const text = attic({ build_root_dir: "/roots", drop_pushed: ["Alpha"], build_links: { Alpha: "alpha-deploy" } }).check_script();
    expect(text).toContain("check Alpha 'github:owner/fleet#nixosConfigurations.\"Alpha\".config.system.build.toplevel' /roots/alpha-deploy.closure");
    expect(text).toContain("check Beta 'github:owner/fleet#nixosConfigurations.\"Beta\".config.system.build.toplevel'\n");
  });

  it("says so on a dropped row", () => {
    const plugin = attic();
    run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\tlocal\t0", "Alpha\town\t2", metadata));
    const row = rows(plugin).Alpha;
    expect(row.status).toBe("online");
    expect(row.summary).toBe("Pushed, kept only in the cache");
  });

  it("never writes to the build root folder", () => {
    const text = attic({ build_root_dir: "/roots", drop_pushed: ["Alpha"] }).check_script();
    expect(text).not.toContain("rm -f");
    expect(text).not.toContain("mv ");
    expect(text).not.toContain("readlink");
  });
});

describe("parse", () => {
  it("calls built and pushed online", () => {
    const plugin = attic();
    const result = run(plugin, report(
      `Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\town\t12",
      `Beta\ttarget\t${beta}`, "Beta\tbuilt\t1", "Beta\town\t3",
      `kernel\ttarget\t${kernel}`, "kernel\tbuilt\t1", "kernel\town\t1",
      metadata));
    expect(result.status).toBe("online");
    expect(result.metrics.targets_pushed).toBe(3.0);
    expect(rows(plugin).Alpha.pushed).toBe("All 12");
    expect(rows(plugin).Alpha.target).toBe(alpha);
    expect(plugin.revision_text).toBe("0123456789ab");
    expect(plugin.pushed_text).toBe("3 / 3");
  });

  it("calls missing paths pending", () => {
    const plugin = attic();
    const result = run(plugin, report(
      `Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\town\t12",
      "Alpha\tmissing\t/nix/store/dddd-dep", "Alpha\tmissing\t/nix/store/ffff-dep",
      `Beta\ttarget\t${beta}`, "Beta\tbuilt\t1", "Beta\town\t3",
      `kernel\ttarget\t${kernel}`, "kernel\tbuilt\t1", "kernel\town\t1"));
    expect(result.status).toBe("warning");
    expect(result.metrics.missing_paths).toBe(2.0);
    const row = rows(plugin).Alpha;
    expect(row.pushed).toBe("2 of 12 missing");
    expect(row.summary).toBe("2 of 12 paths are not in the cache");
    expect(plugin.missing_rows.map((item) => item.path)).toEqual(["/nix/store/dddd-dep", "/nix/store/ffff-dep"]);
  });

  it("calls an unbuilt target pending", () => {
    const plugin = attic();
    const result = run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t0", "Alpha\town\t1", `Alpha\tmissing\t${alpha}`));
    expect(result.status).toBe("warning");
    const row = rows(plugin).Alpha;
    expect([row.built, row.pushed]).toEqual(["No", "No"]);
    expect(row.summary).toBe("Not built from the latest flake");
    expect(plugin.built_text).toBe("0 / 3");
  });

  it("counts a target another host built and pushed as built", () => {
    const plugin = attic();
    run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t0", "Alpha\town\t1"));
    const row = rows(plugin).Alpha;
    expect([row.built, row.pushed, row.local]).toEqual(["Yes", "Yes", false]);
    expect(row.status).toBe("online");
    expect(row.summary).toBe("Pushed, kept only in the cache");
  });

  it("fails a failed evaluation", () => {
    const plugin = attic();
    const result = run(plugin, report("Alpha\terror\terror: attribute missing"));
    expect(result.status).toBe("failed");
    expect(rows(plugin).Alpha.summary).toBe("Evaluation failed: error: attribute missing");
    expect(rows(plugin).Beta.status).toBe("unavailable");
  });

  it("calls an unreachable cache unavailable", () => {
    const plugin = attic();
    run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\town\t5", "Alpha\tcache_error\tunable to download"));
    const row = rows(plugin).Alpha;
    expect([row.status, row.pushed]).toEqual(["unavailable", "Unknown"]);
  });

  it("calls no output unavailable", () => {
    expect(run(attic(), "", 1).status).toBe("unavailable");
  });

  it("caps the missing list", () => {
    const plugin = attic({ missing_limit: 1 });
    run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\town\t9", "Alpha\tmissing\t/nix/store/1", "Alpha\tmissing\t/nix/store/2"));
    const row = rows(plugin).Alpha;
    expect(row.missing).toEqual(["/nix/store/1"]);
    expect(row.missing_count).toBe(2);
  });

  it("takes a configured pending status", () => {
    const plugin = attic({ configurations: ["Alpha"], installables: {}, pending_status: "failed" });
    const result = run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t0", "Alpha\town\t1", `Alpha\tmissing\t${alpha}`));
    expect(result.status).toBe("failed");
  });
});

describe("detached job", () => {
  it("is never sampled on the agent", () => {
    expect(attic().SAMPLED).toBe(false);
  });

  it("launches the check when no job runs", () => {
    const commands = attic().commands();
    expect(commands).toHaveLength(1);
    const text = commands[0].text;
    expect(text).toContain("setsid");
    expect(text).toContain("attic_push-test-plugin");
    expect(text).toContain("timeout 1800 sh -c");
  });

  it("records a running job on launch", () => {
    const plugin = attic();
    const result = launch(plugin, 1234);
    const job = plugin.jobs!.running()!;
    expect(job.kind).toBe("check");
    expect(job.pid).toBe(1234);
    expect(result.status).toBeNull();
    expect(result.snapshot).toBeNull();
  });

  it("calls a failed launch unavailable and records no job", () => {
    const plugin = attic();
    const result = run_cycle(plugin, () => cmd_result(-1, "", "agent offline"));
    expect(result.status).toBe("unavailable");
    expect(plugin.jobs!.running()).toBeNull();
  });

  it("polls a running job instead of relaunching it", () => {
    const plugin = attic();
    launch(plugin);
    const text = plugin.commands()[0].text;
    expect(text).toContain("kill -0 4242");
    expect(text).not.toContain("setsid");
  });

  it("keeps the previous snapshot while a check runs", () => {
    const plugin = attic();
    run(plugin, report(`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\town\t1"));
    const before = plugin.data.latest_snapshot();
    launch(plugin);
    const result = run_cycle(plugin, () => poll(`Alpha\ttarget\t${alpha}\n`));
    expect(result.status).toBeNull();
    expect(result.snapshot).toBeNull();
    expect(plugin.data.latest_snapshot()).toEqual(before);
    expect(plugin.jobs!.running()!.progress).toBe("1 of 3 targets evaluated");
  });

  it("copies output into the job log once", () => {
    const { plugin, db } = make_test_plugin(AtticPush, config);
    launch(plugin);
    const first = `Alpha\ttarget\t${alpha}\n`;
    run_cycle(plugin, () => poll(first));
    run_cycle(plugin, () => poll(first + "Alpha\tbuilt\t1\n"));
    const job_id = plugin.jobs!.running()!.id;
    expect(db.job_output(job_id, -1, 0).map((row) => row.message)).toEqual([`Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1"]);
  });

  it("parses a finished check from its whole output", () => {
    const plugin = attic();
    launch(plugin);
    run_cycle(plugin, () => poll(`Alpha\ttarget\t${alpha}\nAlpha\tbuilt\t1\n`));
    const result = run_cycle(plugin, () => poll(report(
      `Alpha\ttarget\t${alpha}`, "Alpha\tbuilt\t1", "Alpha\town\t4",
      `Beta\ttarget\t${beta}`, "Beta\tbuilt\t1", "Beta\town\t2",
      `kernel\ttarget\t${kernel}`, "kernel\tbuilt\t1", "kernel\town\t1"), 0, false));
    expect(result.status).toBe("online");
    expect(rows(plugin).Alpha.pushed).toBe("All 4");
    expect(plugin.jobs!.running()).toBeNull();
    expect(plugin.jobs!.recent()[0].state).toBe("succeeded");
  });

  it("fails the job of a check that timed out", () => {
    const plugin = attic();
    launch(plugin);
    const result = run_cycle(plugin, () => poll(`Alpha\ttarget\t${alpha}\n`, 124, false));
    expect(plugin.jobs!.recent()[0].state).toBe("failed");
    expect(result.logs.some(([message]) => message.includes("exited with status 124"))).toBe(true);
  });

  it("fails the job of a vanished check", () => {
    const plugin = attic();
    launch(plugin);
    const result = run_cycle(plugin, () => poll("", null, false));
    expect(plugin.jobs!.recent()[0].state).toBe("failed");
    expect(result.status).toBe("unavailable");
  });

  it("leaves the job running after an unanswered poll", () => {
    const plugin = attic();
    launch(plugin);
    const result = run_cycle(plugin, () => cmd_result(-1, "", "Agent 'x' is not connected"));
    expect(plugin.jobs!.running()).not.toBeNull();
    expect(result.status).toBeNull();
    expect(result.logs.some(([message]) => message.includes("Could not poll"))).toBe(true);
  });

  it("adopts the running check after a restart", () => {
    const db = new DatabaseManager();
    launch(attic({}, db), 777);
    const restarted = attic({}, db);
    expect(restarted.commands()[0].text).toContain("kill -0 777");
  });

  it("polls a running check sooner than the interval", () => {
    const plugin = attic();
    expect(plugin.next_cycle_in()).toBeNull();
    launch(plugin);
    expect(plugin.next_cycle_in()).toBe(30);
  });

  it("takes a configured job poll", () => {
    const plugin = attic({ job_poll: "10s" });
    launch(plugin);
    expect(plugin.next_cycle_in()).toBe(10);
  });
});

describe("page", () => {
  it("gives runs a job panel", () => {
    const spec = attic().UI_SPEC;
    expect(spec.job_panel!.title).toBe("Runs");
    expect(spec.layout).toContainEqual(["jobs"]);
  });

  it("titles the tables in sentence case", () => {
    const tables = attic().UI_SPEC.tables as Record<string, { title?: string }>;
    expect(tables.targets.title).toBe("Tracked targets");
    expect(tables.missing.title).toBe("Paths not in the cache");
  });
});

describe("read only", () => {
  it("offers no actions", () => {
    const plugin = attic();
    expect(plugin.get_actions()).toEqual([]);
    expect(plugin.plan_action("build_target", { target: "Alpha" })).toBeNull();
    expect(plugin.plan_action("push_target", { target: "Alpha" })).toBeNull();
  });

  it("offers no row actions", () => {
    expect("row_actions" in attic().UI_SPEC.tables!.targets).toBe(false);
  });

  it("ignores the removed build and push keys", () => {
    const text = attic({ push_command: "attic push fleet", build_args: ["--keep-going"] }).check_script();
    expect(text).not.toContain("attic push");
    expect(text).not.toContain("nix build");
  });
});
