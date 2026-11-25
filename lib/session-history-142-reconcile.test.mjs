import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// #142: journal rebuild must reconcile the frozen spawn receipt (every job
// pending) against the completion frames that live on OTHER rows — a `wait`
// toolResult's details.jobs[] and async-result deliveries. The real session
// 01a212b8 is the regression fixture: #27/#152/#156 (and #131/#208) used to
// rebuild as permanent spinners with no subagent name.
const jiti = createJiti(import.meta.url);
const { readSessionOutline, invalidateJournalIndex } = await jiti.import("./session-history.ts");
const { applyLiveOutlineJobStatus } = await jiti.import("./session-outline.ts");

const REAL_SESSION = join(
  process.env.HOME ?? "",
  ".omp/agent/sessions/-omp-ompweb/2026-11-25T12-40-32-917Z_01a212b8-d595-7000-b235-aba03f0b55b0.jsonl",
);

/** Copy the real journal into an isolated dir so the test never writes it. */
function realJournalCopy() {
  const dir = mkdtempSync(join(tmpdir(), "omp142-real-"));
  const file = join(dir, "session.jsonl");
  copyFileSync(REAL_SESSION, file);
  return { dir, file };
}

function subagentRows(outline) {
  return outline.entries.filter((entry) => entry.role === "subagent");
}

function rowByOrdinal(outline, ordinal) {
  return outline.entries.find((entry) => entry.ordinal + 1 === ordinal && entry.role === "subagent");
}

// The real journal is a machine-local fixture (gateway 172.30.3.123). Skip
// where it is absent so CI and other hosts stay green; the synthetic tests
// below carry the same coverage deterministically.
test("#142 real journal: #27/#152/#156 rebuild terminal with instance names", { skip: existsSync(REAL_SESSION) ? false : "real session journal not present" }, async () => {
  const ctx = realJournalCopy();
  try {
    const outline = await readSessionOutline(ctx.file);
    for (const ordinal of [27, 152, 156]) {
      const row = rowByOrdinal(outline, ordinal);
      assert.ok(row, `#${ordinal} subagent row exists`);
      assert.equal(row.jobStatus, "completed", `#${ordinal} badge is a check, not a spinner`);
      assert.ok(row.jobs && row.jobs.length > 0, `#${ordinal} carries per-job rows`);
      for (const job of row.jobs) {
        assert.equal(job.status, "completed", `#${ordinal} job ${job.id} settled`);
        assert.ok(job.name.length > 0, `#${ordinal} job ${job.id} is named`);
      }
    }
    // #27 is the multi-job row from the issue: both instances settle and name.
    const row27 = rowByOrdinal(outline, 27);
    assert.deepEqual(row27.jobs.map((job) => job.name), ["ScoutModelListTiming", "BuildConfigMockup"]);
    // The whole target set is quiet: only the still-running #244 may spin.
    const spinning = subagentRows(outline).filter((row) => row.jobStatus === "pending" || row.jobStatus === "running");
    assert.deepEqual(spinning.map((row) => row.ordinal + 1), [244]);
  } finally {
    invalidateJournalIndex(ctx.file);
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#142 real journal: delivery rows (#73/#78) keep their own lifecycle", { skip: existsSync(REAL_SESSION) ? false : "real session journal not present" }, async () => {
  const ctx = realJournalCopy();
  try {
    const outline = await readSessionOutline(ctx.file);
    for (const ordinal of [73, 78, 93, 105, 112]) {
      const row = rowByOrdinal(outline, ordinal);
      assert.ok(row, `#${ordinal} delivery row exists`);
      assert.equal(row.jobStatus, "completed", `#${ordinal} delivery row unchanged`);
      assert.ok(row.preview.length > 0, `#${ordinal} keeps its delivery preview`);
    }
  } finally {
    invalidateJournalIndex(ctx.file);
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#142 live merge does not synthesize a duplicate same-name job", () => {
  // Receipt row already carries the instance; a live snapshot with a DIFFERENT
  // id but the same name (the revive path reuses parentToolCallId) must not
  // add a phantom third chip.
  const entries = [{
    entryId: "spawn",
    role: "subagent",
    preview: "task",
    timestamp: "2026-01-01T00:00:00Z",
    ordinal: 1,
    taskCallIds: ["call_1"],
    jobStatus: "running",
    jobs: [{ id: "BuildConfigMockup", name: "BuildConfigMockup", status: "running" }],
  }];
  const merged = applyLiveOutlineJobStatus(entries, [
    { id: "BuildConfigMockup", status: "completed", name: "BuildConfigMockup", parentToolCallId: "call_1" },
  ]);
  assert.equal(merged[0].jobs.length, 1, "no duplicate same-name job");
  assert.equal(merged[0].jobs[0].status, "completed", "the known job upgrades in place");
  assert.equal(merged[0].jobStatus, "completed");
});

test("#142 live merge synthesizes instance name, never the type name", () => {
  const entries = [{
    entryId: "spawn",
    role: "subagent",
    preview: "task",
    timestamp: "2026-01-01T00:00:00Z",
    ordinal: 1,
    taskCallIds: ["call_1"],
    jobStatus: "running",
    jobs: [],
  }];
  const merged = applyLiveOutlineJobStatus(entries, [
    { id: "IntegrateVerify", status: "running", name: "IntegrateVerify", parentToolCallId: "call_1" },
  ]);
  assert.equal(merged[0].jobs.length, 1);
  assert.equal(merged[0].jobs[0].name, "IntegrateVerify", "instance name, not 'task'");
  assert.equal(merged[0].jobs[0].status, "running");
});

test("#142 multi-job wait result settles every job and ignores bash jobs for task rows", async () => {
  // A wait result with 2 task jobs + 1 bash job: the task jobs settle the spawn
  // row; the bash job (jobId key) must not appear on any task row.
  const dir = mkdtempSync(join(tmpdir(), "omp142-mixed-"));
  const file = join(dir, "session.jsonl");
  const ts = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const entries = [
    { type: "session", version: 3, id: "sess-mixed", timestamp: ts(0), cwd: "/tmp/p" },
    { type: "message", id: "u1", parentId: null, timestamp: ts(1), message: { role: "user", content: "go" } },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: ts(2),
      message: {
        role: "assistant", provider: "t", model: "m",
        content: [{ type: "toolCall", id: "call_x", name: "task", arguments: { context: "x" } }],
      },
    },
    {
      type: "message", id: "tr1", parentId: "a1", timestamp: ts(3),
      message: {
        role: "toolResult", toolCallId: "call_x", toolName: "task",
        details: { progress: [{ index: 0, id: "Alpha", agent: "task", status: "pending" }, { index: 1, id: "Beta", agent: "task", status: "pending" }] },
      },
    },
    {
      type: "message", id: "w1", parentId: "tr1", timestamp: ts(4),
      message: {
        role: "toolResult", toolCallId: "call_w", toolName: "wait",
        details: {
          op: "wait",
          jobs: [
            { id: "Alpha", type: "task", status: "completed", label: "Alpha" },
            { id: "Beta", type: "task", status: "failed", label: "Beta" },
            { jobId: "bg_7", type: "bash", status: "completed", label: "ls -la" },
          ],
        },
      },
    },
  ];
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    const outline = await readSessionOutline(file);
    const spawn = subagentRows(outline).find((row) => row.taskCallIds && row.taskCallIds.includes("call_x"));
    assert.ok(spawn, "spawn row present");
    assert.deepEqual(spawn.jobs.map((job) => [job.name, job.status]), [["Alpha", "completed"], ["Beta", "failed"]]);
    assert.equal(spawn.jobStatus, "failed", "worst-status aggregate over the full set");
    assert.ok(!spawn.jobs.some((job) => job.id === "bg_7"), "bash job never joins a task row");
    // The wait toolResult renders but is not an outline row of its own; it
    // only feeds reconciliation, so no outline entry carries the bash job.
    assert.ok(!subagentRows(outline).some((row) => row.jobs?.some((job) => job.id === "bg_7")), "bash job never leaks into any task row");
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});