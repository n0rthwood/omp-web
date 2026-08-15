import { isProxyablePath } from "./proxy-allowlist";
import type { StoredMachine } from "./machine-store";

/**
 * Forwards one request to a remote omp-web machine's API. Never buffers the
 * body in either direction; the caller's abort signal is forwarded so SSE
 * subscriptions, heartbeats and fs.watch handles on the remote are released
 * the moment the gateway client disconnects.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Only these caller headers may reach the remote. */
const FORWARDED_HEADER_NAMES: Record<string, true> = {
  "accept": true,
  "content-type": true,
  "range": true,
};

/** Response headers passed through from the remote. */
const PASSTHROUGH_RESPONSE_HEADERS: Record<string, true> = {
  "content-type": true,
  "content-length": true,
  "content-range": true,
  "accept-ranges": true,
  "content-disposition": true,
  "etag": true,
  "last-modified": true,
  "cache-control": true,
};

/** Bound on connect+headers for the upstream fetch; cleared once headers arrive, so streaming bodies are never cut off. */
const UPSTREAM_HEADER_TIMEOUT_MS = 10_000;

/** Cap on reading a rejected (401/403) upstream body — a hostile remote must not be able to OOM the gateway. */
const REJECTED_BODY_READ_LIMIT = 16 * 1024;

function errorResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}

/** The machine's own credential — replaces anything the caller sent. */
export function authHeader(machine: StoredMachine): Record<string, string> {
  if (machine.authMode === "bearer" && machine.token) {
    return { authorization: `Bearer ${machine.token}` };
  }
  if (machine.authMode === "basic" && machine.token) {
    const username = machine.username ?? "omp";
    return {
      authorization: `Basic ${Buffer.from(`${username}:${machine.token}`).toString("base64")}`,
    };
  }
  return {};
}

function buildOutboundHeaders(machine: StoredMachine, request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (Object.hasOwn(FORWARDED_HEADER_NAMES, name.toLowerCase())) headers.set(name, value);
  }
  // Compression through the proxy would break SSE streaming and range requests;
  // ask the remote for the identity encoding.
  headers.set("accept-encoding", "identity");
  for (const [name, value] of Object.entries({ ...authHeader(machine), ...machine.headers })) {
    headers.set(name, value);
  }
  return headers;
}

function buildUpstreamResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of Object.keys(PASSTHROUGH_RESPONSE_HEADERS)) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    headers.set("cache-control", "no-cache, no-transform");
    headers.set("x-accel-buffering", "no");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * A rejected (401/403) remote: pass its status through, plus the JSON body when
 * it is small and parseable (the remote's own error message), plus the
 * `machine_unauthorized` hint. Anything unreadable gets the fixed body.
 */
async function buildRejectedResponse(upstream: Response): Promise<Response> {
  const lengthHeader = upstream.headers.get("content-length");
  const length = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  if (!Number.isFinite(length) || length <= 0 || length > REJECTED_BODY_READ_LIMIT) {
    return errorResponse(upstream.status, {
      error: "Machine rejected the stored credential",
      code: "machine_unauthorized",
    });
  }
  try {
    const parsed: unknown = JSON.parse(await upstream.text());
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return new Response(
      JSON.stringify({ ...parsed, code: "machine_unauthorized" }),
      { status: upstream.status, headers: { "Content-Type": "application/json", ...NO_STORE } },
    );
  } catch {
    return errorResponse(upstream.status, {
      error: "Machine rejected the stored credential",
      code: "machine_unauthorized",
    });
  }
}

/**
 * Proxy `request` to `machine`. `remotePathname` is the path on the remote
 * (e.g. `/api/sessions`), already 404/403-checked by the caller.
 */
export async function proxyToMachine(
  machine: StoredMachine,
  request: Request,
  remotePathname: string,
  search: string,
): Promise<Response> {
  const url = `${machine.baseUrl}${remotePathname}${search}`;

  // Race connect+headers against a timeout, but clear it as soon as the remote
  // answers — once the body is streaming there is no total deadline. The
  // caller's own signal stays composed in, so a client disconnect still
  // cancels the upstream stream.
  const connectTimeout = new AbortController();
  const timer = setTimeout(() => connectTimeout.abort(), UPSTREAM_HEADER_TIMEOUT_MS);

  let upstream: Response;
  try {
    // `duplex: "half"` is required to stream a request body; the TS lib's
    // RequestInit does not carry it (Bun/undici do at runtime).
    upstream = await fetch(url, {
      method: request.method,
      headers: buildOutboundHeaders(machine, request),
      body: request.body ?? undefined,
      duplex: "half",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, connectTimeout.signal]),
    } as RequestInit);
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(499, { error: "Client disconnected" });
    }
    // Timeout, DNS failure, refused connection, TLS or network error: Bun
    // surfaces these as several error types, and none of them are actionable
    // beyond "this machine did not answer".
    return errorResponse(502, {
      error: `Machine unreachable: ${machine.id}`,
      detail: error instanceof Error ? error.message : String(error),
      code: "machine_unreachable",
    });
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return buildRejectedResponse(upstream);
  }

  return buildUpstreamResponse(upstream);
}

export { isProxyablePath };
