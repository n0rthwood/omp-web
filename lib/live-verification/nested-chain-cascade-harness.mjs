/**
 * Live harness for issue #64's acceptance box — the nested-chain cascade:
 *
 *   "primary fails → fallback A applies → A fails → A's OWN dedicated chain
 *   key must be consulted next."
 *
 * Reproduces the joysort109 incident shape (session 01a0876a, 2026-09-09)
 * against the real, unmodified SDK failover engine over real HTTP:
 *
 *   - primary (mock/model-primary) answers turn 1, then its credential is
 *     killed (401 invalid_api_key) — the wire response a revoked key gets.
 *   - the `default` chain is [mock/model-x, mock/model-a], where model-x
 *     fails permanently (403 AccessDenied.Unpurchased, the exact bailian
 *     error from the incident) and model-a is the chain's LAST entry.
 *   - model-a has its own dedicated chain key `"mock/model-a"` whose first
 *     entry, mock/model-c, is healthy.
 *
 * On the fixed SDK (>= 17.4.1) turn 2 cascades primary → x → a, and when a
 * itself fails, `retryFallbackChainKeys` re-resolves to a's own chain key
 * (the pinned `default` key has no candidates left — a is its last entry),
 * so the turn completes on model-c. On the buggy SDK (<= 17.3.0) the sticky
 * chain key reused `default` for a's failure, found zero candidates, and the
 * turn died on a's 403 — model-c was never even requested.
 *
 * MUST be run as a child process with `HOME` already pointed at a throwaway
 * directory (see `harness-support.mjs` `runHarness` / `buildIsolatedHome`).
 */
import { join } from "node:path";
import { startMockProvider } from "./mock-provider.mjs";
import {
  assertIsolatedAgentDir,
  writeConfigYaml,
  writeModelsYaml,
  readModelChangeEntries,
  readSessionEntries,
} from "./harness-support.mjs";

const resultFile = process.argv[2];
if (!resultFile) throw new Error("usage: nested-chain-cascade-harness.mjs <resultFile>");

const home = process.env.HOME;
const agentDir = join(home, ".omp", "agent");
const cwd = process.cwd();

// First operation, before any write: refuse to run against anything but a
// harness-built throwaway agent dir.
assertIsolatedAgentDir(agentDir);

const mock = startMockProvider();
writeModelsYaml(agentDir, mock.url, ["model-primary", "model-x", "model-a", "model-c"]);
writeConfigYaml(agentDir, {
  defaultModel: "mock/model-primary",
  fallbackChain: ["mock/model-x", "mock/model-a"],
  extraFallbackChains: { "mock/model-a": ["mock/model-c"] },
  // Four model attempts happen inside turn 2 (primary, x, a, c); give the
  // retry budget one spare hop.
  maxRetries: 5,
});

const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

async function main() {
  const settings = await Settings.init({ cwd, agentDir });
  const sessionManager = SessionManager.create(cwd);
  const { session } = await createAgentSession({ cwd, agentDir, settings, sessionManager, hasUI: false });

  const turn = async (text) => {
    await session.prompt(text, { expandPromptTemplates: false, synthetic: true, userInitiated: false });
    await session.waitForIdle();
  };

  await turn("Turn 1: acknowledge in one short sentence.");
  const beforeKill = readModelChangeEntries(session.sessionFile);

  // The incident: the primary's credential is revoked mid-conversation, and
  // every model the default chain can offer is permanently broken — except
  // the nested chain's entry, which only a correct cascade can reach.
  mock.setBehavior("model-primary", "unauthorized");
  mock.setBehavior("model-x", "forbidden");
  mock.setBehavior("model-a", "forbidden");

  await turn("Turn 2: continue the conversation.");

  const entries = readSessionEntries(session.sessionFile);
  const modelChanges = entries.filter((e) => e.type === "model_change");
  const fallbackChanges = modelChanges.filter((e) => e.resolvedModelIsFallback === true);
  const assistantMessages = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const lastAssistantText = (lastAssistant?.message?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // The hop-by-hop evidence: everything from the first failed primary request
  // onward, as (model, outcome) pairs. This is the cascade ORDER.
  const firstFailureIndex = mock.requestLog.findIndex((r) => r.mode !== "ok");
  const cascade = mock.requestLog
    .slice(firstFailureIndex === -1 ? 0 : firstFailureIndex)
    .map((r) => ({ model: r.model, mode: r.mode }));

  await session.dispose();

  return {
    beforeKillModelChangeCount: beforeKill.length,
    allModelChanges: modelChanges.map((e) => ({ model: e.model, resolvedModelIsFallback: e.resolvedModelIsFallback })),
    fallbackModelChanges: fallbackChanges.map((e) => e.model),
    lastAssistantText,
    lastAssistantStopReason: lastAssistant?.message?.stopReason,
    cascade,
    requestLog: mock.requestLog,
  };
}

try {
  const facts = await main();
  await Bun.write(resultFile, JSON.stringify({ ok: true, ...facts }, null, 2));
} catch (error) {
  await Bun.write(
    resultFile,
    JSON.stringify({ ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }, null, 2),
  );
} finally {
  mock.stop();
}
