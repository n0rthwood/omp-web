import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

// issue #10, stage 3: every writer migrates through NavigationProvider's
// navigate() instead of a scattered router.replace(appUrl(...)).

test("no writer calls router.replace/push directly — navigate() is the only URL writer", () => {
  assert.doesNotMatch(source, /router\.(replace|push)\(/);
  assert.doesNotMatch(source, /\bappUrl\(/);
});

test("AppShellBody seeds its initial session/project from the resolved navigation target, not from URL parsing", () => {
  assert.match(source, /function AppShellBody\(\{ initialTarget, initialSession, resolutionRevision \}: AppShellBodyProps\)/);
  assert.match(
    source,
    /const \[selectedSession, setSelectedSession\] = useState<SessionInfo \| null>\(\(\) => initialSession\);/,
  );
  assert.doesNotMatch(source, /getInitialNavigation/);
});

test("explicit user selections push history; system corrections (session-deleted) replace it", () => {
  assert.match(callbackBody("handleSelectSession", "handleNewSession"), /history: "push" \}\)/);
  assert.match(callbackBody("handleNewSession", "handleSessionCreated"), /history: "push" \}\)/);
  assert.match(callbackBody("handleSessionCreated", "deliverSessionNotification"), /history: "push" \}\)/);
  assert.match(callbackBody("handleSessionForked", "handleSessionDeleted"), /history: "push" \}\)/);
  assert.match(source, /nav\.navigate\(\{ machineId: machines\.machineId, project: selectedSession\.projectRoot \?\? selectedSession\.cwd, session: null \}, \{ history: "replace" \}\)/);
});

test("machine switch drops project/session, routed through MachineSwitcher's navigate() call", () => {
  const switcherSource = fs.readFileSync(new URL("./MachineSwitcher.tsx", import.meta.url), "utf8");
  assert.match(
    switcherSource,
    /navigate\(\{ machineId: id, project: null, session: null \}, \{ history: "push" \}\)/,
  );
});

test("the wrapper layers SessionListProvider and NavigationProvider above the machine remount key", () => {
  assert.match(
    source,
    /<MachineProvider>\s*<SessionListProvider>\s*<NavigationProvider>\s*<AppShellMachineKey \/>\s*<\/NavigationProvider>\s*<\/SessionListProvider>\s*<\/MachineProvider>/,
  );
});

test("NavigationProvider is the only popstate handler AppShell.tsx itself never listens for it", () => {
  assert.doesNotMatch(source, /addEventListener\("popstate"/);
});

// issue #10 stage-3 review, blockers #1 and #2: the pipeline canonicalizes
// the address bar at settle, and an interactive machine switch runs through
// it instead of settling immediately with a raw, project-less target.

const navProviderSource = fs.readFileSync(new URL("./NavigationProvider.tsx", import.meta.url), "utf8");

test("blocker #1: a settled result is canonicalized via canonicalRewriteUrl, replacing the URL only when it differs", () => {
  assert.match(navProviderSource, /import \{\s*canonicalRewriteUrl,/);
  assert.match(
    navProviderSource,
    /const rewrite = canonicalRewriteUrl\(result, pathname \+ search\);\s*if \(rewrite\) writeAddressBar\(rewrite, "replace"\);/,
  );
});

// issue #12: router.push/replace re-render the page segment, and the whole
// provider tree is page-mounted — a Next-router navigation remounts the app
// (the "every switch reloads" bug). URL writes must use the native History
// API, which Next 16 syncs without fetching or remounting.
test("issue #12: NavigationProvider writes URLs with the native History API, never the Next router", () => {
  assert.doesNotMatch(navProviderSource, /from "next\/navigation"/);
  assert.doesNotMatch(navProviderSource, /router\.(push|replace)\(/);
  assert.match(navProviderSource, /window\.history\.pushState\(null, "", url\)/);
  assert.match(navProviderSource, /window\.history\.replaceState\(null, "", url\)/);
});

test("blocker #2: navigate() routes a machine-changing target through the async pipeline, not the sync fast path", () => {
  const navigateStart = navProviderSource.indexOf("const navigate = useCallback");
  const navigateEnd = navProviderSource.indexOf("const retry = useCallback", navigateStart);
  assert.notEqual(navigateStart, -1);
  const navigateBody = navProviderSource.slice(navigateStart, navigateEnd);

  assert.match(navigateBody, /if \(next\.machineId !== machinesRef\.current\.machineId\) \{/);
  assert.match(navigateBody, /resolverRef\.current!\.run\(\{ kind: "target", target: next \}, buildDeps\(\)\);/);
  // The same-machine fast path still settles synchronously, without a
  // pipeline round trip.
  assert.match(navigateBody, /setResult\(\{ phase: "settled", target: next, session: null, error: null, source: "url", home: false \}\);/);
});

test("Home session clicks run the resolver even when the target machine is already current", () => {
  const navigateStart = navProviderSource.indexOf("const navigate = useCallback");
  const navigateEnd = navProviderSource.indexOf("const goHome = useCallback", navigateStart);
  assert.notEqual(navigateStart, -1);
  assert.notEqual(navigateEnd, -1);
  const navigateBody = navProviderSource.slice(navigateStart, navigateEnd);

  assert.match(
    navigateBody,
    /if \(resultRef\.current\.phase !== "error" && resultRef\.current\.home && next\.session\) \{[\s\S]*resolverRef\.current!\.run\(\{ kind: "target", target: next \}, buildDeps\(\)\);[\s\S]*return;[\s\S]*\}/,
  );
});

const homePageSource = fs.readFileSync(new URL("./HomePage.tsx", import.meta.url), "utf8");

test("Home fan-out fetch depends on stable fetchSessionsFor, not the whole session list object", () => {
  assert.match(homePageSource, /const \{ fetchSessionsFor \} = useSessionList\(\);/);
  assert.match(homePageSource, /sessions = await fetchSessionsFor\(machine\.id, force\);/);
  assert.doesNotMatch(homePageSource, /\[machines, machinesLoading, sessionList\]/);
});

const sessionListContextSource = fs.readFileSync(new URL("../lib/session-list-context.tsx", import.meta.url), "utf8");

test("Home Refresh bypasses the arbitrary-machine session-list cache", () => {
  assert.match(sessionListContextSource, /fetchSessionsFor\(machineId: string, force\?: boolean\): Promise<SessionInfo\[]>;/);
  assert.match(
    sessionListContextSource,
    /const fetchSessionsFor = useCallback\(async \(targetMachineId: string, force = false\): Promise<SessionInfo\[]> => \{\s*const \{ sessions: fetched \} = await fetchSessionList\(targetMachineId, force\);/,
  );
  assert.match(homePageSource, /const load = useCallback\(async \(force: boolean\) => \{/);
  assert.match(homePageSource, /void load\(reloadKey > 0\);/);
});

test("blocker #3: session-completion notifications build their URL via buildUrl with the session's own machine id, not a bare legacy '?session=' query", () => {
  const notificationBody = callbackBody("deliverSessionNotification", "handleAgentEnd");
  assert.match(
    notificationBody,
    /buildUrl\(\{ machineId: machines\.machineId, project: targetSession\.projectRoot \?\? targetSession\.cwd, session: targetSession\.id \}\)/,
  );
  assert.doesNotMatch(notificationBody, /`\/\?session=\$\{encodeURIComponent\(targetSession\.id\)\}`/);
  assert.match(source, /\}, \[handleSelectSession, machines\.machineId\]\);/);
});

test("minor #9: workspace-memory self-heal confirms against a fresh fetch (never the cached snapshot) before clearing, token-guarded, and keeps memory on fetch failure", () => {
  const handleCwdChangeBody = callbackBody("handleCwdChange", "handleSelectSession");
  // Never clears memory off the stale, in-memory sessionList snapshot alone.
  assert.doesNotMatch(handleCwdChangeBody, /if \(lastOpenId && !restored && !sessionList\.loading\)/);
  assert.match(handleCwdChangeBody, /const myToken = \+\+cwdSelfHealTokenRef\.current;/);
  assert.match(handleCwdChangeBody, /void fetch\(apiPath\("\/api\/sessions"\), \{ cache: "no-store" \}\)/);
  assert.match(handleCwdChangeBody, /if \(!d \|\| cwdSelfHealTokenRef\.current !== myToken\) return;/);
  assert.match(handleCwdChangeBody, /if \(!stillThere\) clearLastOpen\(newProject\);/);
  // A network failure (rejected promise, `.catch`) never clears the memory.
  assert.match(handleCwdChangeBody, /\.catch\(\(\) => \{/);
});

test("minor #6: the selected session id is threaded into SessionListProvider so its own completion doesn't double-reload the list", () => {
  assert.match(source, /sessionList\.setActiveSessionId\(selectedSession\?\.id \?\? null\);/);
});

// final-review fix #1: a popstate between two same-machine settled URLs
// updates NavigationProvider's target but must also update the open
// conversation — AppShellBody's remount key is machineId only, and a
// same-machine navigate() settles synchronously without ever remounting it.

test("final-review fix #1: resolutionRevision threads from NavigationProvider through AppShellMachineKey into AppShellBody", () => {
  assert.match(
    navProviderSource,
    /resolutionRevision: number;/,
  );
  assert.match(source, /interface AppShellBodyProps \{\s*initialTarget: NavigationTarget;\s*initialSession: SessionInfo \| null;\s*resolutionRevision: number;\s*\}/);
  assert.match(
    source,
    /function AppShellMachineKey\(\) \{\s*const \{ machineId \} = useMachines\(\);\s*const \{ target, session, resolutionRevision, home \} = useNavigation\(\);\s*if \(home\) return <HomePage \/>;/,
  );
  assert.match(source, /resolutionRevision=\{resolutionRevision\}/);
});

test("final-review fix #1: NavigationProvider bumps resolutionRevision only from a resolver-delivered result, never from the same-machine navigate() fast path", () => {
  assert.match(
    navProviderSource,
    /resolverRef\.current = createNavigationResolver\(\(next\) => \{\s*setResult\(next\);\s*setResolutionRevision\(\(r\) => r \+ 1\);\s*\}\);/,
  );
  const navigateStart = navProviderSource.indexOf("const navigate = useCallback");
  const navigateEnd = navProviderSource.indexOf("const retry = useCallback", navigateStart);
  const navigateBody = navProviderSource.slice(navigateStart, navigateEnd);
  assert.doesNotMatch(navigateBody, /setResolutionRevision/);
});

test("final-review fix #1: AppShellBody's sync effect is keyed on resolutionRevision alone, adopts or closes to the settled target, and never writes history", () => {
  const effectStart = source.indexOf("useEffect(() => {\n    if (initialSession) {");
  const effectEnd = source.indexOf("}, [resolutionRevision]);", effectStart);
  assert.notEqual(effectStart, -1, "the resolutionRevision sync effect was not found");
  assert.notEqual(effectEnd, -1, "the sync effect must depend on [resolutionRevision] alone");
  const effectBody = source.slice(effectStart, effectEnd);

  // Adopt branch: initialSession differs from what's open -> open it exactly
  // like the old cwd-restore path.
  assert.match(effectBody, /if \(selectedSession\?\.id === initialSession\.id\) return;/);
  assert.match(effectBody, /activeProjectRootRef\.current = initialSession\.projectRoot \?\? initialSession\.cwd;/);
  assert.match(effectBody, /setSelectedSession\(initialSession\);/);
  assert.match(effectBody, /setNewSessionCwd\(null\);/);

  // Close branch: no session at the settled target, but one is open locally
  // -> close it to the URL's project context.
  assert.match(effectBody, /if \(selectedSession\) \{\s*setSelectedSession\(null\);/);
  assert.match(effectBody, /setNewSessionCwd\(initialTarget\.project \?\? null\);/);

  // Popstate must never create/replace history entries from this effect.
  assert.doesNotMatch(effectBody, /router\.(replace|push)\(/);
  assert.doesNotMatch(effectBody, /nav\.navigate\(/);
});
