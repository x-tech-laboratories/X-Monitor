import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { ConfigError, ConfigFileManager } from "../../../src/core/settings/config_file.ts";
import { capture_logs } from "../log_capture.ts";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "x-monitor-config-"));
});

function write_yaml(content: Record<string, unknown>): string {
  const path = join(folder, "config.yaml");
  writeFileSync(path, stringify(content));
  return path;
}

function write_text(name: string, text: string): string {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
}

const caplog = capture_logs();

describe("loading", () => {
  it("loads a valid config", () => {
    const config = new ConfigFileManager(write_yaml({ database: { path: "my.db" }, plugins: [] }));
    expect(config.data.database?.path).toBe("my.db");
  });

  it("loads a JSON config, which is valid YAML", () => {
    const config = new ConfigFileManager(write_text("config.json", JSON.stringify({ database: { path: "my.db" } })));
    expect(config.data.database?.path).toBe("my.db");
  });

  it("reads YAML 1.1 booleans as PyYAML did", () => {
    const config = new ConfigFileManager(write_text("config.yaml", "logging:\n  cycle_timings: no\n"));
    expect(config.cycle_timings).toBe(false);
  });

  it("returns empty data for a missing file", () => {
    expect(new ConfigFileManager(join(folder, "does_not_exist.yaml")).data).toEqual({});
  });

  it("returns empty data for malformed YAML", () => {
    expect(new ConfigFileManager(write_text("bad.yaml", "key: [unclosed bracket")).data).toEqual({});
  });

  it("returns empty data for YAML that is not a mapping", () => {
    expect(new ConfigFileManager(write_text("list.yaml", "- item1\n- item2\n")).data).toEqual({});
  });

  it("throws in strict mode where the lenient read falls back", () => {
    expect(() => new ConfigFileManager(join(folder, "missing.yaml"), true)).toThrow(ConfigError);
    expect(() => new ConfigFileManager(write_text("bad.yaml", "key: [unclosed"), true)).toThrow(/Failed to parse YAML/);
    expect(() => new ConfigFileManager(write_text("list.yaml", "- a\n"), true)).toThrow(/not a mapping of sections/);
  });

  it("hashes the bytes it read", () => {
    const config = new ConfigFileManager(write_yaml({ plugins: [] }));
    expect(config.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("structure warnings", () => {
  it("warns about nothing in a known config", () => {
    new ConfigFileManager(write_yaml({
      database: { path: "my.db" }, plugins: [{ name: "cpu", type: "cpu" }], agents: [{ id: "host", token: "t" }], notifications: { channels: [] },
    }));
    expect(caplog.records).toEqual([]);
  });

  it("names an unknown section with the nearest match", () => {
    const config = new ConfigFileManager(write_yaml({ plugin: [{ type: "cpu" }] }));
    expect(caplog.text()).toContain("unknown top-level section 'plugin'");
    expect(caplog.text()).toContain("did you mean 'plugins'?");
    // The warning is advice, not rejection, so the section still loads as written.
    expect("plugin" in config.data).toBe(true);
  });

  it("reports a section of the wrong shape", () => {
    new ConfigFileManager(write_yaml({ plugins: { name: "cpu" } }));
    expect(caplog.text()).toContain("section 'plugins' should be a list");
  });

  it("reports a plugin without a type by name", () => {
    new ConfigFileManager(write_yaml({ plugins: [{ name: "my-cpu" }] }));
    expect(caplog.text()).toContain("plugins my-cpu has no 'type'");
  });

  it("reports an agent without an id by position", () => {
    new ConfigFileManager(write_yaml({ agents: [{ token: "t" }] }));
    expect(caplog.text()).toContain("agents entry 1 has no 'id'");
  });

  it("reports a plugin entry that is not a mapping", () => {
    new ConfigFileManager(write_yaml({ plugins: ["cpu"] }));
    expect(caplog.text()).toContain("plugins entry 1 should be a mapping");
  });
});

describe("database settings", () => {
  it("returns the configured path", () => {
    expect(new ConfigFileManager(write_yaml({ database: { path: "/data/x-monitor.db" } })).database_settings.path).toBe("/data/x-monitor.db");
  });

  it("defaults to x-monitor.db when missing", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).database_settings.path).toBe("x-monitor.db");
  });

  it("defaults when the file is missing", () => {
    expect(new ConfigFileManager(join(folder, "missing.yaml")).database_settings.path).toBe("x-monitor.db");
  });

  it("reads the write batch and falls back on a bad one", () => {
    expect(new ConfigFileManager(write_yaml({ database: { write_batch_seconds: "2.5" } })).write_batch_seconds).toBe(2.5);
    expect(new ConfigFileManager(write_yaml({ database: { write_batch_seconds: "soon" } })).write_batch_seconds).toBe(1.0);
    expect(caplog.text()).toContain("Invalid database.write_batch_seconds='soon'; falling back to 1.0");
  });
});

describe("plugins", () => {
  it("returns the plugin list", () => {
    const config = new ConfigFileManager(write_yaml({ plugins: [{ name: "A", type: "uptime" }, { name: "B", type: "group" }] }));
    expect(config.plugins).toHaveLength(2);
    expect(config.plugins[0].name).toBe("A");
  });

  it("is empty when the key is absent", () => {
    expect(new ConfigFileManager(write_yaml({ database: { path: "x.db" } })).plugins).toEqual([]);
  });

  it("is empty when the file is missing", () => {
    expect(new ConfigFileManager(join(folder, "missing.yaml")).plugins).toEqual([]);
  });
});

describe("ssh defaults", () => {
  it("returns the configured defaults", () => {
    const config = new ConfigFileManager(write_yaml({ ssh_defaults: { username: "beatlink", key_path: "/run/x-monitor.key" } }));
    expect(config.ssh_defaults).toEqual({ username: "beatlink", key_path: "/run/x-monitor.key" });
  });

  it("is empty when missing", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).ssh_defaults).toEqual({});
  });

  it("is empty when the file is missing", () => {
    expect(new ConfigFileManager(join(folder, "missing.yaml")).ssh_defaults).toEqual({});
  });
});

describe("log retention", () => {
  it("defaults to 30 days", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).log_retention_days).toBe(30);
  });

  it("reads the configured value", () => {
    expect(new ConfigFileManager(write_yaml({ logging: { retention_days: 7 } })).log_retention_days).toBe(7);
  });

  it("takes zero, which turns pruning off", () => {
    expect(new ConfigFileManager(write_yaml({ logging: { retention_days: 0 } })).log_retention_days).toBe(0);
  });

  it("falls back to the default on an invalid value", () => {
    expect(new ConfigFileManager(write_yaml({ logging: { retention_days: "not-a-number" } })).log_retention_days).toBe(30);
  });

  it("defaults when the file is missing", () => {
    expect(new ConfigFileManager(join(folder, "missing.yaml")).log_retention_days).toBe(30);
  });
});

describe("metric retention", () => {
  it("follows log retention when unset", () => {
    expect(new ConfigFileManager(write_yaml({ logging: { retention_days: 7 } })).metric_retention_days).toBe(7);
  });

  it("defaults to 30 when nothing is set", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).metric_retention_days).toBe(30);
  });

  it("reads the configured value", () => {
    expect(new ConfigFileManager(write_yaml({ logging: { retention_days: 7, metric_retention_days: 90 } })).metric_retention_days).toBe(90);
  });

  it("turns off with zero apart from logs", () => {
    const config = new ConfigFileManager(write_yaml({ logging: { retention_days: 30, metric_retention_days: 0 } }));
    expect(config.metric_retention_days).toBe(0);
    expect(config.log_retention_days).toBe(30);
  });

  it("falls back to log retention on an invalid value", () => {
    expect(new ConfigFileManager(write_yaml({ logging: { retention_days: 15, metric_retention_days: "nope" } })).metric_retention_days).toBe(15);
  });
});

describe("downsampling, cycle timings and memory", () => {
  it("turns downsampling off by default and on a bad value", () => {
    expect(new ConfigFileManager(write_yaml({})).metric_downsample_days).toBe(0);
    expect(new ConfigFileManager(write_yaml({ logging: { metric_downsample_days: 3 } })).metric_downsample_days).toBe(3);
    expect(new ConfigFileManager(write_yaml({ logging: { metric_downsample_days: "x" } })).metric_downsample_days).toBe(0);
  });

  it("records cycle timings unless turned off", () => {
    expect(new ConfigFileManager(write_yaml({})).cycle_timings).toBe(true);
    expect(new ConfigFileManager(write_yaml({ logging: { cycle_timings: false } })).cycle_timings).toBe(false);
  });

  it("keeps the default buffer size for a missing, bad or non-positive value", () => {
    const sizes = new ConfigFileManager(write_yaml({ memory: { metric_history: 50, event_history: "lots", log_history: 0 } })).buffer_sizes;
    expect(sizes.metric_history).toBe(50);
    expect(sizes.event_history).toBe(2000);
    expect(sizes.log_history).toBe(500);
    expect(caplog.text()).toContain("Invalid memory.event_history='lots'; falling back to 2000");
    expect(caplog.text()).toContain("memory.log_history must be positive (got 0); falling back to 500");
  });

  it("reads plugin paths only as a list", () => {
    expect(new ConfigFileManager(write_yaml({ plugin_paths: ["/opt/plugins"] })).plugin_paths).toEqual(["/opt/plugins"]);
    expect(new ConfigFileManager(write_yaml({ plugin_paths: "/opt/plugins" })).plugin_paths).toEqual([]);
  });
});

describe("notifications and control", () => {
  it("has no notifications when missing", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).notifications).toEqual({});
  });

  it("has no controllers when missing", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).controllers).toEqual([]);
  });
});

describe("auth settings", () => {
  it("is empty when missing", () => {
    expect(new ConfigFileManager(write_yaml({ plugins: [] })).auth_settings).toEqual({});
  });

  it("returns the configured auth", () => {
    const config = new ConfigFileManager(write_yaml({ plugins: [], auth: { username: "admin", password: "secret" } }));
    expect(config.auth_settings).toEqual({ username: "admin", password: "secret" });
  });
});
