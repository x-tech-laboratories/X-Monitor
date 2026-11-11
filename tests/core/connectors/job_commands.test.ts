import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as jobs from "../../../src/core/connectors/job_commands.ts";
import { CollectResult } from "../../../src/core/connectors/types.ts";
import { DatabaseManager } from "../../../src/core/database/database.ts";
import { temp_folder } from "../coordination/engine_harness.ts";

const path_env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

async function wait_for(file: string, seconds = 5): Promise<boolean> {
  for (let elapsed = 0; elapsed < seconds * 1000 && !existsSync(file); elapsed += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  return existsSync(file);
}

const sh = (script: string, cwd: string, env: Record<string, string> = path_env) => spawnSync("sh", ["-c", script], { cwd, env, encoding: "utf8" });

describe("launch", () => {
  it("really runs the job and records its exit", async () => {
    const home = temp_folder();
    const result = sh(jobs.launch_command("echo ran; (exit 3)", jobs.workdir_for("real-1")), home, { ...path_env, HOME: home });
    expect(jobs.parse_launch(result.stdout)).not.toBeNull();
    const workdir = join(home, ".cache", "x_monitor", "jobs", "real-1");
    expect(await wait_for(join(workdir, "exit"))).toBe(true);
    expect(readFileSync(join(workdir, "out"), "utf8")).toBe("ran\n");
    expect(readFileSync(join(workdir, "exit"), "utf8").trim()).toBe("3");
  });

  it("detaches and echoes the pid", () => {
    const command = jobs.launch_command("borg create repo::x /data", "$HOME/.cache/x_monitor/jobs/tok");
    for (const part of ["setsid", "borg create repo::x /data", "echo $!", '"$d/exit"', '"$d/out"']) expect(command).toContain(part);
  });

  it("reads the pid, or null from garbage", () => {
    expect(jobs.parse_launch("12345\n")).toBe(12345);
    expect(jobs.parse_launch("some warning\n67890\n")).toBe(67890);
    expect(jobs.parse_launch("permission denied")).toBeNull();
    expect(jobs.parse_launch("")).toBeNull();
  });

  it("sanitizes the workdir", () => {
    expect(jobs.workdir_for("borg-monitor-1700000000").endsWith("borg-monitor-1700000000")).toBe(true);
    const unsafe = jobs.workdir_for("../etc/hosts; rm -rf /");
    expect(unsafe).not.toContain(";");
    expect(unsafe.split("/").at(-1)).toBe("..etchostsrm-rf");
  });
});

describe("stream_stderr", () => {
  it("copies stderr to stdout and stdout to its file", () => {
    const folder = temp_folder();
    expect(sh(jobs.stream_stderr("echo out; echo err >&2; exit 4", "rc", { stdout_to: "kept" }), folder).stdout).toBe("err\n");
    expect(readFileSync(join(folder, "kept"), "utf8")).toBe("out\n");
    expect(readFileSync(join(folder, "rc"), "utf8").trim()).toBe("4");
  });

  it("sends both streams to stdout without a file", () => {
    const folder = temp_folder();
    expect(sh(jobs.stream_stderr("echo out; echo err >&2", "rc", { keep: "err" }), folder).stdout.split("\n").filter(Boolean).sort()).toEqual(["err", "out"]);
    expect(readFileSync(join(folder, "err"), "utf8")).toBe("err\n");
    expect(readFileSync(join(folder, "rc"), "utf8").trim()).toBe("0");
  });

  it("marks each stderr line with a prefix", () => {
    expect(sh(jobs.stream_stderr("echo out; printf 'a\\nb\\n' >&2", "rc", { prefix: "@ " }), temp_folder()).stdout.split("\n").filter(Boolean).sort()).toEqual(["@ a", "@ b", "out"]);
  });

  it("sends the copy to stderr so a capture keeps only stdout", () => {
    const result = sh(`v=$(${jobs.stream_stderr("echo out; echo err >&2", "rc", { to_stderr: true })}); echo "got $v"`, temp_folder());
    expect([result.stdout, result.stderr]).toEqual(["got out\n", "err\n"]);
  });
});

describe("poll", () => {
  const output = (size: number, exit_code: number | null, alive: boolean, out: string) =>
    `===XMONITOR_SIZE===\n${size}\n===XMONITOR_EXIT===\n${exit_code ?? ""}\n===XMONITOR_ALIVE===\n${alive ? 1 : 0}\n===XMONITOR_OUT===\n${out}`;

  it("uses the offset and pid", () => {
    const command = jobs.poll_command("$HOME/.cache/x_monitor/jobs/tok", 4242, 100);
    for (const part of ["kill -0 4242", "tail -c +101", "wc -c"]) expect(command).toContain(part);
  });

  it("parses running, finished, failed and vanished jobs", () => {
    expect(jobs.parse_poll(output(500, null, true, "progress line\n"))).toMatchObject({ size: 500, exit_code: null, alive: true });
    expect(jobs.parse_poll(output(500, null, true, "progress line\n")).new_output).toContain("progress line");
    expect(jobs.parse_poll(output(1000, 0, false, "done\n"))).toMatchObject({ exit_code: 0, alive: false });
    expect(jobs.parse_poll(output(0, 2, false, "")).exit_code).toBe(2);
    expect(jobs.parse_poll(output(50, null, false, "partial"))).toMatchObject({ exit_code: null, alive: false });
  });

  it("splits whole lines and leaves a partial one", () => {
    expect(jobs.split_lines("a\nb\nc\n")).toEqual([["a", "b", "c"], 6]);
    expect(jobs.split_lines("a\nb\npartial")).toEqual([["a", "b"], 4]);
    expect(jobs.split_lines("")).toEqual([[], 0]);
    expect(jobs.split_lines("no newline yet")).toEqual([[], 0]);
  });

  it("escalates a cancel from TERM to KILL", () => {
    expect(jobs.cancel_command(999)).toContain("kill 999");
    expect(jobs.cancel_command(999)).toContain("kill -9 999");
  });
});

describe("job state", () => {
  it("fails a pidless job on restart and keeps one with a pid for re-adoption", () => {
    const db = new DatabaseManager();
    const stranded = db.create_job("p", "h", "backup", "cmd");
    const launched = db.create_job("p", "h", "backup", "cmd", "/wd");
    db.set_job_pid(launched, 4242);
    const done = db.create_job("p", "h", "backup", "cmd");
    db.finish_job(done, "succeeded", 0);
    expect(db.reconcile_orphaned_jobs()).toBe(1);
    expect(db.get_job(stranded)!.state).toBe("failed");
    expect(db.get_job(launched)!.state).toBe("running");
    expect(db.running_jobs_with_pid().map((job) => job.id)).toEqual([launched]);
    expect(db.get_job(done)!.state).toBe("succeeded");
  });

  it("appends output in order, tracks the offset and replaces progress", () => {
    const db = new DatabaseManager();
    const job_id = db.create_job("p", "h", "backup", "cmd", "/wd");
    db.append_job_output(job_id, ["a", "b"]);
    db.append_job_output(job_id, ["c"]);
    expect(db.job_output(job_id).map((row) => row.message)).toEqual(["a", "b", "c"]);
    expect(db.job_output(job_id, 1).map((row) => row.message)).toEqual(["c"]);
    db.bump_job_output_seq(job_id, 128);
    db.set_job_progress(job_id, "10 files");
    db.set_job_progress(job_id, "20 files");
    expect(db.get_job(job_id)).toMatchObject({ output_seq: 128, progress: "20 files" });
  });

  it("lists recent jobs newest first and by kind", () => {
    const db = new DatabaseManager();
    const first = db.create_job("p", "h", "backup", "cmd1");
    db.finish_job(first, "succeeded", 0);
    const second = db.create_job("p", "h", "check", "cmd2");
    db.finish_job(second, "succeeded", 0);
    expect(db.recent_jobs("p").map((job) => job.id)).toEqual([second, first]);
    expect(db.recent_jobs("p", 20, "check").map((job) => job.kind)).toEqual(["check"]);
  });
});

describe("metric scoping", () => {
  it("keeps the metrics and log lines of two monitors sharing a name apart", () => {
    const db = new DatabaseManager();
    const line: [string, string, string] = ["Started nixos-upgrade.service", "INFO", "2026-01-01T00:00:00"];
    db.apply_result("h", "odin-borgmatic-on-disk", "On Disk", new CollectResult({ metrics: { last_backup_epoch: 111 }, log_lines: [line] }));
    db.apply_result("h", "heimdall-borgmatic-on-disk", "On Disk", new CollectResult({ metrics: { last_backup_epoch: 222, archive_count: 9 }, log_lines: [line] }));
    expect(db.latest_metric("odin-borgmatic-on-disk", "last_backup_epoch")?.value).toBe(111);
    expect(db.latest_metric("heimdall-borgmatic-on-disk", "last_backup_epoch")?.value).toBe(222);
    expect(db.latest_metric("odin-borgmatic-on-disk", "archive_count")).toBeNull();
    expect(new Set(db.store.log_lines.get("h")!.items.map((record) => record.plugin_id))).toEqual(new Set(["odin-borgmatic-on-disk", "heimdall-borgmatic-on-disk"]));
  });
});
