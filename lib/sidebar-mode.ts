/**
 * Tri-state sidebar mode (issue #22) — "table" (default full list), "strip"
 * (auto-collapse, desktop-only), "drawer" (expanded detail view). Shared
 * between AppShell (owns the pixel width + auto-collapse trigger) and
 * SessionSidebar (renders each mode) so both sides agree on the type and
 * the persisted value.
 *
 * Persisted per machine via `machineStorageKey` — same convention as the
 * other sidebar localStorage keys in components/SessionSidebar.tsx.
 */

import { machineStorageKey } from "./api-path";

export type SidebarMode = "table" | "strip" | "drawer";

const SIDEBAR_MODE_STORAGE_KEY = "omp-web:sidebar-mode";

export function loadSidebarMode(): SidebarMode {
  if (typeof window === "undefined") return "table";
  try {
    const raw = window.localStorage.getItem(machineStorageKey(SIDEBAR_MODE_STORAGE_KEY));
    return raw === "table" || raw === "strip" || raw === "drawer" ? raw : "table";
  } catch {
    return "table";
  }
}

export function saveSidebarMode(mode: SidebarMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(machineStorageKey(SIDEBAR_MODE_STORAGE_KEY), mode);
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
