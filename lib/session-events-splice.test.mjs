// Behavioral guard for the #99 SSE splice (app/api/agent/[id]/events):
//   * the event listener is subscribed BEFORE the fresh boundary is requested;
//   * the first SSE frame is `connected` carrying {seq, journal};
//   * frames admitted while the boundary round-trips are buffered and only
//     the post-boundary ones (hostSeq > boundary.seq) are delivered after it;
//   * later live frames flow with hostSeq; no historical replay ever occurs.
// Runs the REAL route handler against a REAL transport shell + REAL wrapper.
// Individually runnable: bun test lib/session-events-splice.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;
process.env.OMP_WEB_HOST_RUN_DIR = mkdtempSync(join(tmpdir(), "omp99-sse-run-"));
const leaseBase = mkdtempSync(join(tmpdir(), "omp99-sse-lease-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");

const { createSessionTransport } = await import("../ops/session-host/transport.ts");
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { GET } = await import("../app/api/agent/[id]/events/route.ts");

after(() => {
  if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
  else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
  if (savedOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
  else process.env.PI_TEST_SESSION_OWNERS_DIR = savedOwnersDir;
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map();
  rmSync(leaseBase, { recursive: true, force: true });
});

async function until(pred, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Parse an SSE byte stream incrementally into data frames. */
function sseParser() {
  const state = { events: [], pending: "" };
  state.push = (chunk) => {
    state.pending += Buffer.from(chunk).toString("utf8");
    let sep = state.pending.indexOf("\n\n");
    while (sep !== -1) {
      const block = state.pending.slice(0, sep);
      state.pending = state.pending.slice(sep + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) state.events.push(JSON.parse(line.slice(6)));
      }
      sep = state.pending.indexOf("\n\n");
    }
  };
  return state;
}

test("SSE subscribes before the boundary, emits connected{historyBoundary}, then only post-boundary frames", { timeout: 30000 }, async (t) => {
  const runDir = process.env.OMP_WEB_HOST_RUN_DIR;
  const key = `sse-${randomUUID()}`;
  const realId = `real-${randomUUID()}`;

  // Boundary capture is deferred so frames can race the control round-trip.
  let releaseBoundary;
  const boundaryGate = new Promise((resolve) => { releaseBoundary = resolve; });
  let anchorRequests = 0;
  let transport;
  transport = await createSessionTransport({
    sessionId: key, helloSessionId: realId, sessionFile: "", cwd: runDir,
    onFrame: () => {},
    onJournalAttach: () => ({
      seq: transport.currentSeq(),
      journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
    }),
  });
  t.after(async () => { await transport.close(); });

  // Real wrapper over the transport; get_history_anchor answered host-side
  // AFTER the gate opens (simulating the control's round-trip latency).
  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          if (frame.type === "get_history_anchor") {
            anchorRequests++;
            void boundaryGate.then(() => {
              transport.emitHostFrame({
                id: frame.id, type: "response", command: "get_history_anchor", success: true,
                data: {
                  seq: transport.currentSeq(),
                  journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
                },
              });
              // Post-boundary frame queued in the SAME pump tick as the
              // response: the wrapper emits it to the SSE listener before the
              // route's boundary .then microtask runs — it must be buffered
              // and flushed after connected, never dropped.
              transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "racing" }] }, messageId: "m-race" })}\n`);
            });
          }
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
    { sessionId: realId, sessionFile: "", cwd: runDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  // Register so the route's getRpcSession fast path finds it.
  globalThis.__ompSessions = new Map([[realId, wrapper]]);
  t.after(() => wrapper.destroy());

  // Pump host output into the wrapper tap.
  const wire = { frames: [], pending: "", socket: null };
  wire.socket = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq: -1, historyMode: "journal" })}\n`); },
      data(_s, chunk) {
        wire.pending += Buffer.from(chunk).toString("utf8");
        let nl = wire.pending.indexOf("\n");
        while (nl !== -1) {
          const line = wire.pending.slice(0, nl);
          wire.pending = wire.pending.slice(nl + 1);
          if (line.length > 0) wire.frames.push(JSON.parse(line));
          nl = wire.pending.indexOf("\n");
        }
      },
      drain() {}, close() {}, error() {}, end() {},
    },
  });
  const pump = setInterval(() => {
    while (wire.frames.length > 0) {
      wrapper.handleRawStdout(Buffer.from(`${JSON.stringify(wire.frames.shift())}\n`));
    }
  }, 5);
  t.after(() => { clearInterval(pump); wire.socket.end(); });
  await until(() => wrapper.historyBoundary !== undefined, "wrapper attach boundary");

  // Historical frame BEFORE the browser subscribes: must never be delivered.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "old" }, messageId: "m-old" })}\n`);
  await Bun.sleep(30);

  const abort = new AbortController();
  const req = new Request(`http://localhost/api/agent/${realId}/events`, {
    headers: { host: "localhost", "sec-fetch-site": "same-origin" },
    signal: abort.signal,
  });
  const res = await GET(req, { params: Promise.resolve({ id: realId }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const sse = sseParser();
  const reader = res.body.getReader();
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.push(value);
    }
  })();
  t.after(async () => { abort.abort(); try { await readLoop; } catch { /* aborted */ } });

  await until(() => anchorRequests > 0, "boundary control requested");
  assert.equal(sse.events.length, 0, "nothing may be emitted before connected");

  // Pre-boundary frame: admitted while the control round-trips, but its END
  // seq precedes the captured boundary — it must NEVER be delivered.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  await Bun.sleep(30);
  releaseBoundary();
  await until(() => sse.events.some((e) => e.type === "connected"), "connected frame");
  // A later live frame flows normally after the splice.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "live" }] }, messageId: "m-live" })}\n`);
  await until(() => sse.events.some((e) => e.messageId === "m-live"), "post-boundary live frame");
  await Bun.sleep(50);

  const connected = sse.events[0];
  assert.equal(connected.type, "connected", "first frame must be connected");
  assert.equal(connected.sessionId, realId);
  assert.ok(connected.historyBoundary && typeof connected.historyBoundary.seq === "number");
  assert.ok(connected.historyBoundary.journal, "connected carries the journal anchor");
  const boundarySeq = connected.historyBoundary.seq;

  const delivered = sse.events.slice(1);
  for (const event of delivered) {
    assert.equal(typeof event.hostSeq, "number", "every delivered frame carries hostSeq");
    assert.ok(event.hostSeq > boundarySeq, `frame ${event.type} must be strictly post-boundary`);
  }
  assert.ok(!delivered.some((e) => e.type === "message_end"), "no historical replay");
  assert.ok(!delivered.some((e) => e.messageId === "m-old"), "pre-subscription history never delivered");
  assert.ok(!delivered.some((e) => e.type === "agent_start"), "pre-boundary racing frame dropped, not delivered");
  const ids = delivered.map((e) => e.messageId);
  assert.ok(ids.includes("m-race"), "post-boundary frame racing the boundary flush is buffered and delivered");
  assert.ok(ids.includes("m-live"), "later live frame delivered");
  assert.ok(ids.indexOf("m-race") < ids.indexOf("m-live"), "delivery order preserved");
});

test("SSE delivers a pre-existing blocking dialog exactly once as current state after connected", { timeout: 30000 }, async (t) => {
  const runDir = process.env.OMP_WEB_HOST_RUN_DIR;
  const key = `sse-dialog-${randomUUID()}`;
  const realId = `real-${randomUUID()}`;

  let transport;
  transport = await createSessionTransport({
    sessionId: key, helloSessionId: realId, sessionFile: "", cwd: runDir,
    onFrame: () => {},
    onJournalAttach: () => ({
      seq: transport.currentSeq(),
      journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
    }),
  });
  t.after(async () => { await transport.close(); });

  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          if (frame.type === "get_history_anchor") {
            transport.emitHostFrame({
              id: frame.id, type: "response", command: "get_history_anchor", success: true,
              data: { seq: transport.currentSeq(), journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 } },
            });
          }
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
    { sessionId: realId, sessionFile: "", cwd: runDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  globalThis.__ompSessions = new Map([[realId, wrapper]]);
  t.after(() => wrapper.destroy());

  const wire = { frames: [], pending: "", socket: null };
  wire.socket = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq: -1, historyMode: "journal" })}\n`); },
      data(_s, chunk) {
        wire.pending += Buffer.from(chunk).toString("utf8");
        let nl = wire.pending.indexOf("\n");
        while (nl !== -1) {
          const line = wire.pending.slice(0, nl);
          wire.pending = wire.pending.slice(nl + 1);
          if (line.length > 0) wire.frames.push(JSON.parse(line));
          nl = wire.pending.indexOf("\n");
        }
      },
      drain() {}, close() {}, error() {}, end() {},
    },
  });
  const pump = setInterval(() => {
    while (wire.frames.length > 0) {
      wrapper.handleRawStdout(Buffer.from(`${JSON.stringify(wire.frames.shift())}\n`));
    }
  }, 5);
  t.after(() => { clearInterval(pump); wire.socket.end(); });
  await until(() => wrapper.historyBoundary !== undefined, "wrapper attach boundary");

  // Historical message + a blocking dialog BEFORE any SSE subscription.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "old" }, messageId: "m-old" })}\n`);
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Proceed?" })}\n`);
  await until(() => wrapper.pendingExtensionUiRequests().some((d) => d.id === "dlg-1"), "dialog pending in wrapper");

  const abort = new AbortController();
  const req = new Request(`http://localhost/api/agent/${realId}/events`, {
    headers: { host: "localhost" },
    signal: abort.signal,
  });
  const res = await GET(req, { params: Promise.resolve({ id: realId }) });
  assert.equal(res.status, 200);
  const sse = sseParser();
  const reader = res.body.getReader();
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.push(value);
    }
  })();
  t.after(async () => { abort.abort(); try { await readLoop; } catch { /* aborted */ } });

  await until(() => sse.events.some((e) => e.type === "connected"), "connected frame");
  await Bun.sleep(80);
  assert.equal(sse.events[0].type, "connected");
  const dialogs = sse.events.filter((e) => e.type === "extension_ui_request");
  assert.equal(dialogs.length, 1, "pending dialog delivered exactly once as current state");
  assert.equal(dialogs[0].id, "dlg-1");
  assert.equal(dialogs[0].method, "confirm");
  assert.ok(sse.events.indexOf(dialogs[0]) > 0, "dialog arrives AFTER connected");
  assert.ok(!sse.events.some((e) => e.type === "message_end"), "no historical message replay");
});

test("SSE pre-boundary overflow: volatile snapshots coalesce; must-deliver overflow fails recoverably and cleans up", { timeout: 30000 }, async (t) => {
  const runDir = process.env.OMP_WEB_HOST_RUN_DIR;
  const key = `sse-overflow-${randomUUID()}`;
  const realId = `real-${randomUUID()}`;

  let releaseBoundary;
  const boundaryGate = new Promise((resolve) => { releaseBoundary = resolve; });
  let transport;
  transport = await createSessionTransport({
    sessionId: key, helloSessionId: realId, sessionFile: "", cwd: runDir,
    onFrame: () => {},
    onJournalAttach: () => ({
      seq: transport.currentSeq(),
      journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
    }),
  });
  t.after(async () => { await transport.close(); });

  let anchorRequests = 0;
  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          if (frame.type === "get_history_anchor") {
            anchorRequests++;
            void boundaryGate.then(() => {
              transport.emitHostFrame({
                id: frame.id, type: "response", command: "get_history_anchor", success: true,
                data: { seq: transport.currentSeq(), journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 } },
              });
            });
          }
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
    { sessionId: realId, sessionFile: "", cwd: runDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  globalThis.__ompSessions = new Map([[realId, wrapper]]);
  t.after(() => wrapper.destroy());

  const wire = { frames: [], pending: "", socket: null };
  wire.socket = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq: -1, historyMode: "journal" })}\n`); },
      data(_s, chunk) {
        wire.pending += Buffer.from(chunk).toString("utf8");
        let nl = wire.pending.indexOf("\n");
        while (nl !== -1) {
          const line = wire.pending.slice(0, nl);
          wire.pending = wire.pending.slice(nl + 1);
          if (line.length > 0) wire.frames.push(JSON.parse(line));
          nl = wire.pending.indexOf("\n");
        }
      },
      drain() {}, close() {}, error() {}, end() {},
    },
  });
  const pump = setInterval(() => {
    while (wire.frames.length > 0) {
      wrapper.handleRawStdout(Buffer.from(`${JSON.stringify(wire.frames.shift())}\n`));
    }
  }, 5);
  t.after(() => { clearInterval(pump); wire.socket.end(); });
  await until(() => wrapper.historyBoundary !== undefined, "wrapper attach boundary");

  const abort = new AbortController();
  const req = new Request(`http://localhost/api/agent/${realId}/events`, {
    headers: { host: "localhost" },
    signal: abort.signal,
  });
  const res = await GET(req, { params: Promise.resolve({ id: realId }) });
  assert.equal(res.status, 200);
  const sse = sseParser();
  const reader = res.body.getReader();
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.push(value);
    }
  })();
  t.after(async () => { abort.abort(); try { await readLoop; } catch { /* aborted */ } });
  // Prove the route subscribed AND requested the boundary before flooding.
  await until(() => anchorRequests > 0, "boundary control requested");
  assert.equal(sse.events.length, 0, "nothing emitted before connected");

  // Flood volatile snapshots for ONE message while the boundary is pending:
  // they must coalesce to a single slot, never overflow the stream.
  for (let i = 0; i < 5000; i++) {
    transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `snap ${i}` }] }, messageId: "m-flood" })}\n`);
  }
  await Bun.sleep(100);
  assert.ok(!sse.events.some((e) => e.type === "error"), "volatile flood must coalesce, not fail the stream");

  // Now overflow MUST-DELIVER events: the stream must fail recoverably
  // (never silently discard durable events) and close.
  for (let i = 0; i < 5000; i++) {
    transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: `done ${i}` }, messageId: `m-end-${i}` })}\n`);
  }
  await until(() => sse.events.some((e) => e.type === "error"), "recoverable overflow error");
  const err = sse.events.find((e) => e.type === "error");
  assert.equal(err.recoverable, true);
  assert.match(err.error, /backlog|buffer/i);
  await until(() => wrapper.listeners.length === 0, "listener unsubscribed on overflow cleanup");

  // Boundary resolving after the failure must not resurrect the stream.
  releaseBoundary();
  await Bun.sleep(80);
  assert.ok(!sse.events.some((e) => e.type === "connected"), "dead stream never emits connected");
});
