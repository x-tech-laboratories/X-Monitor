import { describe, expect, it } from "vitest";

import { cmd_result, type ActionPlan, type CollectResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Journal, parse_entries, parse_entry, poll_command, priority_of, search_command, search_failure } from "../../src/monitors/journal.ts";
import { make_plugin } from "../harness.ts";

const config: PluginConfig = { name: "test-journal", id: "test-journal", interval: 300, ssh_config: { host: "test.host" } };

function line(message: string, { priority = 6, unit = "nginx.service", identifier = "nginx", cursor = "c1", usec = 1794381916454548 } = {}): string {
  return JSON.stringify({ __REALTIME_TIMESTAMP: String(usec), __CURSOR: cursor, PRIORITY: String(priority), _SYSTEMD_UNIT: unit, SYSLOG_IDENTIFIER: identifier, _PID: "42", MESSAGE: message });
}

const journal = (extra: PluginConfig = {}): Journal => make_plugin(Journal, { ...config, ...extra });

describe("entries", () => {
  it("carries an entry's time, priority, unit and message", () => {
    expect(parse_entry(line("worker started", { priority: 5 }))).toEqual({ epoch: 1794381916.454548, cursor: "c1", priority: 5, unit: "nginx.service", identifier: "nginx", pid: "42", message: "worker started" });
  });

  it("decodes a message that is not UTF-8 from its byte list", () => {
    expect(parse_entry(JSON.stringify({ __REALTIME_TIMESTAMP: "1", PRIORITY: "3", MESSAGE: [104, 105, 255] }))!.message).toBe("hi�");
  });

  it("falls back to the command name without a unit or identifier", () => {
    const entry = parse_entry(JSON.stringify({ __REALTIME_TIMESTAMP: "1", MESSAGE: "x", _COMM: "kthreadd" }))!;
    expect(entry.identifier).toBe("kthreadd");
    expect(entry.priority).toBe(6);
  });

  it("skips lines that are not entries", () => {
    const stdout = "-- No entries --\n" + line("a") + "\n{not json\n" + line("b", { cursor: "c2" }) + "\n";
    expect(parse_entries(stdout).map((entry) => entry.message)).toEqual(["a", "b"]);
  });

  it("reads priorities by number or name", () => {
    expect(priority_of("3")).toBe(3);
    expect(priority_of("err")).toBe(3);
    expect(priority_of("Warning")).toBe(4);
    expect(priority_of("error")).toBe(3);
    expect(priority_of(null)).toBe(7);
    expect(priority_of("nonsense", 6)).toBe(6);
    expect(priority_of(9)).toBe(7);
  });
});

describe("commands", () => {
  it("reads the last interval on the first poll", () => {
    const text = poll_command(null, 300);
    expect(text).toContain("--since=-300s");
    expect(text).toContain("-p warning");
    expect(text).not.toContain("--after-cursor");
  });

  it("reads after the cursor later and falls back to the interval", () => {
    const text = poll_command("s=abc;i=1", 300);
    expect(text.indexOf("--after-cursor='s=abc;i=1'")).toBeLessThan(text.indexOf("|| "));
    expect(text.endsWith("--since=-300s")).toBe(true);
  });

  it("asks journalctl for a search's filters, newest first", () => {
    const text = search_command({ since: "1h", priority: 4, unit: "nginx.service", limit: 200 });
    expect(text.startsWith("journalctl --no-pager -q -r -o json")).toBe(true);
    expect(text).toContain("--since=-3600s");
    expect(text).toContain("-p 4");
    expect(text).toContain("-u nginx.service");
    expect(text.endsWith("-n 200")).toBe(true);
  });

  it("adds no priority filter for this boot and every priority", () => {
    const text = search_command({ since: "boot", priority: 7 });
    expect(text).toContain(" -b");
    expect(text).not.toContain(" -p ");
  });

  it("pipes a text search through grep with the text quoted", () => {
    expect(search_command({ text: "can't bind", limit: 50 })).toContain(`| grep -iF -e 'can'"'"'t bind' | head -n 50`);
  });

  it("quotes a unit with shell characters", () => expect(search_command({ unit: "a;rm -rf /" })).toContain("-u 'a;rm -rf /'"));
  it("caps a search limit", () => expect(search_command({ limit: 1_000_000 }).endsWith("-n 5000")).toBe(true));

  it("takes a search failure from what journalctl printed", () => {
    expect(search_failure(cmd_result(1, "", "Failed to open journal"))).toBe("Failed to open journal");
    expect(search_failure(cmd_result(0, line("ok"), ""))).toBeNull();
    expect(search_failure(cmd_result(0, "", ""))).toBeNull();
  });
});

describe("polling", () => {
  it("counts new errors and warnings and keeps the cursor", () => {
    const plugin = journal();
    const stdout = [line("disk full", { priority: 3, cursor: "c1" }), line("slow", { priority: 4, cursor: "c2" }), line("crashed", { priority: 2, unit: "app.service", cursor: "c3" })].join("\n");
    const result = plugin.parse([cmd_result(0, stdout, "")]);
    expect(result.metrics).toEqual({ errors_new: 2.0, warnings_new: 1.0 });
    expect(result.status).toBe("online");
    expect(result.logs).toEqual([]);
    expect(plugin.commands()[0].text).toContain("--after-cursor=c3");
  });

  it("raises the status past the configured limits", () => {
    const plugin = journal({ warning: 1, threshold: 3 });
    const one = line("x", { priority: 3 });
    const warned = plugin.parse([cmd_result(0, one, "")]);
    expect(warned.status).toBe("warning");
    expect(warned.logs).toEqual([["1 new error entry; newest from nginx.service: x", "WARNING"]]);
    expect(plugin.parse([cmd_result(0, [one, one, one].join("\n"), "")]).status).toBe("failed");
    expect(plugin.parse([cmd_result(0, "", "")]).status).toBe("online");
  });

  it("keeps the previous cursor through a quiet poll", () => {
    const plugin = journal();
    plugin.parse([cmd_result(0, line("x", { priority: 4, cursor: "keep" }), "")]);
    plugin.parse([cmd_result(0, "-- No entries --\n", "")]);
    expect(plugin.commands()[0].text).toContain("--after-cursor=keep");
  });

  it("warns when the account sees only its own journal", () => {
    const result = journal().parse([cmd_result(0, "", "Hint: You are currently not seeing messages from other users and the system.")]);
    expect(result.status).toBe("warning");
    expect(result.logs[0][0]).toContain("systemd-journal");
  });

  it("calls a journal that cannot be read unavailable", () => {
    const result = journal().parse([cmd_result(127, "", "journalctl: command not found")]);
    expect(result.status).toBe("unavailable");
    expect(result.logs[0][0]).toContain("command not found");
  });
});

describe("searching", () => {
  it("runs the search for the query's arguments", () => {
    const plan = journal().plan_action("query_logs", { since: "24h", priority: "err", unit: "", text: "", limit: 100 }) as ActionPlan;
    expect(plan.command).toBe(search_command({ since: "24h", priority: 3, limit: 100 }));
    expect(plan.timeout).toBe(60);
  });

  it("defaults to the configured limit", () => {
    expect((journal({ max_entries: 250 }).plan_action("query_logs") as ActionPlan).command.endsWith("-n 250")).toBe(true);
  });

  it("drops matches only in field names from the answer", () => {
    const stdout = [line("message about MESSAGE", { cursor: "c1" }), line("other", { cursor: "c2" })].join("\n");
    const outcome = journal().interpret_action("query_logs", cmd_result(0, stdout, ""), { text: "message" }) as CollectResult;
    expect(outcome.success).toBe(true);
    expect((JSON.parse(outcome.metadata.entries) as { cursor: string }[]).map((entry) => entry.cursor)).toEqual(["c1"]);
  });

  it("says why a query failed", () => {
    const outcome = journal().interpret_action("query_logs", cmd_result(1, "", "No journal files were found.")) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.metadata).toEqual({ content: "No journal files were found." });
    expect(outcome.status).toBeNull();
  });
});

describe("page", () => {
  it("puts the log search on its own row", () => {
    const plugin = journal();
    expect(plugin.UI_SPEC.layout).toContainEqual(["log_search"]);
    expect((plugin.custom_view().data as { log_search: { default_limit: number } }).log_search.default_limit).toBe(500);
  });
});
