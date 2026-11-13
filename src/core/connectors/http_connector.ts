// The HTTP connector: runs a monitor's HttpRequest with fetch and hands back an HttpResult, so no monitor touches the
// network itself. Redirects are followed, as the Python app's client did.

import { http_result, type HttpRequest, type HttpResult } from "./types.ts";

export const DEFAULT_TIMEOUT = 10.0;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// The message a failed fetch carries: its cause's when node gives one, as "fetch failed" alone says nothing.
function error_text(error: unknown): string {
  const failure = error as Error & { cause?: unknown };
  if (failure.name === "TimeoutError") return "timed out";
  const cause = failure.cause as (Error & { code?: string }) | undefined;
  if (cause && typeof cause === "object") return cause.message || cause.code || failure.message || failure.name;
  return failure.message || failure.name || "Error";
}

export class HttpConnector {
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher = (url, init) => fetch(url, init)) {
    this.fetcher = fetcher;
  }

  async fetch(request: HttpRequest): Promise<HttpResult> {
    const timeout = request.timeout ?? DEFAULT_TIMEOUT;
    const headers: Record<string, string> = { ...request.headers };
    if (request.auth) headers.authorization = `Basic ${Buffer.from(`${request.auth[0]}:${request.auth[1]}`, "utf8").toString("base64")}`;
    const started = performance.now();
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers,
        body: request.body ?? undefined,
        redirect: "follow",
        signal: AbortSignal.timeout(timeout * 1000),
      });
      text = request.method.toUpperCase() === "HEAD" ? "" : await response.text();
    } catch (error) {
      return http_result(null, "", { error: error_text(error) });
    }
    const elapsed_ms = performance.now() - started;
    const response_headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      response_headers[name.toLowerCase()] = value;
    });
    return http_result(response.status, text, { elapsed_ms, headers: response_headers });
  }

  // Nothing to close: fetch pools its own connections.
  close(): void {}
}
