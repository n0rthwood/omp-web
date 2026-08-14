import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];

const tempDir = mkdtempSync(join(tmpdir(), "omp-web-sessions-vis-"));
const usersFile = join(tempDir, "omp-web-users.yml");
const sessionsFile = join(tempDir, "omp-web-sessions.json");
const sessionsDir = join(tempDir, "sessions");
mkdirSync(sessionsDir);

const VISIBLE_ROOT = "/srv/omp-vis-a";
const HIDDEN_ROOT = "/srv/omp-vis-b";

// Two persisted sessions on disk (header-only JSONL) in different projects.
const persistedSessions = [
  { id: "sess-visible", cwd: VISIBLE_ROOT },
  { id: "sess-hidden", cwd: HIDDEN_ROOT },
];
for (const { id, cwd } of persistedSessions) {
  writeFileSync(
    join(sessionsDir, `${id}.jsonl`),
    `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-08-14T00:00:00.000Z" })}\n`,
  );
}
const sessionFile = (id) => join(sessionsDir, `${id}.jsonl`);

/**
 * Run `fn` with specific OMP_WEB_* values (missing keys are cleared so no
 * developer-shell state — e.g. an ambient OMP_WEB_PASSWORD — leaks in).
 */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Point both stores at the temp dir (auth disabled unless overridden — the
 * ambient OMP_WEB_PASSWORD is cleared by default so it cannot flip auth on)
 * and drop process-global caches.
 */
async function withStore(extraEnv, fn) {
  if (typeof fn !== "function") {
    fn = extraEnv;
    extraEnv = {};
  }
  await withEnv(
    {
      OMP_WEB_USERS_FILE: usersFile,
      OMP_WEB_SESSIONS_FILE: sessionsFile,
      OMP_WEB_PASSWORD: undefined,
      ...extraEnv,
    },
    async () => {
      globalThis.__ompWebUsersCache = undefined;
      globalThis.__ompWebSessions = undefined;
      await fn();
    },
  );
}

/** Seed alice (one visible root) + boss (admin), returning bearer raw tokens. */
async function seedStore() {
  const { hashWebPassword, writeWebUsersConfig, createWebUserToken } = await import("./web-users.ts");
  writeWebUsersConfig({
    users: [
      {
        username: "alice",
        role: "user",
        passwordHash: hashWebPassword("pw-123456"),
        projects: [VISIBLE_ROOT],
        tokens: [],
      },
      {
        username: "boss",
        role: "admin",
        passwordHash: hashWebPassword("pw-123456"),
        projects: "*",
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  const alice = createWebUserToken("alice", "cli");
  const boss = createWebUserToken("boss", "cli");
  assert.ok(alice && boss, "token creation failed");
  return { alice: alice.raw, boss: boss.raw };
}

// The session reader calls SessionManager.listAll() via property access so
// tests can stub the persisted session list (see lib/session-reader.ts).
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const originalListAll = SessionManager.listAll;

function stubPersistedSessions() {
  SessionManager.listAll = async () =>
    persistedSessions.map(({ id, cwd }) => ({
      path: sessionFile(id),
      id,
      cwd,
      title: null,
      created: "2026-08-14T00:00:00.000Z",
      modified: "2026-08-14T00:00:00.000Z",
      messageCount: 0,
      firstMessage: "",
    }));
}

function resetSessionCaches() {
  globalThis.__ompSessionListGeneration = (globalThis.__ompSessionListGeneration ?? 0) + 1;
  globalThis.__ompSessionListCache = undefined;
  globalThis.__ompSessionListPromise = undefined;
  globalThis.__ompSessionPathCache = new Map();
  globalThis.__ompPathToSessionIdCache = new Map();
  globalThis.__ompProjectCache?.clear();
}

/** Live in-process session (runtime-registry idiom from runtime-route.test.mjs). */
function makeLiveSession(id, cwd) {
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd, timestamp: "2026-08-14T00:00:00.000Z" }),
    getEntries: () => [],
    getLeafId: () => null,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => sessionFile(id),
  };
  return {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd,
    send: async () => ({ isStreaming: false }),
  };
}

function withLiveSessions(entries, fn) {
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map(entries);
  return Promise.resolve(fn()).finally(() => {
    globalThis.__ompSessions = previous;
  });
}

/** Forged trusted request (loopback host, no origin header). */
function apiRequest(pathname, { method = "GET", token, body, headers = {} } = {}) {
  const allHeaders = {
    host: "localhost:3000",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  };
  return new Request(`http://localhost:3000${pathname}`, {
    method,
    headers: allHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const loadList = () => import("../app/api/sessions/route.ts");
const loadDetail = () => import("../app/api/sessions/[id]/route.ts");
const loadContext = () => import("../app/api/sessions/[id]/context/route.ts");
const loadState = () => import("../app/api/sessions/[id]/state/route.ts");
const loadExport = () => import("../app/api/sessions/[id]/export/route.ts");
const loadAutoName = () => import("../app/api/sessions/[id]/auto-name/route.ts");
const loadThinking = () => import("../app/api/sessions/[id]/entries/[entryId]/thinking/route.ts");

const routeContext = (params) => ({ params: Promise.resolve(params) });

test.after(() => {
  SessionManager.listAll = originalListAll;
  rmSync(tempDir, { recursive: true, force: true });
});

test("listing shows only sessions under the user's visible root; running ids intersect", async () => {
  await withStore(async () => {
    const tokens = await seedStore();
    stubPersistedSessions();
    resetSessionCaches();
    const { GET } = await loadList();

    await withLiveSessions(
      [
        ["sess-visible", makeLiveSession("sess-visible", VISIBLE_ROOT)],
        ["sess-hidden", makeLiveSession("sess-hidden", HIDDEN_ROOT)],
      ],
      async () => {
        const res = await GET(apiRequest("/api/sessions", { token: tokens.alice }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(
          body.sessions.map((s) => s.id).sort(),
          ["sess-visible"],
        );
        assert.deepEqual(body.runningSessionIds, ["sess-visible"]);
      },
    );

    // Unauthenticated requests never reach routes in production (middleware),
    // but the route must not leak the list if invoked directly.
    resetSessionCaches();
    const denied = await GET(apiRequest("/api/sessions"));
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, "Authentication required");
  });
});

test("admin and auth-disabled listings keep every session", async () => {
  stubPersistedSessions();
  resetSessionCaches();
  const { GET } = await loadList();

  await withStore(async () => {
    const tokens = await seedStore();
    await withLiveSessions(
      [
        ["sess-visible", makeLiveSession("sess-visible", VISIBLE_ROOT)],
        ["sess-hidden", makeLiveSession("sess-hidden", HIDDEN_ROOT)],
      ],
      async () => {
        const res = await GET(apiRequest("/api/sessions", { token: tokens.boss }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.sessions.map((s) => s.id).sort(), ["sess-hidden", "sess-visible"]);
        assert.deepEqual(body.runningSessionIds.slice().sort(), ["sess-hidden", "sess-visible"]);
      },
    );
  });

  // Auth disabled (no users file, no env password): unfiltered, no token.
  await withStore({ OMP_WEB_USERS_FILE: join(tempDir, "missing.yml") }, async () => {
    resetSessionCaches();
    const res = await GET(apiRequest("/api/sessions"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.sessions.map((s) => s.id).sort(), ["sess-hidden", "sess-visible"]);
  });
});

test("hidden session detail endpoints return the uniform 404 for the restricted user", async () => {
  await withStore(async () => {
    const tokens = await seedStore();
    stubPersistedSessions();
    resetSessionCaches();

    const detail = await (await loadDetail()).GET(
      apiRequest("/api/sessions/sess-hidden", { token: tokens.alice }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(detail.status, 404);
    assert.equal((await detail.json()).error, "Session not visible for this user");

    const context = await (await loadContext()).GET(
      apiRequest("/api/sessions/sess-hidden/context", { token: tokens.alice }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(context.status, 404);
    assert.equal((await context.json()).error, "Session not visible for this user");

    const state = await (await loadState()).GET(
      apiRequest("/api/sessions/sess-hidden/state", { token: tokens.alice }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(state.status, 404);
    assert.equal((await state.json()).error, "Session not visible for this user");

    const exportRes = await (await loadExport()).GET(
      apiRequest("/api/sessions/sess-hidden/export", { token: tokens.alice }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(exportRes.status, 404);
    assert.equal((await exportRes.json()).error, "Session not visible for this user");

    const thinking = await (await loadThinking()).GET(
      apiRequest("/api/sessions/sess-hidden/entries/e1/thinking?blockIndex=0", { token: tokens.alice }),
      routeContext({ id: "sess-hidden", entryId: "e1" }),
    );
    assert.equal(thinking.status, 404);
    assert.equal((await thinking.json()).error, "Session not visible for this user");

    const autoName = await (await loadAutoName()).POST(
      apiRequest("/api/sessions/sess-hidden/auto-name", { method: "POST", token: tokens.alice }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(autoName.status, 404);
    assert.equal((await autoName.json()).error, "Session not visible for this user");

    const patched = await (await loadDetail()).PATCH(
      apiRequest("/api/sessions/sess-hidden", {
        method: "PATCH",
        token: tokens.alice,
        body: { name: "renamed" },
      }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(patched.status, 404);
    assert.equal((await patched.json()).error, "Session not visible for this user");

    const deleted = await (await loadDetail()).DELETE(
      apiRequest("/api/sessions/sess-hidden", { method: "DELETE", token: tokens.alice }),
      routeContext({ id: "sess-hidden" }),
    );
    assert.equal(deleted.status, 404);
    assert.equal((await deleted.json()).error, "Session not visible for this user");

    // Nothing above may have mutated or removed the hidden session file.
    assert.ok(existsSync(sessionFile("sess-hidden")), "hidden session file must survive gated mutations");
  });
});

test("visible session detail succeeds for the owning user; admin and auth-disabled reach hidden sessions", async () => {
  stubPersistedSessions();
  resetSessionCaches();

  await withStore(async () => {
    const tokens = await seedStore();
    await withLiveSessions([["sess-visible", makeLiveSession("sess-visible", VISIBLE_ROOT)]], async () => {
      const detail = await (await loadDetail()).GET(
        apiRequest("/api/sessions/sess-visible", { token: tokens.alice }),
        routeContext({ id: "sess-visible" }),
      );
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).sessionId, "sess-visible");

      const state = await (await loadState()).GET(
        apiRequest("/api/sessions/sess-visible/state", { token: tokens.alice }),
        routeContext({ id: "sess-visible" }),
      );
      assert.equal(state.status, 200);
    });
  });

  await withStore(async () => {
    const tokens = await seedStore();
    await withLiveSessions([["sess-hidden", makeLiveSession("sess-hidden", HIDDEN_ROOT)]], async () => {
      const detail = await (await loadDetail()).GET(
        apiRequest("/api/sessions/sess-hidden", { token: tokens.boss }),
        routeContext({ id: "sess-hidden" }),
      );
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).sessionId, "sess-hidden");
    });
  });

  // Auth disabled: previous no-auth behavior — any session reachable.
  await withStore({ OMP_WEB_USERS_FILE: join(tempDir, "missing.yml") }, async () => {
    await withLiveSessions([["sess-hidden", makeLiveSession("sess-hidden", HIDDEN_ROOT)]], async () => {
      const detail = await (await loadDetail()).GET(
        apiRequest("/api/sessions/sess-hidden"),
        routeContext({ id: "sess-hidden" }),
      );
      assert.equal(detail.status, 200);
    });
  });
});

// --- title-first regression (omp rewrites the title entry to line 1) ---------------

// A named session's .jsonl starts with {"type":"title"}: the session header is
// line 2. The [id] guard must still resolve the cwd and hide hidden sessions
// (found live in browser smoke: hidden session returned 200 with metadata).
test("session with a leading title entry is still visibility-gated", async (t) => {
  const titleFirst = { id: "sess-title", cwd: HIDDEN_ROOT };
  persistedSessions.push(titleFirst);
  writeFileSync(
    sessionFile("sess-title"),
    `${JSON.stringify({ type: "title", v: 1, title: "Named", source: "auto", updatedAt: "2026-08-14T00:00:00.000Z" })}\n` +
      `${JSON.stringify({ type: "session", id: "sess-title", cwd: HIDDEN_ROOT, timestamp: "2026-08-14T00:00:00.000Z" })}\n`,
  );
  t.after(() => {
    const index = persistedSessions.findIndex((s) => s.id === "sess-title");
    if (index !== -1) persistedSessions.splice(index, 1);
  });

  await withStore(async () => {
    stubPersistedSessions();
    const tokens = await seedStore();
    const { readSessionHeader } = await import("../lib/session-reader.ts");
    assert.equal(readSessionHeader(sessionFile("sess-title"))?.cwd, HIDDEN_ROOT);

    const detail = await (await loadDetail()).GET(
      apiRequest("/api/sessions/sess-title", { token: tokens.alice }),
      routeContext({ id: "sess-title" }),
    );
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), { error: "Session not visible for this user" });

    // Admin still reads it.
    const boss = await (await loadDetail()).GET(
      apiRequest("/api/sessions/sess-title", { token: tokens.boss }),
      routeContext({ id: "sess-title" }),
    );
    assert.equal(boss.status, 200);
  });
});
