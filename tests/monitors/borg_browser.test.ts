// The borg archive browser driven through its viewer state, with borg stubbed at run_action: browsing answers with a
// canned listing run through the monitor's real interpret_action, so the browser, the monitor's listing cache and the
// restore it asks for are all the real ones.

import { describe, expect, it } from "vitest";

import { cmd_result, CollectResult, type CmdResult } from "../../src/core/connectors/types.ts";
import { BorgBrowser, crumb_trail, GONE_TEXT, PICK_TEXT, restore_prompt } from "../../src/monitors/borg/browser.ts";
import { Borg } from "../../src/monitors/borg/plugin.ts";
import { frame_line } from "../../src/monitors/borg/shell.ts";
import { make_test_plugin } from "../harness.ts";

const listings: Record<string, string> = {
  "": "d\t\t\tStorage\n-\t12\t2026-09-20T10:00:00\treadme.txt",
  Storage: "-\t2048\t2026-09-20T10:01:00\tStorage/notes.txt\n-\t5\t2026-09-20T10:02:00\tStorage/todo.txt",
};

function framed(stdout: string): CmdResult {
  return cmd_result(0, [frame_line(0, "out", 0), stdout, frame_line(0, "err", 0), ""].join("\n") + "\n", "");
}

type Call = [action_id: string, args: Record<string, unknown>];

// A borg monitor with two archives listed and its actions answered without borg, recording every call.
function vault(): { plugin: Borg; calls: Call[] } {
  const { plugin, engine } = make_test_plugin(Borg, { name: "vault", id: "vault", repo: "/srv/repo", restore_dir: "/var/tmp/r", ssh_config: { host: "test.host" } });
  const now = Math.trunc(Date.now() / 1000);
  const archives = [{ name: "b2", epoch: now - 60 }, { name: "b1", epoch: now - 3600 }];
  engine.apply(plugin, new CollectResult({ metrics: { archive_list: 2.0 }, metadata: { archive_list: JSON.stringify({ archives }) } }));
  const calls: Call[] = [];
  plugin.run_action = async (action_id, args = {}) => {
    calls.push([action_id, args]);
    if (action_id === "browse_archive") {
      const outcome = plugin.interpret_action(action_id, framed(listings[String(args.path)]), args) as CollectResult;
      return [outcome.success, outcome.metadata.content];
    }
    return [true, "Restore started (pid 7) into /var/tmp/r/b2-x"];
  };
  return { plugin, calls };
}

const names = (browser: BorgBrowser) => browser.rows.map((row) => row.name);

describe("browser", () => {
  it("lists the archives the monitor saw", () => {
    const browser = new BorgBrowser(vault().plugin);
    expect(browser.options).toEqual(["b2", "b1"]);
    expect(browser.status).toBe(PICK_TEXT);
  });

  it("lists an archive's top level when it is picked", async () => {
    const { plugin, calls } = vault();
    const browser = new BorgBrowser(plugin);
    await browser.open_folder("b2", "");
    expect(names(browser)).toEqual(["Storage", "readme.txt"]);
    expect(browser.status).toBe("2 entries");
    expect(calls).toEqual([["browse_archive", { archive: "b2", path: "" }]]);
  });

  it("lists an opened folder and extends the trail", async () => {
    const browser = new BorgBrowser(vault().plugin);
    await browser.open_folder("b2", "");
    await browser.open_row(browser.rows[0]);
    expect(names(browser)).toContain("notes.txt");
    expect(browser.crumbs.map((crumb) => crumb.label)).toEqual(["/", "Storage"]);
    expect(browser.rows[0].size).toBe("2.0 KB");
  });

  it("does not list a folder already listed again", async () => {
    const { plugin, calls } = vault();
    const browser = new BorgBrowser(plugin);
    await browser.open_folder("b2", "");
    await browser.open_row(browser.rows[0]);
    await browser.open_folder(browser.archive, browser.crumbs[0].path);
    expect(names(browser)).toContain("readme.txt");
    expect(calls).toHaveLength(2);
  });

  it("asks before restoring the ticked paths", async () => {
    const { plugin, calls } = vault();
    const browser = new BorgBrowser(plugin);
    await browser.open_folder("b2", "");
    browser.select(browser.rows);
    expect(browser.restore_label).toBe("Restore 2 selected");
    const asked: string[] = [];
    const notice = await browser.restore(async (question) => {
      asked.push(question);
      expect(calls.some(([action_id]) => action_id === "restore_archive")).toBe(false);
      return true;
    });
    expect(asked[0]).toContain("Live files are not touched");
    expect(calls.at(-1)).toEqual(["restore_archive", { archive: "b2", paths: ["Storage", "readme.txt"] }]);
    expect(notice).toEqual({ text: "Restore started (pid 7) into /var/tmp/r/b2-x", type: "positive" });
    expect(browser.restore_label).toBe("Restore selected");
  });

  it("restores nothing when cancelled", async () => {
    const { plugin, calls } = vault();
    const browser = new BorgBrowser(plugin);
    await browser.open_folder("b2", "");
    browser.select(browser.rows.slice(0, 1));
    expect(browser.restore_label).toBe("Restore 1 selected");
    expect(await browser.restore(async () => false)).toBeNull();
    expect(calls.some(([action_id]) => action_id === "restore_archive")).toBe(false);
  });

  it("closes an archive that is gone from the list", async () => {
    const { plugin } = vault();
    const browser = new BorgBrowser(plugin);
    await browser.open_folder("b2", "");
    plugin.engine!.apply(plugin, new CollectResult({ metrics: { archive_list: 1.0 }, metadata: { archive_list: JSON.stringify({ archives: [{ name: "b1", epoch: 1 }] }) } }));
    browser.update_archives();
    expect(browser.options).toEqual(["b1"]);
    expect(browser.archive).toBeNull();
    expect(browser.rows).toEqual([]);
    expect(browser.status).toBe(GONE_TEXT);
  });

  it("hands the page its archives and limits", () => {
    expect(vault().plugin.custom_view()).toEqual({ kind: "borg_browser", data: { cell: "browser", archives: ["b2", "b1"], browse_limit: 2000, restore_dir: "/var/tmp/r" } });
  });

  it("names up to ten paths in the restore question", () => {
    const question = restore_prompt("b2", "/var/tmp/r", Array.from({ length: 12 }, (_, index) => `p${index}`));
    expect(question).toContain("  /p9");
    expect(question).not.toContain("/p10");
    expect(question.endsWith("  … and 2 more")).toBe(true);
  });

  it("builds the trail from the archive's top", () => {
    expect(crumb_trail("a/b")).toEqual([{ label: "/", path: "" }, { label: "a", path: "a" }, { label: "b", path: "a/b" }]);
  });
});

describe("job panel", () => {
  it("has no run button", () => {
    const panel = vault().plugin.UI_SPEC.job_panel!;
    expect(panel.title).toBe("Jobs");
    expect(panel.run_action_id).toBeUndefined();
  });
});
