import {
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { installUsageProviderOverrides } from "./usage-providers";

/**
 * Process-wide omp services.
 *
 * The `omp` CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per
 * process and hands them to every session. omp-web serves many requests from
 * one process, so it builds them once too and re-scopes `Settings` per project
 * instead of re-opening SQLite for every route.
 *
 * Stored on `globalThis` so Next.js hot-reload does not leak a second SQLite
 * handle onto `~/.omp/agent/agent.db`.
 */

declare global {
  var __ompRuntimePromise: Promise<OmpRuntime> | undefined;
}

export interface OmpRuntime {
  agentDir: string;
  settings: Settings;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

async function createRuntime(): Promise<OmpRuntime> {
  const agentDir = getAgentDir();
  const settings = await Settings.init({ agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  // Usage probes for providers whose upstream the SDK knows under another id
  // (zhipu-coding-plan → the ZAI monitor API). Installed before anything can
  // read the runtime so the status poller and health scans see them; a rebuild
  // after invalidateOmpRuntime() reinstalls them.
  installUsageProviderOverrides(authStorage);
  // Pinning the registry to this exact AuthStorage keeps credential_disabled
  // events flowing to the same instance the routes read from.
  const modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh("online-if-uncached");
  return { agentDir, settings, authStorage, modelRegistry };
}

export function getOmpRuntime(): Promise<OmpRuntime> {
  globalThis.__ompRuntimePromise ??= createRuntime().catch((error) => {
    globalThis.__ompRuntimePromise = undefined;
    throw error;
  });
  return globalThis.__ompRuntimePromise;
}

/**
 * Settings scoped to `cwd`, so project-level `.omp/config.yml` overrides apply.
 *
 * Returns the shared instance when `cwd` is already the active scope; omp's
 * `cloneForCwd` reloads only the project layer, leaving global settings and
 * runtime overrides intact.
 */
export async function getSettingsForCwd(cwd: string | undefined): Promise<Settings> {
  const { settings } = await getOmpRuntime();
  if (!cwd || settings.getCwd() === cwd) return settings;
  return settings.cloneForCwd(cwd);
}

/** Drop the cached runtime so the next request rebuilds it (config/auth edits). */
export function invalidateOmpRuntime(): void {
  globalThis.__ompRuntimePromise = undefined;
}
