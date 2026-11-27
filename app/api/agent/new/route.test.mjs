// Issue #161: a brand-new chat's composer must show the mode the session will
// really start in. `POST /api/agent/new` is the only place that knows it (the
// host may enter plan mode while creating the session), so BOTH response
// branches must carry `planMode` from the `get_state` the route already awaits.
//
// Harness reused from lib/session-history-routes.test.mjs: a REAL
// AgentSessionWrapper over a fake UDS connection that answers `get_state`, so
// the assertion covers the wrapper's real state overlay rather than a
// hand-rolled session double. Only `startRpcSession` — the route's single seam
// — is stubbed, and the stub delegates to the real implementation whenever no
// fixture is active so other files in the same `bun test` run are unaffected.
// Individually runnable: bun test app/api/agent/new/route.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, mock, test } from "bun:test";

const ENV_KEYS = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];
const workDir = mkdtempSync(join(tmpdir(), "omp161-agent-new-"));
const absentUsersFile = join(workDir, "absent-users.yml");

const fixture = { active: false, session: null };

const realRpc = await import("@/lib/rpc-manager");
mock.module("@/lib/rpc-manager", () => ({
  ...realRpc,
  startRpcSession: async (key, file, cwd, options) => {
    if (!fixture.active) return realRpc.startRpcSession(key, file, cwd, options);
    return { session: fixture.session, realSessionId: "real-161" };
  },
}));

const { AgentSessionWrapper } = realRpc;
const { POST } = await import("./route.ts");

afterAll(() => {
  fixture.active = false;
  fixture.session?.destroy();
  fixture.session = null;
  for (const key of ENV_KEYS) delete process.env[key];
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompAllowedRootsCache = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

/** Run `fn` with web auth off and `cwd` inside the allowed roots. */
async function withOpenAccess(cwd, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_USERS_FILE = absentUsersFile;
  delete process.env.OMP_WEB_SESSIONS_FILE;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompAllowedRootsCache = undefined;
  const { allowFileRoot } = await import("@/lib/file-access");
  allowFileRoot(cwd);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__ompWebUsersCache = undefined;
    globalThis.__ompAllowedRootsCache = undefined;
  }
}

function post(body) {
  return new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A live wrapper whose host answers `get_state` with `state`. */
function startFixtureSession(state) {
  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          if (frame.type !== "get_state") return;
          queueMicrotask(() => {
            wrapper.handleRawStdout(Buffer.from(`${JSON.stringify({
              id: frame.id,
              type: "response",
              command: "get_state",
              success: true,
              data: state,
            })}\n`));
          });
        },
      },
      exited: new Promise(() => {}),
      peekStderr: () => "",
      kill() {},
    },
    detach() { this.isClosed = true; },
    feedStdout() {},
  };
  const wrapper = new AgentSessionWrapper(
    connection,
    { sessionId: "sess-161", sessionFile: "", cwd: workDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  return wrapper;
}

test("ensure_session and prompt responses both carry the host's planMode", async () => {
  const cwd = mkdtempSync(join(workDir, "proj-161-"));
  const planMode = { enabled: true, planFilePath: "local://PLAN.md", available: true };
  fixture.session = startFixtureSession({
    model: { id: "m", provider: "p" },
    thinkingLevel: "low",
    planMode,
  });
  fixture.active = true;
  try {
    await withOpenAccess(cwd, async () => {
      const ensured = await POST(post({ cwd, type: "ensure_session" }));
      assert.equal(ensured.status, 200);
      assert.deepEqual(
        (await ensured.json()).planMode,
        planMode,
        "ensure_session must surface the mode the host started the session in",
      );

      const prompted = await POST(post({ cwd, type: "prompt", message: "hello" }));
      assert.equal(prompted.status, 200);
      assert.deepEqual(
        (await prompted.json()).planMode,
        planMode,
        "the prompt branch must surface it too — the client may not send a first prompt",
      );
    });
  } finally {
    fixture.active = false;
    fixture.session.destroy();
    fixture.session = null;
  }
});

test("a host that reports no plan mode yields planMode null, never a missing key", async () => {
  const cwd = mkdtempSync(join(workDir, "proj-161b-"));
  fixture.session = startFixtureSession({ model: { id: "m", provider: "p" } });
  fixture.active = true;
  try {
    await withOpenAccess(cwd, async () => {
      const res = await POST(post({ cwd, type: "ensure_session" }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok("planMode" in body, "the key must exist so the client can tell null from absent");
      assert.equal(body.planMode, null);
    });
  } finally {
    fixture.active = false;
    fixture.session.destroy();
    fixture.session = null;
  }
});