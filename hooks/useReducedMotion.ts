"use client";

import { useSyncExternalStore } from "react";

// OS-level reduced-motion preference (#104): follow scrolling and history
// jumps go instant instead of animated when the user asks for less motion.
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** SSR-safe reduced-motion flag (false until the client media query syncs). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
