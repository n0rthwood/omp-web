/**
 * Live, end-to-end verification for the three acceptance boxes issues #30
 * and #31 left open (code landed in `9483846`/`00c0d94`; only live proof was
 * missing):
 *
 *  - #30 "Killing the primary provider's credential mid-conversation causes
 *    the turn to continue on the next backup, and the transcript's
 *    `model_change` entry names it."
 *  - #31 "Within one conversation, every turn resolves to the same model.
 *    Verified across a compaction and across an idle teardown + resume."
 *  - #31 "Killing the primary's credential mid-conversation moves that
 *    conversation to the next entry in its rotated chain, not the globally
 *    configured first backup."
 *
 * Each box is driven by a dedicated child-process harness under
 * `./live-verification/`. The harnesses run the REAL, unmodified
 * `@oh-my-pi/pi-coding-agent` SDK — real `createAgentSession`, real
 * `session.prompt()`/`compact()`/`dispose()`, real retry/fallback engine —
 * against a local mock `openai-completions` HTTP provider
 * (`live-verification/mock-provider.mjs`), inside a throwaway
 * `$HOME`/`~/.omp/agent` built by `buildIsolatedHome()`. Nothing inside the
 * agent process is mocked; only the model backend is (a local loopback HTTP
 * server, not a stub inside the SDK).
 *
 * "Killing the primary's credential" is reproduced by flipping the mock
 * provider's per-model behavior to 401 `invalid_api_key` mid-conversation —
 * the same wire response a real provider returns once a credential is
 * revoked. Each harness's own header comment states this equivalence.
 *
 * Isolation: `buildIsolatedHome()` stamps a marker file in the throwaway
 * `agentDir`; every harness calls `assertIsolatedAgentDir()` as its first
 * operation and refuses to write anywhere unmarked. This test file itself
 * never imports `@oh-my-pi/pi-coding-agent` — it only spawns child processes
 * and reads back JSON result files — so it never touches Settings/AuthStorage
 * in this (real-`$HOME`) process either. Every test additionally snapshots
 * the real `~/.omp/agent/{config.yml,models.yml,agent.db}` mtimes before and
 * after the harness run and asserts they are unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDefaultTimeout } from "bun:test";
import { buildIsolatedHome, harnessScript, realStateMtime, runHarness } from "./live-verification/harness-support.mjs";

// Each test spawns a real child process that boots the SDK, discovers
// models, and drives 2-4 real HTTP turns against a local mock provider —
// bun test's 5s default is too tight for that under load.
setDefaultTimeout(60_000);

const REAL_CONFIG = join(homedir(), ".omp", "agent", "config.yml");
const REAL_MODELS = join(homedir(), ".omp", "agent", "models.yml");
const REAL_AGENT_DB = join(homedir(), ".omp", "agent", "agent.db");

function snapshotRealAgentState() {
  return { config: realStateMtime(REAL_CONFIG), models: realStateMtime(REAL_MODELS), agentDb: realStateMtime(REAL_AGENT_DB) };
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

test("#30: killing the primary's credential mid-conversation fails over to the configured backup, named in a model_change entry", async () => {
  const before = snapshotRealAgentState();
  const { home, cwd } = buildIsolatedHome("credential-failover");
  try {
    const { exitCode, result, stderr } = await runHarness(harnessScript("credential-failover-harness.mjs"), {
      home,
      cwd,
      resultFile: join(home, "result.json"),
      timeoutMs: 45_000,
    });
    assert.equal(exitCode, 0, `harness process crashed:\n${stderr}`);
    assert.ok(result, "harness produced no result file");
    assert.equal(result.ok, true, result.error);

    // Turn 1 resolves to the configured primary, no fallback.
    assert.deepEqual(result.allModelChanges[0], { model: "mock/model-a", resolvedModelIsFallback: false });
    // After the credential kill, turn 2's model_change names the configured
    // backup and is marked as a fallback switch — this is #30's acceptance
    // text verbatim: "the transcript's model_change entry names it."
    assert.deepEqual(result.fallbackModelChanges, ["mock/model-b"]);
    // The turn actually completed on the backup (not just switched and then
    // errored): a real assistant reply came back naming model-b, stop reason
    // "stop", not "error".
    assert.match(result.lastAssistantText, /model-b/);
    assert.equal(result.lastAssistantStopReason, "stop");
  } finally {
    cleanup(home, cwd);
  }
  assert.deepEqual(snapshotRealAgentState(), before, "real ~/.omp/agent was written by this test");
});

test("#31: killing the primary's credential mid-conversation moves to the next entry of its OWN rotated chain, not the global first backup", async () => {
  const before = snapshotRealAgentState();
  const { home, cwd } = buildIsolatedHome("rotated-chain");
  try {
    const { exitCode, result, stderr } = await runHarness(harnessScript("rotated-chain-harness.mjs"), {
      home,
      cwd,
      resultFile: join(home, "result.json"),
      timeoutMs: 45_000,
    });
    assert.equal(exitCode, 0, `harness process crashed:\n${stderr}`);
    assert.ok(result, "harness produced no result file");
    assert.equal(result.ok, true, result.error);

    // Fixture sanity: the global config and this conversation's rotated pick
    // genuinely disagree — otherwise the test would pass even if omp-web read
    // the wrong (global) chain.
    assert.equal(result.globalPrimary, "mock/model-a");
    assert.deepEqual(result.globalChain, ["mock/model-b", "mock/model-c"]);
    assert.equal(result.conversationPrimaryModelId, "model-c");
    assert.deepEqual(result.conversationAppliedRotation, [
      { role: "default", primary: "mock/model-c", index: 2, poolSize: 3 },
    ]);

    // Turn 1 resolves to THIS conversation's rotated primary (model-c), not
    // the globally configured one (model-a).
    assert.deepEqual(result.allModelChanges[0], { model: "mock/model-c", resolvedModelIsFallback: false });
    // After killing model-c's credential, failover lands on model-a — the
    // first entry of THIS conversation's rotated chain [model-a, model-b] —
    // and NOT model-b, which is what the globally configured chain
    // ([model-b, model-c]) would have produced.
    assert.deepEqual(result.fallbackModelChanges, ["mock/model-a"]);
    assert.notDeepEqual(result.fallbackModelChanges, [result.globalChain[0]]);
  } finally {
    cleanup(home, cwd);
  }
  assert.deepEqual(snapshotRealAgentState(), before, "real ~/.omp/agent was written by this test");
});

test("#31: one conversation resolves to the same model across a real compaction and a real idle-teardown + resume, and resume consumes no rotation slot", async () => {
  const before = snapshotRealAgentState();
  const { home, cwd } = buildIsolatedHome("sticky-rotation");
  try {
    const { exitCode, result, stderr } = await runHarness(harnessScript("sticky-rotation-harness.mjs"), {
      home,
      cwd,
      resultFile: join(home, "result.json"),
      timeoutMs: 45_000,
    });
    assert.equal(exitCode, 0, `harness process crashed:\n${stderr}`);
    assert.ok(result, "harness produced no result file");
    assert.equal(result.ok, true, result.error);

    // Fixture sanity: the conversation's rotated pick genuinely differs from
    // the globally configured primary (model-a), so "sticky" below is
    // provably about the rotated pick, not a coincidence.
    assert.equal(result.rotatedPrimary, "mock/model-b");

    // Creating the conversation consumed exactly one rotation slot.
    assert.equal(result.cursorAfterCreate, result.cursorBefore + 1);
    // Real compaction happened.
    assert.equal(result.compactionOk, true);
    assert.equal(result.compactionEntryCount, 1);
    // Idle teardown (dispose) + resume (reopen) consumed NO further slot —
    // the acceptance criterion's other half ("does not consume a rotation
        // slot" on resume, #31 body).
    assert.equal(result.cursorAfterDispose, result.cursorAfterCreate);
    assert.equal(result.cursorAfterResume, result.cursorAfterCreate);
    assert.equal(result.hasExistingMessagesOnResume, true);

    // Every single model_change entry across the whole conversation — before
    // compaction, right after compaction, after the post-compaction turn,
    // and after idle-teardown + resume — named the SAME model.
    assert.deepEqual(result.distinctModels, ["mock/model-b"]);
    for (const snapshot of [result.beforeCompaction, result.afterCompaction, result.afterPostCompactionTurn, result.afterResumeTurn]) {
      assert.ok(snapshot.length > 0, "expected at least one model_change entry");
      for (const entry of snapshot) assert.equal(entry.model, "mock/model-b");
    }
  } finally {
    cleanup(home, cwd);
  }
  assert.deepEqual(snapshotRealAgentState(), before, "real ~/.omp/agent was written by this test");
});
