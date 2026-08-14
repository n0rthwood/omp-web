"use client";

import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef } from "react";

// Type-only: the runtime values are imported dynamically inside the effect,
// because xterm touches `document` at module scope and would break SSR.
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XtermTerminal } from "@xterm/xterm";

interface Props {
  terminalId: string;
  /** Invoked once when the shell process exits; the panel stays mounted so the final output remains readable. */
  onExit?: (exitCode: number | null) => void;
  fontSize: number;
}

function cssVar(styles: CSSStyleDeclaration | null, name: string, fallback: string): string {
  // Whitespace is collapsed, not just trimmed: a CSS value may legally span
  // lines, and xterm feeds `fontFamily` into a canvas `ctx.font` shorthand that
  // an embedded newline makes fail silently.
  const value = styles?.getPropertyValue(name).replace(/\s+/g, " ").trim();
  return value || fallback;
}

/**
 * The full 16-colour ANSI set plus cursor and selection, read from the CSS
 * variables `lib/omp-theme.ts` derives for the active omp theme. Setting only
 * background/foreground/cursor left every coloured program — `ls`, `git diff`,
 * `htop` — rendering in xterm's stock palette, which matches no omp theme.
 */
function themeFromCssVars(styles: CSSStyleDeclaration): ITheme {
  return {
    background: cssVar(styles, "--term-bg", cssVar(styles, "--bg", "#141414")),
    foreground: cssVar(styles, "--term-fg", cssVar(styles, "--text", "#cccccc")),
    cursor: cssVar(styles, "--term-cursor", cssVar(styles, "--accent", "#4a9eff")),
    cursorAccent: cssVar(styles, "--term-cursor-accent", cssVar(styles, "--bg", "#141414")),
    selectionBackground: cssVar(styles, "--term-selection-bg", cssVar(styles, "--bg-selected", "#264f78")),
    black: cssVar(styles, "--term-black", "#0d0f14"),
    red: cssVar(styles, "--term-red", "#ff4757"),
    green: cssVar(styles, "--term-green", "#00ff88"),
    yellow: cssVar(styles, "--term-yellow", "#ffb347"),
    blue: cssVar(styles, "--term-blue", "#00b4ff"),
    magenta: cssVar(styles, "--term-magenta", "#b06bff"),
    cyan: cssVar(styles, "--term-cyan", "#00ffd5"),
    white: cssVar(styles, "--term-white", "#b5bcc9"),
    brightBlack: cssVar(styles, "--term-bright-black", "#6b7280"),
    brightRed: cssVar(styles, "--term-bright-red", "#ff707c"),
    brightGreen: cssVar(styles, "--term-bright-green", "#38ffa2"),
    brightYellow: cssVar(styles, "--term-bright-yellow", "#ffc46c"),
    brightBlue: cssVar(styles, "--term-bright-blue", "#38c6ff"),
    brightMagenta: cssVar(styles, "--term-bright-magenta", "#c08bff"),
    brightCyan: cssVar(styles, "--term-bright-cyan", "#38ffdd"),
    brightWhite: cssVar(styles, "--term-bright-white", "#e8ecf4"),
  };
}

/**
 * xterm.js pane attached to a server-side shell.
 *
 * - xterm is imported dynamically inside useEffect: the library touches
 *   `document` at module scope, so a static import breaks Next.js SSR.
 * - Unmounting (navigation, reload) does NOT delete the terminal — the shell
 *   keeps running server-side and a later mount reattaches to it via the
 *   replay buffer. Only an explicit tab close (AppShell) calls DELETE.
 */
export function TerminalPanel({ terminalId, onExit, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Live handles so font-size and theme changes reconfigure the running
  // terminal instead of remounting it — a remount would re-request the whole
  // replay buffer and flash the pane.
  const termRef = useRef<XtermTerminal | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    refitRef.current?.();
  }, [fontSize]);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const term = termRef.current;
      const element = containerRef.current;
      if (!term || !element) return;
      term.options.theme = themeFromCssVars(getComputedStyle(element));
    });
    // `useTheme` swaps the palette by writing CSS variables onto the root and
    // toggling `.dark`; without this the open terminal keeps the old colours.
    observer.observe(root, { attributeFilter: ["class", "style", "data-omp-theme-name"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let term: XtermTerminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let eventSource: EventSource | null = null;
    let dataSubscription: { dispose(): void } | null = null;
    let cancelUnsuppressTimer: (() => void) | null = null;
    let lastCols = 0;
    let lastRows = 0;

    // The panel this lives in is always mounted and collapses to `width: 0`,
    // so the container is regularly unmeasurable. Fitting then yields a
    // degenerate geometry and — worse — pushes it to the pty, which reflows the
    // shell to ~11 columns and wrecks any running TUI. Only ever fit a
    // container that has a real box; the ResizeObserver re-fits when the panel
    // expands.
    const isMeasurable = () => {
      const element = containerRef.current;
      return Boolean(element && element.offsetWidth > 0 && element.offsetHeight > 0);
    };

    const sendResize = () => {
      if (!term) return;
      const { cols, rows } = term;
      if (cols < 2 || rows < 2) return;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      void fetch(`/api/terminals/${encodeURIComponent(terminalId)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    };

    const refit = (fitAddon: XtermFitAddon) => {
      if (!isMeasurable()) return;
      try {
        fitAddon.fit();
      } catch { /* container measured but not renderable yet */ }
      sendResize();
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;

      const styles = getComputedStyle(containerRef.current);
      term = new Terminal({
        convertEol: false,
        // `--term-font`, not `--font-mono`: the UI stack contains ligature and
        // proportional faces that break a fixed cell grid in Chrome.
        fontFamily: cssVar(styles, "--term-font", cssVar(styles, "--font-mono", "monospace")),
        fontSize: fontSizeRef.current,
        fontWeight: 400,
        fontWeightBold: 600,
        letterSpacing: 0,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorInactiveStyle: "outline",
        // A theme's decorative colours are chosen for chrome, not for body text;
        // this is xterm's own runtime floor for anything that still lands too
        // close to the background.
        minimumContrastRatio: 4.5,
        scrollback: 5000,
        smoothScrollDuration: 0,
        drawBoldTextInBrightColors: true,
        theme: themeFromCssVars(styles),
      });
      termRef.current = term;
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      refitRef.current = () => refit(fitAddon);
      refit(fitAddon);

      // Renderer addons are imported dynamically for two reasons a static
      // import cannot serve: they touch `document`/WebGL at module scope, which
      // breaks Next's server bundle, and which one is used is decided at
      // runtime from what the device actually supports.
      const loadCanvasRenderer = async () => {
        try {
          const { CanvasAddon } = await import("@xterm/addon-canvas");
          if (disposed || !term) return;
          term.loadAddon(new CanvasAddon());
        } catch { /* fall back to xterm's DOM renderer */ }
      };

      // The DOM renderer draws one styled <span> run per row per frame: it is
      // xterm's slowest and least crisp path, and its per-span subpixel
      // positioning is what made Chrome's cell grid look uneven where Safari's
      // looked fine. WebGL first, canvas next, DOM only if neither loads.
      // WebGL contexts are lost on GPU resets and when a mobile browser
      // backgrounds a tab, so a lost context disposes the addon and falls back
      // instead of freezing on a dead canvas.
      void (async () => {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          if (disposed || !term) return;
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            webgl.dispose();
            void loadCanvasRenderer();
          });
          term.loadAddon(webgl);
        } catch {
          await loadCanvasRenderer();
        }
      })();
      // Opening a terminal must leave the keyboard in it: otherwise the
      // launcher button keeps focus, the first thing typed goes nowhere, and on
      // a phone the soft keyboard never comes up until the surface is tapped.
      // A restored terminal can mount while the panel is still collapsed, so
      // focus is claimed only once the surface is actually on screen — the
      // observer below takes care of that case.
      let focused = false;
      const focusWhenVisible = () => {
        if (focused || !isMeasurable()) return;
        focused = true;
        term?.focus();
      };
      focusWhenVisible();

      resizeObserver = new ResizeObserver(() => {
        refit(fitAddon);
        focusWhenVisible();
      });
      resizeObserver.observe(containerRef.current);

      // xterm's onData already emits ANSI-encoded bytes for typing and
      // paste — send the string verbatim, never double-encode.
      // POSTs are serialized through one queue: parallel fire-and-forget
      // fetches can be delivered out of order, which scrambles fast typing.
      let inputQueue = "";
      let inputSending = false;
      const pumpInput = async () => {
        if (inputSending) return;
        inputSending = true;
        try {
          while (inputQueue) {
            const chunk = inputQueue;
            inputQueue = "";
            try {
              await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: chunk }),
              });
            } catch {
              // Network hiccup — best effort; the next keystroke retries.
            }
          }
        } finally {
          inputSending = false;
        }
      };
      // Scrollback replayed on reattach can contain terminal-query sequences
      // (DA / OSC colour queries emitted by a vim/htop from the previous
      // session). A fresh xterm answers them through `onData`, and piping those
      // answers to the shell makes bash execute garbage — so those answers are
      // dropped while a `replay` frame is being parsed. xterm's write callback
      // runs after the parser, and therefore after the answers.
      //
      // Two deliberate narrowings, each a bug this used to cause:
      // - Only a `replay` frame arms it, never live output. A freshly created
      //   terminal has no scrollback to protect against, and arming on the
      //   first frame of any kind left it unable to accept typing at all (#4).
      // - Only escape-prefixed data is dropped. Query answers are always
      //   escape sequences, while anything a user can type in that window is
      //   overwhelmingly printable, and dropping all of it silently ate the
      //   first command typed into a reattached terminal.
      // A timer disarms it regardless, so a write callback that never fires
      // cannot wedge the terminal read-only.
      let inputSuppressed = false;
      // `window.setTimeout` (not the ambient overload) so the handle is a
      // number in this browser-only component.
      let unsuppressTimer: number | undefined;
      const allowInput = () => {
        inputSuppressed = false;
        clearTimeout(unsuppressTimer);
        unsuppressTimer = undefined;
      };
      cancelUnsuppressTimer = () => clearTimeout(unsuppressTimer);
      dataSubscription = term.onData((data) => {
        if (inputSuppressed && data.startsWith("\x1b")) return;
        inputQueue += data;
        void pumpInput();
      });

      eventSource = new EventSource(`/api/terminals/${encodeURIComponent(terminalId)}/events`);
      eventSource.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as {
            type: string;
            data?: unknown;
            exitCode?: unknown;
          };
          if (frame.type === "replay" && typeof frame.data === "string") {
            inputSuppressed = true;
            unsuppressTimer = window.setTimeout(allowInput, 1000);
            term?.write(frame.data, allowInput);
          } else if (frame.type === "output" && typeof frame.data === "string") {
            term?.write(frame.data);
          } else if (frame.type === "exit") {
            const exitCode = typeof frame.exitCode === "number" ? frame.exitCode : null;
            onExitRef.current?.(exitCode);
            // `exit` is terminal — stop streaming and never reconnect.
            eventSource?.close();
          }
        } catch {
          // Ignore malformed frames rather than killing the stream.
        }
      };
    })();

    return () => {
      disposed = true;
      dataSubscription?.dispose();
      cancelUnsuppressTimer?.();
      resizeObserver?.disconnect();
      eventSource?.close();
      term?.dispose();
    };
  }, [terminalId]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
