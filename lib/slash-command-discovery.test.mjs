import assert from "node:assert/strict";
import test from "node:test";

// Issue #94: slash-command discovery moved with the session into the host
// business layer (ops/session-host/web-compat.ts).
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("../ops/session-host/web-compat.ts");
  } catch {
    return import("../ops/session-host/web-compat.ts");
  }
}

const { getAvailableSlashCommands } = await loadSubject();

function makeSession(promptTemplates = []) {
  return {
    extensionRunner: undefined,
    customCommands: [],
    mcpPromptCommands: [],
    skills: [],
    skillsSettings: { enableSkillCommands: false },
    setSlashCommands() {},
    sessionManager: { getCwd: () => process.cwd() },
    promptTemplates,
  };
}

test("exposes all omp built-in slash commands, including plan and handoff", async () => {
  const commands = await getAvailableSlashCommands(makeSession());
  const byName = new Map(commands.map((command) => [command.name, command]));

  assert.equal(byName.get("plan")?.source, "builtin");
  assert.equal(byName.get("handoff")?.source, "builtin");
  assert.equal(byName.get("plan")?.description, "Toggle plan mode (agent plans before executing)");
  assert.equal(new Set(byName.keys()).size, commands.length);
});

test("retains prompt templates alongside the SDK command registry", async () => {
  const commands = await getAvailableSlashCommands(makeSession([
    { name: "review", description: "Review the current change", source: "/tmp/review.md" },
  ]));

  assert.deepEqual(
    commands.find((command) => command.name === "review"),
    {
      name: "review",
      description: "Review the current change",
      source: "prompt",
      path: "/tmp/review.md",
    },
  );
});