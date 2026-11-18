import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}
const { getRpcSessionInfos } = await loadSubject();

// Issue #94: the web tier never reads a live session's journal. The session
// list is computed from the host-pushed session_info mirror; a runtime with
// no mirror (idle empty ensure_session, suppressed host-side) stays hidden.
function makeRuntimeSession({ id, filePath, running, mirror }) {
  return {
    isAlive: () => true,
    isRunning: () => running,
    sessionInfo: mirror,
    get sessionId() { return id; },
    get sessionFile() { return filePath; },
    get cwd() { return "/tmp/runtime-cwd"; },
  };
}

function makeMirror({ id, filePath, persisted, messageCount, firstMessage }) {
  const timestamp = "2026-08-12T01:02:03.000Z";
  return {
    type: "session_info",
    sessionId: id,
    sessionFile: filePath,
    cwd: "/tmp/runtime-cwd",
    created: timestamp,
    modified: timestamp,
    messageCount,
    firstMessage,
    persisted,
    status: persisted ? "idle" : "pending",
    isRunning: !persisted,
  };
}

test("lists an accepted new prompt before its session file exists", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const visibleFile = join(tmpdir(), "pi-web-missing-runtime-session.jsonl");
  const visible = makeRuntimeSession({
    id: "visible-runtime",
    filePath: visibleFile,
    running: true,
    mirror: makeMirror({
      id: "visible-runtime",
      filePath: visibleFile,
      persisted: false,
      messageCount: 1,
      firstMessage: "first prompt",
    }),
  });
  // The host suppresses the mirror for an idle, empty ensure_session runtime.
  const emptyEnsureSession = makeRuntimeSession({
    id: "empty-runtime",
    filePath: join(tmpdir(), "pi-web-missing-empty-session.jsonl"),
    running: false,
    mirror: undefined,
  });
  globalThis.__ompSessions = new Map([
    ["visible-runtime", visible],
    ["empty-runtime", emptyEnsureSession],
  ]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "visible-runtime");
  assert.equal(infos[0].firstMessage, "first prompt");
  assert.equal(infos[0].messageCount, 1);
  assert.equal(infos[0].transient, true);
});

test("keeps an idle runtime visible once its JSONL file exists", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-runtime-session-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  globalThis.__ompSessions = new Map([["persisted-runtime", makeRuntimeSession({
    id: "persisted-runtime",
    filePath,
    running: false,
    mirror: makeMirror({
      id: "persisted-runtime",
      filePath,
      persisted: true,
      messageCount: 0,
      firstMessage: "(no messages)",
    }),
  })]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].transient, false);
});