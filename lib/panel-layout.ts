export const MOBILE_MAX_WIDTH = 640;
export const SPLIT_PANEL_MIN_WIDTH = 960;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

// Sidebar tri-state modes (issue #22): the resizable "table" width above
// uses SIDEBAR_MIN/MAX_WIDTH unchanged. "strip" is a fixed, non-resizable
// auto-collapse rail (~5 CJK characters + padding); "drawer" is a fixed,
// non-resizable wide detail view, clamped like the table width but against
// a taller cap so it can genuinely show more columns.
export const SIDEBAR_STRIP_WIDTH = 92;
export const SIDEBAR_DRAWER_MIN_WIDTH = 460;
export const SIDEBAR_DRAWER_DEFAULT_WIDTH = 580;
export const SIDEBAR_DRAWER_MAX_WIDTH = 780;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 420;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.42, 360, 640);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  /** Cap to clamp against instead of SIDEBAR_MAX_WIDTH — the drawer mode
   *  (issue #22) reuses this same "leave room for chat + file panel" formula
   *  with a taller cap. */
  cap?: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth, cap = SIDEBAR_MAX_WIDTH } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return cap;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const chatWidth = compact ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  return Math.min(cap, viewportWidth - chatWidth - visibleRightPanelWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_MAX_WIDTH;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    viewportWidth - DESKTOP_CHAT_MIN_WIDTH - visibleSidebarWidth,
  );
}
