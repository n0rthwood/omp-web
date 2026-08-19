"use client";

import { useSyncExternalStore } from "react";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
const MOBILE_QUERY = "(max-width: 640px)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Home calendar wide breakpoint (issue #17): 7-column week view at >=1280px.
const HOME_WIDE_QUERY = "(min-width: 1280px)";

function subscribeWide(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(HOME_WIDE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getWideSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia(HOME_WIDE_QUERY).matches;
}

function getWideServerSnapshot(): boolean {
  return true;
}

/**
 * Returns true when the viewport is at or above the Home wide-calendar
 * breakpoint (1280px). SSR/desktop-first like useIsMobile's inverse: renders
 * as wide (true) on the server and first client paint, then syncs.
 */
export function useHomeWideCalendar(): boolean {
  return useSyncExternalStore(subscribeWide, getWideSnapshot, getWideServerSnapshot);
}
