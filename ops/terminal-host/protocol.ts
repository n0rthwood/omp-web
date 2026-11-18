/**
 * Wire types shared by the terminal-host daemon (ops/terminal-host/) and the
 * web-side UDS relay (lib/terminals/terminal-service.ts).
 *
 * NDJSON over the UDS at `terminalHostSocketPath()`: one JSON object per line.
 * A client sends a `hello` frame first; the daemon replies with a `hello`
 * frame. After that the client may issue requests, each correlated by `id`:
 *
 *   - one-shot requests get exactly one `response` frame with the same id;
 *   - `attach` gets one `response` frame carrying the buffered scrollback
 *     (`replay`) and, if the shell already exited, the `exit` state — and then
 *     a stream of `event` frames with the same id until detach or daemon-side
 *     terminal close. The attach response is ALWAYS sent before any live
 *     event for that id, so subscribers never see scrollback labelled as live
 *     output and never miss the exit of an already-dead shell.
 *
 * Requests are processed in arrival order, so a write sent after an attach
 * response was received can never have its echo precede the replay.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalInfo } from "../../lib/api-types";

export type { TerminalInfo };

/** Same event union the SSE route serializes; shapes are frozen (issue #4). */
export type TerminalStreamEvent =
  /** Live pty output. */
  | { type: "output"; data: string }
  /** Buffered scrollback, sent once per subscribe, before any live output. */
  | { type: "replay"; data: string }
  | { type: "exit"; exitCode: number | null };

export type WriteResult = "ok" | "not-found" | "exited";

export type TerminalRequest =
  | { id: string; type: "list"; cwd: string }
  | { id: string; type: "info"; terminalId: string }
  | { id: string; type: "create"; cwd: string; cols?: number; rows?: number; name?: string }
  | { id: string; type: "write"; terminalId: string; data: string }
  | { id: string; type: "resize"; terminalId: string; cols: number; rows: number }
  | { id: string; type: "attach"; terminalId: string }
  | { id: string; type: "detach"; terminalId: string }
  | { id: string; type: "close"; terminalId: string }
  /** White-box: shell pid for kill-verification in tests. */
  | { id: string; type: "pid"; terminalId: string };

/** Payload shapes; which one applies is fixed by the request type (see above). */
export type TerminalResult =
  | TerminalInfo[] // list
  | TerminalInfo // create
  | TerminalInfo | null // info
  | WriteResult // write / resize
  | { found: boolean; replay?: string; exited?: boolean; exitCode?: number | null } // attach
  | null // detach / close / pid of unknown terminal
  | number; // pid

export type TerminalResponse =
  | { id: string; ok: true; result: TerminalResult }
  | { id: string; ok: false; error: string };

export type TerminalWireFrame =
  | { type: "hello"; protocol: "omp-terminal-host/1"; pid: number }
  | TerminalResponse
  | { type: "event"; id: string; event: TerminalStreamEvent };

/** Client→daemon handshake line, sent before any request. */
export interface TerminalHello {
  type: "hello";
  protocol: "omp-terminal-host/1";
}

/**
 * Read a successful response payload as the shape its request type fixes.
 * The relay only ever calls this after checking `ok`, with T chosen by the
 * request it sent — the cast encodes that request/response pairing, which
 * the flat wire union cannot express.
 */
export function responseResult<T extends TerminalResult>(response: TerminalResponse): T {
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

/**
 * UDS location. Production default matches contract §6; tests/dev set
 * OMP_TERMINAL_HOST_SOCK to an isolated path so they never disturb the
 * gateway's real terminal daemon.
 */
export function terminalHostSocketPath(): string {
  const override = process.env.OMP_TERMINAL_HOST_SOCK;
  if (override) return override;
  return join(homedir(), ".omp", "run", "omp-web-hosts", "terminal-host.sock");
}
