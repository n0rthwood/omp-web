"use client";

import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef } from "react";

interface Props {
  terminalId: string;
  /** Invoked once when the shell process exits; the panel stays mounted so the final output remains readable. */
  onExit?: (exitCode: number | null) => void;
}

function cssVar(styles: CSSStyleDeclaration | null, name: string, fallback: string): string {
  const value = styles?.getPropertyValue(name).trim();
  return value || fallback;
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
export function TerminalPanel({ terminalId, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let term: import("@xterm/xterm").Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let eventSource: EventSource | null = null;
    let dataSubscription: { dispose(): void } | null = null;
    let lastCols = 0;
    let lastRows = 0;

    const sendResize = () => {
      if (!term) return;
      const { cols, rows } = term;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      void fetch(`/api/terminals/${encodeURIComponent(terminalId)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
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
        fontFamily: cssVar(styles, "--font-mono", "monospace"),
        fontSize: 13,
        cursorBlink: true,
        theme: {
          background: cssVar(styles, "--bg", "#141414"),
          foreground: cssVar(styles, "--text", "#cccccc"),
          cursor: cssVar(styles, "--accent", "#4a9eff"),
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch { /* container not measurable yet */ }
      sendResize();

      resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch { /* container not measurable */ }
        sendResize();
      });
      resizeObserver.observe(containerRef.current);

      // xterm's onData already emits ANSI-encoded bytes for typing and
      // paste — send the string verbatim, never double-encode.
      dataSubscription = term.onData((data) => {
        void fetch(`/api/terminals/${encodeURIComponent(terminalId)}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        }).catch(() => {});
      });

      eventSource = new EventSource(`/api/terminals/${encodeURIComponent(terminalId)}/events`);
      eventSource.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as {
            type: string;
            data?: unknown;
            exitCode?: unknown;
          };
          if (frame.type === "output" && typeof frame.data === "string") {
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
      resizeObserver?.disconnect();
      eventSource?.close();
      term?.dispose();
    };
  }, [terminalId]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
