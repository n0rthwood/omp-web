/**
 * Live harness for issue #31's box:
 *
 *   "Within one conversation, every turn resolves to the same model.
 *   Verified across a compaction and across an idle teardown + resume."
 *
 * MUST be run as a child process with `HOME` already pointed at a throwaway
 * directory built by `buildIsolatedHome()` — see `credential-failover-harness.mjs`
 * and `harness-support.mjs`'s `assertIsolatedAgentDir` doc comment for why.
 *
 * The rotation cursor is pre-seeded to land the conversation on `model-b`,
 * NOT the globally configured primary `model-a` — proving stickiness means
 * proving the conversation keeps returning to its *rotated* pick, not just
 * "the same value settings.modelRoles.default always had anyway".
 *
 * "Idle teardown + resume" is reproduced by literally doing what
 * `lib/rpc-manager.ts` does: disposing the in-process `AgentSession` (a real
 * idle-teardown does exactly this, dropping the in-memory session while
 * leaving the `.jsonl` on disk) and then reopening the same session file via
 * `SessionManager.open()` and a second `createAgentSession()` call — mirroring
 * `rpc-manager.ts`'s own `hasExistingMessages` gate: no explicit `model` is
 * passed, and `applyConversationRotation` is *not* called for the reopened
 * session, exactly like production. The SDK's own session-restore logic
 * (`sdk.ts`, `existingSession`/`model = restoredModel`) is what should then
 * recover `model-b` from the transcript's last `model_change` entry.
 */
import { join } from "node:path";
import { startMockProvider } from "./mock-provider.mjs";
import {
  assertIsolatedAgentDir,
  writeConfigYaml,
  writeModelsYaml,
  writeRotationState,
  readRotationState,
  readSessionEntries,
} from "./harness-support.mjs";

const resultFile = process.argv[2];
if (!resultFile) throw new Error("usage: sticky-rotation-harness.mjs <resultFile>");

const home = process.env.HOME;
const agentDir = join(home, ".omp", "agent");
const cwd = process.cwd();

assertIsolatedAgentDir(agentDir);

const mock = startMockProvider();
writeModelsYaml(agentDir, mock.url, ["model-a", "model-b"]);
writeConfigYaml(agentDir, {
  defaultModel: "mock/model-a",
  fallbackChain: ["mock/model-b"],
  // Force a real compaction after only two short turns: findCutPoint keeps
  // ~keepRecentTokens of the tail and summarizes everything before it, so a
  // budget of 1 token guarantees the first turn is old enough to summarize.
  keepRecentTokens: 1,
});
// Cursor 1 on pool [model-a, model-b] lands this conversation on model-b —
// different from the globally configured primary (model-a), so "sticky"
// below is provably about the ROTATED pick, not a coincidence.
writeRotationState(agentDir, { enabled: true, roles: { default: true }, cursors: { default: 1 } });

const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
const { applyConversationRotation } = await import("../model-rotation.ts");

const modelsOf = (entries) =>
  entries.filter((e) => e.type === "model_change").map((e) => ({ model: e.model, resolvedModelIsFallback: e.resolvedModelIsFallback }));

async function main() {
  const baseSettings = await Settings.init({ cwd, agentDir });

  const cursorBefore = readRotationState(agentDir).cursors.default ?? 0;

  // --- Session #1: creation, mirrors rpc-manager.ts's `!hasExistingMessages` branch. ---
  const sessionSettings = await baseSettings.cloneForCwd(cwd);
  const rotated = applyConversationRotation(sessionSettings, agentDir, {});
  const rotatedPrimary = rotated[0]?.primary;
  if (!rotatedPrimary) throw new Error(`rotation did not apply: ${JSON.stringify(rotated)}`);

  const cursorAfterCreate = readRotationState(agentDir).cursors.default ?? 0;

  const sessionManager1 = SessionManager.create(cwd);
  const { session: session1 } = await createAgentSession({
    cwd,
    agentDir,
    settings: sessionSettings,
    sessionManager: sessionManager1,
    hasUI: false,
  });
  const sessionFile = session1.sessionFile;

  const turn1 = async (text) => {
    await session1.prompt(text, { expandPromptTemplates: false, synthetic: true, userInitiated: false });
    await session1.waitForIdle();
  };

  await turn1("Turn 1: acknowledge in one short sentence.");
  await turn1("Turn 2: say something else in one short sentence.");

  const beforeCompaction = modelsOf(readSessionEntries(sessionFile));

  // --- Real compaction, same conversation, same in-memory session. ---
  const compactionResult = await session1.compact();

  const afterCompaction = modelsOf(readSessionEntries(sessionFile));
  const compactionEntries = readSessionEntries(sessionFile).filter((e) => e.type === "compaction");

  await turn1("Turn 3: continue after compaction, one short sentence.");
  const afterPostCompactionTurn = modelsOf(readSessionEntries(sessionFile));

  // --- Idle teardown: dispose the in-process session, exactly what rpc-manager.ts does. ---
  await session1.dispose();

  const cursorAfterDispose = readRotationState(agentDir).cursors.default ?? 0;

  // --- Resume: mirrors rpc-manager.ts's `hasExistingMessages` branch — reload,
  // do NOT call applyConversationRotation, do NOT pass an explicit model. ---
  const sessionManager2 = await SessionManager.open(sessionFile, undefined);
  const hasExistingMessages = sessionManager2.buildSessionContext().messages.length > 0;
  const { session: session2 } = await createAgentSession({
    cwd,
    agentDir,
    settings: baseSettings, // the ORIGINAL, unrotated settings — no clone, no override.
    sessionManager: sessionManager2,
    hasUI: false,
  });

  const turn2 = async (text) => {
    await session2.prompt(text, { expandPromptTemplates: false, synthetic: true, userInitiated: false });
    await session2.waitForIdle();
  };

  await turn2("Turn 4: after resume, one short sentence.");
  const afterResumeTurn = modelsOf(readSessionEntries(sessionFile));

  await session2.dispose();

  const cursorAfterResume = readRotationState(agentDir).cursors.default ?? 0;
  const allModelChanges = modelsOf(readSessionEntries(sessionFile));
  const distinctModels = [...new Set(allModelChanges.map((e) => e.model))];

  return {
    rotatedPrimary,
    cursorBefore,
    cursorAfterCreate,
    cursorAfterDispose,
    cursorAfterResume,
    hasExistingMessagesOnResume: hasExistingMessages,
    beforeCompaction,
    afterCompaction,
    compactionEntryCount: compactionEntries.length,
    compactionOk: Boolean(compactionResult),
    afterPostCompactionTurn,
    afterResumeTurn,
    allModelChanges,
    distinctModels,
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
