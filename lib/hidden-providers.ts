/**
 * Per-machine "hidden from the provider list" set (issue #144).
 *
 * A provider whose key comes from the environment cannot be disconnected: the
 * logout and API-key routes only remove stored credentials, so the row was
 * listed again on the next fetch. Hiding is a local, per-browser preference
 * with the same discipline as `lib/removed-projects.ts` — machine-scoped
 * through `machineStorageKey()`, best-effort, and it changes nothing on disk
 * or in the fleet.
 */

import { machineStorageKey } from "./api-path";

const HIDDEN_PROVIDERS_STORAGE_KEY = "omp-web:hidden-providers";

export function loadHiddenProviders(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(machineStorageKey(HIDDEN_PROVIDERS_STORAGE_KEY));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function saveHiddenProviders(providers: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (providers.size === 0) window.localStorage.removeItem(machineStorageKey(HIDDEN_PROVIDERS_STORAGE_KEY));
    else window.localStorage.setItem(machineStorageKey(HIDDEN_PROVIDERS_STORAGE_KEY), JSON.stringify([...providers]));
  } catch {
    // Ignore storage quota and privacy-mode errors.
  }
}
