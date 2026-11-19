import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";


const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
async function loadRoute(path) {
  try {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, {
      alias: { "@": process.cwd() },
      interopDefault: true,
      moduleCache: false,
    });
    return await jiti.import(path);
  } catch {
    return import(path);
  }
}
const { GET: getSessionDetail } = await loadRoute("./[id]/route.ts");
const { GET: getSessionState } = await loadRoute("./[id]/state/route.ts");

/**
 * Run `fn` with web auth disabled: an ambient OMP_WEB_PASSWORD or users file
 * (developer shell) must not make the forged no-credential requests 401 —
 * these routes resolve the synthetic `__anonymous` admin when auth is off.
 */
async function withAuthDisabled(fn) {
  const keys = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  for (const key of keys) delete process.env[key];
  // Point the users store at a path that cannot exist: the developer machine
  // may have a real ~/.omp/agent/omp-web-users.yml (any deployment does once
  // the first user is created), and it must not flip auth back on.
  process.env.OMP_WEB_USERS_FILE = join(tmpdir(), `omp-runtime-route-absent-${process.pid}.yml`);
  globalThis.__ompWebUsersCache = undefined;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) continue;
      process.env[key] = saved[key];
    }
    globalThis.__ompWebUsersCache = undefined;
  }
}

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live host session before requiring a JSONL path", () => {
  // Issue #94: live reads go through the host wire (get_entries/get_tree/
  // get_state); SessionManager.open is only the non-live read-only fallback.
  const liveFirst = [
    [detailRoute, /liveRpc \? undefined : await SessionManager\.open/],
    [contextRoute, /liveRpc\n      \? \(\(await liveRpc\.send/],
  ];
  for (const [source, pattern] of liveFirst) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, pattern);
  }
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionFile = `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`;
  globalThis.__ompSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    sessionInfo: {
      type: "session_info",
      sessionId: id,
      sessionFile,
      cwd: "/tmp",
      created: timestamp,
      modified: timestamp,
      messageCount: 1,
      firstMessage: "hello live",
      persisted: false,
      status: "pending",
      isRunning: true,
    },
    sessionFile,
    sessionId: id,
    cwd: "/tmp",
    send: async (command) => {
      if (command.type === "get_entries") return { entries: [entry], leafId: entry.id };
      if (command.type === "get_tree") return { tree: [] };
      if (command.type === "get_state") return { isStreaming: true };
      if (command.type === "get_history_anchor") {
        return { seq: 0, journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 } };
      }
      return {};
    },
    // #99 contract: state snapshot carries the response frame's END seq.
    getStateSnapshot: async () => ({ state: { isStreaming: true }, hostSeq: 0 }),
  }]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
  });

  await withAuthDisabled(async () => {
    const routeContext = { params: Promise.resolve({ id }) };
    const detailResponse = await getSessionDetail(
      new Request(`http://localhost/api/sessions/${id}`, { headers: { host: "localhost" } }),
      routeContext,
    );
    const stateResponse = await getSessionState(
      new Request(`http://localhost/api/sessions/${id}/state`, { headers: { host: "localhost" } }),
      routeContext,
    );
    const detail = await detailResponse.json();

    assert.equal(detailResponse.status, 200);
    assert.equal(detail.info.transient, true);
    assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
    assert.equal(stateResponse.status, 200);
    assert.deepEqual(await stateResponse.json(), {
      running: true,
      state: { isStreaming: true },
      hostSeq: 0,
    });
  });
});
