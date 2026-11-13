import { describe, expect, it } from "vitest";

import { http_result, type HttpRequest, type HttpResult } from "../../src/core/connectors/types.ts";
import { check_images, local_digests, MANIFEST_ACCEPT, parse_challenge, parse_reference, RegistryAuth, remote_digest, type ImageRef } from "../../src/monitors/containers/registry.ts";

const new_digest = "sha256:" + "b".repeat(64);
const old_digest = "sha256:" + "a".repeat(64);
const hub_challenge = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"';

const ref = (text: string): ImageRef => parse_reference(text)!;

// Answers manifest requests like a registry behind a bearer-token challenge.
class FakeRegistry {
  readonly calls: HttpRequest[] = [];
  readonly digest: string;
  readonly challenge: string | null;
  readonly token: string;
  readonly status: number;
  readonly head_digest: boolean;

  constructor({ digest = new_digest, challenge = hub_challenge as string | null, token = "tok", status = 200, head_digest = true } = {}) {
    this.digest = digest;
    this.challenge = challenge;
    this.token = token;
    this.status = status;
    this.head_digest = head_digest;
  }

  readonly fetch = async (request: HttpRequest): Promise<HttpResult> => {
    this.calls.push(request);
    if (request.url.includes("/token")) return http_result(200, JSON.stringify({ token: this.token }));
    const authorization = (request.headers ?? {}).Authorization;
    if (this.challenge && authorization !== `Bearer ${this.token}` && request.auth === null) return http_result(401, "", { headers: { "www-authenticate": this.challenge } });
    if (this.status !== 200) return http_result(this.status, "");
    if (request.method === "HEAD" && !this.head_digest) return http_result(200, "");
    return http_result(200, "{}", { headers: { "docker-content-digest": this.digest } });
  };
}

describe("parse reference", () => {
  it.each([
    ["nginx", "docker.io/library/nginx:latest"],
    ["nginx:1.25", "docker.io/library/nginx:1.25"],
    ["someone/app:2", "docker.io/someone/app:2"],
    ["docker.io/library/nginx:alpine", "docker.io/library/nginx:alpine"],
    ["index.docker.io/library/nginx", "docker.io/library/nginx:latest"],
    ["ghcr.io/owner/repo:stable", "ghcr.io/owner/repo:stable"],
    ["quay.io/prometheus/node-exporter", "quay.io/prometheus/node-exporter:latest"],
    ["localhost:5000/app", "localhost:5000/app:latest"],
    ["registry.example.com:5000/team/app:1.2", "registry.example.com:5000/team/app:1.2"],
  ])("normalises %s to %s", (text, key) => expect(ref(text).key).toBe(key));

  it("names Docker Hub's API host", () => {
    expect(ref("nginx").api_host).toBe("registry-1.docker.io");
    expect(ref("ghcr.io/o/r").api_host).toBe("ghcr.io");
  });

  it("reads a digest pin", () => {
    const pinned = ref(`nginx@${old_digest}`);
    expect(pinned.digest).toBe(old_digest);
    expect(pinned.tag).toBeNull();
  });

  it("reads a tag and a digest", () => {
    const pinned = ref(`nginx:1.25@${old_digest}`);
    expect(pinned.digest).toBe(old_digest);
    expect(pinned.tag).toBe("1.25");
  });

  it.each(["", "   ", "a".repeat(64), "sha256:" + "c".repeat(64)])("refuses %j", (text) => expect(parse_reference(text)).toBeNull());
});

describe("local digests", () => {
  it("matches the same repository in any spelling", () => {
    const entries = [`nginx@${old_digest}`, `docker.io/library/nginx@${new_digest}`, `ghcr.io/x/nginx@sha256:${"d".repeat(64)}`];
    expect(local_digests(entries, ref("nginx:latest"))).toEqual(new Set([old_digest, new_digest]));
  });

  it("ignores another repository", () => expect(local_digests([`redis@${old_digest}`], ref("nginx"))).toEqual(new Set()));
});

describe("parse challenge", () => {
  it("reads a bearer challenge", () => {
    const [kind, params] = parse_challenge(hub_challenge);
    expect(kind).toBe("bearer");
    expect(params.realm).toBe("https://auth.docker.io/token");
    expect(params.service).toBe("registry.docker.io");
  });

  it("reads an empty header", () => expect(parse_challenge("")).toEqual(["", {}]));
});

describe("remote digest", () => {
  it("follows the anonymous bearer flow", async () => {
    const registry = new FakeRegistry();
    const found = await remote_digest(registry.fetch, ref("nginx"), null, 5);
    expect(found.digest).toBe(new_digest);
    expect(found.error).toBeNull();
    const [head, token, retry] = registry.calls;
    expect(head.method).toBe("HEAD");
    expect(head.url).toBe("https://registry-1.docker.io/v2/library/nginx/manifests/latest");
    expect(head.headers!.Accept).toBe(MANIFEST_ACCEPT);
    expect(MANIFEST_ACCEPT).toContain("application/vnd.oci.image.index.v1+json");
    expect(token.url.startsWith("https://auth.docker.io/token?")).toBe(true);
    expect(token.url).toContain("service=registry.docker.io");
    expect(token.url).toContain("scope=repository%3Alibrary%2Fnginx%3Apull");
    expect(token.auth).toBeNull();
    expect(retry.headers!.Authorization).toBe("Bearer tok");
  });

  it("builds the scope when the challenge omits it", async () => {
    const registry = new FakeRegistry({ challenge: 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' });
    await remote_digest(registry.fetch, ref("ghcr.io/owner/repo:1"), null, 5);
    expect(registry.calls[1].url).toContain("scope=repository%3Aowner%2Frepo%3Apull");
  });

  it("sends credentials to the token realm", async () => {
    const registry = new FakeRegistry();
    await remote_digest(registry.fetch, ref("nginx"), new RegistryAuth("robot", "secret"), 5);
    expect(registry.calls[1].auth).toEqual(["robot", "secret"]);
  });

  it("retries a basic challenge with credentials", async () => {
    const registry = new FakeRegistry({ challenge: 'Basic realm="registry"' });
    const found = await remote_digest(registry.fetch, ref("registry.example.com/app:1"), new RegistryAuth("u", "p"), 5);
    expect(found.digest).toBe(new_digest);
    expect(registry.calls.at(-1)!.auth).toEqual(["u", "p"]);
  });

  it("reports a basic challenge without credentials", async () => {
    const found = await remote_digest(new FakeRegistry({ challenge: 'Basic realm="registry"' }).fetch, ref("registry.example.com/app:1"), null, 5);
    expect(found.digest).toBeNull();
    expect(found.error).toContain("401");
  });

  it("uses http for an insecure registry", async () => {
    const registry = new FakeRegistry({ challenge: null });
    await remote_digest(registry.fetch, ref("localhost:5000/app"), new RegistryAuth(null, null, true), 5);
    expect(registry.calls[0].url).toBe("http://localhost:5000/v2/app/manifests/latest");
  });

  it("falls back to GET when HEAD lacks the digest", async () => {
    const registry = new FakeRegistry({ head_digest: false });
    const found = await remote_digest(registry.fetch, ref("nginx"), null, 5);
    expect(found.digest).toBe(new_digest);
    expect(registry.calls.at(-1)!.method).toBe("GET");
    expect(registry.calls.at(-1)!.headers!.Authorization).toBe("Bearer tok");
  });

  it.each([[404, "not found"], [429, "rate limit"], [500, "HTTP 500"]])("names HTTP %d", async (status, text) => {
    const found = await remote_digest(new FakeRegistry({ status }).fetch, ref("nginx"), null, 5);
    expect(found.digest).toBeNull();
    expect(found.error).toContain(text);
    expect(found.reachable).toBe(true);
  });

  it("reports a failed token request", async () => {
    const fetch = async (request: HttpRequest) => (request.url.includes("/token") ? http_result(403, "no") : http_result(401, "", { headers: { "www-authenticate": hub_challenge } }));
    const found = await remote_digest(fetch, ref("nginx"), null, 5);
    expect(found.digest).toBeNull();
    expect(found.error).toContain("token request");
  });

  it("reports a token response that is not JSON", async () => {
    const fetch = async (request: HttpRequest) => (request.url.includes("/token") ? http_result(200, "<html>") : http_result(401, "", { headers: { "www-authenticate": hub_challenge } }));
    expect((await remote_digest(fetch, ref("nginx"), null, 5)).error).toContain("not JSON");
  });

  it("accepts an access_token field", async () => {
    const fetch = async (request: HttpRequest) => {
      if (request.url.includes("/token")) return http_result(200, JSON.stringify({ access_token: "at" }));
      if ((request.headers ?? {}).Authorization === "Bearer at") return http_result(200, "", { headers: { "docker-content-digest": new_digest } });
      return http_result(401, "", { headers: { "www-authenticate": hub_challenge } });
    };
    expect((await remote_digest(fetch, ref("nginx"), null, 5)).digest).toBe(new_digest);
  });

  it("reports an unreachable registry", async () => {
    const found = await remote_digest(async () => http_result(null, "", { error: "connection refused" }), ref("nginx"), null, 5);
    expect(found.reachable).toBe(false);
    expect(found.error).toContain("connection refused");
  });
});

describe("check images", () => {
  it("skips only an unreachable registry's other images", async () => {
    const calls: string[] = [];
    const fetch = async (request: HttpRequest) => {
      calls.push(request.url);
      if (request.url.includes("registry.example.com")) return http_result(null, "", { error: "timeout" });
      return http_result(200, "", { headers: { "docker-content-digest": new_digest } });
    };
    const found = await check_images(fetch, ["registry.example.com/a:1", "registry.example.com/b:1", "ghcr.io/o/r:1"].map(ref), {}, 5);
    expect(calls.filter((url) => url.includes("registry.example.com"))).toHaveLength(1);
    expect(found["registry.example.com/b:1"].error).toContain("skipped");
    expect(found["ghcr.io/o/r:1"].digest).toBe(new_digest);
  });

  it("costs only its own image on an exception", async () => {
    const fetch = async (request: HttpRequest) => {
      if (request.url.includes("broken")) throw new Error("bad header");
      return http_result(200, "", { headers: { "docker-content-digest": new_digest } });
    };
    const found = await check_images(fetch, [ref("ghcr.io/o/broken:1"), ref("ghcr.io/o/fine:1")], {}, 5);
    expect(found["ghcr.io/o/broken:1"].error).toContain("bad header");
    expect(found["ghcr.io/o/fine:1"].digest).toBe(new_digest);
  });

  it("chooses credentials by registry", async () => {
    const registry = new FakeRegistry({ challenge: 'Basic realm="r"' });
    const found = await check_images(registry.fetch, [ref("registry.example.com/app:1")], { "registry.example.com": new RegistryAuth("u", "p") }, 5);
    expect(found["registry.example.com/app:1"].digest).toBe(new_digest);
  });
});
