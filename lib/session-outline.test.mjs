import assert from "node:assert/strict";
import { test } from "bun:test";

const { aggregateOutlineJobStatus, applyLiveOutlineJobStatus } = await import("./session-outline.ts");

function job(id, status, name = id) {
  return { id, name, status };
}

function live(id, status, parentToolCallId = undefined, name = id) {
  return { id, status, name, parentToolCallId };
}

function entry(overrides = {}) {
  return {
    entryId: "spawn",
    role: "subagent",
    preview: "task",
    timestamp: "2026-01-01T00:00:00Z",
    ordinal: 1,
    ...overrides,
  };
}

test("aggregate severity: failed > aborted > running > pending > completed", () => {
  assert.equal(aggregateOutlineJobStatus([]), undefined);
  assert.equal(aggregateOutlineJobStatus([job("a", "completed")]), "completed");
  assert.equal(aggregateOutlineJobStatus([job("a", "completed"), job("b", "pending")]), "pending");
  assert.equal(aggregateOutlineJobStatus([job("a", "pending"), job("b", "running")]), "running");
  assert.equal(aggregateOutlineJobStatus([job("a", "aborted"), job("b", "running")]), "aborted", "worst-status aggregate: a settled abort outranks in-flight work");
  assert.equal(aggregateOutlineJobStatus([job("a", "aborted"), job("b", "completed")]), "aborted");
  assert.equal(aggregateOutlineJobStatus([job("a", "failed"), job("b", "running")]), "failed");
});

test("live snapshot merge upgrades spawn rows and recomputes the aggregate", () => {
  const entries = [entry({
    jobStatus: "running",
    jobs: [job("w1", "running", "scout"), job("w2", "pending", "task")],
  })];
  const merged = applyLiveOutlineJobStatus(entries, [live("w1", "completed"), live("w2", "failed")]);
  assert.notStrictEqual(merged, entries);
  assert.deepEqual(merged[0].jobs, [job("w1", "completed", "scout"), job("w2", "failed", "task")]);
  assert.equal(merged[0].jobStatus, "failed");
  // Input rows are never mutated.
  assert.equal(entries[0].jobs[0].status, "running");
  assert.equal(entries[0].jobStatus, "running");
});

test("live merge precedence: snapshot wins over delivery/spawn statuses", () => {
  // Delivery row already settled completed; a live re-run snapshot re-opens it.
  const entries = [entry({ jobStatus: "completed", jobs: [job("w1", "completed")] })];
  const merged = applyLiveOutlineJobStatus(entries, [live("w1", "running")]);
  assert.equal(merged[0].jobStatus, "running");
  assert.equal(merged[0].jobs[0].status, "running");
});

test("receipt-less spawn rows synthesize jobs from parentToolCallId-matched snapshots", () => {
  // Sync task call: no receipt journaled yet, row defaults to running badge-less.
  const entries = [entry({ jobStatus: "running", taskCallIds: ["call-1"] })];
  const merged = applyLiveOutlineJobStatus(entries, [
    live("w1", "running", "call-1", "scout"),
    live("w2", "pending", "call-1", "task"),
    live("other", "failed", "call-2"),
  ]);
  assert.deepEqual(merged[0].jobs, [job("w1", "running", "scout"), job("w2", "pending", "task")]);
  assert.equal(merged[0].jobStatus, "running");
  // Terminal flip without reload: same row, snapshots settle.
  const settled = applyLiveOutlineJobStatus(merged, [
    live("w1", "completed", "call-1", "scout"),
    live("w2", "failed", "call-1", "task"),
  ]);
  assert.equal(settled[0].jobStatus, "failed");
  assert.deepEqual(settled[0].jobs.map((j) => j.status), ["completed", "failed"]);
});

test("live merge recovers jobs beyond the display cap (uncapped aggregation)", () => {
  // Server capped the display list at 16 completed jobs; jobStatus said completed.
  const capped = Array.from({ length: 16 }, (_, i) => job(`w${i}`, "completed"));
  const entries = [entry({ jobStatus: "completed", jobs: capped, taskCallIds: ["call-1"] })];
  const liveJobs = Array.from({ length: 20 }, (_, i) => live(`w${i}`, i === 19 ? "failed" : "completed", "call-1"));
  const merged = applyLiveOutlineJobStatus(entries, liveJobs);
  assert.equal(merged[0].jobStatus, "failed", "late failure beyond the cap still surfaces");
  assert.equal(merged[0].jobs.length, 16, "display list stays capped");
});

test("live merge is identity-preserving when nothing applies", () => {
  const entries = [
    entry({ jobStatus: "running", jobs: [job("w1", "running")] }),
    entry({ entryId: "user", role: "user", preview: "hi", ordinal: 0 }),
    entry({ entryId: "tool", role: "tool", preview: "bash", ordinal: 2 }),
    entry({ entryId: "nojobs", jobStatus: "running" }),
  ];
  assert.strictEqual(applyLiveOutlineJobStatus(entries, []), entries);
  assert.strictEqual(applyLiveOutlineJobStatus(entries, [live("unknown", "failed")]), entries);
  assert.strictEqual(applyLiveOutlineJobStatus(entries, [live("w1", "running")]), entries, "same status is not a change");
});

test("old payloads without jobs/jobStatus/taskCallIds pass through untouched", () => {
  const entries = [entry(), entry({ entryId: "legacy", jobs: undefined, jobStatus: undefined })];
  assert.strictEqual(applyLiveOutlineJobStatus(entries, [live("spawn", "completed", "call-1")]), entries);
});
