const STORAGE_PREFIX = "omp-web-terminal-tabs:";

export interface PersistedTerminalTabs {
  ids: string[];
  activeId: string | null;
}

export function loadTerminalTabs(cwd: string): PersistedTerminalTabs {
  if (typeof window === "undefined") return { ids: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + cwd);
    if (!raw) return { ids: [], activeId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedTerminalTabs>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((v): v is string => typeof v === "string") : [];
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
    return { ids, activeId };
  } catch {
    return { ids: [], activeId: null };
  }
}

export function saveTerminalTabs(cwd: string, tabs: PersistedTerminalTabs): void {
  if (typeof window === "undefined") return;
  try {
    if (tabs.ids.length === 0) window.localStorage.removeItem(STORAGE_PREFIX + cwd);
    else window.localStorage.setItem(STORAGE_PREFIX + cwd, JSON.stringify(tabs));
  } catch { /* storage unavailable/full — persistence is best-effort */ }
}
