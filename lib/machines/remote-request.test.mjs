import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

async function loadSubject() {
  return import("./remote-request.ts");
}

// --- real local HTTP servers for the transport/failover cases ------------------
// A stubbed `fetch` (used above) can't produce a genuine ECONNREFUSED, a real
// mid-stream connection reset, or real chunked streaming, so the failover and
// failback tests below spin up throwaway servers on ephemeral loopback ports
// instead — never touching a real fleet machine or the on-disk registry.

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** A loopback URL nothing is listening on — a real ECONNREFUSED, not a stub. */
async function unreachableUrl() {
  const server = await startServer(() => {});
  const url = serverUrl(server);
  await stopServer(server);
  return url;
}

let realMachineCounter = 0;
/** A fresh machine id per test — `remote-request.ts` keys failover/failback
 *  state by machine id in a process-global map (`endpoint-state.ts`), so
 *  distinct tests must never share one. */
function freshMachine(overrides) {
  realMachineCounter += 1;
  return {
    id: `remote-request-real-${realMachineCounter}`,
    name: "Real machine",
    authMode: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
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

// --- endpoint failover / lazy failback (real servers, issue #37) --------------

test("endpoint-order selection: a healthy primary is used first and the fallback is never dialed", async () => {
  const { proxyToMachine } = await loadSubject();
  let primaryHits = 0;
  let fallbackHits = 0;
  const primary = await startServer((req, res) => {
    primaryHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, from: "primary" }));
  });
  const fallback = await startServer((req, res) => {
    fallbackHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, from: "fallback" }));
  });
  try {
    const machine = freshMachine({ baseUrl: serverUrl(primary), fallbackUrls: [serverUrl(fallback)] });
    const response = await proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/health", "");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, from: "primary" });
    assert.equal(primaryHits, 1);
    assert.equal(fallbackHits, 0);
  } finally {
    await stopServer(primary);
    await stopServer(fallback);
  }
});

test("acceptance: an unreachable primary (ECONNREFUSED) fails over so a proxied request succeeds over the fallback", async () => {
  const { proxyToMachine } = await loadSubject();
  const deadPrimary = await unreachableUrl();
  let fallbackHits = 0;
  const fallback = await startServer((req, res) => {
    fallbackHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const machine = freshMachine({ baseUrl: deadPrimary, fallbackUrls: [serverUrl(fallback)] });
    const response = await proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/health", "");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(fallbackHits, 1);
  } finally {
    await stopServer(fallback);
  }
});

for (const status of [401, 404, 500]) {
  test(`acceptance: an HTTP ${status} from the primary is returned as-is and never triggers failover`, async () => {
    const { proxyToMachine } = await loadSubject();
    let primaryHits = 0;
    let fallbackHits = 0;
    const primary = await startServer((req, res) => {
      primaryHits += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `boom-${status}` }));
    });
    const fallback = await startServer((req, res) => {
      fallbackHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const machine = freshMachine({ baseUrl: serverUrl(primary), fallbackUrls: [serverUrl(fallback)] });
      const response = await proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/x", "");
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: `boom-${status}` });
      assert.equal(primaryHits, 1);
      assert.equal(fallbackHits, 0, "an HTTP response from the primary — even an error — must never trigger a fallback attempt");
    } finally {
      await stopServer(primary);
      await stopServer(fallback);
    }
  });
}

test("a POST whose body has already started streaming to the primary is not replayed on the fallback", async () => {
  const { proxyToMachine } = await loadSubject();
  let primaryHits = 0;
  const primary = await startServer((req) => {
    primaryHits += 1;
    // A genuine mid-stream failure: the connection is live and some of the
    // body has arrived, then it is reset before any response headers form.
    req.once("data", () => req.socket.destroy());
  });
  let fallbackHits = 0;
  const fallback = await startServer((req, res) => {
    fallbackHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const machine = freshMachine({ baseUrl: serverUrl(primary), fallbackUrls: [serverUrl(fallback)] });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-one"));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("chunk-two"));
          controller.close();
        }, 30);
      },
    });
    const request = new Request("http://gateway.test/x", { method: "POST", body, duplex: "half" });
    const response = await proxyToMachine(machine, request, "/api/x", "");
    assert.equal(response.status, 502);
    assert.equal(primaryHits, 1);
    assert.equal(fallbackHits, 0, "a request whose body already began streaming must not be replayed on another endpoint");
  } finally {
    await stopServer(primary);
    await stopServer(fallback);
  }
});

test("acceptance: a streaming response continues to work when served over a fallback endpoint", async () => {
  const { proxyToMachine } = await loadSubject();
  const deadPrimary = await unreachableUrl();
  const fallback = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => {
      res.write("data: two\n\n");
      res.end();
    }, 50);
  });
  try {
    const machine = freshMachine({ baseUrl: deadPrimary, fallbackUrls: [serverUrl(fallback)] });
    const response = await proxyToMachine(machine, new Request("http://gateway.test/x"), "/api/agent/s1/events", "");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    let chunkCount = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      received += decoder.decode(value);
    }
    assert.ok(chunkCount >= 2, "the body must arrive as it streams, not as one buffered read");
    assert.match(received, /data: one/);
    assert.match(received, /data: two/);
  } finally {
    await stopServer(fallback);
  }
});

test("acceptance: after failing over, the primary is re-probed no more than once per 5 minutes and the gateway switches back on the first success", async () => {
  const { proxyToMachine } = await loadSubject();
  let primaryUp = false;
  let primaryHits = 0;
  let fallbackHits = 0;
  const primary = await startServer((req, res) => {
    primaryHits += 1;
    if (primaryUp) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, from: "primary" }));
    } else {
      req.socket.destroy();
    }
  });
  const fallback = await startServer((req, res) => {
    fallbackHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, from: "fallback" }));
  });
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const machine = freshMachine({ baseUrl: serverUrl(primary), fallbackUrls: [serverUrl(fallback)] });

    let response = await proxyToMachine(machine, new Request("http://gateway.test/1"), "/api/health", "");
    assert.equal((await response.json()).from, "fallback");
    assert.equal(primaryHits, 1);
    assert.equal(fallbackHits, 1);

    now += 4 * 60 * 1000; // 4 minutes later: still inside the floor.
    response = await proxyToMachine(machine, new Request("http://gateway.test/2"), "/api/health", "");
    assert.equal((await response.json()).from, "fallback");
    assert.equal(primaryHits, 1, "must not re-probe the primary before the 5-minute floor elapses");
    assert.equal(fallbackHits, 2);

    primaryUp = true;
    now += 2 * 60 * 1000; // 6 minutes since the last probe: past the floor.
    response = await proxyToMachine(machine, new Request("http://gateway.test/3"), "/api/health", "");
    assert.equal((await response.json()).from, "primary", "the floor elapsed and the primary answered: switch back on the first success");
    assert.equal(primaryHits, 2);
    assert.equal(fallbackHits, 2);

    response = await proxyToMachine(machine, new Request("http://gateway.test/4"), "/api/health", "");
    assert.equal((await response.json()).from, "primary", "fully switched back: served directly with no fallback contact");
    assert.equal(primaryHits, 3);
    assert.equal(fallbackHits, 2);
  } finally {
    Date.now = realNow;
    await stopServer(primary);
    await stopServer(fallback);
  }
});

test("acceptance: concurrent requests while serving a fallback produce at most one in-flight primary probe", async () => {
  const { proxyToMachine } = await loadSubject();
  let primaryHits = 0;
  let fallbackHits = 0;
  const primary = await startServer((req) => {
    primaryHits += 1;
    req.socket.destroy(); // the primary is down for the whole test
  });
  const fallback = await startServer((req, res) => {
    fallbackHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const machine = freshMachine({ baseUrl: serverUrl(primary), fallbackUrls: [serverUrl(fallback)] });

    // Establish "on fallback"; this attempt itself consumes the floor.
    let response = await proxyToMachine(machine, new Request("http://gateway.test/0"), "/api/health", "");
    assert.equal(response.status, 200);
    assert.equal(primaryHits, 1);
    assert.equal(fallbackHits, 1);

    now += 6 * 60 * 1000; // past the floor: the next requests are eligible to re-probe.

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => proxyToMachine(machine, new Request(`http://gateway.test/c${i}`), "/api/health", "")),
    );
    for (const r of responses) assert.equal(r.status, 200);
    assert.equal(primaryHits, 2, "exactly one of the five concurrent requests attempted the primary probe");
    assert.equal(fallbackHits, 6, "the probing request's own failover plus the other four served straight from the fallback");
  } finally {
    Date.now = realNow;
    await stopServer(primary);
    await stopServer(fallback);
  }
});
