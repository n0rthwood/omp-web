// Behavioral guards for the #99 bounded history routes (detail tail/anchor +
// context before/after paging) against REAL journals and the REAL handlers:
//   * dead session ?tail=5 returns exactly the latest 5 durable messages with
//     historyPage{anchor,hasEarlier,headEntryId}; anchor bounds later appends;
//   * before/after paging walks the transcript without gaps or duplicates;
//   * malformed anchor / tail inputs are 400, never a file-selection vector;
//   * legacy no-pagination calls keep the full-context shape (no historyPage);
//   * live tail path captures a fresh boundary and NEVER sends get_entries.
// Individually runnable: bun test lib/session-history-routes.test.mjs
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;
process.env.OMP_WEB_HOST_RUN_DIR = mkdtempSync(join(tmpdir(), "omp99-routes-run-"));
const leaseBase = mkdtempSync(join(tmpdir(), "omp99-routes-lease-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");

const { cacheSessionPath, invalidateSessionPathCache } = await import("./session-reader.ts");
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const detail = await import("../app/api/sessions/[id]/route.ts");
const contextRoute = await import("../app/api/sessions/[id]/context/route.ts");

after(() => {
  if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
  else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
  if (savedOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
  else process.env.PI_TEST_SESSION_OWNERS_DIR = savedOwnersDir;
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map();
  globalThis.__ompSessionPathCache = new Map();
  globalThis.__ompPathToSessionIdCache = new Map();
  rmSync(leaseBase, { recursive: true, force: true });
});

function userEntry(id, parentId, text) {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } };
}
function assistantEntry(id, parentId, text) {
  return {
    type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text }] },
  };
}

/** Write a linear journal of n user/assistant pairs; return {path, id, entries}. */
function makeJournal(dir, pairs) {
  const id = `sess-${randomUUID()}`;
  const path = join(dir, `${id}.jsonl`);
  const entries = [];
  let parent = null;
  for (let i = 0; i < pairs; i++) {
    const u = userEntry(`u${i}`, parent, `question ${i}`);
    const a = assistantEntry(`a${i}`, u.id, `answer ${i}`);
    entries.push(u, a);
    parent = a.id;
  }
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
    ...entries.map((e) => JSON.stringify(e)),
  ].join("\n") + "\n");
  return { path, id, entries };
}

function anchorOf(path, entries) {
  const stat = statSync(path);
  return {
    lastEntryId: entries[entries.length - 1]?.id ?? null,
    leafId: entries[entries.length - 1]?.id ?? null,
    entryCount: entries.length,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function get(route, id, query = "") {
  const req = new Request(`http://localhost/api/sessions/${id}${query}`, { headers: { host: "localhost" } });
  return route.GET(req, { params: Promise.resolve({ id }) });
}

async function json(res) {
  return { status: res.status, body: await res.json() };
}

test("dead session tail=5 returns the latest 5 durable messages with a paging anchor; anchor bounds later appends", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp99-tail-"));
  const { path, id } = makeJournal(dir, 60); // 120 entries
  cacheSessionPath(id, path);
  t.after(() => { invalidateSessionPathCache(id); rmSync(dir, { recursive: true, force: true }); });

  const { status, body } = await json(await get(detail, id, "?tail=5"));
  assert.equal(status, 200);
  assert.ok(body.historyPage, "tail path returns historyPage");
  assert.equal(body.context.messages.length, 5);
  assert.deepEqual(body.context.entryIds, ["a57", "u58", "a58", "u59", "a59"]);
  assert.equal(body.historyPage.headEntryId, "a57");
  assert.equal(body.historyPage.hasEarlier, true);
  assert.equal(body.historyPage.anchor.entryCount, 120);
  assert.equal(body.historyPage.anchor.lastEntryId, "a59");
  assert.equal(body.historyPage.anchor.sizeBytes, statSync(path).size);
  assert.equal(body.leafId, "a59");
  assert.ok(Array.isArray(body.tree), "tree metadata present without get_entries");
  // Dead-session metadata parity with the legacy path: firstMessage from the
  // spine, planMode derived from mode_change entries, name from the header.
  assert.equal(body.info.firstMessage, "question 0");
  assert.ok(body.planMode, "planMode present for dead sessions on the tail path");
  assert.equal(body.planMode.enabled, false);

  // Append AFTER the anchor: an anchored read must not include it.
  const anchor = body.historyPage.anchor;
  appendFileSync(path, `${JSON.stringify(userEntry("u60", "a59", "question 60"))}\n${JSON.stringify(assistantEntry("a60", "u60", "answer 60"))}\n`);
  const anchored = await json(await get(detail, id, `?tail=5&anchor=${encodeURIComponent(JSON.stringify(anchor))}`));
  assert.equal(anchored.status, 200);
  assert.deepEqual(anchored.body.context.entryIds, ["a57", "u58", "a58", "u59", "a59"], "anchor excludes later durable entries");
  assert.equal(anchored.body.historyPage.anchor.entryCount, 120);

  // Unanchored tail sees the new tail.
  const fresh = await json(await get(detail, id, "?tail=5"));
  assert.deepEqual(fresh.body.context.entryIds, ["a58", "u59", "a59", "u60", "a60"]);

  // Malformed inputs are 400 — the anchor can never select another file.
  assert.equal((await get(detail, id, "?tail=0")).status, 400);
  assert.equal((await get(detail, id, "?tail=abc")).status, 400);
  assert.equal((await get(detail, id, `?tail=5&anchor=${encodeURIComponent('{"lastEntryId":1}')}`)).status, 400);
  assert.equal((await get(detail, id, "?tail=5&anchor=not-json")).status, 400);

  // Legacy no-pagination call keeps the full-context shape.
  const legacy = await json(await get(detail, id));
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.historyPage, undefined);
  assert.equal(legacy.body.context.messages.length, 122);
});

test("branched journal: firstMessage is the earliest user message and planMode is chronological last-wins", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp99-branch-"));
  const id = `sess-${randomUUID()}`;
  const path = join(dir, `${id}.jsonl`);
  // Physical file order deliberately puts the LATER branch first: a naive
  // DFS/first-visited pick would return "late branch question" / mode "none".
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
    JSON.stringify({ type: "message", id: "u0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "original question" } }),
    JSON.stringify({ type: "message", id: "a0", parentId: "u0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "test", model: "m", content: [{ type: "text", text: "answer" }] } }),
    JSON.stringify({ type: "message", id: "u-late", parentId: "a0", timestamp: "2026-01-01T00:00:09.000Z", message: { role: "user", content: "late branch question" } }),
    JSON.stringify({ type: "mode_change", id: "mc-late", parentId: "u-late", timestamp: "2026-01-01T00:00:10.000Z", mode: "none" }),
    JSON.stringify({ type: "message", id: "u-early", parentId: "a0", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "early branch question" } }),
    JSON.stringify({ type: "mode_change", id: "mc-early", parentId: "u-early", timestamp: "2026-01-01T00:00:04.000Z", mode: "plan", data: { planFilePath: "/tmp/plan.md" } }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  cacheSessionPath(id, path);
  t.after(() => { invalidateSessionPathCache(id); rmSync(dir, { recursive: true, force: true }); });

  const { status, body } = await json(await get(detail, id, "?tail=5"));
  assert.equal(status, 200);
  assert.equal(body.info.firstMessage, "original question", "earliest-timestamp user message wins across branches");
  assert.ok(body.planMode, "planMode derived on branched dead session");
  // Chronological last mode_change is mc-late (00:00:10, mode none) even
  // though mc-early appears later in the physical file.
  assert.equal(body.planMode.enabled, false, "chronological last-wins, not file-order last-wins");
});

test("branched journal: chronologically-last plan mode wins even when file order says otherwise", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp99-branch-plan-"));
  const id = `sess-${randomUUID()}`;
  const path = join(dir, `${id}.jsonl`);
  // File order: plan entry FIRST, none entry LAST — but the none entry is
  // chronologically EARLIER. A file-order last-wins (or a stub dropping
  // mode/data) would wrongly report disabled; chronological last-wins must
  // report the plan mode with its file path.
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
    JSON.stringify({ type: "message", id: "u0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "plan question" } }),
    JSON.stringify({ type: "mode_change", id: "mc-plan", parentId: "u0", timestamp: "2026-01-01T00:00:08.000Z", mode: "plan", data: { planFilePath: "/tmp/plan.md" } }),
    JSON.stringify({ type: "mode_change", id: "mc-none", parentId: "mc-plan", timestamp: "2026-01-01T00:00:03.000Z", mode: "none" }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  cacheSessionPath(id, path);
  t.after(() => { invalidateSessionPathCache(id); rmSync(dir, { recursive: true, force: true }); });

  const { status, body } = await json(await get(detail, id, "?tail=5"));
  assert.equal(status, 200);
  assert.ok(body.planMode, "planMode present");
  assert.equal(body.planMode.enabled, true, "chronologically-last plan entry wins over file-order none");
  assert.equal(body.planMode.planFilePath, "/tmp/plan.md", "mode/data survive the spine stub");
});

test("context before/after paging walks the transcript with no gaps or duplicates", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp99-page-"));
  const { path, id, entries } = makeJournal(dir, 30); // 60 entries
  cacheSessionPath(id, path);
  t.after(() => { invalidateSessionPathCache(id); rmSync(dir, { recursive: true, force: true }); });

  const anchor = anchorOf(path, entries);
  const anchorQ = `&anchor=${encodeURIComponent(JSON.stringify(anchor))}`;

  const tail = await json(await get(contextRoute, id, `?tail=5${anchorQ}`));
  assert.equal(tail.status, 200);
  assert.deepEqual(tail.body.context.entryIds, ["a27", "u28", "a28", "u29", "a29"]);
  assert.equal(tail.body.historyPage.headEntryId, "a27");
  assert.equal(tail.body.historyPage.hasEarlier, true);

  // Page backwards 20 at a time from the head; collect until exhausted.
  const collected = [...tail.body.context.entryIds];
  let before = tail.body.historyPage.headEntryId;
  let pages = 0;
  while (before && pages < 10) {
    const page = await json(await get(contextRoute, id, `?before=${before}&limit=20${anchorQ}`));
    assert.equal(page.status, 200);
    if (page.body.context.entryIds.length === 0) {
      assert.equal(page.body.historyPage.hasEarlier, false);
      break;
    }
    // Strictly earlier than the cursor, newest-first window order preserved.
    const idx = entries.findIndex((e) => e.id === before);
    for (const entryId of page.body.context.entryIds) {
      assert.ok(entries.findIndex((e) => e.id === entryId) < idx, "before page strictly earlier");
    }
    collected.unshift(...page.body.context.entryIds);
    before = page.body.historyPage.headEntryId;
    pages++;
    if (!page.body.historyPage.hasEarlier) break;
  }
  assert.deepEqual(collected, entries.map((e) => e.id), "full walk covers every entry exactly once, in order");

  // Warm delta: after a cached entry returns strictly later messages up to anchor.
  const delta = await json(await get(contextRoute, id, `?after=a27${anchorQ}`));
  assert.equal(delta.status, 200);
  assert.deepEqual(delta.body.context.entryIds, ["u28", "a28", "u29", "a29"]);

  // before+after together is a 400.
  assert.equal((await get(contextRoute, id, "?before=a1&after=a2")).status, 400);

  // Legacy context call: full history, no historyPage.
  const legacy = await json(await get(contextRoute, id));
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.historyPage, undefined);
  assert.equal(legacy.body.context.messages.length, 60);
});

test("live tail path captures a fresh boundary and never sends get_entries", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp99-live-"));
  const { path, id, entries } = makeJournal(dir, 10); // 20 entries
  cacheSessionPath(id, path);
  t.after(() => { invalidateSessionPathCache(id); rmSync(dir, { recursive: true, force: true }); });

  const sent = [];
  let anchorCalls = 0;
  const connection = {
    isClosed: false,
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(String(chunk));
          sent.push(frame.type);
          const respond = (data) => queueMicrotask(() => {
            wrapper.handleRawStdout(Buffer.from(`${JSON.stringify({ id: frame.id, type: "response", command: frame.type, success: true, data })}\n`));
          });
          if (frame.type === "get_history_anchor") {
            anchorCalls++;
            respond({ seq: 1000 + anchorCalls, journal: anchorOf(path, entries) });
          } else if (frame.type === "get_tree") {
            // Bounded tail path must not use the wire tree (full bodies);
            // answer anyway so an accidental send would be observable.
            respond({ tree: [] });
          } else if (frame.type === "get_state") {
            respond({ isStreaming: false, planMode: { enabled: false }, contextUsage: null });
          } else if (frame.type === "get_entries") {
            respond({ entries, leafId: "a9" });
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
    { sessionId: id, sessionFile: path, cwd: dir },
    { attach: () => {}, terminate: { allowed: false } },
  );
  globalThis.__ompSessions = new Map([[id, wrapper]]);
  t.after(() => wrapper.destroy());

  const { status, body } = await json(await get(detail, id, "?tail=5"));
  assert.equal(status, 200);
  assert.equal(anchorCalls, 1, "fresh boundary captured for the live tail");
  assert.ok(!sent.includes("get_entries"), "tail path must NEVER send get_entries");
  assert.ok(!sent.includes("get_tree"), "tail path must NEVER send get_tree (full bodies over the wire)");
  assert.ok(sent.includes("get_history_anchor"));
  assert.ok(Array.isArray(body.tree) && body.tree.length > 0, "tree served from the journal spine, not the wire");
  assert.deepEqual(body.context.entryIds, ["a7", "u8", "a8", "u9", "a9"]);
  assert.equal(body.historyPage.anchor.entryCount, 20);
  assert.ok(body.historyBoundary, "fresh boundary returned when the client had no anchor");
  assert.equal(body.historyBoundary.seq, 1001);

  // With a client anchor, no extra boundary capture is needed.
  const anchorQ = `&anchor=${encodeURIComponent(JSON.stringify(anchorOf(path, entries)))}`;
  const second = await json(await get(detail, id, `?tail=5${anchorQ}`));
  assert.equal(second.status, 200);
  assert.equal(anchorCalls, 1, "client anchor skips the boundary control");
  assert.equal(second.body.historyBoundary, undefined);

  // Live context paging also avoids get_entries.
  sent.length = 0;
  const page = await json(await get(contextRoute, id, `?before=a7&limit=20${anchorQ}`));
  assert.equal(page.status, 200);
  assert.ok(!sent.includes("get_entries"), "context paging must NEVER send get_entries");
  assert.deepEqual(page.body.context.entryIds, entries.slice(0, 15).map((e) => e.id));
});
