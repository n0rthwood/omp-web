import assert from "node:assert/strict";
import test from "node:test";

let idCounter = 0;
/** A fresh machine id per test — the module keys state by id in a process-global
 *  map, so distinct tests never interfere with each other. */
function freshId() {
  idCounter += 1;
  return `endpoint-state-test-${idCounter}`;
}

async function loadSubject() {
  return import("./endpoint-state.ts");
}

/** Runs `body` with `Date.now` pinned, restoring it afterward. */
function withClock(startMs, body) {
  const real = Date.now;
  let now = startMs;
  Date.now = () => now;
  try {
    return body({ advance: (ms) => { now += ms; } });
  } finally {
    Date.now = real;
  }
}

test("a fresh machine tries the primary first, in the given fallback priority order", async () => {
  const { planAttempt } = await loadSubject();
  const id = freshId();
  const plan = planAttempt(id, "http://primary", ["http://fallback-a", "http://fallback-b"]);
  assert.deepEqual(plan.order, ["http://primary", "http://fallback-a", "http://fallback-b"]);
  plan.release();
});

test("a machine with no fallbackUrls only ever offers the primary", async () => {
  const { planAttempt } = await loadSubject();
  const id = freshId();
  const plan = planAttempt(id, "http://only", undefined);
  assert.deepEqual(plan.order, ["http://only"]);
  plan.release();
});

test("recordSuccess on a fallback makes it sticky for the next plan", async () => {
  const { planAttempt } = await loadSubject();
  const id = freshId();
  const first = planAttempt(id, "http://primary", ["http://fallback"]);
  first.recordFailure("http://primary");
  first.recordSuccess("http://fallback");
  first.release();

  const second = planAttempt(id, "http://primary", ["http://fallback"]);
  // Sticky on the fallback; the primary is excluded until the failback floor elapses.
  assert.deepEqual(second.order, ["http://fallback"]);
  second.release();
});

test("the failback floor blocks a primary retry until 5 minutes have elapsed, then allows exactly one", async () => {
  const { planAttempt } = await loadSubject();
  const id = freshId();
  withClock(1_700_000_000_000, ({ advance }) => {
    const initial = planAttempt(id, "http://primary", ["http://fallback"]);
    initial.recordFailure("http://primary");
    initial.recordSuccess("http://fallback");
    initial.release();

    advance(4 * 60 * 1000 + 59_000); // 4m59s later: still inside the floor.
    const tooSoon = planAttempt(id, "http://primary", ["http://fallback"]);
    assert.deepEqual(tooSoon.order, ["http://fallback"], "must not re-offer the primary before 5 minutes elapse");
    tooSoon.recordSuccess("http://fallback");
    tooSoon.release();

    advance(2_000); // total 5m01s since the last primary attempt.
    const eligible = planAttempt(id, "http://primary", ["http://fallback"]);
    assert.deepEqual(eligible.order, ["http://primary", "http://fallback"], "the floor has elapsed; the primary is offered again, still with the sticky fallback as backup");
    eligible.release();
  });
});

test("a claimed probe is exclusive: a second plan while one is in flight excludes the primary entirely", async () => {
  const { planAttempt } = await loadSubject();
  const id = freshId();
  withClock(1_700_000_000_000, ({ advance }) => {
    const initial = planAttempt(id, "http://primary", ["http://fallback"]);
    initial.recordFailure("http://primary");
    initial.recordSuccess("http://fallback");
    initial.release();

    // The initial failover itself consumed the floor (it attempted the
    // primary while still nominally "on" it); advance past the floor so the
    // next plan is eligible to probe again.
    advance(6 * 60 * 1000);

    const probing = planAttempt(id, "http://primary", ["http://fallback"]);
    assert.ok(probing.order.includes("http://primary"), "the floor has elapsed: this plan claims the probe slot");

    // A second plan constructed at the same instant, before `probing`
    // releases, must not also claim the primary — at most one in-flight
    // probe per machine.
    const concurrent = planAttempt(id, "http://primary", ["http://fallback"]);
    assert.deepEqual(concurrent.order, ["http://fallback"], "a second concurrent plan must not also probe the primary");
    concurrent.recordSuccess("http://fallback");
    concurrent.release();

    probing.recordFailure("http://primary");
    probing.recordSuccess("http://fallback");
    probing.release();

    // Immediately after release the floor restarts from this instant (the
    // failed probe just refreshed it), so a fresh plan still excludes the primary.
    const afterRelease = planAttempt(id, "http://primary", ["http://fallback"]);
    assert.deepEqual(afterRelease.order, ["http://fallback"]);
    afterRelease.release();
  });
});

test("a successful primary probe fully switches back — describeEndpoints reports the primary active with fresh health", async () => {
  const { planAttempt, describeEndpoints } = await loadSubject();
  const id = freshId();
  withClock(1_700_000_000_000, ({ advance }) => {
    const initial = planAttempt(id, "http://primary", ["http://fallback"]);
    initial.recordFailure("http://primary");
    initial.recordSuccess("http://fallback");
    initial.release();

    let status = describeEndpoints(id, "http://primary", ["http://fallback"]);
    assert.equal(status.activeUrl, "http://fallback");
    assert.deepEqual(status.endpoints, [
      { url: "http://primary", healthy: false },
      { url: "http://fallback", healthy: true },
    ]);

    advance(6 * 60 * 1000);
    const probe = planAttempt(id, "http://primary", ["http://fallback"]);
    assert.deepEqual(probe.order, ["http://primary", "http://fallback"]);
    probe.recordSuccess("http://primary");
    probe.release();

    status = describeEndpoints(id, "http://primary", ["http://fallback"]);
    assert.equal(status.activeUrl, "http://primary");
    assert.equal(status.endpoints.find((e) => e.url === "http://primary").healthy, true);
  });
});

test("describeEndpoints on a never-touched machine reports the primary active with unknown health for every endpoint", async () => {
  const { describeEndpoints } = await loadSubject();
  const id = freshId();
  const status = describeEndpoints(id, "http://primary", ["http://fallback-a", "http://fallback-b"]);
  assert.equal(status.activeUrl, "http://primary");
  assert.deepEqual(status.endpoints, [
    { url: "http://primary", healthy: null },
    { url: "http://fallback-a", healthy: null },
    { url: "http://fallback-b", healthy: null },
  ]);
});

test("clearEndpointState drops runtime state, resetting to a fresh machine on the next plan", async () => {
  const { planAttempt, clearEndpointState, describeEndpoints } = await loadSubject();
  const id = freshId();
  const plan = planAttempt(id, "http://primary", ["http://fallback"]);
  plan.recordFailure("http://primary");
  plan.recordSuccess("http://fallback");
  plan.release();
  assert.equal(describeEndpoints(id, "http://primary", ["http://fallback"]).activeUrl, "http://fallback");

  clearEndpointState(id);
  const status = describeEndpoints(id, "http://primary", ["http://fallback"]);
  assert.equal(status.activeUrl, "http://primary");
  assert.deepEqual(status.endpoints.map((e) => e.healthy), [null, null]);
});
