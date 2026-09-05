/**
 * Live harness for issue #31's box:
 *
 *   "Killing the primary's credential mid-conversation moves that
 *   conversation to the next entry in *its* rotated chain, not the globally
 *   configured first backup."
 *
 * MUST be run as a child process with `HOME` already pointed at a throwaway
 * directory built by `buildIsolatedHome()` (see `harness-support.mjs`) —
 * `@oh-my-pi/pi-coding-agent` resolves `getAgentDir()` from `os.homedir()` at
 * the moment this file's static imports run, before any code below executes.
 * `assertIsolatedAgentDir` below is a second, independent guard: it refuses
 * to write anywhere that isn't stamped by `buildIsolatedHome()` — see that
 * function's doc comment for the incident this prevents.
 *
 * Disambiguation is the whole point of this harness: the rotation cursor is
 * pre-seeded so the conversation's rotated primary (`mock/model-c`) is
 * DIFFERENT from the globally configured primary (`mock/model-a`), and its
 * rotated chain (`[model-a, model-b]`) starts with a DIFFERENT entry than the
 * globally configured chain (`[model-b, model-c]`). If omp-web's rotation
 * override ever leaked back to the shared/global `Settings` — the exact trap
 * `applyConversationRotation`'s own doc comment and `rpc-manager.ts` warn
 * about — the credential kill below would fail over to `model-b` (the
 * global chain's first entry) instead of `model-a` (this conversation's own
 * rotated chain's first entry), and the assertion in the driving test would
 * catch it.
 */
import { join } from "node:path";
import { startMockProvider } from "./mock-provider.mjs";
import {
  assertIsolatedAgentDir,
  writeConfigYaml,
  writeModelsYaml,
  writeRotationState,
  readSessionEntries,
} from "./harness-support.mjs";

const resultFile = process.argv[2];
if (!resultFile) throw new Error("usage: rotated-chain-harness.mjs <resultFile>");

const home = process.env.HOME;
const agentDir = join(home, ".omp", "agent");
const cwd = process.cwd();

assertIsolatedAgentDir(agentDir);

const mock = startMockProvider();
writeModelsYaml(agentDir, mock.url, ["model-a", "model-b", "model-c"]);
// Global config: primary model-a, backups [model-b, model-c].
writeConfigYaml(agentDir, {
  defaultModel: "mock/model-a",
  fallbackChain: ["mock/model-b", "mock/model-c"],
});
// Cursor 2 on pool [model-a, model-b, model-c] lands this conversation on
// model-c, whose rotated remainder is [model-a, model-b] — deliberately
// disjoint from the global chain's first entry (model-b).
writeRotationState(agentDir, { enabled: true, roles: { default: true }, cursors: { default: 2 } });

const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
// The application code under test: omp-web's own rotation module, imported
// by its real repo-relative path (resolved against this file's URL, not
// `process.cwd()`, so it works regardless of the child's working directory).
const { applyConversationRotation } = await import("../model-rotation.ts");

async function main() {
  const baseSettings = await Settings.init({ cwd, agentDir });
  const globalChain = baseSettings.get("retry.fallbackChains")?.default ?? [];

  // Mirror lib/rpc-manager.ts exactly: clone before overriding, because
  // getSettingsForCwd() would otherwise hand back the shared instance.
  const sessionSettings = await baseSettings.cloneForCwd(cwd);
  const rotated = applyConversationRotation(sessionSettings, agentDir, {});

  const sessionManager = SessionManager.create(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settings: sessionSettings,
    sessionManager,
    hasUI: false,
  });

  const turn = async (text) => {
    await session.prompt(text, { expandPromptTemplates: false, synthetic: true, userInitiated: false });
    await session.waitForIdle();
  };

  await turn("Turn 1: acknowledge in one short sentence.");

  const primaryModelId = rotated[0]?.primary?.split("/")[1];
  if (!primaryModelId) throw new Error(`rotation did not apply: ${JSON.stringify(rotated)}`);

  // Kill the credential this conversation is actually using (model-c), not
  // the globally configured primary (model-a) — the two differ by design.
  mock.setBehavior(primaryModelId, "unauthorized");

  await turn("Turn 2: continue the conversation.");

  const entries = readSessionEntries(session.sessionFile);
  const modelChanges = entries.filter((e) => e.type === "model_change");
  const fallbackChanges = modelChanges.filter((e) => e.resolvedModelIsFallback === true);

  await session.dispose();

  return {
    globalPrimary: baseSettings.getModelRole("default"),
    globalChain,
    conversationAppliedRotation: rotated,
    conversationPrimaryModelId: primaryModelId,
    allModelChanges: modelChanges.map((e) => ({ model: e.model, resolvedModelIsFallback: e.resolvedModelIsFallback })),
    fallbackModelChanges: fallbackChanges.map((e) => e.model),
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
