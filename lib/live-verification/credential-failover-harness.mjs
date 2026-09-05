/**
 * Live harness for issue #30's last open acceptance box:
 *
 *   "Killing the primary provider's credential mid-conversation causes the
 *   turn to continue on the next backup, and the transcript's `model_change`
 *   entry names it."
 *
 * MUST be run as a child process with `HOME` already pointed at a throwaway
 * directory (see `harness-support.mjs` `runHarness` / `buildIsolatedHome`) —
 * `@oh-my-pi/pi-coding-agent` resolves `getAgentDir()` from `os.homedir()` at
 * the moment this file's static imports run, before any code below executes.
 *
 * "Killing the credential" is reproduced by a local `openai-completions`
 * mock (`mock-provider.mjs`) that starts answering normally and then, mid
 * conversation, starts returning 401 `invalid_api_key` for the primary model
 * only — the exact wire response a provider gives once a credential is
 * revoked. This exercises the real, unmodified SDK failover engine
 * (`session/turn-recovery.ts`) over real HTTP; nothing inside the agent
 * process is mocked.
 *
 * Rotation (#31) is deliberately OFF here — this box belongs to #30's plain
 * `retry.fallbackChains`, independent of rotation. The rotation-vs-global
 * distinction is a separate harness (`rotated-chain-harness.mjs`).
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
if (!resultFile) throw new Error("usage: credential-failover-harness.mjs <resultFile>");

const home = process.env.HOME;
const agentDir = join(home, ".omp", "agent");
const cwd = process.cwd();

// First operation, before any write: refuse to run against anything but a
// harness-built throwaway agent dir. See harness-support.mjs's doc comment
// on buildIsolatedHome for the incident this guards against.
assertIsolatedAgentDir(agentDir);

const mock = startMockProvider();
writeModelsYaml(agentDir, mock.url, ["model-a", "model-b"]);
writeConfigYaml(agentDir, { defaultModel: "mock/model-a", fallbackChain: ["mock/model-b"] });

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

  // Kill the primary's credential mid-conversation: from this point on, the
  // mock rejects every request naming "model-a" with 401 invalid_api_key,
  // exactly what a real provider returns once the key is revoked.
  mock.setBehavior("model-a", "unauthorized");

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

  await session.dispose();

  return {
    beforeKillModelChangeCount: beforeKill.length,
    allModelChanges: modelChanges.map((e) => ({ model: e.model, resolvedModelIsFallback: e.resolvedModelIsFallback })),
    fallbackModelChanges: fallbackChanges.map((e) => e.model),
    lastAssistantText,
    lastAssistantStopReason: lastAssistant?.message?.stopReason,
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
