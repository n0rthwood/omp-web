"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  SETTINGS_WINDOW_MIN_HEIGHT,
  SETTINGS_WINDOW_MIN_WIDTH,
} from "@/lib/panel-layout";

/**
 * #146: drag-to-resize for the settings dialog.
 *
 * The dialog used to be a fixed `min(1180px, 100vw - 36px)` box, which clipped
 * the provider model table's right-hand columns on narrow viewports. Size is a
 * per-browser preference (localStorage, like the outline rail width in #137),
 * read before first paint so the window never flashes at its default size, and
 * clamped to the viewport on mount and on every resize.
 */

export interface ModalSize {
  width: number;
  height: number;
}

/** The dialog is centred with 18px of backdrop on each side. */
const VIEWPORT_GUTTER = 36;
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 48;

function clampToViewport(size: ModalSize): ModalSize {
  const maxWidth = typeof window === "undefined"
    ? SETTINGS_WINDOW_DEFAULT_MAX_WIDTH
    : Math.max(SETTINGS_WINDOW_MIN_WIDTH, window.innerWidth - VIEWPORT_GUTTER);
  const maxHeight = typeof window === "undefined"
    ? SETTINGS_WINDOW_DEFAULT_MAX_HEIGHT
    : Math.max(SETTINGS_WINDOW_MIN_HEIGHT, window.innerHeight - VIEWPORT_GUTTER);
  return {
    width: Math.round(Math.max(SETTINGS_WINDOW_MIN_WIDTH, Math.min(maxWidth, size.width))),
    height: Math.round(Math.max(SETTINGS_WINDOW_MIN_HEIGHT, Math.min(maxHeight, size.height))),
  };
}

const SETTINGS_WINDOW_DEFAULT_MAX_WIDTH = 1180;
const SETTINGS_WINDOW_DEFAULT_MAX_HEIGHT = 860;

/** Read-before-paint: the stored size, or null when nothing was saved. */
export function readStoredModalSize(storageKey: string): ModalSize | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModalSize>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
    return { width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

function writeStoredModalSize(storageKey: string, size: ModalSize): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(size));
  } catch {
    // Private mode / full storage: resizing still works for this session.
  }
}

export interface ResizableModalOptions {
  storageKey: string;
  defaultSize: ModalSize;
  /** Accessible name for the resize handle. */
  label: string;
}

export interface ResizableModalResult {
  size: ModalSize;
  isResizing: boolean;
  handleProps: {
    role: "separator";
    tabIndex: number;
    "aria-label": string;
    "aria-orientation": "horizontal";
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

export function useResizableModal({ storageKey, defaultSize, label }: ResizableModalOptions): ResizableModalResult {
  const [size, setSize] = useState<ModalSize>(() => readStoredModalSize(storageKey) ?? defaultSize);
  const [isResizing, setIsResizing] = useState(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; start: ModalSize } | null>(null);
  // The size the drag last computed: pointerup can arrive before React commits
  // the final move, so persisting `sizeRef` would store a stale frame.
  const lastDragSizeRef = useRef<ModalSize | null>(null);

  // A viewport smaller than the stored size (rotation, devtools, a new
  // monitor) must not leave the dialog off-screen.
  useEffect(() => {
    const fit = () => setSize((current) => clampToViewport(current));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, start: sizeRef.current };
    lastDragSizeRef.current = sizeRef.current;
    setIsResizing(true);
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampToViewport({
      width: drag.start.width + (event.clientX - drag.startX),
      height: drag.start.height + (event.clientY - drag.startY),
    });
    lastDragSizeRef.current = next;
    setSize(next);
  }, []);

  const endDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    writeStoredModalSize(storageKey, lastDragSizeRef.current ?? sizeRef.current);
  }, [storageKey]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const delta: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    const next = clampToViewport({ width: sizeRef.current.width + move[0], height: sizeRef.current.height + move[1] });
    setSize(next);
    writeStoredModalSize(storageKey, next);
  }, [storageKey]);

  return {
    size,
    isResizing,
    handleProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": label,
      "aria-orientation": "horizontal",
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onKeyDown,
    },
  };
}