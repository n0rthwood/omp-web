import { isProxyablePath } from "./proxy-allowlist";
import { planAttempt } from "./endpoint-state";
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

/** Bound on connect+headers for the upstream fetch; cleared once headers arrive, so streaming bodies are never cut off.
 *  15s (WAN remotes over ZeroTier) so the browser's own 20s health-probe deadline never fires first. */
const UPSTREAM_HEADER_TIMEOUT_MS = 15_000;

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
 * Proxy `request` to `machine`. `remotePathname` is the path on the remote
 * (e.g. `/api/sessions`), already 404/403-checked by the caller.
 *
 * Endpoints (`machine.baseUrl`, then `machine.fallbackUrls` in order) are
 * tried per `planAttempt`'s plan. A transport failure — DNS, connection
 * refused, connect timeout, TLS — before response headers arrive moves to
 * the next endpoint; any HTTP response, whatever its status, is final and
 * never triggers a switch. A request with a body is `.clone()`d before each
 * attempt so a virgin stream is always offered; once an attempt's clone
 * reports `bodyUsed`, upstream has started reading it, so that attempt's
 * failure is terminal — replaying a request whose body has already begun
 * streaming could apply it twice on the far end.
 */
export async function proxyToMachine(
  machine: StoredMachine,
  request: Request,
  remotePathname: string,
  search: string,
): Promise<Response> {
  const plan = planAttempt(machine.id, machine.baseUrl, machine.fallbackUrls);
  const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";

  try {
    for (let i = 0; i < plan.order.length; i++) {
      const endpoint = plan.order[i];
      const attemptRequest = hasBody ? request.clone() : request;

      // Race connect+headers against a timeout, but clear it as soon as the
      // remote answers — once the body is streaming there is no total
      // deadline. The caller's own signal stays composed in, so a client
      // disconnect still cancels the upstream stream.
      const connectTimeout = new AbortController();
      const timer = setTimeout(() => connectTimeout.abort(), UPSTREAM_HEADER_TIMEOUT_MS);

      let upstream: Response;
      try {
        // `duplex: "half"` is required to stream a request body; the TS lib's
        // RequestInit does not carry it (Bun/undici do at runtime).
        upstream = await fetch(`${endpoint}${remotePathname}${search}`, {
          method: request.method,
          headers: buildOutboundHeaders(machine, request),
          body: hasBody ? attemptRequest.body : undefined,
          duplex: "half",
          redirect: "manual",
          signal: AbortSignal.any([request.signal, connectTimeout.signal]),
        } as RequestInit);
      } catch {
        if (request.signal.aborted) {
          return errorResponse(499, { error: "Client disconnected" });
        }
        plan.recordFailure(endpoint);
        // The body has already started streaming to this endpoint: it may
        // have been partially applied on the far end, so trying the next
        // endpoint could replay it. Only a connect-phase failure — nothing
        // sent yet — is safe to retry, even for POST.
        const bodyAlreadyStreamed = hasBody && attemptRequest.bodyUsed;
        if (bodyAlreadyStreamed || i === plan.order.length - 1) {
          // Timeout, DNS failure, refused connection, TLS or network error.
          // The platform's message is deliberately not relayed: repeated
          // over a caller-chosen baseUrl it distinguishes closed from
          // filtered from open ports. Diagnose a machine with the pre-save
          // probe instead.
          return errorResponse(502, {
            error: `Machine unreachable: ${machine.id}`,
            code: "machine_unreachable",
          });
        }
        continue;
      } finally {
        clearTimeout(timer);
      }

      plan.recordSuccess(endpoint);
      return buildUpstreamResponse(upstream);
    }
    // plan.order is never empty (it always contains at least the primary).
    return errorResponse(502, { error: `Machine unreachable: ${machine.id}`, code: "machine_unreachable" });
  } finally {
    plan.release();
  }
}

export { isProxyablePath };
