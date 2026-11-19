import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Issue #97: steer/follow-up messages silently lost. Incident (gateway session
// 01a1f18e): the host ring held ZERO steer frames — the LIVE web wrapper had
// stopped round-tripping commands while its socket stayed open. get_state hit
// the #96 30s bound 4 times in a row on the SAME registry-alive wrapper; steer
// had no pending bound at all, and writeBytes silently drops on a closed
// connection, so a steer could 200-ack bytes that never reached the host.
// BEHAVIOR tests against real Bun UDS fake hosts (harness copied from
// session-host-discovery.test.mjs):
//   T1 a connection that silently stops responding must reject the steer
//      within the bound, degrade (evict + destroy) the wrapper, and reattach
//      fresh against the SURVIVING host (detach-only, never kill).
//   T2 a send on a closed connection must throw fast, never silently drop.
//   T3 healthy steer round-trips still resolve; prompt stays fire-and-forget.
// T1/T2 fail on pre-fix code (steer hangs past the race; closed send returns
// null); T3 guards the fix against regressions.

// Short mutation bound BEFORE the module loads: the constant reads it at
// import time. Default in production is 30000 (OMP_WEB_MUTATION_TIMEOUT_MS).
const savedMutationTimeout = process.env.OMP_WEB_MUTATION_TIMEOUT_MS;
process.env.OMP_WEB_MUTATION_TIMEOUT_MS = "300";

const { cacheSessionPath } = await import("./session-reader.ts");

async function loadRpcManager() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

// Lease isolation must be set BEFORE the SDK loads in this process.
const leaseBase = mkdtempSync(join(tmpdir(), "omp97-steer-test-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");
const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;

const rpc = await loadRpcManager();
const { AgentSessionWrapper, startRpcSession, getRpcSession } = rpc;

const READY_FRAME = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

function sessionInfoFrame(realId, sessionFile, cwd, overrides = {}) {
  return {
    type: "session_info",
    sessionId: realId,
    sessionFile,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    persisted: true,
    status: "complete",
    isRunning: false,
    ...overrides,
  };
}

function makeJournal(dir, realId, cwd) {
  const journalPath = join(dir, `${realId}.jsonl`);
  writeFileSync(journalPath, `${JSON.stringify({ type: "session", id: realId, cwd, created: "2026-01-01T00:00:00.000Z" })}\n`);
  return journalPath;
}

/**
 * Fake session host with a per-connection `silent` switch. While silent it
 * ACCEPTS every frame (records it) but never answers — the incident signature:
 * an open socket whose wrapper has stopped round-tripping commands. The host
 * process itself stays healthy; flipping silent off restores full responses
 * on the SAME server, proving reattach works against the surviving host.
 */
function startSilentSwitchHost({ runDir, key, realId, sessionFile, cwd }) {
  const hello = { type: "host_hello", protocol: "omp-web-host/1", sessionId: realId, sessionFile, cwd };
  const received = [];
  const state = { silent: false };
  const server = Bun.listen({
    unix: join(runDir, `${key}.sock`),
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
        socket.write(`${JSON.stringify(hello)}\n${JSON.stringify(READY_FRAME)}\n`);
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString("utf8");
        for (;;) {
          const newline = socket.data.buffer.indexOf("\n");
          if (newline === -1) return;
          const line = socket.data.buffer.slice(0, newline).trim();
          socket.data.buffer = socket.data.buffer.slice(newline + 1);
          if (!line) continue;
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          received.push(frame);
          if (state.silent) continue; // accepted but never answered
          if (frame.type === "host_attach") {
            socket.write(
              `${JSON.stringify(hello)}\n${JSON.stringify(READY_FRAME)}\n` +
              `${JSON.stringify({ type: "host_attach", seq: 0 })}\n` +
              `${JSON.stringify(sessionInfoFrame(realId, sessionFile, cwd))}\n`,
            );
          } else if (frame.type === "negotiate_protocol") {
            socket.write(`${JSON.stringify({ type: "response", id: frame.id, command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } })}\n`);
          } else if (typeof frame.id === "string") {
            socket.write(`${JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} })}\n`);
          }
        }
      },
      close() {},
      error() {},
    },
  });
  return {
    server,
    state,
    received,
    socketPath: join(runDir, `${key}.sock`),
    stop() { server.stop(true); },
  };
}

function writeSidecar(runDir, key, pid, info) {
  writeFileSync(join(runDir, `${key}.info`), JSON.stringify({ pid, socketKey: key, info }));
}

function freshRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "omp97-steer-run-"));
  process.env.OMP_WEB_HOST_RUN_DIR = dir;
  globalThis.__ompDiscoveredHosts = new Map();
  globalThis.__ompDiscoveredHostKeys = new Map();
  return dir;
}

function cleanupRegistry() {
  for (const session of globalThis.__ompSessions?.values() ?? []) {
    try { session.destroy(); } catch { /* already gone */ }
  }
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map();
  globalThis.__ompSessionPathCache = new Map();
}

/** Race a command against a hard deadline; never let the test itself hang. */
function bounded(promise, ms) {
  return Promise.race([
    promise.then((data) => ({ data })).catch((error) => ({ error })),
    Bun.sleep(ms).then(() => ({ timeout: true })),
  ]);
}

after(() => {
  cleanupRegistry();
  if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
  else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
  if (savedOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
  else process.env.PI_TEST_SESSION_OWNERS_DIR = savedOwnersDir;
  if (savedMutationTimeout === undefined) delete process.env.OMP_WEB_MUTATION_TIMEOUT_MS;
  else process.env.OMP_WEB_MUTATION_TIMEOUT_MS = savedMutationTimeout;
  globalThis.__ompDiscoveredHosts = new Map();
  globalThis.__ompDiscoveredHostKeys = new Map();
  rmSync(leaseBase, { recursive: true, force: true });
});

test("T1: a silently non-responding connection rejects steer within the bound, degrades the wrapper, and reattaches against the surviving host", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startSilentSwitchHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => { host.stop(); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  cacheSessionPath(realId, journalPath);

  const { session } = await startRpcSession(realId, journalPath, undefined, { attachOnly: true });
  assert.equal(getRpcSession(realId), session);

  // The connection stops round-tripping while the socket stays open.
  host.state.silent = true;
  const startedAt = Date.now();
  const result = await bounded(session.send({ type: "steer", message: "lost steer" }), 2500);
  const elapsed = Date.now() - startedAt;
  // Pre-fix: no mutation bound exists → the race times out → FAIL.
  assert.equal(result.timeout, undefined, `steer hung ${elapsed}ms on a silently non-responding connection (no pending bound)`);
  assert.ok(result.error instanceof Error, "steer must reject, not silently ack");
  assert.match(result.error.message, /[Tt]imed out/, `expected a retryable timeout error, got: ${result.error.message}`);
  assert.ok(elapsed >= 250 && elapsed < 2500, `rejection must land near the 300ms bound, took ${elapsed}ms`);

  // Degraded: the zombie must not stay the registry alive fast path.
  assert.equal(session.isAlive(), false, "timed-out wrapper must be destroyed");
  assert.equal(getRpcSession(realId), undefined, "timed-out wrapper must be evicted from the registry");
  assert.ok(host.received.some((f) => f.type === "steer"), "the steer frame was written before the timeout");

  // The host SURVIVED (detach-only). A fresh attachOnly reattach must work
  // against the same server and round-trip again.
  host.state.silent = false;
  const reattached = await startRpcSession(realId, journalPath, undefined, { attachOnly: true });
  assert.notEqual(reattached.session, session, "reattach must build a fresh wrapper");
  assert.equal(reattached.session.isAlive(), true);
  assert.equal(getRpcSession(realId), reattached.session);
  const healthy = await bounded(reattached.session.send({ type: "steer", message: "delivered steer" }), 2500);
  assert.equal(healthy.timeout, undefined, "healthy steer after reattach must settle");
  assert.equal(healthy.error, undefined, `healthy steer after reattach rejected: ${healthy.error?.message}`);
  assert.equal(healthy.data, null, "steer keeps its fire-and-forget-shaped null ack");
});

test("T2: send on a closed connection throws fast instead of silently dropping the frame", async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  t.after(() => { cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  // Closed connection whose exit notification has NOT landed yet (exited never
  // settles): the exact window where _alive is still true but writeBytes drops
  // every byte. Mock shape follows rpc-manager-shutdown.test.mjs. A real
  // HostConnection always resolves exited on close, so its exited.then→destroy
  // microtask would mask the defect; the contract under test is that send
  // checks connection liveness ITSELF, not via an eventual destroy.
  function closedConnection() {
    const written = [];
    const exits = [];
    return {
      written,
      exits,
      isClosed: true,
      process: {
        stdin: { write(chunk) { written.push(JSON.parse(String(chunk))); } },
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        exited: new Promise(() => {}), // never settles: no exit rescue
        peekStderr: () => "",
        kill() {},
      },
      detach() { exits.push("detach"); },
      feedStdout() {},
    };
  }
  function makeWrapper(connection) {
    return new AgentSessionWrapper(
      connection,
      { sessionId: realId, sessionFile: journalPath, cwd },
      { attach: () => {}, terminate: { allowed: false } },
    );
  }

  // steer: pre-fix writeFrame drops the bytes and registerPending (unbounded)
  // awaits a response that can never arrive → hang. Fixed: synchronous throw.
  const steerConn = closedConnection();
  const steerWrapper = makeWrapper(steerConn);
  const steer = await bounded(steerWrapper.send({ type: "steer", message: "vanishing steer" }), 1500);
  assert.equal(steer.timeout, undefined, "steer on a closed connection must not hang");
  assert.ok(steer.error instanceof Error, "steer on a closed connection must throw");
  assert.match(steer.error.message, /closed/i);
  assert.equal(steerConn.written.length, 0, "no frame may be written into a closed connection");
  assert.equal(steerWrapper.isAlive(), false, "closed-connection wrapper must be degraded");

  // prompt: the sharpest silent-loss signature — pre-fix it is fire-and-forget,
  // so the dropped bytes still 200-ack (returns null) and the client confirms a
  // draft that never reached the host. Fixed: same fast throw → route 500.
  const promptConn = closedConnection();
  const promptWrapper = makeWrapper(promptConn);
  const prompt = await bounded(promptWrapper.send({ type: "prompt", message: "vanishing prompt", promptId: "draft-x" }), 1500);
  assert.equal(prompt.timeout, undefined);
  assert.ok(prompt.error instanceof Error, "prompt on a closed connection must throw, not 200-ack dropped bytes");
  assert.match(prompt.error.message, /closed/i);
  assert.equal(promptConn.written.length, 0);
  assert.equal(promptWrapper.isAlive(), false);
});

test("T3: healthy steer round-trips resolve and prompt stays fire-and-forget", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startSilentSwitchHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => { host.stop(); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  cacheSessionPath(realId, journalPath);

  const { session } = await startRpcSession(realId, journalPath, undefined, { attachOnly: true });

  const steer = await bounded(session.send({ type: "steer", message: "hello" }), 2500);
  assert.equal(steer.timeout, undefined, "healthy steer must settle well inside the bound");
  assert.equal(steer.error, undefined, `healthy steer rejected: ${steer.error?.message}`);
  assert.equal(steer.data, null);

  const followUp = await bounded(session.send({ type: "follow_up", message: "next" }), 2500);
  assert.equal(followUp.timeout, undefined);
  assert.equal(followUp.error, undefined, `healthy follow_up rejected: ${followUp.error?.message}`);

  // prompt: fire-and-forget at admission (#88) — resolves null immediately even
  // though this fake host never answers the prompt command itself.
  const prompt = await bounded(session.send({ type: "prompt", message: "hi", promptId: "draft-1" }), 1500);
  assert.equal(prompt.timeout, undefined, "prompt admission must not await a host response");
  assert.equal(prompt.error, undefined, `prompt admission rejected: ${prompt.error?.message}`);
  assert.equal(prompt.data, null);
  assert.equal(session.isAlive(), true, "a healthy wrapper must stay alive and registered");
  assert.equal(getRpcSession(realId), session);

  // The mutation bound must not fire on an in-flight prompt after its default:
  // wait past the 300ms test bound; the prompt tracker stays open (no timeout
  // rejection path exists for prompt) and the wrapper stays healthy.
  await Bun.sleep(450);
  assert.equal(session.isAlive(), true, "prompt must be exempt from the mutation timeout");
});
