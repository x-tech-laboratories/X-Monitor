import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { create_logger_for, own_log_level, root_log_level, set_own_log_level, set_root_log_level } from "../../../src/core/logging.ts";
import { ConfigFileManager } from "../../../src/core/settings/config_file.ts";
import { LogLevels, normalize_level } from "../../../src/core/settings/log_levels.ts";
import { capture_logs } from "../log_capture.ts";

const SSH = "x_monitor.core.connectors.ssh_connector";
const touched = [SSH, "x_monitor.plugins.cpu", "x_monitor.test.other"];

create_logger_for(SSH);
const caplog = capture_logs();

let levels: LogLevels;

beforeEach(() => {
  set_root_log_level("INFO");
  levels = new LogLevels();
});

// Puts the root and every logger a test touches back the way they were.
afterEach(() => {
  set_root_log_level("INFO");
  for (const name of touched) set_own_log_level(name, null);
});

describe("normalize", () => {
  it("takes any case", () => {
    expect(normalize_level("debug")).toBe("DEBUG");
  });

  it("refuses an unknown level", () => {
    expect(() => normalize_level("LOUD")).toThrow("unknown log level");
  });
});

describe("set_level", () => {
  it("sets the root", () => {
    levels.set_level(null, "DEBUG");
    expect(root_log_level()).toBe("DEBUG");
  });

  it("sets one logger", () => {
    const result = levels.set_level(SSH, "debug");
    expect(own_log_level(SSH)).toBe("DEBUG");
    expect(result).toEqual({ root: "INFO", [SSH]: "DEBUG" });
  });

  it("makes a logger inherit again with no level", () => {
    levels.set_level(SSH, "DEBUG");
    const result = levels.set_level(SSH, null);
    expect(own_log_level(SSH)).toBeNull();
    expect(SSH in result).toBe(false);
  });

  it("cannot unset the root", () => {
    expect(() => levels.set_level("root", null)).toThrow();
  });

  it("changes nothing on a bad level", () => {
    expect(() => levels.set_level(SSH, "LOUD")).toThrow();
    expect(own_log_level(SSH)).toBeNull();
  });

  it("logs every change as a warning even when logging is quiet", () => {
    levels.set_level(null, "ERROR");
    levels.set_level(SSH, "DEBUG", "dashboard");
    const record = caplog.records.find((each) => each.message.includes(SSH))!;
    expect(record.level).toBe("warn");
    expect(record.message).toContain("from inherited to DEBUG (dashboard)");
  });
});

describe("step", () => {
  it("goes more verbose", () => {
    expect(levels.step(true, "SIGUSR1")).toBe("DEBUG");
  });

  it("goes quieter", () => {
    expect(levels.step(false, "SIGUSR2")).toBe("WARNING");
  });

  it("stops at either end", () => {
    levels.set_level(null, "DEBUG");
    expect(levels.step(true, "SIGUSR1")).toBe("DEBUG");
    levels.set_level(null, "CRITICAL");
    expect(levels.step(false, "SIGUSR2")).toBe("CRITICAL");
  });
});

describe("configure", () => {
  it("sets the root and named levels", () => {
    levels.configure("WARNING", { [SSH]: "DEBUG" });
    expect(root_log_level()).toBe("WARNING");
    expect(own_log_level(SSH)).toBe("DEBUG");
  });

  it("keeps the starting root level when config gives none", () => {
    levels.configure("ERROR", {});
    levels.configure(null, {});
    expect(root_log_level()).toBe("INFO");
  });

  it("makes a logger dropped from config inherit again", () => {
    levels.configure(null, { [SSH]: "DEBUG", "x_monitor.plugins.cpu": "ERROR" });
    levels.configure(null, { "x_monitor.plugins.cpu": "ERROR" });
    expect(own_log_level(SSH)).toBeNull();
    expect(own_log_level("x_monitor.plugins.cpu")).toBe("ERROR");
  });

  it("keeps a logger set by hand through a config that never named it", () => {
    levels.set_level("x_monitor.test.other", "DEBUG");
    levels.configure(null, { [SSH]: "DEBUG" });
    levels.configure(null, {});
    expect(own_log_level("x_monitor.test.other")).toBe("DEBUG");
  });

  it("reports a bad entry and applies the rest", () => {
    levels.configure(null, { "x_monitor.test.other": "LOUD", [SSH]: "DEBUG" });
    expect(own_log_level(SSH)).toBe("DEBUG");
    expect(caplog.text()).toContain("unknown log level 'LOUD'");
  });

  it("lists only X-Monitor's loggers as known", () => {
    create_logger_for("elsewhere.module");
    const known = LogLevels.known_loggers();
    expect(known).toContain(SSH);
    expect(known.every((name) => name.startsWith("x_monitor"))).toBe(true);
  });
});

describe("config file", () => {
  function load(section: Record<string, unknown>): ConfigFileManager {
    const path = join(mkdtempSync(join(tmpdir(), "x-monitor-levels-")), "config.yaml");
    writeFileSync(path, stringify({ logging: section }));
    return new ConfigFileManager(path);
  }

  it("reads the level and levels", () => {
    const config = load({ level: "DEBUG", levels: { [SSH]: "WARNING" } });
    expect(config.log_level).toBe("DEBUG");
    expect(config.log_levels).toEqual({ [SSH]: "WARNING" });
  });

  it("reads nothing when unset", () => {
    const config = load({});
    expect(config.log_level).toBeNull();
    expect(config.log_levels).toEqual({});
  });

  it("ignores levels that are not a mapping", () => {
    const config = load({ levels: ["DEBUG"] });
    expect(config.log_levels).toEqual({});
    expect(caplog.text()).toContain("logging.levels should be a mapping");
  });
});
