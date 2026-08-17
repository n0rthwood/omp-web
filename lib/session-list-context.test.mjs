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
