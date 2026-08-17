/**
 * Per-machine "hidden from the workspace selector" project set.
 *
 * Shared by two call sites (issue #10 stage-3 review, minor #8): the
 * `SessionSidebar` UI that owns removing/restoring a project, and the
 * navigation pipeline's default-project pick (`lib/nav-state.ts`) — a
 * project the user removed from their sidebar must never be silently
 * reselected as a machine-switch or deeplink default either.
 *
 * `normalizeProjectKey` is pure; `loadRemovedProjects`/`saveRemovedProjects`
 * touch `window.localStorage` and are best-effort (silently ignored when
 * unavailable), matching `workspace-memory.ts`'s discipline.
 */

import { machineStorageKey } from "./api-path";

const REMOVED_PROJECTS_STORAGE_KEY = "omp-web:removed-projects";

export function normalizeProjectKey(project: string): string {
  const normalized = project.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function loadRemovedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(machineStorageKey(REMOVED_PROJECTS_STORAGE_KEY));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((project): project is string => typeof project === "string").map(normalizeProjectKey))
      : new Set();
  } catch {
    return new Set();
  }
}

export function saveRemovedProjects(projects: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (projects.size === 0) window.localStorage.removeItem(machineStorageKey(REMOVED_PROJECTS_STORAGE_KEY));
    else window.localStorage.setItem(machineStorageKey(REMOVED_PROJECTS_STORAGE_KEY), JSON.stringify([...projects]));
  } catch {
    // Ignore storage quota and privacy-mode errors.
  }
}
