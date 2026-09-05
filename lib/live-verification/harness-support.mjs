/**
 * Shared, SDK-free utilities for the live #30/#31 verification harnesses.
 *
 * Deliberately imports nothing from `@oh-my-pi/pi-coding-agent`: this module
 * is used both by the `bun:test` driver (running in the *real* process, which
 * must never load the SDK against the real `~/.omp/agent`) and indirectly by
 * the isolated child harnesses. Isolation is env-based (`HOME` points at a
 * throwaway directory) rather than code-based, because `getAgentDir()`
 * resolves from `os.homedir()` at SDK-module-load time — see
 * `node_modules/@oh-my-pi/pi-utils/src/dirs.ts`. That resolution happens the
 * instant a script's *static* `import` of `@oh-my-pi/pi-coding-agent` runs,
 * which for an ES module is before any of the script's own code executes —
 * so `HOME` MUST be set by the process that spawns the child, not by code
 * inside it.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const ISOLATION_MARKER = ".omp-harness-isolated";

/**
 * Build a throwaway `$HOME` + project `cwd`, distinct from any real config,
 * and stamp `agentDir` with a marker file.
 *
 * The marker exists because of a real incident: a smoke run invoked directly
 * (`bun run credential-failover-harness.mjs …`) without going through
 * `runHarness()` inherited the real `$HOME` and silently overwrote this
 * machine's live `~/.omp/agent/{config,models}.yml`. `assertIsolatedAgentDir`
 * (called first thing by every harness, before any write) now refuses to
 * touch an `agentDir` that lacks this marker — a real agent dir never has
 * one, so any invocation that forgets to build an isolated home aborts
 * immediately instead of mutating live state.
 */
export function buildIsolatedHome(label) {
  const home = mkdtempSync(join(tmpdir(), `omp3031-${label}-home-`));
  const agentDir = join(home, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, ISOLATION_MARKER), `harness-owned, created ${new Date().toISOString()}\n`);
  const cwd = mkdtempSync(join(tmpdir(), `omp3031-${label}-cwd-`));
  return { home, agentDir, cwd };
}

/**
 * MUST be the first thing every harness script does with `agentDir`, before
 * writing `config.yml`/`models.yml`/rotation state. Throws if the marker
 * `buildIsolatedHome` stamps is missing — see that function's doc comment.
 */
export function assertIsolatedAgentDir(agentDir) {
  if (!existsSync(join(agentDir, ISOLATION_MARKER))) {
    throw new Error(
      `refusing to write into ${agentDir}: missing ${ISOLATION_MARKER} marker. ` +
        "This dir was not built by buildIsolatedHome() — it may be a real ~/.omp/agent. Aborting before any write.",
    );
  }
}

/** Write `models.yml` with one `mock` provider backed by a local mock server. */
export function writeModelsYaml(agentDir, providerUrl, modelIds) {
  assertIsolatedAgentDir(agentDir);
  const models = modelIds.map((id) => `      - id: ${id}\n        name: ${id}`).join("\n");
  writeFileSync(
    join(agentDir, "models.yml"),
    `providers:\n  mock:\n    baseUrl: ${providerUrl}\n    api: openai-completions\n    apiKey: MOCK_API_KEY\n    authHeader: true\n    models:\n${models}\n`,
  );
}

/**
 * Write `config.yml`. `defaultModel`/`fallbackChain` are bare `mock/<id>`
 * selectors. `retry.maxRetries`/`baseDelayMs` are kept tiny so a real 401
 * fails over fast instead of paying production backoff during a test.
 */
export function writeConfigYaml(agentDir, { defaultModel, fallbackChain, keepRecentTokens = 20000 }) {
  assertIsolatedAgentDir(agentDir);
  const chainLines = fallbackChain.map((m) => `      - ${m}`).join("\n");
  writeFileSync(
    join(agentDir, "config.yml"),
    [
      "modelRoles:",
      `  default: ${defaultModel}`,
      "retry:",
      "  enabled: true",
      "  maxRetries: 3",
      "  baseDelayMs: 5",
      "  maxDelayMs: 2000",
      "  modelFallback: true",
      "  fallbackRevertPolicy: never",
      "  fallbackChains:",
      "    default:",
      chainLines,
      "compaction:",
      "  enabled: true",
      `  keepRecentTokens: ${keepRecentTokens}`,
      "disabledProviders: []",
      "",
    ].join("\n"),
  );
}

const ROTATION_FILE = "omp-web-model-rotation.json";

export function writeRotationState(agentDir, state) {
  assertIsolatedAgentDir(agentDir);
  writeFileSync(join(agentDir, ROTATION_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function readRotationState(agentDir) {
  const p = join(agentDir, ROTATION_FILE);
  if (!existsSync(p)) return { enabled: false, roles: {}, cursors: {} };
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Every entry of a session `.jsonl`, parsed. */
export function readSessionEntries(sessionFile) {
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readModelChangeEntries(sessionFile) {
  return readSessionEntries(sessionFile).filter((e) => e.type === "model_change");
}

/** mtimeMs of a real fleet-state file, or `null` if it does not exist. Used to prove a harness run never touched it. */
export function realStateMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function harnessScript(name) {
  return join(HERE, name);
}

/**
 * Spawn a harness as an isolated child process: `HOME` (and nothing else
 * sensitive) is overridden, so every `@oh-my-pi/pi-coding-agent` path that
 * resolves `getAgentDir()`/`getProjectDir()` — including ones this file never
 * touches directly (discovery, extensions, memories, plugins) — resolves
 * under the throwaway home, never `~/.omp/agent`.
 */
export async function runHarness(scriptPath, { home, cwd, resultFile, extraEnv = {}, timeoutMs = 30_000 }) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", scriptPath, resultFile],
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      MOCK_API_KEY: "sk-mock-isolated-test-key",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  let result;
  if (existsSync(resultFile)) {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  }
  return { exitCode, stdout, stderr, result };
}
