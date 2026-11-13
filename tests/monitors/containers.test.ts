import { describe, expect, it } from "vitest";

import { cmd_result, http_result, type ActionPlan, type CollectResult, type HttpRequest, type HttpResult } from "../../src/core/connectors/types.ts";
import type { PluginConfig } from "../../src/monitors/base/plugin_helpers.ts";
import { Containers, type ContainerRow } from "../../src/monitors/containers/plugin.ts";
import type { ItemColorRule } from "../../src/shared/ui_spec.ts";
import { make_plugin, run_cycle, run_io_cycle, store_of, type FakeEngine } from "../harness.ts";

const containers = (extra: PluginConfig = {}): Containers => make_plugin(Containers, { name: "test-ctr", id: "test-ctr", ssh_config: { host: "test.host" }, ...extra });
const ps = (...rows: [string, string][]): string => rows.map(([name, state]) => `${name}\t${state}\n`).join("");
const run = (plugin: Containers, stdout: string, code = 0, stderr = "") => run_cycle(plugin, () => cmd_result(code, stdout, stderr));
const latest_status = (plugin: Containers) => store_of(plugin).latest_status("test-ctr");
const latest_metric = (plugin: Containers, name: string) => store_of(plugin).latest_metric("test-ctr", name)?.value ?? null;

describe("collection", () => {
  it("calls all running online", () => {
    const plugin = containers();
    run(plugin, ps(["web", "running"], ["db", "running"]));
    expect(latest_status(plugin)).toBe("online");
    expect(latest_metric(plugin, "containers_running")).toBeCloseTo(2.0);
    expect(latest_metric(plugin, "containers_stopped")).toBeCloseTo(0.0);
  });

  it("warns on a stopped container", () => {
    const plugin = containers();
    run(plugin, ps(["web", "running"], ["db", "exited"]));
    expect(latest_status(plugin)).toBe("warning");
    expect(latest_metric(plugin, "containers_stopped")).toBeCloseTo(1.0);
  });

  it("stays online with the stopped warning off", () => {
    const plugin = containers({ stopped_warning: false });
    run(plugin, ps(["web", "running"], ["db", "exited"]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("fails a missing expected container", () => {
    const plugin = containers({ expect_running: ["db"] });
    run(plugin, ps(["web", "running"], ["db", "exited"]));
    expect(latest_status(plugin)).toBe("failed");
  });

  it("calls expected containers that run online", () => {
    const plugin = containers({ expect_running: ["web", "db"] });
    run(plugin, ps(["web", "running"], ["db", "running"]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("counts paused as benign", () => {
    const plugin = containers();
    run(plugin, ps(["web", "running"], ["job", "paused"]));
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls no containers online", () => {
    const plugin = containers();
    run(plugin, "");
    expect(latest_status(plugin)).toBe("online");
  });

  it("calls a missing runtime unavailable", () => {
    const plugin = containers();
    run(plugin, "", 127, "bash: docker: command not found");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("calls an unreachable host unavailable", () => {
    const plugin = containers();
    run(plugin, "", -1, "Agent 'h' is not connected");
    expect(latest_status(plugin)).toBe("unavailable");
  });

  it("uses the podman runtime", () => {
    const plugin = containers({ runtime: "podman" });
    expect(plugin.commands()[0].text.startsWith("podman ")).toBe(true);
    run(plugin, ps(["web", "running"]));
    expect(latest_status(plugin)).toBe("online");
  });
});

describe("actions", () => {
  it("restarts a listed container", () => {
    const plugin = containers({ expect_running: ["web"] });
    const plan = plugin.plan_action("restart:web") as ActionPlan;
    expect(plan.command).toContain("docker restart");
    expect(plan.command).toContain("web");
    expect(plugin.interpret_action("restart:web", cmd_result(0, "", ""))).toBe(true);
  });

  it("refuses an unlisted container", () => {
    const plan = containers({ expect_running: ["web"] }).plan_action("restart:evil") as CollectResult;
    expect(plan.success).toBe(false);
    expect(plan.logs.length).toBeGreaterThan(0);
  });

  it("lists actions from the expected containers", () => {
    expect(new Set(containers({ expect_running: ["web", "db"] }).get_actions().map((action) => action.action_id))).toEqual(new Set(["restart:web", "restart:db"]));
  });
});

const new_digest = "sha256:" + "b".repeat(64);
const old_digest = "sha256:" + "a".repeat(64);
const hub_challenge = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"';

// Collection output in the inventory script's shape: ps rows, container images, image digests.
function inventory(rows: [string, string][], images: [string, string, string][] = [], digests: [string, string[]][] = []): string {
  let out = ps(...rows) + "@@x-monitor-images\n";
  out += images.map(([name, image, image_id]) => `/${name}\t${image}\tsha256:${image_id}\n`).join("");
  out += "@@x-monitor-digests\n";
  out += digests.map(([image_id, entries]) => `sha256:${image_id}\t${entries.join(" ")}\n`).join("");
  return out;
}

const nginx = (local_digest = old_digest, image = "nginx:latest") => inventory([["web", "running"]], [["web", image, "i1"]], [["i1", [`nginx@${local_digest}`]]]);

// Serves one digest per repository behind Docker Hub's anonymous token challenge.
class FakeHub {
  readonly calls: HttpRequest[] = [];
  readonly digests: Record<string, string>;
  readonly fail: boolean;

  constructor(digests: Record<string, string> = { "library/nginx": new_digest }, fail = false) {
    this.digests = digests;
    this.fail = fail;
  }

  readonly handle = (request: HttpRequest): HttpResult => {
    this.calls.push(request);
    if (this.fail) return http_result(null, "", { error: "connection refused" });
    if (request.url.includes("/token")) return http_result(200, JSON.stringify({ token: "tok" }));
    if ((request.headers ?? {}).Authorization !== "Bearer tok") return http_result(401, "", { headers: { "www-authenticate": hub_challenge } });
    const repository = request.url.split("/v2/")[1].split("/manifests/")[0];
    if (!(repository in this.digests)) return http_result(404, "");
    return http_result(200, "", { headers: { "docker-content-digest": this.digests[repository] } });
  };

  manifest_calls(): HttpRequest[] {
    return this.calls.filter((call) => call.url.includes("/manifests/") && "Authorization" in (call.headers ?? {}));
  }
}

async function check(plugin: Containers, hub: FakeHub): Promise<CollectResult> {
  (plugin.engine as FakeEngine).http_fetch_handler = hub.handle;
  expect(plugin.io_call()).not.toBeNull();
  return run_io_cycle(plugin);
}

const rows_of = (plugin: Containers) => Object.fromEntries((plugin.data.latest_snapshot<ContainerRow[]>([]) ?? []).map((row) => [row.name, row]));

describe("inventory", () => {
  it("reads images and digests when update checks are on", () => {
    const text = containers().commands()[0].text;
    expect(text).toContain("container inspect");
    expect(text).toContain("{{.Config.Image}}");
    expect(text).toContain("image inspect");
    expect(text).toContain("{{join .RepoDigests");
    expect(text).toContain("|| exit");
    expect(text.endsWith("true")).toBe(true);
  });

  it("reads the podman image name", () => {
    const text = containers({ runtime: "podman" }).commands()[0].text;
    expect(text).toContain("{{.ImageName}}");
    expect(text).not.toContain("{{.Config.Image}}");
  });

  it("runs plain ps when update checks are off", () => {
    expect(containers({ update_check_interval: 0 }).commands()[0].text).toBe("docker ps -a --format '{{.Names}}\t{{.State}}' 2>&1");
  });

  it("samples only without update checks", () => {
    expect(containers().subscriptions()).toEqual([]);
    expect(containers({ update_check_interval: 0 }).subscriptions().map((stream) => stream.kind)).toEqual(["sample"]);
  });

  it("carries the image and a pending update in the rows", () => {
    const plugin = containers();
    const result = run(plugin, nginx());
    const row = rows_of(plugin).web;
    expect(row.image).toBe("nginx:latest");
    expect(row.state).toBe("running");
    expect(row.update).toBe("Not checked yet");
    expect("images_update_available" in result.metrics).toBe(false);
    expect(latest_status(plugin)).toBe("online");
  });

  it("leaves the update column out when checks are off", () => {
    const plugin = containers({ update_check_interval: 0 });
    run(plugin, ps(["web", "running"]));
    expect(rows_of(plugin).web).toEqual({ name: "web", state: "running", image: "--" });
  });

  it("tolerates missing image sections", () => {
    const plugin = containers();
    run(plugin, ps(["web", "running"]));
    expect(rows_of(plugin).web.update).toBe("Unknown");
    expect(plugin.io_call()).toBeNull();
  });

  it("checks neither pinned nor local images", () => {
    const plugin = containers();
    run(plugin, inventory([["pinned", "running"], ["built", "running"]], [["pinned", `nginx@${old_digest}`, "i1"], ["built", "myapp:dev", "i2"]], [["i1", [`nginx@${old_digest}`]], ["i2", []]]));
    const rows = rows_of(plugin);
    expect(rows.pinned.update).toBe("Pinned by digest");
    expect(rows.built.update).toBe("Local image");
    expect(plugin.io_call()).toBeNull();
  });
});

describe("update check", () => {
  it("finds an update", async () => {
    const plugin = containers();
    run(plugin, nginx(old_digest));
    const result = await check(plugin, new FakeHub());
    expect(result.metrics.images_update_available).toBe(1.0);
    expect(latest_metric(plugin, "images_update_available")).toBeCloseTo(1.0);
    expect(rows_of(plugin).web.update).toBe("Update available");
    expect(latest_status(plugin)).toBe("online");
    expect(result.logs.some(([message]) => message.includes("docker.io/library/nginx:latest"))).toBe(true);
  });

  it("finds an image up to date", async () => {
    const plugin = containers();
    run(plugin, nginx(new_digest));
    const result = await check(plugin, new FakeHub());
    expect(result.metrics.images_update_available).toBe(0.0);
    expect(rows_of(plugin).web.update).toBe("Up to date");
  });

  it("warns on updates only when asked", async () => {
    const plugin = containers({ update_warning: true });
    run(plugin, nginx(old_digest));
    await check(plugin, new FakeHub());
    expect(latest_status(plugin)).toBe("warning");
    run(plugin, nginx(old_digest));
    expect(latest_status(plugin)).toBe("warning");
  });

  it("stays failed for a missing expected container on a check cycle", async () => {
    const plugin = containers({ expect_running: ["db"] });
    run(plugin, nginx(old_digest));
    await check(plugin, new FakeHub());
    expect(latest_status(plugin)).toBe("failed");
  });

  it("only logs a registry failure", async () => {
    const plugin = containers({ update_warning: true });
    run(plugin, nginx(old_digest));
    const result = await check(plugin, new FakeHub(undefined, true));
    expect(latest_status(plugin)).toBe("online");
    expect(result.metrics.images_update_available).toBe(0.0);
    expect(rows_of(plugin).web.update).toBe("Check failed");
    expect(result.logs.some(([message, level]) => level === "WARNING" && message.includes("connection refused"))).toBe(true);
  });

  it("keeps the last known digest through a failed check", async () => {
    const plugin = containers({ update_check_interval: "1s" });
    run(plugin, nginx(old_digest));
    await check(plugin, new FakeHub());
    plugin.next_check = 0;
    await check(plugin, new FakeHub(undefined, true));
    expect(rows_of(plugin).web.update).toBe("Update available");
  });

  it("calls a re-pull current without a new check", async () => {
    const plugin = containers();
    run(plugin, nginx(old_digest));
    await check(plugin, new FakeHub());
    const result = run(plugin, nginx(new_digest));
    expect(rows_of(plugin).web.update).toBe("Up to date");
    expect(result.metrics.images_update_available).toBe(0.0);
  });

  it("waits for its interval between checks", async () => {
    const plugin = containers({ update_check_interval: "6h" });
    expect(plugin.io_call()).toBeNull();
    run(plugin, nginx(old_digest));
    await check(plugin, new FakeHub());
    expect(plugin.io_call()).toBeNull();
    expect(plugin.next_check).toBeGreaterThan(performance.now() / 1000 + 5 * 3600);
    plugin.next_check = performance.now() / 1000 - 1;
    expect(plugin.io_call()).not.toBeNull();
  });

  it("looks up each distinct image once", async () => {
    const plugin = containers();
    run(plugin, inventory([["a", "running"], ["b", "exited"], ["c", "running"]], [["a", "nginx:latest", "i1"], ["b", "docker.io/library/nginx:latest", "i1"], ["c", "redis:7", "i2"]], [["i1", [`nginx@${old_digest}`]], ["i2", [`redis@${new_digest}`]]]));
    const hub = new FakeHub({ "library/nginx": new_digest, "library/redis": new_digest });
    const result = await check(plugin, hub);
    expect(hub.manifest_calls()).toHaveLength(2);
    expect(result.metrics.images_update_available).toBe(1.0);
    const rows = rows_of(plugin);
    expect(rows.a.update).toBe("Update available");
    expect(rows.b.update).toBe("Update available");
    expect(rows.c.update).toBe("Up to date");
  });

  it("tells a container on an older image than the tag", async () => {
    const plugin = containers();
    run(plugin, inventory([["old", "running"], ["new", "running"]], [["old", "nginx:latest", "i1"], ["new", "nginx:latest", "i2"]], [["i1", [`nginx@${old_digest}`]], ["i2", [`nginx@${new_digest}`]]]));
    await check(plugin, new FakeHub());
    const rows = rows_of(plugin);
    expect(rows.old.update).toBe("Update available");
    expect(rows.new.update).toBe("Up to date");
  });

  it("reads registry credentials from config", () => {
    const plugin = containers({ registries: { "index.docker.io": { username: "robot", password: "pw" }, "registry.example.com:5000": { username: "u", password_command: "echo secret", insecure: true } } });
    expect(plugin.registries["docker.io"].basic).toEqual(["robot", "pw"]);
    const example = plugin.registries["registry.example.com:5000"];
    expect(example.basic).toEqual(["u", "secret"]);
    expect(example.insecure).toBe(true);
  });

  it("adds the update column and card", () => {
    const on = containers().UI_SPEC;
    expect("updates_card" in on.cards!).toBe(true);
    expect(on.tables!.containers.columns!.at(-1)!.name).toBe("update");
    const off = containers({ update_check_interval: 0 }).UI_SPEC;
    expect("updates_card" in off.cards!).toBe(false);
    expect(off.tables!.containers.columns!.map((column) => column.name)).not.toContain("update");
  });

  it("colors an update cell warning", () => {
    const rule = containers().UI_SPEC.tables!.containers.columns!.at(-1)!.cell_color_by as ItemColorRule;
    expect(rule({ update_state: "available" })).toBe("warning");
    expect(rule({ update_state: "current" })).toBeNull();
  });
});

const docker_prune_output = `Deleted Containers:
4a7f7eebae0f
1f3b5c2d9e8a

Deleted Networks:
old_default

Deleted Images:
untagged: nginx@sha256:aaaa
deleted: sha256:bbbb
deleted: sha256:cccc

Total reclaimed space: 1.2GB
`;

const podman_prune_output = `Deleted Containers
4a7f7eebae0f
Deleted Pods
Deleted Images
9f8e7d6c5b4a
Total reclaimed space: 300MB
`;

// Fills a confirm template as the page does: {plugin.<attr>} from the plugin, and doubled braces made single.
function substitute(template: string, plugin: Containers): string {
  return template.replace(/\{\{|\}\}|\{plugin\.(\w+)\}/g, (match, attr: string | undefined) => (match === "{{" ? "{" : match === "}}" ? "}" : String((plugin as unknown as Record<string, unknown>)[attr!])));
}

describe("prune", () => {
  it("runs the default prune command", () => {
    const plan = containers().plan_action("prune") as ActionPlan;
    expect(plan.command).toBe("docker system prune -f 2>&1");
    expect(plan.timeout).toBeGreaterThanOrEqual(300);
  });

  it("runs detached", () => expect((containers().plan_action("prune") as ActionPlan).detached).toBe(true));

  it("takes its flags from config", () => {
    expect((containers({ runtime: "podman", prune_volumes: true, prune_all_images: true }).plan_action("prune") as ActionPlan).command).toBe("podman system prune -f -a --volumes 2>&1");
  });

  it("summarises docker's output", () => {
    const outcome = containers().interpret_action("prune", cmd_result(0, docker_prune_output, "")) as CollectResult;
    expect(outcome.success).toBe(true);
    const summary = outcome.metadata.content;
    expect(summary).toBe("Reclaimed 1.2GB (containers: 2, networks: 1, images: 2)");
    expect(outcome.status).toBeNull();
    expect(outcome.logs).toEqual([[`Ran \`docker system prune -f\`: ${summary}`, "INFO"]]);
  });

  it("summarises podman's output", () => {
    expect((containers({ runtime: "podman" }).interpret_action("prune", cmd_result(0, podman_prune_output, "")) as CollectResult).metadata.content).toBe("Reclaimed 300MB (containers: 1, images: 1)");
  });

  it("says when there was nothing to prune", () => {
    expect((containers().interpret_action("prune", cmd_result(0, "Total reclaimed space: 0B\n", "")) as CollectResult).metadata.content).toBe("Reclaimed 0B");
  });

  it("logs a failed prune without changing the status", () => {
    const plugin = containers();
    run(plugin, ps(["web", "running"]));
    const outcome = plugin.interpret_action("prune", cmd_result(1, "Error response from daemon: a prune operation is already running", "")) as CollectResult;
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.metadata.content).toContain("already running");
    expect(outcome.logs[0][1]).toBe("ERROR");
    store_of(plugin).apply_result(plugin.target, plugin.id, plugin.name, outcome);
    expect(latest_status(plugin)).toBe("online");
  });

  it("confirms what the prune deletes", () => {
    const plugin = containers({ prune_volumes: true, prune_all_images: true });
    const button = plugin.UI_SPEC.buttons!.tools[0];
    expect(button.id).toBe("prune");
    expect(button.color).toBe("negative");
    const text = substitute(button.confirm!, plugin);
    expect(text).toContain("docker system prune -f -a --volumes");
    expect(text).toContain("every image no container uses");
    expect(text).toContain("every volume");
    expect(plugin.UI_SPEC.layout).toContainEqual(["tools"]);
  });

  it("names dangling images only by default", () => {
    const plugin = containers();
    const text = substitute(plugin.UI_SPEC.buttons!.tools[0].confirm!, plugin);
    expect(text).toContain("dangling images");
    expect(text).not.toContain("volume");
  });
});

describe("page", () => {
  it("shares one bar between running and stopped containers", () => {
    const spec = containers().UI_SPEC;
    const card = spec.cards!.running_card;
    expect(card.kind).toBe("share");
    expect(card.parts!.map((part) => [part.metric, part.color])).toEqual([["containers_running", "online"], ["containers_stopped", "warning"]]);
    expect("stopped_card" in spec.cards!).toBe(false);
    expect(spec.layout!.some((row) => row.includes("stopped_card"))).toBe(false);
    expect(spec.layout).toContainEqual(["containers"]);
  });
});
