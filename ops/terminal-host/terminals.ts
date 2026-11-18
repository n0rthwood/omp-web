/**
 * Terminal registry + PTY lifecycle, ported wholesale from the former
 * in-process lib/terminals/terminal-service.ts (issue #94): the daemon owns
 * the Bun.Terminal PTYs, setsid shells and scrollback replay buffers so they
 * survive web-server restarts. Behavior is unchanged — batching, replay
 * semantics, process-group kill on close, and `proc.exited` as the
 * authoritative exit signal all mirror the old service verbatim.
 *
 * The only structural change: fanout targets are per-connection attach
 * subscriptions (each carries the wire request id events are tagged with)
 * instead of in-process listener closures.
 */
import { randomUUID } from "crypto";
import type { TerminalInfo, TerminalStreamEvent } from "./protocol";

const MAX_REPLAY_BUFFER = 200_000; // chars, mirrors pi-web's terminalService.ts

export interface TerminalSubscription {
  /** Wire request id of the attach this subscription belongs to. */
  id: string;
  deliver: (event: TerminalStreamEvent) => void;
}

interface TerminalRecord extends TerminalInfo {
  term: Bun.Terminal;
  proc: Bun.Subprocess;
  buffer: string;
  subscriptions: Set<TerminalSubscription>;
  /** Output accumulated since the last flush; see `queueOutput`. */
  pending: string;
  pendingFlush: Timer | null;
}

declare global {
  var __ompTerminals: Map<string, TerminalRecord> | undefined;
}

function registry(): Map<string, TerminalRecord> {
  if (!globalThis.__ompTerminals) globalThis.__ompTerminals = new Map();
  return globalThis.__ompTerminals;
}

export function listTerminals(cwd: string): TerminalInfo[] {
  const reg = registry();
  const results: TerminalInfo[] = [];
  for (const record of reg.values()) {
    if (record.cwd !== cwd) continue;
    if (record.exited) {
      // The exit event was fanned out to subscribers when `exited` flipped,
      // so the record has been delivered — reap it here so the registry
      // (and this list) never grows unbounded.
      reg.delete(record.id);
      continue;
    }
    results.push(toInfo(record));
  }
  return results;
}

export function getTerminalInfo(id: string): TerminalInfo | undefined {
  const record = registry().get(id);
  return record ? toInfo(record) : undefined;
}

/** White-box pid access for kill-verification in tests. */
export function getTerminalPid(id: string): number | undefined {
  return registry().get(id)?.proc.pid;
}

export function createTerminal(options: { cwd: string; cols?: number; rows?: number; name?: string }): TerminalInfo {
  const id = randomUUID();
  const cols = isPositiveFiniteInt(options.cols) ? options.cols : 80;
  const rows = isPositiveFiniteInt(options.rows) ? options.rows : 24;
  const shell = process.env.SHELL || "/bin/bash";
  const decoder = new TextDecoder();

  // `record` is created after `term`/`proc` exist so the object literal needs
  // no `as` cast; the `data` callback closes over it and only ever runs on
  // the event loop, after `createTerminal` has synchronously created it.
  // eslint-disable-next-line prefer-const -- assigned once below, after term/proc exist so the literal needs no cast
  let record: TerminalRecord;

  const term = new Bun.Terminal({
    cols,
    rows,
    name: "xterm-256color",
    data: (_t, chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      appendToBuffer(record, text);
      // Coalesce rather than fan out per pty chunk. A full-screen redraw or a
      // `cat` of a large file arrives as hundreds of small chunks, and each one
      // would otherwise become its own SSE frame with its own JSON envelope and
      // its own xterm write. The first chunk after an idle period flushes on
      // the next tick, so a single keystroke's echo is never delayed by the
      // batching window.
      queueOutput(record, text);
    },
    // NOTE: no pty `exit` callback here on purpose. Verified on Bun 1.3.14
    // (see /tmp/bun-terminal-spike): the pty stream's `exit` callback only
    // fires on term.close(), NOT when the shell process exits on its own —
    // and its `exitCode` is a pty lifecycle status anyway, not the child's.
    // Subprocess exit below is the authoritative exit signal.
  });

  // `setsid -c` makes the pty the shell's *controlling* terminal, without
  // which bash has no job control. The shell becomes its own session/process-
  // group leader — `closeTerminal` relies on that to kill the whole group.
  const proc = Bun.spawn(["setsid", "-c", shell, "-i"], {
    cwd: options.cwd,
    terminal: term,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  record = {
    id,
    cwd: options.cwd,
    name: options.name || shell.split("/").pop() || "shell",
    createdAt: new Date().toISOString(),
    exited: false,
    buffer: "",
    pending: "",
    pendingFlush: null,
    subscriptions: new Set(),
    term,
    proc,
  };

  void proc.exited.then((exitCode) => {
    if (record.exited) return; // already reported — fire the exit event once
    record.exited = true;
    record.exitCode = exitCode;
    // Batched output first: a shell that prints and immediately exits would
    // otherwise lose its last frame behind the `exit` event.
    flushOutput(record);
    fanout(record, { type: "exit", exitCode });
    // Keep the record (and its buffer) around so a client that reconnects
    // right after exit still sees the final output + exit event on
    // attach, then let it be pruned on next `listTerminals`/explicit close.
  });

  registry().set(id, record);
  return toInfo(record);
}

export function writeToTerminal(id: string, data: string): "ok" | "not-found" | "exited" {
  const record = registry().get(id);
  if (!record) return "not-found";
  if (record.exited) return "exited";
  record.term.write(data);
  return "ok";
}

export function resizeTerminal(id: string, cols: number, rows: number): "ok" | "not-found" | "exited" {
  const record = registry().get(id);
  if (!record) return "not-found";
  if (record.exited) return "exited";
  record.term.resize(cols, rows);
  return "ok";
}

/**
 * Attach a connection's event subscription. Returns the buffered scrollback
 * and exit state so the daemon can put them in the attach RESPONSE — which is
 * queued before any live event frame — preserving the old service's
 * "replay (and exit) before live output" guarantee across the wire.
 *
 * Replay is a `replay` frame, not `output`, on purpose: only scrollback can
 * contain terminal-query sequences left by a previous vim/htop, and the
 * client must suppress xterm's answers to those until it has parsed them
 * (issue #4). The relay/route deliver it verbatim — never re-send the buffer.
 */
export function attachTerminal(
  id: string,
  subscription: TerminalSubscription,
): { found: boolean; replay?: string; exited?: boolean; exitCode?: number | null } {
  const record = registry().get(id);
  if (!record) return { found: false };
  record.subscriptions.add(subscription);
  return {
    found: true,
    ...(record.buffer ? { replay: record.buffer } : {}),
    ...(record.exited ? { exited: true, exitCode: record.exitCode ?? null } : {}),
  };
}

/** Drop every subscription belonging to a (disconnected or detaching) client. */
export function detachSubscriptions(subscriptions: Iterable<TerminalSubscription>): void {
  for (const sub of subscriptions) {
    for (const record of registry().values()) record.subscriptions.delete(sub);
  }
}

export function closeTerminal(id: string): void {
  const record = registry().get(id);
  if (!record) return;
  registry().delete(id);
  // The record is gone from the registry and its subscriptions are about to
  // be dropped: a queued flush would fan out to nobody and keep a timer alive.
  clearTimeout(record.pendingFlush ?? undefined);
  record.pendingFlush = null;
  try {
    // Spawned via `setsid -c`, so the shell is its own process-group leader —
    // signal the whole group so TUI children (vim, htop, …) die too, not
    // just the shell. Fall back to proc.kill() if the pid is unknown/gone.
    if (record.proc.pid) process.kill(-record.proc.pid, "SIGTERM");
  } catch { /* already gone */ }
  try { record.term.close(); } catch { /* already closed */ }
  // Escalate if it doesn't die quickly. unref so a close never keeps the
  // daemon alive on its own.
  setTimeout(() => {
    try { if (record.proc.pid) process.kill(-record.proc.pid, "SIGKILL"); } catch { /* gone */ }
  }, 2000).unref();
}

function toInfo(record: TerminalRecord): TerminalInfo {
  return { id: record.id, cwd: record.cwd, name: record.name, createdAt: record.createdAt, exited: record.exited, exitCode: record.exitCode };
}

function fanout(record: TerminalRecord, event: TerminalStreamEvent): void {
  for (const sub of record.subscriptions) sub.deliver(event);
}

function appendToBuffer(record: TerminalRecord, text: string): void {
  record.buffer += text;
  if (record.buffer.length > MAX_REPLAY_BUFFER) {
    record.buffer = record.buffer.slice(record.buffer.length - MAX_REPLAY_BUFFER);
  }
}

/**
 * Batch pty output into one wire/SSE frame per tick instead of one per pty
 * chunk. `setTimeout(…, 0)` — not a longer window — keeps a single
 * keystroke's echo on the same tick it arrived, so interactive latency is
 * unchanged while a burst collapses into far fewer frames.
 */
function queueOutput(record: TerminalRecord, text: string): void {
  record.pending += text;
  if (record.pendingFlush !== null) return;
  record.pendingFlush = setTimeout(() => {
    record.pendingFlush = null;
    const data = record.pending;
    record.pending = "";
    if (data) fanout(record, { type: "output", data });
  }, 0);
}

/** Deliver anything still batched — used before an `exit` frame so no output is lost. */
function flushOutput(record: TerminalRecord): void {
  if (record.pendingFlush !== null) {
    clearTimeout(record.pendingFlush);
    record.pendingFlush = null;
  }
  const data = record.pending;
  record.pending = "";
  if (data) fanout(record, { type: "output", data });
}

function isPositiveFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
