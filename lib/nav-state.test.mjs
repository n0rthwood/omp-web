import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NavOfflineError,
  canonicalRewriteUrl,
  createNavigationResolver,
  resolveIntent,
} from "./nav-state.ts";

// --- test doubles -------------------------------------------------------------
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

// --- resolveIntent: precedence ------------------------------------------------

test("resolveIntent: a url target always wins, source 'url'", () => {
  const intent = resolveIntent({ kind: "target", target: target("m1", "/p", "s1") });
  assert.deepEqual(intent, { target: target("m1", "/p", "s1"), source: "url", home: false });
});

test("resolveIntent: a home location yields the home intent (issue #15 Always Home — no resume)", () => {
  assert.deepEqual(resolveIntent({ kind: "home" }), { home: true });
});

// --- home resolution (issue #15) -------------------------------------------------

test("home: settles after boot+auth with home:true and touches no loaders, no machine commit", async () => {
  const calls = [];
  const deps = baseDeps({
    waitForAuth: async () => { calls.push("auth"); },
    listMachines: async () => { calls.push("machines"); return [{ id: "local" }]; },
    listSessions: async () => { calls.push("sessions"); return []; },
    onMachineCommit: (id) => calls.push(`commit:${id}`),
  });
  const { results, onChange } = collect();
  createNavigationResolver(onChange).run({ kind: "home" }, deps);
  await flush();

  assert.deepEqual(results.map((r) => r.phase), ["boot", "auth", "settled"]);
  const settled = results[results.length - 1];
  assert.equal(settled.home, true);
  assert.equal(settled.source, "home");
  assert.deepEqual(settled.target, { machineId: "local", project: null, session: null });
  assert.equal(settled.session, null);
  assert.deepEqual(calls, ["auth"], "the home pipeline must never resolve machines/projects/sessions");
});

test("home: waits for auth before settling", async () => {
  const authGate = deferred();
  const order = [];
  const deps = baseDeps({ waitForAuth: () => authGate.promise });
  createNavigationResolver((r) => order.push(r.phase)).run({ kind: "home" }, deps);
  await flush();
  assert.deepEqual(order, ["boot", "auth"]);
  authGate.resolve();
  await flush();
  assert.deepEqual(order, ["boot", "auth", "settled"]);
});

// --- happy paths ----------------------------------------------------------------

test("golden path: a local machine-only target settles with the most-recent project and its remembered session, phases in order", async () => {
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
  resolver.run({ kind: "target", target: target("local", null, null) }, deps);
  await flush();

  assert.deepEqual(
    results.map((r) => r.phase),
    ["boot", "auth", "machines", "machine-commit", "projects", "project-commit", "session", "settled"],
  );
  const settled = results[results.length - 1];
  assert.equal(settled.home, false);
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

// --- explicit-session project reconciliation (final review fix #3) -----------
// Precedent: the old ?session= restore let the session's own project win.
// /m/x/p/A/s/<sid-belonging-to-B> must settle {project: B, session: sid},
// never the inconsistent {project: A, session: sid}.

test("explicit session whose project differs from the URL project settles with the SESSION's project, not the requested one", async () => {
  const sessions = [
    session("a1", "/proj-a"),
    session("b1", "/proj-b"),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    getSession: async (_id, sid) => sessions.find((s) => s.id === sid) ?? null,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj-a", "b1") }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.deepEqual(settled.target, { machineId: "local", project: "/proj-b", session: "b1" });
  assert.equal(settled.session.id, "b1");
  assert.equal(
    canonicalRewriteUrl(settled, "/p/%2Fproj-a/s/b1"),
    "/p/%2Fproj-b/s/b1",
    "the canonicalized address bar must reflect the session's true project, not the URL's",
  );
});


test("a session matching its requested project is left untouched by reconciliation", async () => {
  const sessions = [
    session("a1", "/proj-a", { modified: "2026-01-01T00:00:00.000Z" }),
    session("a2", "/proj-a", { modified: "2026-02-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    getSession: async (_id, sid) => sessions.find((s) => s.id === sid) ?? null,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/proj-a", "a1") }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.deepEqual(settled.target, { machineId: "local", project: "/proj-a", session: "a1" });
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

// --- no more soft step-down (issue #15 retired resume/default sources) ----------
// Every pipeline target is URL-sourced and hard: a stale machine/project/session
// deeplink surfaces the AccessNotice gate instead of silently redirecting.

test("stale machine-only deeplink errors instead of silently stepping down to local (resume retired)", async () => {
  const { results, onChange } = collect();
  const deps = baseDeps({ probeMachine: async () => "not-found" });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("gone", "/old-proj", "old-session") }, deps);
  await flush();

  assert.deepEqual(results[results.length - 1].error, { stage: "machine", variant: "not-found" });
});

test("stale project on a machine-only shape deeplink -> not-available (no silent default-project fallback)", async () => {
  const sessions = [session("real", "/repo-current")];
  let getSessionCalls = 0;
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    validateCwd: async () => null,
    getSession: async () => { getSessionCalls++; return null; },
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", "/deleted-repo", "stale-session") }, deps);
  await flush();

  assert.equal(getSessionCalls, 0, "the session under an abandoned project must never be validated");
  assert.deepEqual(results[results.length - 1].error, { stage: "project", variant: "not-available" });
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

// --- storage is retired (issue #15): the resolver no longer reads/writes it -----
// (Covered structurally: NavDeps carries no storage and the module exports no
// read/write helpers — the deleted tests above asserted exactly-once writes.)

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
  resolver.run({ kind: "target", target: target("local", null, null) }, deps);
  await flush();

  assert.deepEqual(order, ["boot", "auth"]);
  authGate.resolve();
  await flush();

  assert.ok(order.includes("machines"));
  assert.ok(order.indexOf("auth") < order.indexOf("machines"));
});

// --- canonicalRewriteUrl: address-bar canonicalization at settle (blocker #1) ---

test("canonicalRewriteUrl: rewrites a url-sourced settle whose canonical form differs from the current URL", () => {
  const settled = {
    phase: "settled",
    target: target("local", "/proj", "s1"),
    session: session("s1", "/proj"),
    error: null,
    source: "url",
    home: false,
  };
  assert.equal(canonicalRewriteUrl(settled, "/?session=s1"), "/p/%2Fproj/s/s1");
});

test("canonicalRewriteUrl: never rewrites a home settle, even though its URL differs from any canonical target (no history pollution from opening '/')", () => {
  const settledFromHome = {
    phase: "settled",
    target: target("local", null, null),
    session: null,
    error: null,
    source: "home",
    home: true,
  };
  assert.equal(canonicalRewriteUrl(settledFromHome, "/"), null);
});

test("canonicalRewriteUrl: no-op once the URL already matches the canonical form", () => {
  const settled = {
    phase: "settled",
    target: target("local", "/proj", "s1"),
    session: session("s1", "/proj"),
    error: null,
    source: "url",
    home: false,
  };
  assert.equal(canonicalRewriteUrl(settled, "/p/%2Fproj/s/s1"), null);
});

test("canonicalRewriteUrl: never rewrites a non-settled (mid-resolution) or error result", () => {
  const midResolution = { phase: "machines", target: target("local", null, null), session: null, error: null, source: "url", home: false };
  assert.equal(canonicalRewriteUrl(midResolution, "/anything"), null);

  const errored = {
    phase: "error",
    target: target("ghost", null, null),
    session: null,
    error: { stage: "machine", variant: "not-found" },
    source: "url",
  };
  assert.equal(canonicalRewriteUrl(errored, "/anything"), null);
});


test("canonicalRewriteUrl end-to-end: a legacy-query-shaped run's settle rewrites the URL to the canonical path", async () => {
  const sessions = [session("s1", "/proj")];

  const { results: urlResults, onChange: urlOnChange } = collect();
  createNavigationResolver(urlOnChange).run(
    // `?session=s1` decodes to exactly this shape in lib/nav-url.ts's parseLegacyQuery.
    { kind: "target", target: target("local", null, "s1") },
    baseDeps({ listSessions: async () => sessions, getSession: async (_id, sid) => (sid === "s1" ? sessions[0] : null) }),
  );
  await flush();
  const urlSettled = urlResults[urlResults.length - 1];
  assert.equal(urlSettled.phase, "settled");
  assert.equal(canonicalRewriteUrl(urlSettled, "/?session=s1"), "/p/%2Fproj/s/s1");
});

// --- machine-switch equivalence (blocker #2) -----------------------------------

test("a machine-only hard target (project/session null) resolves the machine's own defaults — the same shape a MachineSwitcher pick now routes through the pipeline as", async () => {
  const sessions = [
    session("a", "/repo-a", { modified: "2026-01-01T00:00:00.000Z" }),
    session("b", "/repo-b", { modified: "2026-02-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listMachines: async () => [{ id: "local" }, { id: "remote-1" }],
    listSessions: async () => sessions,
    getLastOpenSession: () => null,
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("remote-1", null, null) }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.equal(settled.source, "url");
  assert.deepEqual(settled.target, { machineId: "remote-1", project: "/repo-b", session: "b" });
});

// --- default-project pick excludes removed projects (minor #8) -----------------

test("default project pick excludes the user's removed projects, falling to the next most-recent", async () => {
  const sessions = [
    session("a", "/repo-a", { modified: "2026-01-01T00:00:00.000Z" }),
    session("b", "/repo-b", { modified: "2026-02-01T00:00:00.000Z" }),
  ];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    removedProjectsSupplier: () => new Set(["/repo-b"]),
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", null, null) }, deps);
  await flush();

  assert.equal(results[results.length - 1].target.project, "/repo-a");
});

test("default project pick falls back to no project when every candidate is removed (never an error)", async () => {
  const sessions = [session("a", "/repo-a")];
  const { results, onChange } = collect();
  const deps = baseDeps({
    listSessions: async () => sessions,
    removedProjectsSupplier: () => new Set(["/repo-a"]),
  });
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", null, null) }, deps);
  await flush();

  const settled = results[results.length - 1];
  assert.equal(settled.phase, "settled");
  assert.equal(settled.target.project, null);
});

test("no removedProjectsSupplier -> nothing is excluded (matches every pre-existing test above)", async () => {
  const sessions = [session("a", "/repo-a", { modified: "2026-01-01T00:00:00.000Z" })];
  const { results, onChange } = collect();
  const resolver = createNavigationResolver(onChange);
  resolver.run({ kind: "target", target: target("local", null, null) }, baseDeps({ listSessions: async () => sessions }));
  await flush();

  assert.equal(results[results.length - 1].target.project, "/repo-a");
});
