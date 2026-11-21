// Behavioral guards for the #99 host bridge (real Bun UDS, real transport):
//   T1 journal-mode fresh attach NEVER replays historical frames and its ack
//      carries an atomic boundary {seq, journal}; legacy attach still gap-fills.
//   T2 get_history_anchor round-trips through the REAL wrapper against a real
//      transport shell: durable flush happens before the anchor, seq matches
//      the ring end, and each call captures a FRESH boundary.
//   T3 the wrapper stamps every emitted event with the logical frame END seq
//      (hostSeq) and keeps the freshest active partial for get_state.
// Individually runnable: bun test lib/rpc-manager-history-boundary.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;
const leaseBase = mkdtempSync(join(tmpdir(), "omp99-lease-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");

// SessionManager.create() resolves its sessions root from the agent dir, which
// defaults to the REAL ~/.omp/agent. Without this redirect every `bun test` run
// writes journals into the live store and they show up as untitled "(no
// messages)" conversations (/tmp/omp99-run-*). Imported before SessionManager
// so the resolver is built against the redirected dir.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
setAgentDir(join(leaseBase, "agent"));

const { createSessionTransport } = await import("../ops/session-host/transport.ts");
const { captureJournalBoundary } = await import("../ops/session-host/web-compat.ts");
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");

after(() => {
  if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
  else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
  if (savedOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
  else process.env.PI_TEST_SESSION_OWNERS_DIR = savedOwnersDir;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else setAgentDir(savedAgentDir);
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map();
  rmSync(leaseBase, { recursive: true, force: true });
});

function freshRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "omp99-run-"));
  process.env.OMP_WEB_HOST_RUN_DIR = dir;
  return dir;
}

/** Line-splitting UDS collector; records every parsed frame in arrival order. */
async function openCollector(transport, attachFrame) {
  const state = { frames: [], ack: null, pending: "", socket: null };
  state.socket = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify(attachFrame)}\n`); },
      data(_s, chunk) {
        state.pending += Buffer.from(chunk).toString("utf8");
        let nl = state.pending.indexOf("\n");
        while (nl !== -1) {
          const line = state.pending.slice(0, nl);
          state.pending = state.pending.slice(nl + 1);
          if (line.length > 0) {
            const frame = JSON.parse(line);
            state.frames.push(frame);
            if (frame.type === "host_attach") state.ack = frame;
          }
          nl = state.pending.indexOf("\n");
        }
      },
      drain() {}, close() {}, error() {}, end() {},
    },
  });
  return state;
}

async function until(pred, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("T1: journal-mode attach never replays history; ack carries the atomic boundary; legacy attach still gap-fills", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const key = `boundary-${randomUUID()}`;
  const journalPath = join(runDir, "journal.jsonl");
  writeFileSync(journalPath, `${JSON.stringify({ type: "session", id: "real-1", cwd: runDir, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  let boundaryCalls = 0;
  let transport;
  transport = await createSessionTransport({
    sessionId: key, helloSessionId: "real-1", sessionFile: journalPath, cwd: runDir,
    onFrame: () => {},
    onJournalAttach: () => {
      boundaryCalls++;
      // Simulated durable position: the real host callback flushes + stats.
      return {
        seq: transport.currentSeq(),
        journal: { lastEntryId: "e1", leafId: "e1", entryCount: 1, sizeBytes: 100, mtimeMs: 1 },
      };
    },
  });
  t.after(async () => { await transport.close(); rmSync(runDir, { recursive: true, force: true }); });

  // Historical traffic BEFORE any client attaches.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "old history" }, messageId: "m-old" })}\n`);
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_end" })}\n`);

  const fresh = await openCollector(transport, { type: "host_attach", lastSeenSeq: -1, historyMode: "journal" });
  await until(() => fresh.ack !== null, "journal-mode attach ack");
  await Bun.sleep(50);
  assert.equal(boundaryCalls, 1, "boundary captured exactly once, synchronously at attach");
  assert.ok(fresh.ack.boundary, "journal-mode ack must carry the boundary");
  assert.equal(fresh.ack.boundary.seq, fresh.ack.seq);
  assert.equal(fresh.ack.boundary.journal.lastEntryId, "e1");
  const historical = fresh.frames.filter((f) => f.type === "message_end" || f.type === "agent_end");
  assert.equal(historical.length, 0, "fresh journal attach must NEVER replay historical frames");

  // Live frames after the boundary flow normally.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  await until(() => fresh.frames.some((f) => f.type === "agent_start"), "post-boundary live frame");

  // Legacy attach (no historyMode) still replays the retained gap.
  const legacy = await openCollector(transport, { type: "host_attach", lastSeenSeq: 0 });
  await until(() => legacy.ack !== null, "legacy attach ack");
  await until(() => legacy.frames.some((f) => f.type === "message_end"), "legacy gap replay");
  assert.equal(legacy.ack.boundary, undefined, "legacy ack has no boundary");
  fresh.socket.end();
  legacy.socket.end();
});

test("T1b: a THROWING journal capture never replays history, acks boundaryError, and the host survives", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const key = `throw-${randomUUID()}`;
  let transport;
  transport = await createSessionTransport({
    sessionId: key, helloSessionId: "real-throw", sessionFile: "", cwd: runDir,
    onFrame: () => {},
    onJournalAttach: () => { throw new Error("latched disk failure"); },
  });
  t.after(async () => { await transport.close(); rmSync(runDir, { recursive: true, force: true }); });

  // Historical traffic before attach: must NOT be replayed even on failure.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "old" }, messageId: "m-old" })}\n`);
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_end" })}\n`);

  const fresh = await openCollector(transport, { type: "host_attach", lastSeenSeq: -1, historyMode: "journal" });
  await until(() => fresh.ack !== null, "failure ack");
  await Bun.sleep(50);
  assert.equal(fresh.ack.boundary, undefined, "no boundary on capture failure");
  assert.match(fresh.ack.boundaryError, /latched disk failure/, "ack surfaces the capture error");
  const historical = fresh.frames.filter((f) => f.type === "message_end" || f.type === "agent_end");
  assert.equal(historical.length, 0, "journal-mode failure must NEVER fall back to historical replay");

  // Host survives: live frames still flow to the attached client.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  await until(() => fresh.frames.some((f) => f.type === "agent_start"), "host still streams after capture failure");
  fresh.socket.end();
});

test("T2: captureJournalBoundary flushes durable appends and snapshots seq atomically; get_history_anchor round-trips via the wrapper", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const key = `anchor-${randomUUID()}`;
  const sm = await SessionManager.create(runDir);
  await sm.ensureOnDisk();
  const journalPath = sm.getSessionFile();
  assert.ok(journalPath && existsSync(journalPath));
  const transport = await createSessionTransport({
    sessionId: key, helloSessionId: sm.getSessionId(), sessionFile: journalPath, cwd: runDir,
    onFrame: (frame) => {
      // Minimal host-side control answering, mirroring web-compat's case.
      if (frame && typeof frame === "object" && "type" in frame && frame.type === "get_history_anchor") {
        const boundary = captureJournalBoundary(sm, () => transport.currentSeq());
        transport.emitHostFrame({ id: frame.id, type: "response", command: "get_history_anchor", success: true, data: boundary });
      }
    },
  });
  t.after(async () => { await transport.close(); await sm.close(); rmSync(runDir, { recursive: true, force: true }); });

  // Prior sequenced traffic: the ring must already hold frames before the
  // first capture, so the atomic seq snapshot is meaningfully non-zero.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  // Append an entry through the manager; capture must make it durable.
  sm.appendCustomEntry("probe", { text: "hello" });
  const first = captureJournalBoundary(sm, () => transport.currentSeq());
  assert.ok(first.journal.entryCount >= 1, "appended entry counted");
  assert.ok(first.journal.lastEntryId, "lastEntryId captured");
  assert.equal(first.journal.sizeBytes, readFileSync(journalPath).length, "anchor size matches the durable file");
  assert.ok(first.seq > 0, "boundary seq covers the prior sequenced frame");
  assert.equal(first.seq, transport.currentSeq());

  // Wrapper round-trip over the REAL transport: the mock connection's stdin
  // IS the host inbound path (transport.onFrame answers the control), and
  // host output is pumped into the wrapper's raw tap.
  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          if (frame.type === "get_history_anchor") {
            const boundary = captureJournalBoundary(sm, () => transport.currentSeq());
            transport.emitHostFrame({ id: frame.id, type: "response", command: "get_history_anchor", success: true, data: boundary });
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
    { sessionId: sm.getSessionId(), sessionFile: journalPath, cwd: runDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  const collector = await openCollector(transport, { type: "host_attach", lastSeenSeq: -1, historyMode: "journal" });
  await until(() => collector.ack !== null, "wrapper-side attach ack");
  // Route every host frame into the wrapper tap (raw line bytes).
  const pump = setInterval(() => {
    while (collector.frames.length > 0) {
      const frame = collector.frames.shift();
      wrapper.handleRawStdout(Buffer.from(`${JSON.stringify(frame)}\n`));
    }
  }, 5);
  t.after(() => clearInterval(pump));

  const boundary = await wrapper.captureHistoryBoundary();
  assert.ok(boundary.seq >= first.seq, "wrapper-observed boundary covers the prior ring traffic");
  assert.ok(boundary.seq > 0);
  assert.ok(boundary.journal.entryCount >= first.journal.entryCount);
  assert.equal(boundary.journal.sizeBytes, readFileSync(journalPath).length);

  // A later append yields a FRESH, larger boundary on the next capture.
  sm.appendCustomEntry("probe", { text: "world" });
  const second = await wrapper.captureHistoryBoundary();
  assert.ok(second.journal.entryCount > boundary.journal.entryCount, "each capture is fresh");
  assert.ok(second.seq >= boundary.seq);
  wrapper.destroy();
  collector.socket.end();
});

test("T3: wrapper stamps hostSeq on emitted events and exposes the freshest active partial via get_state", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const key = `seq-${randomUUID()}`;
  const transport = await createSessionTransport({
    sessionId: key, helloSessionId: "real-3", sessionFile: "", cwd: runDir,
    onFrame: () => {},
  });
  t.after(async () => { await transport.close(); rmSync(runDir, { recursive: true, force: true }); });

  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          if (frame.type === "get_state") {
            transport.emitHostFrame({ id: frame.id, type: "response", command: "get_state", success: true, data: { isStreaming: true, activePartial: null } });
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
    { sessionId: "real-3", sessionFile: "", cwd: runDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const collector = await openCollector(transport, { type: "host_attach", lastSeenSeq: 0 });
  await until(() => collector.ack !== null, "attach ack");
  const boundarySeq = collector.ack.seq;
  const pump = setInterval(() => {
    while (collector.frames.length > 0) {
      wrapper.handleRawStdout(Buffer.from(`${JSON.stringify(collector.frames.shift())}\n`));
    }
  }, 5);
  t.after(() => clearInterval(pump));

  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] }, messageId: "m-1" })}\n`);
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial text" }] }, messageId: "m-1" })}\n`);
  await until(() => events.some((e) => e.type === "message_update"), "message_update emission");

  const update = events.find((e) => e.type === "message_update");
  assert.equal(typeof update.hostSeq, "number", "every emitted event carries hostSeq");
  assert.ok(update.hostSeq > boundarySeq, "live frame END seq is past the attach boundary");
  const start = events.find((e) => e.type === "message_start");
  assert.ok(start.hostSeq < update.hostSeq, "hostSeq is monotonic per logical frame");

  const { state, hostSeq } = await wrapper.getStateSnapshot();
  assert.ok(hostSeq >= update.hostSeq, "state snapshot seq covers the partial");
  assert.ok(state.activePartial, "active partial exposed via get_state");
  assert.equal(state.activePartial.messageId, "m-1");
  assert.equal(state.activePartial.message.content[0].text, "partial text");
  assert.ok(state.activePartial.hostSeq <= hostSeq);

  // message_end settles the partial: the next snapshot has none.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial text" }] }, messageId: "m-1" })}\n`);
  await until(() => events.some((e) => e.type === "message_end"), "message_end emission");
  const after = await wrapper.getStateSnapshot();
  assert.equal(after.state.activePartial ?? null, null, "partial cleared at message_end");
  wrapper.destroy();
  collector.socket.end();
});

test("T4: journal-mode attach re-emits in-flight prompt identities so a reattached wrapper settles the original draft (#88)", { timeout: 20000 }, async (t) => {
  const runDir = freshRunDir();
  const key = `identity-${randomUUID()}`;
  // Mirrors ops/session-host/main.ts onJournalAttach: identities of admitted
  // prompts still awaiting prompt_result are re-emitted BEFORE the boundary
  // capture (journal-mode attach skips the ring replay that used to carry
  // host_prompt_identity), so they land inside the handshake.
  const pendingIdentities = [{ id: "cmd-1", promptId: "draft-88", streamingBehavior: "steer" }];
  let transport;
  transport = await createSessionTransport({
    sessionId: key, helloSessionId: "real-4", sessionFile: "", cwd: runDir,
    onFrame: () => {},
    onJournalAttach: () => {
      for (const identity of pendingIdentities) {
        transport.emitHostFrame({ type: "host_prompt_identity", ...identity });
      }
      return {
        seq: transport.currentSeq(),
        journal: { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
      };
    },
  });
  t.after(async () => { await transport.close(); rmSync(runDir, { recursive: true, force: true }); });

  const connection = {
    isClosed: false,
    process: {
      stdin: { write() {} },
      exited: new Promise(() => {}),
      peekStderr: () => "",
      kill() {},
    },
    detach() { this.isClosed = true; },
    feedStdout() {},
  };
  const wrapper = new AgentSessionWrapper(
    connection,
    { sessionId: "real-4", sessionFile: "", cwd: runDir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const collector = await openCollector(transport, { type: "host_attach", lastSeenSeq: -1, historyMode: "journal" });
  await until(() => collector.ack !== null, "attach ack");
  let pumped = 0;
  const pump = setInterval(() => {
    while (collector.frames.length > 0) {
      wrapper.handleRawStdout(Buffer.from(`${JSON.stringify(collector.frames.shift())}\n`));
      pumped++;
    }
  }, 5);
  t.after(() => clearInterval(pump));
  // Deterministic: every handshake frame (hello, ack, identity) has been fed
  // through the wrapper tap before the prompt_result is written.
  await until(() => pumped >= 3 && collector.frames.length === 0, "handshake frames consumed");
  assert.ok(collector.ack.boundary.seq > 0, "boundary covers the re-emitted identity bytes");

  // prompt_result for a command THIS wrapper never sent: the tracker-miss
  // path must settle via the re-emitted identity, echoing the client draft.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "prompt_result", id: "cmd-1", status: "completed" })}\n`);
  await until(() => events.some((e) => e.type === "prompt_done"), "draft settlement");
  const done = events.find((e) => e.type === "prompt_done");
  assert.equal(done.promptId, "draft-88", "original submitter draft identity echoed");
  assert.equal(done.streamingBehavior, "steer");
  assert.equal(typeof done.hostSeq, "number");
  wrapper.destroy();
  collector.socket.end();
});
