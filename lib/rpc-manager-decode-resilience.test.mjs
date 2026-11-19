import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Issue #96 behavior B: the SDK RpcFrameDecoder never clears its pending chunk
// sequence on throw, so ONE interrupted sequence poisoned every later frame and
// every get_state/get_entries/get_tree response was dropped at the decode catch
// → registerPending never settled → session routes hung forever. The wrapper
// must reset the decoder and recover the interrupting non-chunk response.
// BEHAVIOR test against a real Bun UDS fake host (harness copied from
// session-host-discovery.test.mjs); fails (hangs) on the old decoder.

const { cacheSessionPath } = await import("./session-reader.ts");

async function loadRpcManager() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

const leaseBase = mkdtempSync(join(tmpdir(), "omp96-decode-test-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");
const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;

const rpc = await loadRpcManager();
const { startRpcSession } = rpc;

const READY_FRAME = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

function sessionInfoFrame(realId, sessionFile, cwd) {
  return {
    type: "session_info", sessionId: realId, sessionFile, cwd,
    created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1, firstMessage: "hello", persisted: true, status: "complete", isRunning: false,
  };
}

function makeJournal(dir, realId, cwd) {
  const journalPath = join(dir, `${realId}.jsonl`);
  writeFileSync(journalPath, `${JSON.stringify({ type: "session", id: realId, cwd, created: "2026-01-01T00:00:00.000Z" })}\n`);
  return journalPath;
}

// Minimal VALID chunk index 0 that starts a pending reassembly sequence
// (count>=2, byteLength>=1MiB, data<=256KiB base64). The real response that
// follows interrupts it — exactly the production poison trigger.
const chunk0 = {
  type: "rpc_chunk", chunkId: "poison-1", index: 0, count: 2,
  byteLength: 2 * 1024 * 1024,
  data: Buffer.alloc(256 * 1024, 0x41).toString("base64"),
};

/** Fake host: on get_state it emits a valid chunk0 (starts a sequence) then the
 *  real response (interrupts it). Every other command is acked normally. */
function startPoisonHost({ runDir, key, realId, sessionFile, cwd }) {
  const hello = { type: "host_hello", protocol: "omp-web-host/1", sessionId: realId, sessionFile, cwd };
  // Bun UDS socket.write DROPS the unaccepted tail, so the fake host must honor
  // backpressure exactly like the real transport: queue bytes, advance by the
  // accepted count, rewrite the remainder on drain. Without this the ~350KB
  // chunk0 line fills the socket buffer and the response written right after is
  // silently dropped — the wrapper would never see the interrupting frame.
  function makeWriter(socket) {
    const state = { queue: [], inFlight: 0 };
    function pump() {
      if (state.inFlight > 0) return;
      while (state.queue.length > 0) {
        const entry = state.queue[0];
        const payload = entry.offset > 0 ? entry.bytes.subarray(entry.offset) : entry.bytes;
        const written = socket.write(payload);
        if (written <= 0) return;
        entry.offset += written;
        if (entry.offset < entry.bytes.length) { state.inFlight = entry.bytes.length - entry.offset; return; }
        state.queue.shift();
      }
    }
    return {
      write(text) { state.queue.push({ bytes: Buffer.from(text, "utf8"), offset: 0 }); pump(); },
      drain() { state.inFlight = 0; pump(); },
    };
  }
  const server = Bun.listen({
    unix: join(runDir, `${key}.sock`),
    socket: {
      open(socket) {
        socket.data = { buffer: "", writer: makeWriter(socket) };
        socket.data.writer.write(`${JSON.stringify(hello)}\n${JSON.stringify(READY_FRAME)}\n`);
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
          const w = socket.data.writer;
          if (frame.type === "host_attach") {
            w.write(
              `${JSON.stringify(hello)}\n${JSON.stringify(READY_FRAME)}\n` +
              `${JSON.stringify({ type: "host_attach", seq: 0 })}\n` +
              `${JSON.stringify(sessionInfoFrame(realId, sessionFile, cwd))}\n`,
            );
          } else if (frame.type === "negotiate_protocol") {
            w.write(`${JSON.stringify({ type: "response", id: frame.id, command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } })}\n`);
          } else if (frame.type === "get_state") {
            w.write(`${JSON.stringify(chunk0)}\n`);
            w.write(`${JSON.stringify({ type: "response", id: frame.id, command: "get_state", success: true, data: { ok: 1 } })}\n`);
          } else if (typeof frame.id === "string") {
            w.write(`${JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} })}\n`);
          }
        }
      },
      drain(socket) { socket.data.writer.drain(); },
      close() {},
      error() {},
    },
  });
  return { server, socketPath: join(runDir, `${key}.sock`), stop() { server.stop(true); } };
}

function writeSidecar(runDir, key, pid, info) {
  writeFileSync(join(runDir, `${key}.info`), JSON.stringify({ pid, socketKey: key, info }));
}

function freshRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "omp96-decode-run-"));
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

test("get_state resolves after an interrupted chunk sequence (decoder self-heals)", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const realId = `real-${randomUUID()}`;
  const key = `__new__fake-${randomUUID()}`;
  const cwd = join(runDir, "project");
  mkdirSync(cwd);
  const journalPath = makeJournal(runDir, realId, cwd);
  const host = startPoisonHost({ runDir, key, realId, sessionFile: journalPath, cwd });
  t.after(() => { host.stop(); cleanupRegistry(); rmSync(runDir, { recursive: true, force: true }); });

  writeSidecar(runDir, key, process.pid, sessionInfoFrame(realId, journalPath, cwd));
  cacheSessionPath(realId, journalPath);

  const { session } = await startRpcSession(realId, journalPath, undefined, { attachOnly: true });

  // Old decoder: the interrupting response is dropped and registerPending never
  // settles → this race resolves "timeout" → fail. Fixed decoder recovers it.
  const result = await Promise.race([
    session.send({ type: "get_state" }).then((data) => ({ data })).catch((error) => ({ error })),
    Bun.sleep(5000).then(() => ({ timeout: true })),
  ]);
  assert.equal(result.timeout, undefined, "get_state hung: decoder stayed poisoned after the interrupted sequence");
  assert.equal(result.error, undefined, `get_state rejected: ${result.error?.message}`);
  // overlayState enriches get_state data with isPromptRunning/subagents; the
  // load-bearing assertion is that the real payload survived the interruption.
  assert.equal(result.data?.ok, 1, "interrupting get_state response must be recovered intact");
});
