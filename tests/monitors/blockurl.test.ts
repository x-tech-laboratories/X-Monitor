import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cmd_result, http_result, type CmdResult, type Command, type HttpRequest, type HttpResult, type Request } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { AGENT_UNAVAILABLE, Blockurl, parse_response, write_probe_error } from "../../src/monitors/blockurl.ts";
import { make_plugin, run_requests, store_of } from "../harness.ts";

const base_config: PluginConfig = {
  name: "test-blockurl",
  id: "test-blockurl",
  api_url: "http://blockurl.test:9001",
  api_key: "key-value",
  min_domains: 1,
  ssh_config: { host: "test.host" },
};

const domains = [["example.com", 5], ["other.com", 3]];
const probe_url = "https://x-monitor-write-probe.invalid/blockurl";

const plugin = () => make_plugin(Blockurl, base_config);

function result(list: unknown[] = domains): HttpResult {
  return http_result(200, JSON.stringify(list));
}

function probe(stdout: string | null = null, exit_code = 0, stderr = ""): CmdResult {
  return cmd_result(exit_code, stdout ?? `block=200 unblock=200 check={"${probe_url}": true}`, stderr);
}

// Answers the domains GET and the write probe each with their own result type.
function respond(http: HttpResult | null = null, probe_result: CmdResult | null = null) {
  return (request: Request) => (request.kind === "command" ? (probe_result ?? probe()) : (http ?? result()));
}

const latest_status = (monitor: Blockurl, id = "test-blockurl") => store_of(monitor).store.statuses.get(id)?.state ?? null;
const latest_metric = (monitor: Blockurl, name: string, id = "test-blockurl") => store_of(monitor).latest_metric(id, name)?.value ?? null;

describe("parse response", () => {
  it("parses a domain list", () => {
    expect(parse_response(JSON.stringify(domains))).toHaveLength(2);
  });

  it("rejects a non-list", () => {
    expect(() => parse_response('{"foo": "bar"}')).toThrow(/not a list/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parse_response("not json")).toThrow(/not JSON/);
  });
});

describe("requests", () => {
  it("asks for the domains with the api key header", () => {
    const request = plugin().requests()[0] as HttpRequest;
    expect(request.kind).toBe("http");
    expect(request.url).toBe("http://blockurl.test:9001/urls/domains");
    expect(request.headers).toEqual({ "X-API-Key": "key-value" });
  });

  it("declares a write probe", () => {
    const requests = plugin().requests();
    expect(requests).toHaveLength(2);
    expect(requests[1].kind).toBe("command");
    for (const part of ["/urls/block", "/urls/check", "/urls/unblock"]) expect((requests[1] as Command).text).toContain(part);
  });

  it("reads the key on the agent, not in the text", () => {
    const text = (plugin().requests()[1] as Command).text;
    expect(text).not.toContain("key-value");
    expect(text).toContain("/run/secrets/blockurl_api_key");
  });

  it("writes the probe command as Python did", () => {
    const call = `printf "X-API-Key: %s\\n" "$KEY" | curl -sS -m 10 -X POST -H @- -H "Content-Type: application/json" -d '{"urls": ["${probe_url}"]}'`;
    expect(plugin().probe_command()).toBe(
      "KEY=$(cut -d= -f2- /run/secrets/blockurl_api_key); " +
        `B=$(${call} -o /dev/null -w '%{http_code}' http://blockurl.test:9001/urls/block); ` +
        `C=$(${call} http://blockurl.test:9001/urls/check); ` +
        `D=$(${call} -o /dev/null -w '%{http_code}' http://blockurl.test:9001/urls/unblock); ` +
        'echo "block=$B unblock=$D check=$C"',
    );
  });

  it("keeps the key off every command line", () => {
    const folder = mkdtempSync(join(tmpdir(), "blockurl-"));
    const log = join(folder, "curl.log");
    const curl = join(folder, "curl");
    writeFileSync(curl, `#!/bin/sh\necho "argv: $*" >> ${log}\necho "stdin: $(cat)" >> ${log}\n`);
    chmodSync(curl, 0o755);
    const monitor = make_plugin(Blockurl, { ...base_config, api_key: null, api_key_command: "echo probe-key-value" });
    const done = spawnSync("sh", ["-c", (monitor.requests()[1] as Command).text], { env: { PATH: `${folder}:/usr/bin:/bin:/run/current-system/sw/bin` } });
    expect(done.status).toBe(0);
    const lines = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
    expect(lines.some((line) => line.startsWith("argv:"))).toBe(true);
    expect(lines.filter((line) => line.startsWith("argv:") && line.includes("probe-key-value"))).toEqual([]);
    expect(lines.filter((line) => line === "stdin: X-API-Key: probe-key-value")).toHaveLength(3);
  });

  it("can turn the write probe off", () => {
    expect(make_plugin(Blockurl, { ...base_config, write_probe: false }).requests()).toHaveLength(1);
  });

  it("asks nothing without a url", () => {
    expect(make_plugin(Blockurl, { name: "b", id: "b", ssh_config: { host: "h" } }).requests()).toEqual([]);
  });
});

describe("collection", () => {
  it("calls a populated list online", () => {
    const monitor = plugin();
    const collected = run_requests(monitor, respond());
    expect(latest_status(monitor)).toBe("online");
    expect(collected.logs[0][0]).toBe("2 domain(s), 8 blocked URL(s)");
  });

  it("warns on an empty list", () => {
    const monitor = plugin();
    run_requests(monitor, respond(result([])));
    expect(latest_status(monitor)).toBe("warning");
  });

  it("calls a request error unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, respond(http_result(null, "", { error: "connection refused" })));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("calls a malformed response unavailable", () => {
    const monitor = plugin();
    run_requests(monitor, respond(http_result(200, "<html>oops</html>")));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("fails a 401", () => {
    const monitor = plugin();
    run_requests(monitor, respond(http_result(401, "")));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records the url total", () => {
    const monitor = plugin();
    run_requests(monitor, respond());
    expect(latest_metric(monitor, "urls_total")).toBe(8.0);
  });

  it("records the domain total", () => {
    const monitor = plugin();
    run_requests(monitor, respond());
    expect(latest_metric(monitor, "domains_total")).toBe(2.0);
  });
});

describe("actions", () => {
  it("handles none", () => {
    expect(plugin().plan_action("anything")).toBeNull();
  });
});

describe("write probe parsing", () => {
  it("finds no error in a clean round trip", () => {
    expect(write_probe_error(probe())).toBe("");
  });

  it("calls a missing result unavailable, not a failure", () => {
    expect(write_probe_error(null)).toBe(AGENT_UNAVAILABLE);
  });

  it("calls a disconnected agent unavailable, not a failure", () => {
    expect(write_probe_error(probe("", -1, "Agent 'heimdall' is not connected"))).toBe(AGENT_UNAVAILABLE);
  });

  it("errs on a non-zero exit", () => {
    expect(write_probe_error(probe("", 7, "boom"))).toBe("probe command exited 7: 'boom'");
  });

  it("errs on a failed block", () => {
    expect(write_probe_error(probe('block=500 unblock=200 check={"x": true}'))).toContain("block returned HTTP 500");
  });

  it("errs on a failed unblock", () => {
    expect(write_probe_error(probe('block=200 unblock=500 check={"x": true}'))).toContain("unblock returned HTTP 500");
  });

  it("errs on a url not reading back as blocked", () => {
    expect(write_probe_error(probe(`block=200 unblock=200 check={"${probe_url}": false}`))).toContain("did not read back as blocked");
  });

  it("errs on a non-JSON check", () => {
    expect(write_probe_error(probe("block=200 unblock=200 check=<html>oops</html>"))).toContain("not JSON");
  });
});

describe("write probe collection", () => {
  it("records write_ok for a healthy probe", () => {
    const monitor = plugin();
    run_requests(monitor, respond());
    expect(latest_metric(monitor, "write_ok")).toBe(1.0);
    expect(latest_status(monitor)).toBe("online");
  });

  it("fails a failing write though reads are fine", () => {
    const monitor = plugin();
    run_requests(monitor, respond(null, probe("", 1, "database disk image is malformed")));
    expect(latest_status(monitor)).toBe("failed");
    expect(latest_metric(monitor, "write_ok")).toBe(0.0);
    expect(latest_metric(monitor, "domains_total")).toBe(2.0);
  });

  it("ranks a write failure above an empty blocklist warning", () => {
    const monitor = plugin();
    run_requests(monitor, respond(result([]), probe(null, 1)));
    expect(latest_status(monitor)).toBe("failed");
  });

  it("records no write metric with the probe off", () => {
    const monitor = make_plugin(Blockurl, { ...base_config, id: "bu-noprobe", name: "bu-noprobe", write_probe: false });
    run_requests(monitor, () => result());
    expect(latest_status(monitor, "bu-noprobe")).toBe("online");
    expect(latest_metric(monitor, "write_ok", "bu-noprobe")).toBeNull();
  });
});

describe("probe unavailable", () => {
  it("calls a disconnected agent unavailable, not failed", () => {
    const monitor = plugin();
    run_requests(monitor, respond(null, probe("", -1, "Agent 'heimdall' is not connected")));
    expect(latest_status(monitor)).toBe("unavailable");
  });

  it("records no write metric for an unrun probe", () => {
    const monitor = plugin();
    run_requests(monitor, respond(null, probe("", -1, "Agent 'heimdall' is not connected")));
    expect(latest_metric(monitor, "write_ok")).toBeNull();
    expect(latest_metric(monitor, "domains_total")).toBe(2.0);
  });
});

describe("page", () => {
  it("warns on the domains card below the floor", () => {
    const monitor = make_plugin(Blockurl, { ...base_config, min_domains: 5 });
    expect(monitor.domains_color(2)).toBe("warning");
    expect(monitor.domains_color(5)).toBe("online");
    expect(monitor.domains_color(null)).toBeNull();
  });
});
