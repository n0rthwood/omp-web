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
  assert.match(source, /function AppShellBody\(\{ initialTarget, initialSession \}: AppShellBodyProps\)/);
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
