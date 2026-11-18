import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Issue #94 defect 2: after a web restart, surviving session-host processes
// must be re-discovered (sidecar + hello probes) and re-attached even though
// the socket is keyed by a temporary __new__ id while routes ask by real id.
// These are BEHAVIOR tests against a real Bun UDS fake host — each one fails
// if the corresponding defect-2 mechanism regresses.

const transport = await import("./session-host-transport.ts");
const { cacheSessionPath } = await import("./session-reader.ts");

async function loadRpcManager() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

// Lease isolation must be set BEFORE the SDK loads in this process; the
// foreign-lease child inherits it so both meet the same abstract-socket flock.
const leaseBase = mkdtempSync(join(tmpdir(), "omp94-discovery-test-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");
const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;

const rpc = await loadRpcManager();
const { startRpcSession, attachLiveHostIfExists, getRpcSession } = rpc;

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
 * Fake session host: greets hello+ready on EVERY open (contract §3), answers
 * host_attach with hello+ready+host_attach(seq)+session_info, negotiates v2,
 * acks wrapper commands, records prompts without answering them (outcomes
 * arrive as prompt_result, #88). `emit` targets the latest attached client.
 */
function startFakeHost({ runDir, key, realId, sessionFile, cwd }) {
  const hello = { type: "host_hello", protocol: "omp-web-host/1", sessionId: realId, sessionFile, cwd };
  const prompts = [];
  let attachedSocket;
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
          if (frame.type === "host_attach") {
            attachedSocket = socket;
            socket.write(
              `${JSON.stringify(hello)}\n${JSON.stringify(READY_FRAME)}\n` +
              `${JSON.stringify({ type: "host_attach", seq: 0 })}\n` +
              `${JSON.stringify(sessionInfoFrame(realId, sessionFile, cwd))}\n`,
            );
          } else if (frame.type === "negotiate_protocol") {
            socket.write(`${JSON.stringify({ type: "response", id: frame.id, command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } })}\n`);
          } else if (frame.type === "prompt") {
            prompts.push(frame); // fire-and-forget: outcome comes via prompt_result
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
    prompts,
    socketPath: join(runDir, `${key}.sock`),
    emit(frame) {
      assert.ok(attachedSocket, "fake host has no attached client to emit to");
      attachedSocket.write(`${JSON.stringify(frame)}\n`);
    },
    stop() { server.stop(true); },
  };
}

function writeSidecar(runDir, key, pid, info) {
  writeFileSync(join(runDir, `${key}.info`), JSON.stringify({ pid, socketKey: key, info }));
}

function freshRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "omp94-discovery-run-"));
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

async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  assert.ok(condition(), "timed out waiting for condition");
}

/** Spawn a child that exits immediately; resolve its (now dead) pid. */
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

after(() => {
  cleanupRegistry();
  if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
  else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
  if (savedOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
  else process.env.PI_TEST_SESSION_OWNERS_DIR = savedOwnersDir;
  globalThis.__ompDiscoveredHosts = new Map();
  globalThis.__ompDiscoveredHostKeys = new Map();
  rmSync(leaseBase, { recursive: true, force: true });
});

test("sidecar discovery finds a temp-keyed host by real id; dead and malformed sidecars are skipped", async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startFakeHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => { host.stop(); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  const dead = await deadPid();
  const deadId = `dead-${randomUUID()}`;
  writeSidecar(runDir, "dead-host", dead, sessionInfoFrame(deadId, journalPath, cwd));
  writeFileSync(join(runDir, "malformed.info"), "{not valid json");

  await transport.refreshHostDiscovery();
  const discovered = transport.getDiscoveredHosts();
  assert.ok(discovered.has(realId), "live sidecar must be discovered by REAL id");
  assert.equal(discovered.get(realId).socketKey, key);
  assert.equal(transport.hasDiscoveredLiveHost(realId), true);
  assert.equal(transport.discoveredHostCwd(realId), cwd);
  assert.equal(discovered.has(deadId), false, "dead-pid sidecar must be skipped");
  assert.equal(transport.hasDiscoveredLiveHost(deadId), false);
  for (const entry of discovered.values()) assert.notEqual(entry.pid, dead, "no entry may carry the dead pid");
});

test("findHostSocketKeyForSession resolves the temp key via hello sweep without a sidecar; stale sockets never resolve", async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startFakeHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => { host.stop(); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  // No sidecar at all: only the hello sweep can bridge real id → temp key.
  assert.equal(readdirSync(runDir).some((name) => name.endsWith(".info")), false);
  assert.equal(await transport.findHostSocketKeyForSession(realId), key);

  // A stale socket FILE with no listener is never trusted.
  writeFileSync(join(runDir, "stale.sock"), "");
  host.stop();
  assert.equal(await transport.findHostSocketKeyForSession(realId), null);
  assert.equal(await transport.findHostSocketKeyForSession(`absent-${randomUUID()}`), null);
});

test("probeHostSocket returns the hello of a live host and null for dead paths and garbage servers within the bound", async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startFakeHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  const garbage = Bun.listen({
    unix: join(runDir, "garbage.sock"),
    socket: {
      open(socket) { socket.write("this is not json\n"); },
      data() {},
      close() {},
      error() {},
    },
  });
  t.after(() => { host.stop(); garbage.stop(true); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  const hello = await transport.probeHostSocket(host.socketPath);
  assert.ok(hello, "live host must answer the probe");
  assert.equal(hello.sessionId, realId);
  assert.equal(hello.sessionFile, journalPath);

  assert.equal(await transport.probeHostSocket(join(runDir, "missing.sock")), null);

  const started = Date.now();
  assert.equal(await transport.probeHostSocket(join(runDir, "garbage.sock")), null);
  assert.ok(Date.now() - started < 2000, "garbage server must not hang the probe past its bound");
});

test("attachOnly never spawns: no live host rejects cleanly, a surviving temp-keyed host reattaches by real id", async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  t.after(() => { cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  // Empty run dir: attachOnly must refuse BEFORE any lease probe or spawn.
  await assert.rejects(
    startRpcSession(realId, journalPath, undefined, { attachOnly: true }),
    /No live host for this session/,
  );
  assert.equal(readdirSync(runDir).some((name) => name.endsWith(".sock")), false, "attachOnly must never create a socket");
  assert.equal(await attachLiveHostIfExists(realId), undefined, "read-only lookup must not spawn");

  // The surviving host appears under its TEMP key with a sidecar.
  const host = startFakeHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => host.stop());
  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  cacheSessionPath(realId, journalPath);

  const wrapper = await attachLiveHostIfExists(realId);
  assert.ok(wrapper, "surviving host must be reattached");
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.sessionId, realId);
  assert.equal(getRpcSession(realId), wrapper, "registry must be keyed by REAL id");
  assert.equal(await attachLiveHostIfExists(realId), wrapper, "second lookup returns the same wrapper");
});

test("foreign lease refuses the spawn branch but never blocks attaching our own live host", { timeout: 30000 }, async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);

  // Leases are per-process refcounted: a CHILD must hold it (same-process
  // acquire would succeed and prove nothing). It inherits the owners dir.
  const holder = Bun.spawn(
    [process.execPath, "-e", `
      const { tryAcquireSessionLease } = await import("@oh-my-pi/pi-coding-agent");
      const lease = tryAcquireSessionLease(process.env.OMP94_LEASE_ID);
      if (!lease) { console.log("FAILED"); process.exit(1); }
      console.log("HELD");
      setInterval(() => {}, 1000);
    `],
    {
      cwd: process.cwd(),
      env: { ...process.env, OMP94_LEASE_ID: realId },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  t.after(async () => {
    holder.kill();
    await holder.exited;
    cleanupRegistry();
    rmSync(runDir, { recursive: true, force: true });
  });
  // Read incrementally: the holder stays alive, so Response.text() (EOF-based)
  // would hang until the default test timeout kills the run.
  const reader = holder.stdout.getReader();
  let held = "";
  try {
    const deadline = Date.now() + 15000;
    while (!held.includes("HELD") && !held.includes("FAILED") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      held += new TextDecoder().decode(value);
    }
  } finally {
    reader.releaseLock();
  }
  assert.ok(held.includes("HELD"), `lease child must acquire the lease, got: ${held}`);

  // (a) No live host: the spawn branch refuses with the exact foreign-lease text.
  await assert.rejects(
    startRpcSession(realId, journalPath, undefined),
    (error) => error instanceof Error && error.message === transport.FOREIGN_LEASE_ERROR,
  );
  assert.equal(readdirSync(runDir).some((name) => name.endsWith(".sock")), false, "refusal must precede any spawn");

  // (b) Our own live host answers with a matching journal: attach succeeds
  // despite the foreign lease (a live answering socket proves ownership).
  const host = startFakeHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => host.stop());
  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  cacheSessionPath(realId, journalPath);

  const { session, realSessionId } = await startRpcSession(realId, journalPath, undefined);
  assert.equal(realSessionId, realId);
  assert.equal(session.isAlive(), true);
  assert.equal(getRpcSession(realId), session);
});

test("prompt settlement replays across reattach via host_prompt_identity; unknown results touch no draft", async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startFakeHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => { host.stop(); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });
  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  cacheSessionPath(realId, journalPath);

  const first = await attachLiveHostIfExists(realId);
  assert.ok(first);
  const firstEvents = [];
  first.onEvent((event) => firstEvents.push(event));
  await first.send({ type: "prompt", message: "hello", promptId: "draft-42" });
  await waitFor(() => host.prompts.length === 1);
  const commandId = host.prompts[0].id;
  assert.equal(host.prompts[0].promptId, "draft-42", "promptId must ride the web→host prompt frame");

  // Web restart: detach the old wrapper (host survives), attach a fresh one
  // with NO prompt trackers — the outcome must still settle the draft.
  first.destroy();
  const second = await attachLiveHostIfExists(realId);
  assert.ok(second);
  assert.notEqual(second, first);
  const events = [];
  second.onEvent((event) => events.push(event));

  host.emit({ type: "host_prompt_identity", id: commandId, promptId: "draft-42" });
  host.emit({ type: "prompt_result", id: commandId, agentInvoked: true, status: "completed", sessionSettled: true });
  await waitFor(() => events.some((event) => event.type === "prompt_done" && event.promptId === "draft-42"));
  assert.equal(
    events.some((event) => event.type === "host_prompt_identity"),
    false,
    "host_prompt_identity is host-only and must never reach subscribers",
  );
  assert.equal(
    firstEvents.some((event) => event.type === "host_prompt_identity"),
    false,
  );

  // A prompt_result with no stored identity settles nothing draft-related.
  const before = events.length;
  host.emit({ type: "prompt_result", id: `unknown-${randomUUID()}`, agentInvoked: true, status: "completed", sessionSettled: true });
  await waitFor(() => events.length > before);
  const tail = events.slice(before);
  assert.equal(tail.some((event) => event.type === "prompt_done" || event.type === "prompt_error"), false);
});