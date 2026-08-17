import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("running-session polling moved to SessionListProvider — SessionSidebar only consumes the shared state", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.doesNotMatch(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(source, /const \{ sessions: allSessions, loading, error, runningSessionIds, refreshDone: sessionRefreshDone, refresh: refreshSessions \} = useSessionList\(\);/);
});

test("keeps subagents out of the left session sidebar", () => {
  assert.doesNotMatch(source, /SubagentRail|SubagentPanel|subagents/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});
test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});
test("manual refresh and the completion notification both go through SessionListProvider", () => {
  assert.match(source, /onClick=\{\(\) => refreshSessions\(\)\}/);
  assert.doesNotMatch(source, /\bloadSessions\(/);
  assert.match(source, /completedInBackground\.length > 0[\s\S]*?onBackgroundTaskDone\?\.\(\);/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hovered && !session\.transient && \(/);
});

test("minor #5: unread markers are pruned against the loaded session list, but never while it's still loading", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(loading\) return;\s*setUnreadSessionIds\(\(prev\) => \{\s*const next = new Set\(\[\.\.\.prev\]\.filter\(\(id\) => allSessions\.some\(\(s\) => s\.id === id\)\)\);/,
  );
});

test("minor #8: the project-recency ranking is a shared helper, not a local duplicate of nav-state's default-project pick", () => {
  assert.match(source, /import \{ mostRecentProjectRoots \} from "@\/lib\/project-recency";/);
  assert.match(source, /import \{ loadRemovedProjects, normalizeProjectKey, saveRemovedProjects \} from "@\/lib\/removed-projects";/);
  assert.doesNotMatch(source, /function getRecentProjects/);
  assert.match(source, /const projectPaths = mostRecentProjectRoots\(sessionsForDisplay\)/);
});
