import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

// issue #21: the floating file panel is one of several top-bar dropdowns
// (branches, system, session, language, files) sharing a single
// activeTopPanel slot. Closing it on click-outside or Escape must listen
// globally and target topBarRef, since the dropdown itself renders
// position: fixed and can sit outside topBarRef's DOM subtree.
test("click-outside/Escape effect closes the active top panel via topBarRef and setActiveTopPanel(null)", () => {
  const effectStart = source.indexOf("useEffect(() => {\n    if (!activeTopPanel) return;");
  assert.notEqual(effectStart, -1, "the top-panel click-outside/Escape effect was not found");
  const effectEnd = source.indexOf("}, [activeTopPanel]);", effectStart);
  assert.notEqual(effectEnd, -1, "the effect must depend on [activeTopPanel] alone");
  const effectBody = source.slice(effectStart, effectEnd);

  assert.match(effectBody, /const handlePointerDown = \(e: MouseEvent\) => \{\s*if \(topBarRef\.current\?\.contains\(e\.target as Node\)\) return;\s*setActiveTopPanel\(null\);/);
  assert.match(effectBody, /const handleKeyDown = \(e: KeyboardEvent\) => \{\s*if \(e\.key === "Escape"\) setActiveTopPanel\(null\);/);
  assert.match(effectBody, /document\.addEventListener\("mousedown", handlePointerDown\);/);
  assert.match(effectBody, /document\.addEventListener\("keydown", handleKeyDown\);/);
  assert.match(effectBody, /document\.removeEventListener\("mousedown", handlePointerDown\);/);
  assert.match(effectBody, /document\.removeEventListener\("keydown", handleKeyDown\);/);
});

// issue #21: the panel's FileExplorer must always reflect the same cwd
// precedence AppShell uses elsewhere — the live machine-reported cwd first,
// then the open session's cwd, then a pending new-session cwd.
test("explorerCwd derives from activeCwd, then selectedSession.cwd, then newSessionCwd", () => {
  assert.match(source, /const explorerCwd = activeCwd \?\? selectedSession\?\.cwd \?\? newSessionCwd \?\? null;/);
});
