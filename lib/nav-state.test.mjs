import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NavOfflineError,
  createNavigationResolver,
  readLastLocation,
  resolveIntent,
  writeLastLocation,
} from "./nav-state.ts";

// --- test doubles -------------------------------------------------------------

function createStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

function session(id, cwd, opts = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd,
    projectRoot: opts.projectRoot ?? cwd,
    created: opts.modified ?? "2026-01-01T00:00:00.000Z",
    modified: opts.modified ?? "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
  };
}

/** A resolvable deferred, for controlling exact interleaving in race tests. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function baseDeps(overrides = {}) {
  return {
    listMachines: async () => [{ id: "local" }],
    probeMachine: async () => "ok",
    listSessions: async () => [],
    validateCwd: async () => null,
    getSession: async () => null,
    getLastOpenSession: () => null,
    storage: createStorage(),
    ...overrides,
  };
}

function collect() {
  const results = [];
  const onChange = (r) => results.push(r);
  return { results, onChange };
}

function target(machineId, project, sessionId) {
  return { machineId, project: project ?? null, session: sessionId ?? null };
}

async function flush() {
  // Let every queued microtask (chained awaits inside resolve()) run.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// --- resolveIntent: precedence -----------------------------------------------

test("resolveIntent: a url target always wins, source 'url'", () => {
  const intent = resolveIntent({ kind: "target", target: target("m1", "/p", "s1") }, createStorage());
  assert.deepEqual(intent, { target: target("m1", "/p", "s1"), source: "url" });
});

test("resolveIntent: resume reads localStorage when the URL carries no target", () => {
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "m2", project: "/proj", session: "s9" }),
  });
  const intent = resolveIntent({ kind: "resume" }, storage);
  assert.deepEqual(intent, { target: target("m2", "/proj", "s9"), source: "resume" });
});

test("resolveIntent: malformed ('root') behaves exactly like resume", () => {
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "m2", project: null, session: null }),
  });
  assert.deepEqual(resolveIntent({ kind: "root" }, storage).source, "resume");
});

test("resolveIntent: no stored location and no URL target -> local defaults", () => {
  const intent = resolveIntent({ kind: "resume" }, createStorage());
  assert.deepEqual(intent, { target: target("local", null, null), source: "default" });
});

test("readLastLocation: ignores corrupt JSON, wrong version, and a missing machine", () => {
  assert.equal(readLastLocation(createStorage({ "omp-web:last-location": "{not json" })), null);
  assert.equal(readLastLocation(createStorage({ "omp-web:last-location": JSON.stringify({ v: 2, machine: "x" }) })), null);
  assert.equal(readLastLocation(createStorage({ "omp-web:last-location": JSON.stringify({ v: 1 }) })), null);
  assert.equal(readLastLocation(null), null);
});

test("writeLastLocation then readLastLocation round-trips", () => {
  const storage = createStorage();
  writeLastLocation(storage, { v: 1, machine: "m1", project: "/p", session: "s1" });
  assert.deepEqual(readLastLocation(storage), { v: 1, machine: "m1", project: "/p", session: "s1" });
});

// --- happy paths ----------------------------------------------------------------

test("golden path: local defaults settle with the most-recent project and its remembered session, phases in order", async () => {
  const sessions = [
    session("old", "/repo-a", { modified: "2026-01-01T00:00:00.000Z" }),
    session("new", "/repo-b", { modified: "2026-02-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    getLastOpenSession: (key) => (key === "/repo-b" ? "new" : null),
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "resume" }, deps);
  await flush();

  assert.deepEqual(
    results.map((r) => r.phase),
    ["boot", "auth", "machines", "machine-commit", "projects", "project-commit", "session", "settled"],
  );
  const settled = results[results.length - 1];
  assert.deepEqual(settled.target, { machineId: "local", project: "/repo-b", session: "new" });
  assert.equal(settled.session.id, "new");
});

test("explicit deeplink machine present in the list commits and resolves normally", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({
    listMachines: async () => [{ id: "local" }, { id: "remote-1" }],
    listSessions: async (machineId) => (machineId === "remote-1" ? [session("s1", "/proj")] : []),
    getSession: async (_id, sid) => (sid === "s1" ? session("s1", "/proj") : null),
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("remote-1", "/proj", "s1") }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.deepEqual(settled.target, target("remote-1", "/proj", "s1"));
});

test("zero-session project deeplink resolves via cwd/validate fallback, session stays null (no error)", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => [],
    validateCwd: async (_id, cwd) => cwd,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/fresh-dir", null) }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.deepEqual(settled.target, target("local", "/fresh-dir", null));
  assert.equal(settled.session, null);
});

test("explicit session id wins over a newer session in the same project", async () => {
  const sessions = [
    session("older", "/proj", { modified: "2026-01-01T00:00:00.000Z" }),
    session("newer", "/proj", { modified: "2026-03-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    getSession: async (_id, sid) => sessions.find((s) => s.id === sid) ?? null,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj", "older") }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.target.session, "older");
});

// --- hard errors (url-sourced) ---------------------------------------------------

test("hard: unknown deeplink machine (404 probe) -> not-found error at the machine stage", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ probeMachine: async () => "not-found" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("ghost", null, null) }, deps);
  await flush();

  const last = results[results.length - 1];
  assert.equal(last.phase, "error");
  assert.deepEqual(last.error, { stage: "machine", variant: "not-found" });
});

test("hard: ungranted deeplink machine (403 probe) -> no-permission error, distinct from not-found", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ probeMachine: async () => "no-permission" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("theirs", null, null) }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "machine", variant: "no-permission" });
});

test("hard: offline machine probe -> offline error", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ probeMachine: async () => "offline" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("down", null, null) }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "machine", variant: "offline" });
});

test("hard: probeMachine throwing is treated as offline, not swallowed", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ probeMachine: async () => { throw new Error("boom"); } });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("down", null, null) }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "machine", variant: "offline" });
});

test("hard: unknown/unvisible project (no list match, cwd/validate fails) -> not-available at project stage", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ listSessions: async () => [], validateCwd: async () => null });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/forbidden", null) }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "project", variant: "not-available" });
});

test("hard: unknown/hidden session (getSession 404) -> not-available at session stage, uniform for both causes", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => [session("other", "/proj")],
    getSession: async () => null,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj", "missing") }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "session", variant: "not-available" });
});

test("offline mid-resolution (session-list fetch fails) is hard even though the machine stage already passed", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({
    listMachines: async () => [{ id: "local" }, { id: "flaky" }],
    listSessions: async () => { throw new NavOfflineError(); },
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("flaky", null, null) }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "machine", variant: "offline" });
});

// --- soft step-down (resume/default-sourced) -------------------------------------

test("soft: unknown resume machine steps down silently to local (no error), dropping project/session", async () => {
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "gone", project: "/old-proj", session: "old-session" }),
  });
  const { results, onChange } = collect();
  const deps = baseDeps({ storage, probeMachine: async () => "not-found" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "resume" }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.deepEqual(settled.target, { machineId: "local", project: null, session: null });
});

test("soft: ungranted resume machine also steps down silently (no-permission is soft, unlike offline)", async () => {
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "theirs", project: null, session: null }),
  });
  const { results, onChange } = collect();
  const deps = baseDeps({ storage, probeMachine: async () => "no-permission" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "resume" }, deps);
  await flush();

  assert.equal(results[results.length - 1].phase, "settled");
  assert.equal(results[results.length - 1].target.machineId, "local");
});

test("soft: offline resume machine is still a hard offline error — offline never steps down", async () => {
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "down", project: null, session: null }),
  });
  const { results, onChange } = collect();
  const deps = baseDeps({ storage, probeMachine: async () => "offline" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "resume" }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "machine", variant: "offline" });
});

test("soft: stale resume project falls back to the default project, and the stale session id is discarded (never looked up)", async () => {
  const sessions = [
    session("real", "/repo-current", { modified: "2026-04-01T00:00:00.000Z" }),
  ];
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "local", project: "/deleted-repo", session: "stale-session" }),
  });
  let getSessionCalls = 0;
  const { results, onChange } = collect();
  const deps = baseDeps({
    storage,
    listSessions: async () => sessions,
    validateCwd: async () => null,
    getSession: async () => { getSessionCalls++; return null; },
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "resume" }, deps);
  await flush();

  assert.equal(getSessionCalls, 0, "the stale session id from the abandoned project must never be validated");
  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.deepEqual(settled.target, { machineId: "local", project: "/repo-current", session: "real" });
});

test("soft: stale resume session (project fine) steps down to the default conversation in that project", async () => {
  const sessions = [
    session("keep", "/proj", { modified: "2026-01-01T00:00:00.000Z" }),
  ];
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "local", project: "/proj", session: "deleted-session" }),
  });
  const { results, onChange } = collect();
  const deps = baseDeps({
    storage,
    listSessions: async () => sessions,
    getSession: async () => null,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "resume" }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].target, { machineId: "local", project: "/proj", session: "keep" });
});

// --- workspace-memory / most-recent precedence in the session stage -----------

test("session default: workspace-memory's remembered session wins over a newer one in the same project", async () => {
  const sessions = [
    session("remembered", "/proj", { modified: "2026-01-01T00:00:00.000Z" }),
    session("newer", "/proj", { modified: "2026-05-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    getLastOpenSession: () => "remembered",
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj", null) }, deps);
  await flush();

  assert.equal(results[results.length - 1].target.session, "remembered");
});

test("session default: a workspace-memory id that drifted out of the project (or was deleted) is ignored, falls to most-recent", async () => {
  const sessions = [
    session("in-project", "/proj", { modified: "2026-01-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    getLastOpenSession: () => "belongs-to-another-project",
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj", null) }, deps);
  await flush();

  assert.equal(results[results.length - 1].target.session, "in-project");
});

test("session default: zero sessions in the project leaves session null without an error", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ listSessions: async () => [] });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", null, null) }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.equal(settled.target.session, null);
});

// --- storage: exactly one write, only at settle -----------------------------------

test("storage: writes exactly once, only on settle, with the final resolved shape", async () => {
  const storage = createStorage();
  let setCalls = 0;
  const wrapped = { getItem: (k) => storage.getItem(k), setItem: (k, v) => { setCalls++; storage.setItem(k, v); } };
  const sessions = [session("s1", "/proj", { modified: "2026-01-01T00:00:00.000Z" })];
  const { onChange } = collect();
  const deps = baseDeps({ storage: wrapped, listSessions: async () => sessions, getSession: async () => sessions[0] });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj", "s1") }, deps);
  await flush();

  assert.equal(setCalls, 1);
  assert.deepEqual(readLastLocation(storage), { v: 1, machine: "local", project: "/proj", session: "s1" });
});

test("storage: a hard-failed deeplink never writes (must not clobber the remembered good state)", async () => {
  const storage = createStorage({
    "omp-web:last-location": JSON.stringify({ v: 1, machine: "local", project: "/good", session: "s-good" }),
  });
  let setCalls = 0;
  const wrapped = { getItem: (k) => storage.getItem(k), setItem: (k, v) => { setCalls++; storage.setItem(k, v); } };
  const { onChange } = collect();
  const deps = baseDeps({ storage: wrapped, probeMachine: async () => "not-found" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("ghost", null, null) }, deps);
  await flush();

  assert.equal(setCalls, 0);
  assert.deepEqual(readLastLocation(storage), { v: 1, machine: "local", project: "/good", session: "s-good" });
});

// --- race safety --------------------------------------------------------------

test("race: a superseded intent's late-resolving loaders never emit — only the second run's result is observed", async () => {
  const firstGate = deferred();
  const { results, onChange } = collect();
  const deps1 = baseDeps({ listMachines: () => firstGate.promise.then(() => [{ id: "local" }]) });
  const deps2 = baseDeps({ listSessions: async () => [session("s2", "/second")] });
  const resolver = createNavigationResolver(onChange);

  resolver.run({ kind: "target", target: target("local", "/first", null) }, deps1);
  await Promise.resolve(); // let the first run reach "machines" and start awaiting listMachines()
  resolver.run({ kind: "target", target: target("local", "/second", null) }, deps2);
  await flush();
  firstGate.resolve(); // now let the superseded first run's loader finish
  await flush();

  assert.equal(results.filter((r) => r.phase === "settled").length, 1, "only one run may ever settle");
  assert.equal(results[results.length - 1].target.project, "/second");
  // The stale run's own late completion must not have appended anything after the second run settled.
  const settledIndex = results.findIndex((r) => r.phase === "settled");
  assert.equal(settledIndex, results.length - 1);
});

test("race: popstate landing mid-resolution (after machine-commit) aborts the in-flight run without a second onMachineCommit for the stale machine", async () => {
  const commits = [];
  const machinesGate = deferred();
  const { results, onChange } = collect();
  const deps1 = baseDeps({
    listMachines: async () => [{ id: "local" }, { id: "m1" }],
    onMachineCommit: (id) => commits.push(id),
    listSessions: () => machinesGate.promise.then(() => []),
  });
  const deps2 = baseDeps({
    listMachines: async () => [{ id: "local" }, { id: "m2" }],
    onMachineCommit: (id) => commits.push(id),
    listSessions: async () => [],
  });
  const resolver = createNavigationResolver(onChange);

  resolver.run({ kind: "target", target: target("m1", null, null) }, deps1);
  await flush(); // reaches machine-commit for m1, then blocks in listSessions on machinesGate

  resolver.run({ kind: "target", target: target("m2", null, null) }, deps2);
  await flush();
  machinesGate.resolve();
  await flush();

  assert.deepEqual(commits, ["m1", "m2"]);
  const settled = results.filter((r) => r.phase === "settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].target.machineId, "m2");
});

test("race: the session list is fetched exactly once per run (one snapshot for both project and session validation)", async () => {
  let calls = 0;
  const sessions = [session("s1", "/proj", { modified: "2026-01-01T00:00:00.000Z" })];
  const { onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => { calls++; return sessions; },
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj", null) }, deps);
  await flush();

  assert.equal(calls, 1);
});

// --- auth gate ------------------------------------------------------------------

test("auth: resolution waits for waitForAuth before touching machines", async () => {
  const authGate = deferred();
  const order = [];
  const deps = baseDeps({
    waitForAuth: () => authGate.promise,
    listMachines: async () => { order.push("machines"); return [{ id: "local" }]; },
  });
  const resolver = createNavigationResolver((r) => order.push(r.phase));
  resolver.run({ kind: "resume" }, deps);
  await flush();

  assert.deepEqual(order, ["boot", "auth"]);
  authGate.resolve();
  await flush();

  assert.ok(order.includes("machines"));
  assert.ok(order.indexOf("auth") < order.indexOf("machines"));
});
