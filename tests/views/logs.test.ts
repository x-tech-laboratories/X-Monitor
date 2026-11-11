import { afterEach, describe, expect, it, vi } from "vitest";

import { DatabaseManager } from "../../src/core/database/database.ts";
import { ChangeBus } from "../../src/core/state/changes.ts";
import { CollectResult } from "../../src/core/connectors/types.ts";
import { COOLDOWN_SECONDS, follow_store_changes, IDLE_REFRESH_SECONDS } from "../../src/server/views/change_feed.ts";
import { entry_rows, grouped_rows, journal_monitors, logs_view, run_search, search_kwargs, search_logs, summary_text, type JournalLike } from "../../src/server/views/logs.ts";

// ── Logs ─────────────────────────────────────────────────────────────────────

function journal(id: string, host: string): JournalLike {
  return { id, name: id, target: host, config: { type: "journal" }, children: [], max_entries: 500 };
}

function entry(message: string, epoch: number, priority = 6, unit = "nginx.service", cursor: string | null = null): Record<string, unknown> {
  return { epoch, cursor: cursor ?? message, priority, unit, identifier: "", pid: "1", message };
}

const HEIMDALL = journal("heimdall-journal", "heimdall");
const RAGNAROK = journal("ragnarok-journal", "ragnarok");

// Answers each monitor's search with canned entries, or fails it.
function engine(answers: Record<string, Record<string, unknown>[] | string | Error>, plugins: JournalLike[] = []) {
  const calls: [string, string, Record<string, unknown>][] = [];
  return {
    plugins,
    calls,
    async dispatch_action(plugin: unknown, action_id: string, args: Record<string, unknown> = {}): Promise<[boolean, Record<string, string> | null]> {
      const monitor = plugin as JournalLike;
      calls.push([monitor.id, action_id, args]);
      const answer = answers[monitor.id];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "string") return [false, { content: answer }];
      return [true, { entries: JSON.stringify(answer) }];
    },
  };
}

describe("the logs view", () => {
  it("merges rows from every host newest first", () => {
    const rows = entry_rows([[HEIMDALL, [entry("a", 10), entry("c", 30)]], [RAGNAROK, [entry("b", 20, 3)]]]);
    expect(rows.map((row) => [row.host, row.message])).toEqual([["heimdall", "c"], ["ragnarok", "b"], ["heimdall", "a"]]);
    expect(rows[1].priority_name).toBe("err");
    expect(rows[1].priority_badge).toBe("bad");
  });

  it("shows an entry's identifier when it has no unit", () => {
    expect(entry_rows([[HEIMDALL, [{ ...entry("a", 1, 6, ""), identifier: "kernel" }]]])[0].unit).toBe("kernel");
  });

  it("puts each entry under one row per grouped value", () => {
    const rows = entry_rows([[HEIMDALL, [entry("a", 30), entry("b", 20, 6, "sshd.service"), entry("c", 10)]]]);
    expect(grouped_rows(rows, "unit").map((row) => [row.group, row.parent])).toEqual([
      ["nginx.service (2)", null], ["", "group:nginx.service"], ["", "group:nginx.service"], ["sshd.service (1)", null], ["", "group:sshd.service"],
    ]);
  });

  it("runs priority groups from the most severe", () => {
    const rows = entry_rows([[HEIMDALL, [entry("a", 30, 6), entry("b", 20, 3)]]]);
    expect(grouped_rows(rows, "priority").filter((row) => row.parent === null).map((row) => row.group)).toEqual(["err (1)", "info (1)"]);
  });

  it("leaves the rows as they are with no grouping", () => {
    const rows = entry_rows([[HEIMDALL, [entry("a", 1)]]]);
    expect(grouped_rows(rows, "")).toBe(rows);
  });

  it("searches only journal monitors", () => {
    const group = { id: "host", name: "host", config: { type: "group" }, target: "", children: [HEIMDALL, { id: "cpu", name: "cpu", target: "", config: { type: "cpu" }, children: [] }] };
    expect(journal_monitors([group, RAGNAROK, HEIMDALL])).toEqual([HEIMDALL, RAGNAROK]);
  });

  it("names hosts that could not be searched", () => {
    expect(summary_text(1, 1, [])).toBe("1 entry from 1 host");
    expect(summary_text(5, 2, [["odin", "timed out"]])).toBe("5 entries from 2 hosts. Not searched: odin (timed out)");
  });

  it("defaults the search to every priority", () => {
    expect(search_kwargs("1h", null, " nginx ", "", "100")).toEqual({ since: "1h", priority: 7, unit: "nginx", text: "", limit: 100 });
  });

  it("searches every host and reports the ones that failed", async () => {
    const fake = engine({ [HEIMDALL.id]: [entry("a", 1)], [RAGNAROK.id]: "Permission denied" });
    const [found, failures] = await run_search(fake, [HEIMDALL, RAGNAROK], search_kwargs("1h", 6, "", "", 500));
    expect(found).toEqual([[HEIMDALL, [entry("a", 1)]]]);
    expect(failures).toEqual([["ragnarok", "Permission denied"]]);
    expect(fake.calls.map((call) => call[0])).toEqual([HEIMDALL.id, RAGNAROK.id]);
  });

  it("reports a host whose search throws rather than throwing", async () => {
    const [found, failures] = await run_search(engine({ [HEIMDALL.id]: new Error("refused") }), [HEIMDALL], search_kwargs("1h", 6, "", "", 500));
    expect(found).toEqual([]);
    expect(failures).toEqual([["heimdall", "refused"]]);
  });

  it("searches every host from the page and lists the entries", async () => {
    const fake = engine({ [HEIMDALL.id]: [entry("disk full", 20, 3)], [RAGNAROK.id]: [entry("started", 10)] }, [HEIMDALL, RAGNAROK]);
    const result = await search_logs(fake, null, search_kwargs("1h", 6, "", "", 500));
    expect(result.summary).toBe("2 entries from 2 hosts");
    expect(result.rows.map((row) => row.message)).toEqual(["disk full", "started"]);
    expect(new Set(fake.calls.map((call) => call[0]))).toEqual(new Set([HEIMDALL.id, RAGNAROK.id]));
  });

  it("asks for a host when none is chosen", async () => {
    expect((await search_logs(engine({}, [HEIMDALL]), [], search_kwargs("1h", 6, "", "", 500))).summary).toBe("Pick at least one host");
  });

  it("knows when there is nothing to search", () => {
    expect(logs_view({ plugins: [] }).monitors).toEqual([]);
    expect(logs_view({ plugins: [{ ...HEIMDALL, max_entries: 200 }] }).default_limit).toBe(200);
  });
});

// ── Push refreshes ───────────────────────────────────────────────────────────

describe("the change feed", () => {
  afterEach(() => vi.useRealTimers());

  function feed() {
    vi.useFakeTimers();
    const bus = new ChangeBus();
    let announced = 0;
    const handle = follow_store_changes(bus, () => (announced += 1));
    return { bus, handle, count: () => announced };
  }

  it("announces a status write at once", () => {
    const { bus, handle, count } = feed();
    bus.publish("status", "some-monitor");
    expect(count()).toBe(1);
    handle.stop();
  });

  it("collapses one cycle's many writes into one refresh and one trailing one", () => {
    const { bus, handle, count } = feed();
    for (let index = 0; index < 8; index += 1) bus.publish("metric", "some-monitor");
    expect(count()).toBe(1);
    vi.advanceTimersByTime(COOLDOWN_SECONDS * 1000 + 100);
    expect(count()).toBe(2);
    vi.advanceTimersByTime(COOLDOWN_SECONDS * 1000 + 100);
    expect(count()).toBe(2);
    handle.stop();
  });

  it("refreshes nothing on an idle system until the idle sweep", () => {
    const { handle, count } = feed();
    vi.advanceTimersByTime(600);
    expect(count()).toBe(0);
    vi.advanceTimersByTime(IDLE_REFRESH_SECONDS * 1000);
    expect(count()).toBe(1);
    handle.stop();
  });

  it("stops listening once stopped", () => {
    const { bus, handle, count } = feed();
    handle.stop();
    bus.publish("status", "some-monitor");
    expect(count()).toBe(0);
  });

  it("hears the database's writes on the shared bus", async () => {
    const { CHANGES } = await import("../../src/core/state/changes.ts");
    vi.useFakeTimers();
    let announced = 0;
    const handle = follow_store_changes(CHANGES, () => (announced += 1));
    const db = new DatabaseManager();
    db.apply_result("host", "some-monitor", "Some Monitor", new CollectResult({ success: true, status: "online", metrics: Object.fromEntries(Array.from({ length: 8 }, (_unused, index) => [`m${index}`, index])) }));
    expect(announced).toBe(1);
    handle.stop();
  });
});
