import assert from "node:assert/strict";
import test from "node:test";

const { createMachineHealthProbe, MACHINE_HEALTH_CACHE_TTL_MS } = await import("./health-probe.ts");

function machine(id) {
  return {
    id,
    name: id,
    baseUrl: `http://${id}.local`,
    fallbackUrls: [],
    authMode: "none",
    createdAt: "",
    updatedAt: "",
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A probe whose upstream is fully controlled and counted. */
function makeFixture(upstream, { ttlMs = MACHINE_HEALTH_CACHE_TTL_MS } = {}) {
  let calls = 0;
  let now = 1_000;
  const probe = createMachineHealthProbe({
    now: () => now,
    ttlMs,
    probeRemote: async () => {
      calls += 1;
      return upstream();
    },
  });
  return {
    probe,
    count: () => calls,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("a 200 with ok:true is online", async () => {
  const { probe } = makeFixture(() => jsonResponse(200, { ok: true }));
  assert.deepEqual(await probe.probe(machine("gpu-1")), { id: "gpu-1", state: "online" });
});

test("401 and 403 are unauthorized, with the upstream reason when present", async () => {
  const rejected = makeFixture(() => jsonResponse(401, { error: "Authentication required" }));
  assert.deepEqual(await rejected.probe.probe(machine("gpu-1")), {
    id: "gpu-1",
    state: "unauthorized",
    reason: "Authentication required",
  });

  const forbidden = makeFixture(() => jsonResponse(403, {}));
  assert.deepEqual(await forbidden.probe.probe(machine("gpu-2")), {
    id: "gpu-2",
    state: "unauthorized",
    reason: "The configured credential was rejected.",
  });
});

test("a non-ok status or ok:false body is offline with an HTTP reason", async () => {
  const serverError = makeFixture(() => jsonResponse(500, { ok: false }));
  assert.deepEqual(await serverError.probe.probe(machine("gpu-1")), {
    id: "gpu-1",
    state: "offline",
    reason: "HTTP 500",
  });

  const lyingBody = makeFixture(() => jsonResponse(200, { ok: false }));
  assert.deepEqual(await lyingBody.probe.probe(machine("gpu-2")), {
    id: "gpu-2",
    state: "offline",
    reason: "HTTP 200",
  });
});

test("a transport failure is offline, not a rejection", async () => {
  const dead = makeFixture(() => Promise.reject(new Error("ECONNREFUSED")));
  assert.deepEqual(await dead.probe.probe(machine("gpu-1")), {
    id: "gpu-1",
    state: "offline",
    reason: "Connection timed out.",
  });
});

test("results are cached for the TTL window", async () => {
  const fixture = makeFixture(() => jsonResponse(200, { ok: true }));
  const m = machine("gpu-1");

  await fixture.probe.probe(m);
  await fixture.probe.probe(m);
  assert.equal(fixture.count(), 1);

  fixture.advance(MACHINE_HEALTH_CACHE_TTL_MS);
  await fixture.probe.probe(m);
  assert.equal(fixture.count(), 2);
});

test("two concurrent calls coalesce into one upstream probe", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = makeFixture(async () => {
    await gate;
    return jsonResponse(200, { ok: true });
  });
  const m = machine("gpu-1");

  const first = fixture.probe.probe(m);
  const second = fixture.probe.probe(m);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(fixture.count(), 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, { id: "gpu-1", state: "online" });
});

test("machines are cached independently", async () => {
  const fixture = makeFixture(() => jsonResponse(200, { ok: true }));
  await fixture.probe.probe(machine("gpu-1"));
  await fixture.probe.probe(machine("gpu-2"));
  assert.equal(fixture.count(), 2);
});

test("clear() forces the next probe to go upstream again", async () => {
  const fixture = makeFixture(() => jsonResponse(200, { ok: true }));
  const m = machine("gpu-1");
  await fixture.probe.probe(m);
  fixture.probe.clear(m.id);
  await fixture.probe.probe(m);
  assert.equal(fixture.count(), 2);
});
