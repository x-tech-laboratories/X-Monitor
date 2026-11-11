import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { parse_plugin_paths, PluginLoader, type PluginPath } from "../../../src/core/coordination/plugin_loader.ts";
import { Cpu } from "../../../src/monitors/cpu.ts";
import { capture_logs } from "../log_capture.ts";
import { make_engine, temp_folder, write_folder_plugin } from "./engine_harness.ts";

const caplog = capture_logs();
let folder: string;

beforeEach(() => {
  folder = temp_folder();
});

const hello = (mark: string) => `class Hello extends Plugin { static MARK = ${JSON.stringify(mark)}; parse() { return new CollectResult({ status: "online" }); } }`;
const loader = (directories: string[], override = false) => new PluginLoader(directories.map((directory): PluginPath => ({ directory, override })));

describe("built-in types", () => {
  it("resolves a built-in type", async () => {
    expect(await new PluginLoader().resolve("cpu")).toBe(Cpu);
  });

  it("loads a class once per loader", async () => {
    const plugins = new PluginLoader();
    expect(await plugins.resolve("cpu")).toBe(await plugins.resolve("cpu"));
  });
});

describe("folder types", () => {
  it("resolves a type a folder plugin provides", async () => {
    write_folder_plugin(folder, "hello", { hello: hello("external") });
    const cls = await loader([folder]).resolve("hello");
    expect(cls.name).toBe("Hello");
    expect((cls as unknown as { MARK: string }).MARK).toBe("external");
  });

  it("lets the first folder that has it win", async () => {
    write_folder_plugin(join(folder, "a"), "first", { hello: hello("a") });
    write_folder_plugin(join(folder, "b"), "second", { hello: hello("b") });
    expect(((await loader([join(folder, "a"), join(folder, "b")]).resolve("hello")) as unknown as { MARK: string }).MARK).toBe("a");
  });

  it("reads an edited file in a new loader", async () => {
    write_folder_plugin(folder, "hello", { hello: hello("first") });
    expect(((await loader([folder]).resolve("hello")) as unknown as { MARK: string }).MARK).toBe("first");
    write_folder_plugin(folder, "hello", { hello: hello("second") });
    expect(((await loader([folder]).resolve("hello")) as unknown as { MARK: string }).MARK).toBe("second");
  });
});

describe("shadowing", () => {
  it("lets a built-in win and names the shadowed plugin", async () => {
    write_folder_plugin(folder, "mine", { cpu: "class MyCpu extends Plugin {}" });
    expect(await loader([folder]).resolve("cpu")).toBe(Cpu);
    expect(caplog.text()).toContain("shadowed by X-Monitor's built-in plugin");
    expect(caplog.text()).toContain("override: true");
  });

  it("lets an override win", async () => {
    write_folder_plugin(folder, "mine", { cpu: "class MyCpu extends Plugin {}" });
    expect((await loader([folder], true).resolve("cpu")).name).toBe("MyCpu");
    expect(caplog.text()).toContain("overrides X-Monitor's built-in plugin");
  });
});

describe("errors", () => {
  it("names where it looked for an unknown type", async () => {
    await expect(loader([folder]).resolve("nope")).rejects.toThrow(new RegExp(`no plugin type 'nope'.*${folder}`));
  });

  it("says none were configured", async () => {
    await expect(new PluginLoader().resolve("nope")).rejects.toThrow("none configured");
  });

  it.each(["../escape", "a.b", "", "has space"])("refuses %j as a type name", async (name) => {
    await expect(new PluginLoader().resolve(name)).rejects.toThrow("not a valid module name");
  });

  it("refuses a provided type that is not a class", async () => {
    write_folder_plugin(folder, "odd", { odd: "42" });
    await expect(loader([folder]).resolve("odd")).rejects.toThrow("is not a monitor class");
  });

  it("reports a folder plugin that fails to import and keeps looking", async () => {
    write_folder_plugin(folder, "broken", { broken: "class Broken extends Plugin {}" }, 'import "no-such-module-anywhere";');
    await expect(loader([folder]).resolve("broken")).rejects.toThrow("no plugin type 'broken'");
    expect(caplog.text()).toContain("failed to load");
  });
});

describe("plugin paths", () => {
  it("reads relative paths under the config folder", () => {
    mkdirSync(join(folder, "plugins"));
    expect(parse_plugin_paths(["plugins"], folder)).toEqual([{ directory: join(folder, "plugins"), override: false }]);
  });

  it("lets a mapping override", () => {
    expect(parse_plugin_paths([{ path: folder, override: true }], folder)).toEqual([{ directory: folder, override: true }]);
  });

  it("reports and skips a missing folder", () => {
    expect(parse_plugin_paths(["nowhere"], folder)).toEqual([]);
    expect(caplog.text()).toContain("is not a directory");
  });

  it("reports an entry with no path", () => {
    expect(parse_plugin_paths([{ override: true }], folder)).toEqual([]);
    expect(caplog.text()).toContain("names no directory");
  });
});

describe("the engine", () => {
  it("loads a monitor of a folder type", async () => {
    const root = temp_folder();
    write_folder_plugin(join(root, "my-plugins"), "hello", { hello: hello("x") });
    const { engine } = make_engine({
      plugin_paths: ["my-plugins"],
      plugins: [{ name: "Hi", id: "hi", type: "hello", target_host: "h" }, { name: "Gone", id: "gone", type: "nope" }],
    }, { folder: root });
    await engine.setup_modules();
    expect(engine.plugins.map((plugin) => plugin.constructor.name)).toEqual(["Hello"]);
  });
});
