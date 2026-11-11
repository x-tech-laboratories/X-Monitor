import { describe, expect, it } from "vitest";

import type { JobRecord, StatusRecord } from "../../../src/core/state/records.ts";
import { StateStore } from "../../../src/core/state/store.ts";

const minutes_ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

function status(plugin_id: string, state: string): StatusRecord {
  return { plugin_id, state, timestamp: new Date() };
}

function job_record(id: number, started: Date): JobRecord {
  return {
    id, plugin_id: "p", target: "h", kind: "k", state: "success", command: "cmd", started,
    finished: null, exit_code: null, progress: null, error: null, pid: null, workdir: null, output_seq: 0,
  };
}

describe("direct mutation", () => {
  it("keeps settings as a plain map", () => {
    const store = new StateStore();
    store.settings.set("k", "v");
    expect(store.settings.get("k")).toBe("v");
    expect(store.settings.get("missing") ?? "d").toBe("d");
  });

  it("holds decoded snapshots", () => {
    const store = new StateStore();
    const rows = [{ pid: 1 }];
    store.snapshots.set("p", rows);
    // The same object comes back, with no serialise and parse round trip.
    expect(store.snapshots.get("p")).toBe(rows);
  });
});

describe("metrics", () => {
  it("takes the newest append as the latest metric", () => {
    const store = new StateStore();
    for (const value of [1, 2, 3]) store.add_metric("h", "cpu", "usage", value);
    expect(store.latest_metric("cpu", "usage")?.value).toBe(3);
  });

  it("has no latest metric for an unseen series", () => {
    expect(new StateStore().latest_metric("nope", "usage")).toBeNull();
  });

  it("returns history oldest to newest", () => {
    const store = new StateStore();
    for (const value of [1, 2, 3]) store.add_metric("h", "cpu", "usage", value);
    expect(store.metric_history("cpu", "usage").map((record) => record.value)).toEqual([1, 2, 3]);
  });

  it("returns the newest history within the limit", () => {
    const store = new StateStore();
    for (let value = 0; value < 10; value++) store.add_metric("h", "cpu", "usage", value);
    expect(store.metric_history("cpu", "usage", 3).map((record) => record.value)).toEqual([7, 8, 9]);
  });

  it("bounds a series by its buffer size", () => {
    const store = new StateStore({ metric_history: 5 });
    for (let value = 0; value < 100; value++) store.add_metric("h", "cpu", "usage", value);
    expect(store.metric_history("cpu", "usage", 0).map((record) => record.value)).toEqual([95, 96, 97, 98, 99]);
  });

  it("keeps series apart", () => {
    const store = new StateStore();
    store.add_metric("h", "cpu", "usage", 1);
    store.add_metric("h", "cpu", "temp", 2);
    store.add_metric("h", "disk", "usage", 3);
    expect(store.latest_metric("cpu", "usage")?.value).toBe(1);
    expect(store.latest_metric("cpu", "temp")?.value).toBe(2);
    expect(store.latest_metric("disk", "usage")?.value).toBe(3);
  });

  it("spans one plugin's series and no other's in collector_metrics", () => {
    const store = new StateStore();
    store.add_metric("h", "cpu", "usage", 1);
    store.add_metric("h", "cpu", "temp", 2);
    store.add_metric("h", "disk", "usage", 3);
    const records = store.collector_metrics("cpu", 10);
    expect(new Set(records.map((record) => record.plugin_id))).toEqual(new Set(["cpu"]));
    expect(new Set(records.map((record) => record.metric_name))).toEqual(new Set(["usage", "temp"]));
  });

  it("orders collector_metrics newest first, even within one millisecond", () => {
    const store = new StateStore();
    for (let value = 0; value < 5; value++) store.add_metric("h", "cpu", "usage", value);
    expect(store.collector_metrics("cpu", 3).map((record) => record.value)).toEqual([4, 3, 2]);
  });

  it("takes one point per series in latest_metrics", () => {
    const store = new StateStore();
    for (let value = 0; value < 5; value++) {
      store.add_metric("h", "cpu", "usage", value);
      store.add_metric("h", "cpu", "temp", value);
    }
    const latest = store.latest_metrics();
    expect(latest).toHaveLength(2);
    expect(new Set(latest.map((record) => record.value))).toEqual(new Set([4]));
  });
});

describe("status", () => {
  it("keeps the last write", () => {
    const store = new StateStore();
    store.statuses.set("cpu", status("cpu", "online"));
    store.statuses.set("cpu", status("cpu", "failed"));
    expect(store.statuses.get("cpu")?.state).toBe("failed");
  });

  it("does not accumulate history", () => {
    const store = new StateStore();
    for (let index = 0; index < 100; index++) store.statuses.set("cpu", status("cpu", "online"));
    expect(store.statuses.size).toBe(1);
  });
});

describe("events", () => {
  it("lists recent events newest first", () => {
    const store = new StateStore();
    for (let index = 0; index < 3; index++) store.add_event("INFO", `m${index}`);
    expect(store.recent_events().map((record) => record.message)).toEqual(["m2", "m1", "m0"]);
  });

  it("bounds events", () => {
    const store = new StateStore({ event_history: 10 });
    for (let index = 0; index < 100; index++) store.add_event("INFO", `m${index}`);
    const events = store.recent_events(0);
    expect(events).toHaveLength(10);
    expect(events[0].message).toBe("m99");
  });

  it("composes filters", () => {
    const store = new StateStore();
    store.add_event("INFO", "keep me", "h1");
    store.add_event("ERROR", "keep me", "h1");
    store.add_event("ERROR", "keep me", "h2");
    store.add_event("ERROR", "other", "h1");
    expect(store.recent_events(200, "ERROR", "h1", "keep")).toHaveLength(1);
  });

  it("applies the limit after filtering", () => {
    const store = new StateStore();
    for (let index = 0; index < 50; index++) store.add_event(index % 2 ? "ERROR" : "INFO", `m${index}`);
    expect(store.recent_events(5, "ERROR")).toHaveLength(5);
  });

  it("prefers the plugin id for a plugin's events", () => {
    const store = new StateStore();
    store.add_event("INFO", "[A] mine", null, "a");
    store.add_event("INFO", "[A] theirs", null, "b");
    expect(store.plugin_events("a").map((record) => record.message)).toEqual(["[A] mine"]);
  });

  it("falls back to the name prefix for a plugin's events", () => {
    const store = new StateStore();
    store.add_event("INFO", "[A] mine", "h");
    store.add_event("INFO", "[B] theirs", "h");
    expect(store.plugin_events("", "[A] ", "h").map((record) => record.message)).toEqual(["[A] mine"]);
  });
});

describe("log lines", () => {
  it("rejects a duplicate line", () => {
    const store = new StateStore();
    expect(store.add_log_line("h", "s", "INFO", "line", "hash1")).not.toBeNull();
    expect(store.add_log_line("h", "s", "INFO", "line", "hash1")).toBeNull();
    expect(store.recent_log_lines("h", "", 0)).toHaveLength(1);
  });

  it("keeps distinct lines", () => {
    const store = new StateStore();
    store.add_log_line("h", "s", "INFO", "a", "hash1");
    store.add_log_line("h", "s", "INFO", "b", "hash2");
    expect(store.recent_log_lines("h", "", 0)).toHaveLength(2);
  });

  it("ages hashes out of the dedup set with the buffer", () => {
    const store = new StateStore({ log_history: 5 });
    for (let index = 0; index < 100; index++) store.add_log_line("h", "s", "INFO", `line${index}`, `hash${index}`);
    expect(store["log_dedup"].get("h")!.size).toBeLessThanOrEqual(5);
    // An evicted line is no longer a known duplicate, so it re-enters.
    expect(store.add_log_line("h", "s", "INFO", "line0", "hash0")).not.toBeNull();
  });

  it("keeps targets apart", () => {
    const store = new StateStore();
    store.add_log_line("h1", "s", "INFO", "a", "hash1");
    store.add_log_line("h2", "s", "INFO", "b", "hash2");
    expect(store.recent_log_lines("h1", "", 0)).toHaveLength(1);
    expect(store.recent_log_lines("h2", "", 0)).toHaveLength(1);
  });

  it("filters by source", () => {
    const store = new StateStore();
    store.add_log_line("h", "nginx", "INFO", "a", "hash1");
    store.add_log_line("h", "sshd", "INFO", "b", "hash2");
    expect(store.recent_log_lines("h", "nginx", 0).map((record) => record.message)).toEqual(["a"]);
  });

  it("lists newest first", () => {
    const store = new StateStore();
    for (let index = 0; index < 3; index++) store.add_log_line("h", "s", "INFO", `line${index}`, `hash${index}`);
    expect(store.recent_log_lines("h").map((record) => record.message)).toEqual(["line2", "line1", "line0"]);
  });
});

describe("jobs", () => {
  it("gives unique ascending ids", () => {
    const store = new StateStore();
    expect([1, 2, 3, 4, 5].map(() => store.create_job("p", "h", "k", "cmd").id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("advances a job in place", () => {
    const store = new StateStore();
    const job = store.create_job("p", "h", "k", "cmd");
    store.update_job(job.id, { pid: 42, progress: "50%" });
    expect(store.get_job(job.id)?.pid).toBe(42);
    expect(store.get_job(job.id)?.progress).toBe("50%");
  });

  it("does nothing for an unknown job", () => {
    expect(new StateStore().update_job(999, { pid: 1 })).toBeNull();
  });

  it("filters running jobs", () => {
    const store = new StateStore();
    store.create_job("p1", "h", "k", "cmd");
    const second = store.create_job("p2", "h", "k", "cmd");
    store.update_job(second.id, { pid: 7 });
    expect(store.running_jobs()).toHaveLength(2);
    expect(store.running_jobs("p1")).toHaveLength(1);
    expect(store.running_jobs(null, true)).toHaveLength(1);
  });

  it("does not count a finished job as running", () => {
    const store = new StateStore();
    const job = store.create_job("p", "h", "k", "cmd");
    store.update_job(job.id, { state: "success", finished: new Date() });
    expect(store.running_jobs()).toEqual([]);
    expect(store.get_job(job.id)?.running).toBe(false);
  });

  it("keeps output sequence numbers contiguous across appends", () => {
    const store = new StateStore();
    const job = store.create_job("p", "h", "k", "cmd");
    store.append_job_output(job.id, ["a", "b"]);
    store.append_job_output(job.id, ["c"]);
    expect(store.job_output(job.id).map((record) => record.seq)).toEqual([0, 1, 2]);
  });

  it("returns only output after a sequence number", () => {
    const store = new StateStore();
    const job = store.create_job("p", "h", "k", "cmd");
    store.append_job_output(job.id, ["a", "b", "c"]);
    expect(store.job_output(job.id, 0).map((record) => record.message)).toEqual(["b", "c"]);
  });

  it("skips null output lines", () => {
    const store = new StateStore();
    const job = store.create_job("p", "h", "k", "cmd");
    store.append_job_output(job.id, ["a", null, "b"]);
    expect(store.job_output(job.id).map((record) => record.message)).toEqual(["a", "b"]);
  });

  it("reconciles only jobs without a pid", () => {
    const store = new StateStore();
    const launched = store.create_job("p", "h", "k", "cmd");
    store.update_job(launched.id, { pid: 99 });
    const stranded = store.create_job("p", "h", "k", "cmd");
    expect(store.reconcile_orphaned_jobs("restarted")).toEqual([stranded.id]);
    // The job with a live remote pid is left for its plugin to re-adopt.
    expect(store.get_job(launched.id)?.state).toBe("running");
    expect(store.get_job(stranded.id)?.state).toBe("failed");
  });

  it("evicts finished jobs past the cap", () => {
    const store = new StateStore({ jobs_per_plugin: 3 });
    const ids: number[] = [];
    for (let index = 0; index < 10; index++) {
      const job = store.create_job("p", "h", "k", "cmd");
      store.append_job_output(job.id, ["out"]);
      store.update_job(job.id, { state: "success" });
      ids.push(job.id);
    }
    expect(store.jobs.size).toBe(3);
    // The newest three survive; the rest are gone with their output.
    expect([...store.jobs.keys()].sort((a, b) => a - b)).toEqual(ids.slice(-3));
    expect(store.get_job(ids[0])).toBeNull();
    expect(store.job_output(ids[0])).toEqual([]);
    expect(new Set(store.job_output_buffers.keys())).toEqual(new Set(ids.slice(-3)));
  });

  it("keeps a running job's full output", () => {
    const store = new StateStore({ finished_job_output: 10 });
    const job = store.create_job("p", "h", "k", "cmd");
    store.append_job_output(job.id, Array.from({ length: 100 }, (_, index) => `line${index}`));
    expect(store.job_output(job.id, -1, 0)).toHaveLength(100);
  });

  it("trims a finished job's output to its tail", () => {
    const store = new StateStore({ finished_job_output: 10 });
    const job = store.create_job("p", "h", "k", "cmd");
    store.append_job_output(job.id, Array.from({ length: 100 }, (_, index) => `line${index}`));
    store.update_job(job.id, { state: "success" });
    const remaining = store.job_output(job.id, -1, 0);
    expect(remaining).toHaveLength(10);
    // The tail is kept, and sequence numbers stay intact for after_seq.
    expect(remaining.map((record) => record.message)).toEqual(Array.from({ length: 10 }, (_, index) => `line${index + 90}`));
    expect(remaining.map((record) => record.seq)).toEqual(Array.from({ length: 10 }, (_, index) => index + 90));
  });

  it("leaves short finished output alone", () => {
    const store = new StateStore({ finished_job_output: 10 });
    const job = store.create_job("p", "h", "k", "cmd");
    store.append_job_output(job.id, ["a", "b"]);
    store.update_job(job.id, { state: "success" });
    expect(store.job_output(job.id).map((record) => record.message)).toEqual(["a", "b"]);
  });

  it("never evicts a running job", () => {
    const store = new StateStore({ jobs_per_plugin: 2 });
    const running = store.create_job("p", "h", "k", "cmd");
    for (let index = 0; index < 10; index++) {
      const job = store.create_job("p", "h", "k", "cmd");
      store.update_job(job.id, { state: "success" });
    }
    expect(store.get_job(running.id)?.state).toBe("running");
  });

  it("evicts per plugin", () => {
    const store = new StateStore({ jobs_per_plugin: 2 });
    for (const plugin of ["a", "b"]) {
      for (let index = 0; index < 5; index++) {
        const job = store.create_job(plugin, "h", "k", "cmd");
        store.update_job(job.id, { state: "success" });
      }
    }
    expect(store.recent_jobs("a", 99)).toHaveLength(2);
    expect(store.recent_jobs("b", 99)).toHaveLength(2);
  });

  it("holds hydrated jobs to the cap and resumes ids past them", () => {
    const store = new StateStore({ jobs_per_plugin: 2 });
    store.load_jobs(Array.from({ length: 10 }, (_, index) => job_record(index + 1, new Date(Date.now() + (index + 1) * 1000))), new Map());
    expect(store.jobs.size).toBe(2);
    // Ids still resume past the highest restored id, evicted or not.
    expect(store.create_job("p", "h", "k", "cmd").id).toBe(11);
  });

  it("does not reuse a restored id", () => {
    const store = new StateStore();
    store.load_jobs([job_record(7, new Date())], new Map());
    expect(store.create_job("p", "h", "k", "cmd").id).toBe(8);
  });
});

describe("late records", () => {
  it("never makes a late metric the latest", () => {
    const store = new StateStore();
    const now = new Date();
    store.add_metric("h", "cpu", "usage", 2, null, now);
    store.add_metric("h", "cpu", "usage", 1, null, minutes_ago(now, 5));
    expect(store.latest_metric("cpu", "usage")?.value).toBe(2);
    expect(store.metric_history("cpu", "usage").map((record) => record.value)).toEqual([1, 2]);
  });

  it("places a late metric between its neighbours", () => {
    const store = new StateStore();
    const now = new Date();
    store.add_metric("h", "cpu", "usage", 1, null, minutes_ago(now, 10));
    store.add_metric("h", "cpu", "usage", 3, null, now);
    store.add_metric("h", "cpu", "usage", 2, null, minutes_ago(now, 5));
    expect(store.metric_history("cpu", "usage").map((record) => record.value)).toEqual([1, 2, 3]);
  });

  it("drops the oldest of a full series to make room", () => {
    const store = new StateStore({ metric_history: 3 });
    const now = new Date();
    for (const [minutes, value] of [[30, 1], [20, 2], [0, 4]]) store.add_metric("h", "cpu", "usage", value, null, minutes_ago(now, minutes));
    store.add_metric("h", "cpu", "usage", 3, null, minutes_ago(now, 10));
    expect(store.metric_history("cpu", "usage", 0).map((record) => record.value)).toEqual([2, 3, 4]);
  });

  it("does not keep a record older than a full series", () => {
    const store = new StateStore({ metric_history: 2 });
    const now = new Date();
    for (const [minutes, value] of [[10, 2], [0, 3]]) store.add_metric("h", "cpu", "usage", value, null, minutes_ago(now, minutes));
    store.add_metric("h", "cpu", "usage", 1, null, minutes_ago(now, 60));
    expect(store.metric_history("cpu", "usage", 0).map((record) => record.value)).toEqual([2, 3]);
  });

  it("keeps the feed newest first with late events", () => {
    const store = new StateStore();
    const now = new Date();
    store.add_event("INFO", "new", null, null, now);
    store.add_event("INFO", "old", null, null, minutes_ago(now, 5));
    expect(store.recent_events().map((record) => record.message)).toEqual(["new", "old"]);
  });

  it("still deduplicates a late log line", () => {
    const store = new StateStore();
    const now = new Date();
    store.add_log_line("h", "p", "INFO", "line", "hash", now);
    expect(store.add_log_line("h", "p", "INFO", "line", "hash", minutes_ago(now, 1))).toBeNull();
  });
});
