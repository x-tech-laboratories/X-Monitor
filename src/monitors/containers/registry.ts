// Image references and the registry lookup behind the containers plugin's update detection. parse_reference() reads an
// image reference the way docker does (Docker Hub's `library/` prefix included); remote_digest() asks the registry's v2
// API for a tag's current manifest digest, answering a 401 with the anonymous or credentialed bearer-token flow its
// challenge names. Every request goes through the engine's HTTP connector via the fetch function.

import { http_request, type HttpRequest, type HttpResult } from "../../core/connectors/types.ts";

export const DOCKER_HUB = "docker.io";
const docker_hub_api = "registry-1.docker.io";
const docker_hub_aliases = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

// A tag may point at a multi-arch index or a single manifest, so every kind is accepted.
export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

const image_id_pattern = /^(sha256:)?[0-9a-f]{64}$/;
const challenge_param_pattern = /(\w+)="([^"]*)"/g;

export type Fetch = (request: HttpRequest) => Promise<HttpResult>;

// ── References ───────────────────────────────────────────────────────────────

export class ImageRef {
  readonly registry: string;
  readonly repository: string;
  readonly tag: string | null;
  readonly digest: string | null;

  constructor(registry: string, repository: string, tag: string | null, digest: string | null) {
    this.registry = registry;
    this.repository = repository;
    this.tag = tag;
    this.digest = digest;
  }

  // The registry and repository, the part RepoDigests entries share with the reference.
  get name(): string {
    return `${this.registry}/${this.repository}`;
  }

  // The normalised reference, used to cache one lookup per tag.
  get key(): string {
    return this.digest ? `${this.name}@${this.digest}` : `${this.name}:${this.tag}`;
  }

  get api_host(): string {
    return this.registry === DOCKER_HUB ? docker_hub_api : this.registry;
  }
}

export class RegistryAuth {
  readonly username: string | null;
  readonly password: string | null;
  readonly insecure: boolean;

  constructor(username: string | null = null, password: string | null = null, insecure = false) {
    this.username = username;
    this.password = password;
    this.insecure = insecure;
  }

  get basic(): readonly [string, string] | null {
    return this.username ? [this.username, this.password || ""] : null;
  }
}

export interface RemoteDigest {
  digest: string | null;
  error: string | null;
  reachable: boolean;
}

function remote(fields: Partial<RemoteDigest>): RemoteDigest {
  return { digest: fields.digest ?? null, error: fields.error ?? null, reachable: fields.reachable ?? true };
}

// A registry host as references name it, with Docker Hub's aliases folded to docker.io.
export function normalise_registry(host: string): string {
  const lowered = host.trim().toLowerCase();
  return docker_hub_aliases.has(lowered) ? DOCKER_HUB : lowered;
}

// `[registry/]repo[:tag][@digest]` as a reference, or null for a bare image id or an empty string.
export function parse_reference(raw: string | null | undefined): ImageRef | null {
  let ref = (raw || "").trim();
  if (!ref || image_id_pattern.test(ref)) return null;
  let digest: string | null = null;
  if (ref.includes("@")) [ref, digest] = [ref.slice(0, ref.indexOf("@")), ref.slice(ref.indexOf("@") + 1)];
  let tag: string | null = null;
  if (ref.slice(ref.lastIndexOf("/") + 1).includes(":")) [ref, tag] = [ref.slice(0, ref.lastIndexOf(":")), ref.slice(ref.lastIndexOf(":") + 1)];
  const slash = ref.indexOf("/");
  const first = slash === -1 ? ref : ref.slice(0, slash);
  let registry: string;
  let repository: string;
  if (slash !== -1 && (first.includes(".") || first.includes(":") || first === "localhost")) [registry, repository] = [normalise_registry(first), ref.slice(slash + 1)];
  else [registry, repository] = [DOCKER_HUB, ref];
  if (registry === DOCKER_HUB && !repository.includes("/")) repository = `library/${repository}`;
  if (!repository) return null;
  if (tag === null && digest === null) tag = "latest";
  return new ImageRef(registry, repository.toLowerCase(), tag, digest);
}

// The manifest digests an image's RepoDigests record for the same repository as `ref`.
export function local_digests(repo_digests: Iterable<string>, ref: ImageRef): Set<string> {
  const digests = new Set<string>();
  for (const entry of repo_digests) {
    const parsed = parse_reference(entry);
    if (parsed && parsed.digest && parsed.name === ref.name) digests.add(parsed.digest);
  }
  return digests;
}

// A WWW-Authenticate header's lower-cased scheme and its quoted parameters.
export function parse_challenge(header: string | null | undefined): [scheme: string, params: Record<string, string>] {
  const text = (header || "").trim();
  const space = text.indexOf(" ");
  const scheme = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? "" : text.slice(space + 1);
  return [scheme.toLowerCase(), Object.fromEntries([...rest.matchAll(challenge_param_pattern)].map((match) => [match[1], match[2]]))];
}

// A query string as Python's urlencode writes it, with quote_plus escaping.
function urlencode(query: Record<string, string>): string {
  const quote_plus = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%20", "+");
  return Object.entries(query).map(([key, value]) => `${quote_plus(key)}=${quote_plus(value)}`).join("&");
}

// ── Lookups ──────────────────────────────────────────────────────────────────

// The token, or why not, from the realm a bearer challenge names.
async function bearer_token(fetch: Fetch, params: Record<string, string>, ref: ImageRef, auth: RegistryAuth | null, timeout: number): Promise<[token: string | null, error: string | null]> {
  const realm = params.realm;
  const query: Record<string, string> = {};
  if (params.service) query.service = params.service;
  const scope = params.scope || `repository:${ref.repository}:pull`;
  if (scope) query.scope = scope;
  const url = realm + (realm.includes("?") ? "&" : "?") + urlencode(query);
  const response = await fetch(http_request(url, { auth: auth ? auth.basic : null, timeout }));
  if (response.status_code !== 200) {
    const why = response.status_code === null ? response.error : `HTTP ${response.status_code}`;
    return [null, `token request for ${ref.key} failed: ${why}`];
  }
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    return [null, `token response for ${ref.key} was not JSON`];
  }
  const record = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const token = record ? record.token || record.access_token : null;
  if (!token) return [null, `token response for ${ref.key} carried no token`];
  return [String(token), null];
}

function http_problem(status: number | null): string {
  if (status === 401) return "registry refused access (HTTP 401): the repository is private or missing; set credentials under registries";
  if (status === 404) return "tag not found in the registry (HTTP 404)";
  if (status === 429) return "registry rate limit reached (HTTP 429)";
  return `registry answered HTTP ${status}`;
}

// The digest the registry serves for `ref`'s tag now, from a HEAD's Docker-Content-Digest header, with a GET as
// fallback for registries that leave it off a HEAD.
export async function remote_digest(fetch: Fetch, ref: ImageRef, auth: RegistryAuth | null, timeout: number): Promise<RemoteDigest> {
  const scheme = auth && auth.insecure ? "http" : "https";
  let request = http_request(`${scheme}://${ref.api_host}/v2/${ref.repository}/manifests/${ref.tag}`, { method: "HEAD", headers: { Accept: MANIFEST_ACCEPT }, timeout });
  let response = await fetch(request);
  if (response.status_code === 401) {
    const [kind, params] = parse_challenge(response.headers["www-authenticate"] ?? "");
    if (kind === "bearer" && params.realm) {
      const [token, error] = await bearer_token(fetch, params, ref, auth, timeout);
      if (token === null) return remote({ error });
      request = { ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } };
      response = await fetch(request);
    } else if (kind === "basic" && auth && auth.basic) {
      request = { ...request, auth: auth.basic };
      response = await fetch(request);
    }
  }
  if (response.status_code === null) return remote({ error: `${ref.api_host} unreachable: ${response.error}`, reachable: false });
  if (response.status_code === 200 && !response.headers["docker-content-digest"]) response = await fetch({ ...request, method: "GET" });
  if (response.status_code !== 200) return remote({ error: `${ref.key}: ${http_problem(response.status_code)}` });
  const digest = response.headers["docker-content-digest"];
  if (!digest) return remote({ error: `${ref.key}: registry sent no Docker-Content-Digest` });
  return remote({ digest });
}

// Each reference looked up in turn, keyed by ImageRef.key, skipping the rest of a registry's references once it proves
// unreachable.
export async function check_images(fetch: Fetch, refs: readonly ImageRef[], auths: Record<string, RegistryAuth>, timeout: number): Promise<Record<string, RemoteDigest>> {
  const results: Record<string, RemoteDigest> = {};
  const down = new Set<string>();
  for (const ref of refs) {
    if (down.has(ref.registry)) {
      results[ref.key] = remote({ error: `${ref.api_host} unreachable, skipped`, reachable: false });
      continue;
    }
    let found: RemoteDigest;
    // One malformed registry answer must not cost the other images their check.
    try {
      found = await remote_digest(fetch, ref, auths[ref.registry] ?? null, timeout);
    } catch (error) {
      const failure = error as Error;
      found = remote({ error: `${ref.key}: ${failure.name}: ${failure.message}` });
    }
    if (!found.reachable) down.add(ref.registry);
    results[ref.key] = found;
  }
  return results;
}
