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

const FONT_SIZE_KEY = "omp-web-terminal-font-size";
export const TERMINAL_FONT_SIZE_RANGE = { min: 8, max: 22 } as const;

/**
 * Phones get a smaller default: at 13px a 390px viewport fits only 48 columns,
 * which wraps ordinary prompts and `ls` output.
 */
export function defaultTerminalFontSize(isMobile: boolean): number {
  return isMobile ? 11 : 12;
}

export function loadTerminalFontSize(isMobile: boolean): number {
  const fallback = defaultTerminalFontSize(isMobile);
  if (typeof window === "undefined") return fallback;
  const parsed = Number.parseInt(window.localStorage.getItem(FONT_SIZE_KEY) ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.max(TERMINAL_FONT_SIZE_RANGE.min, parsed));
}

export function saveTerminalFontSize(size: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(size));
  } catch { /* storage unavailable/full — persistence is best-effort */ }
}
