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
