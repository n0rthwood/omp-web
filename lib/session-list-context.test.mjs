import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./session-list-context.tsx", import.meta.url), "utf8");

// Ported as-is from the pre-lift SessionSidebar (issue #10, stage 3) — see
// git history / components/SessionSidebar.test.mjs for the prior coverage.

test("polls running sessions only while the tab is visible, no SSE", () => {
  assert.doesNotMatch(source, /new EventSource\(/);
  assert.match(source, /fetch\(apiPath\("\/api\/agent\/running", machineId\)/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("manual and lifecycle refreshes bypass the server session-list cache", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
});

test("refreshKey bumps reload in the background; the initial load shows a loading state", () => {
  assert.match(source, /void load\(true, false\)/);
  assert.match(source, /void load\(false, true\)/);
});

test("once the poll delivers a snapshot it is authoritative — a slower session-list fetch cannot overwrite it", () => {
  assert.match(source, /if \(!runningPollAuthoritativeRef\.current\) setRunningSessionIds/);
  assert.match(source, /runningPollAuthoritativeRef\.current = true;/);
});

test("fetchSessionsFor is a one-off fetch for an arbitrary machine, independent of the reactive current-machine state", () => {
  assert.match(
    source,
    /const fetchSessionsFor = useCallback\(async \(targetMachineId: string\)[\s\S]*?fetchSessionList\(targetMachineId, false\)/,
  );
});

test("a network failure or a 502 from the proxy (machine unreachable) surfaces as NavOfflineError, not a generic Error", () => {
  assert.match(source, /throw new NavOfflineError\(`Machine unreachable: \$\{machineId\}`\);/);
  assert.match(source, /if \(res\.status === 502\) throw new NavOfflineError/);
});

// issue #10 stage-3 review, minors #4, #6, #7.

test("minor #4: the refreshKey-reactive reload effect depends only on refreshKey, not on load's identity (which changes on every machine switch)", () => {
  const effectStart = source.indexOf("const loadRef = useRef(load);");
  const effectEnd = source.indexOf("}, [refreshKey]);", effectStart);
  assert.notEqual(effectStart, -1);
  assert.notEqual(effectEnd, -1, "the refreshKey effect must depend on [refreshKey] alone, not [refreshKey, load]");
  const effectBody = source.slice(effectStart, effectEnd);
  assert.match(effectBody, /const loadRef = useRef\(load\);/);
  assert.match(effectBody, /loadRef\.current = load;/);
  assert.match(effectBody, /void loadRef\.current\(false, true\);/);
});

test("minor #6: the currently-active session is excluded from the polling-driven completion reload, so bumpRefreshKey() on agent-end is not double-triggered", () => {
  assert.match(
    source,
    /const completed = \[\.\.\.previous\]\.filter\(\(id\) => !runningSessionIds\.has\(id\) && id !== activeSessionIdRef\.current\);/,
  );
  assert.match(source, /const setActiveSessionId = useCallback\(\(id: string \| null\) => \{\s*activeSessionIdRef\.current = id;/);
});

test("minor #7: a machine switch resets stale session-list state synchronously during render, not only in a post-render effect (no one-frame cross-machine flash)", () => {
  const providerStart = source.indexOf("export function SessionListProvider");
  const firstEffect = source.indexOf("useEffect(() => {", providerStart);
  assert.notEqual(providerStart, -1);
  assert.notEqual(firstEffect, -1);
  // The reset must happen before the component's first useEffect runs
  // (React effects always run after render) — i.e. textually before the
  // first useEffect call in the component body.
  const beforeFirstEffect = source.slice(providerStart, firstEffect);
  assert.match(beforeFirstEffect, /const sessionsMachineIdRef = useRef\(machineId\);/);
  assert.match(beforeFirstEffect, /if \(sessionsMachineIdRef\.current !== machineId\) \{/);
  assert.match(beforeFirstEffect, /setSessions\(\[\]\);/);
  assert.match(beforeFirstEffect, /setLoading\(true\);/);
});

// final-review fix: an in-flight fetch for the previous machine must never
// overwrite the new machine's freshly-reset list — the pre-lift sidebar was
// remounted per machine, so this race is new to the lifted provider.

test("final-review fix: load() machine-guards every post-await setState so a stale-machine fetch cannot clobber the fresh list", () => {
  const loadStart = source.indexOf("const load = useCallback(async (showLoading: boolean, force: boolean) => {");
  const loadEnd = source.indexOf("}, [machineId]);", loadStart);
  assert.notEqual(loadStart, -1);
  assert.notEqual(loadEnd, -1);
  const loadBody = source.slice(loadStart, loadEnd);

  assert.match(loadBody, /const forMachine = machineId;/);

  const guard = "if (sessionsMachineIdRef.current !== forMachine) return;";
  const tryStart = loadBody.indexOf("try {");
  const catchStart = loadBody.indexOf("} catch");
  const finallyStart = loadBody.indexOf("} finally", catchStart);
  assert.notEqual(tryStart, -1);
  assert.notEqual(catchStart, -1);
  assert.notEqual(finallyStart, -1);

  // try block: the guard precedes every post-await setState.
  const tryBody = loadBody.slice(tryStart, catchStart);
  const guardInTry = tryBody.indexOf(guard);
  assert.notEqual(guardInTry, -1, "the try block must bail before touching state once superseded");
  for (const call of ["setSessions(fetched)", "setRunningSessionIds(", "setError(null)", "setRefreshDone(true)"]) {
    const callIndex = tryBody.indexOf(call);
    assert.notEqual(callIndex, -1, `expected ${call} in the try block`);
    assert.ok(guardInTry < callIndex, `the machine guard must precede ${call}`);
  }

  // catch block: guarded before setError.
  const catchBody = loadBody.slice(catchStart, finallyStart);
  const guardInCatch = catchBody.indexOf(guard);
  assert.notEqual(guardInCatch, -1, "the catch block must bail before setError for a superseded fetch");
  assert.ok(guardInCatch < catchBody.indexOf("setError(String(err))"));

  // finally block: setLoading(false) is guarded too.
  const finallyBody = loadBody.slice(finallyStart);
  assert.match(finallyBody, /if \(sessionsMachineIdRef\.current === forMachine && showLoading\) setLoading\(false\);/);
});
