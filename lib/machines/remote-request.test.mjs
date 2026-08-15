import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./remote-request.ts");
}

const machine = {
  id: "build-box",
  name: "Build box",
  baseUrl: "http://10.0.0.5:5010",
  authMode: "bearer",
  token: "web_supersecret",
  headers: { "x-fleet": "1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Runs `body` with a stubbed global fetch, returning what the proxy sent upstream. */
async function withStubbedFetch(respond, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("only allow-listed caller headers reach the remote, and the machine's own credential replaces theirs", async () => {
  const { proxyToMachine } = await loadSubject();
  const request = new Request("http://gateway.test/api/machines/build-box/api/sessions?force=1", {
    method: "GET",
    headers: {
      "accept": "application/json",
      "range": "bytes=0-31",
      "cookie": "omp-web-session=stolen",
      "authorization": "Bearer web_callers_own_token",
      "x-forwarded-for": "203.0.113.9",
      "origin": "http://gateway.test",
      "user-agent": "probe",
    },
  });

  const { calls } = await withStubbedFetch(
    () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    () => proxyToMachine(machine, request, "/api/sessions", "?force=1"),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://10.0.0.5:5010/api/sessions?force=1");

  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get("accept"), "application/json");
  assert.equal(sent.get("range"), "bytes=0-31");
  assert.equal(sent.get("accept-encoding"), "identity");
  assert.equal(sent.get("x-fleet"), "1");
  // The machine's credential, never the caller's.
  assert.equal(sent.get("authorization"), "Bearer web_supersecret");
  // Caller identity and forwarding hints must not leak to the remote.
  assert.equal(sent.get("cookie"), null);
  assert.equal(sent.get("x-forwarded-for"), null);
  assert.equal(sent.get("origin"), null);
  assert.equal(sent.get("user-agent"), null);
});

test("the caller's abort reaches the upstream fetch", async () => {
  const { proxyToMachine } = await loadSubject();
  const controller = new AbortController();
  const request = new Request("http://gateway.test/api/machines/build-box/api/agent/running/events", {
    signal: controller.signal,
  });

  const { calls } = await withStubbedFetch(
    () => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    () => proxyToMachine(machine, request, "/api/agent/running/events", ""),
  );

  const upstreamSignal = calls[0].init.signal;
  assert.ok(upstreamSignal instanceof AbortSignal);
  assert.equal(upstreamSignal.aborted, false);
  // Without this composition a disconnected client leaves the remote holding
  // the subscription, its heartbeat interval and any fs.watch handles.
  controller.abort();
  assert.equal(upstreamSignal.aborted, true);
});

test("an event stream is passed through unbuffered, without the remote's auth headers", async () => {
  const { proxyToMachine } = await loadSubject();
  const stream = new ReadableStream({ start() {} });
  const upstream = new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "set-cookie": "omp-web-session=remote-session",
      "www-authenticate": 'Basic realm="omp-web"',
      "etag": "W/\"abc\"",
    },
  });

  const { result } = await withStubbedFetch(
    () => upstream,
    () => proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/terminals/t1/events", ""),
  );

  assert.equal(result.status, 200);
  assert.equal(result.body, stream, "the upstream body must be handed through, never read into memory");
  assert.equal(result.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(result.headers.get("x-accel-buffering"), "no");
  assert.equal(result.headers.get("etag"), 'W/"abc"');
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("www-authenticate"), null);
});

test("a byte range answer keeps its 206 semantics", async () => {
  const { proxyToMachine } = await loadSubject();
  const { result } = await withStubbedFetch(
    () => new Response("0123456789", {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-9/2626",
        "accept-ranges": "bytes",
        "content-length": "10",
        "content-disposition": "attachment; filename=\"x\"",
      },
    }),
    () => proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/files/x", "?type=download"),
  );

  assert.equal(result.status, 206);
  assert.equal(result.headers.get("content-range"), "bytes 0-9/2626");
  assert.equal(result.headers.get("accept-ranges"), "bytes");
  assert.equal(result.headers.get("content-length"), "10");
  assert.equal(result.headers.get("content-disposition"), 'attachment; filename="x"');
});

test("an unreachable machine answers 502 without leaking the credential", async () => {
  const { proxyToMachine } = await loadSubject();
  const { result } = await withStubbedFetch(
    () => { throw new TypeError("Unable to connect. Is the computer able to access the url?"); },
    () => proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/health", ""),
  );

  assert.equal(result.status, 502);
  const text = await result.text();
  assert.match(text, /machine_unreachable/);
  assert.match(text, /build-box/);
  assert.doesNotMatch(text, /web_supersecret/);
});

test("a remote rejection is passed through as its own status and message", async () => {
  const { proxyToMachine } = await loadSubject();
  const { result } = await withStubbedFetch(
    () => new Response(JSON.stringify({ error: "Access denied" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
    () => proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/files/etc", "?type=list"),
  );

  // Relabelling this as a credential failure would misdiagnose the remote's
  // own file allow-list refusal.
  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), { error: "Access denied" });
});
