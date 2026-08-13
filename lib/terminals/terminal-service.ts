import { randomUUID } from "crypto";
import type { TerminalInfo } from "../api-types";

const MAX_REPLAY_BUFFER = 200_000; // chars, mirrors pi-web's terminalService.ts

interface TerminalRecord extends TerminalInfo {
  term: Bun.Terminal;
  proc: Bun.Subprocess;
  buffer: string;
  listeners: Set<TerminalListener>;
}

export type TerminalStreamEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null };

type TerminalListener = (event: TerminalStreamEvent) => void;

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
      // The exit event was fanned out to subscribers synchronously when
      // `exited` flipped, so the record has been delivered — reap it here
      // so the registry (and this list) never grows unbounded.
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
      fanout(record, { type: "output", data: text });
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
    listeners: new Set(),
    term,
    proc,
  };

  void proc.exited.then((exitCode) => {
    if (record.exited) return; // already reported — fire the exit event once
    record.exited = true;
    record.exitCode = exitCode;
    fanout(record, { type: "exit", exitCode });
    // Keep the record (and its buffer) around so a client that reconnects
    // right after exit still sees the final output + exit event on
    // subscribe, then let it be pruned on next `listTerminals`/explicit close.
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

export function subscribeTerminal(id: string, listener: TerminalListener): (() => void) | undefined {
  const record = registry().get(id);
  if (!record) return undefined;
  // Replay is delivered synchronously here — routes must NOT re-send the
  // buffer themselves or every connect doubles the scrollback.
  if (record.buffer) listener({ type: "output", data: record.buffer });
  if (record.exited) listener({ type: "exit", exitCode: record.exitCode ?? null });
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

export function closeTerminal(id: string): void {
  const record = registry().get(id);
  if (!record) return;
  registry().delete(id);
  try {
    // Spawned via `setsid -c`, so the shell is its own process-group leader —
    // signal the whole group so TUI children (vim, htop, …) die too, not
    // just the shell. Fall back to proc.kill() if the pid is unknown/gone.
    if (record.proc.pid) process.kill(-record.proc.pid, "SIGTERM");
  } catch { /* already gone */ }
  try { record.term.close(); } catch { /* already closed */ }
  // Escalate if it doesn't die quickly.
  setTimeout(() => {
    try { if (record.proc.pid) process.kill(-record.proc.pid, "SIGKILL"); } catch { /* gone */ }
  }, 2000);
}

function toInfo(record: TerminalRecord): TerminalInfo {
  return { id: record.id, cwd: record.cwd, name: record.name, createdAt: record.createdAt, exited: record.exited, exitCode: record.exitCode };
}

function fanout(record: TerminalRecord, event: TerminalStreamEvent): void {
  for (const listener of record.listeners) listener(event);
}

function appendToBuffer(record: TerminalRecord, text: string): void {
  record.buffer += text;
  if (record.buffer.length > MAX_REPLAY_BUFFER) {
    record.buffer = record.buffer.slice(record.buffer.length - MAX_REPLAY_BUFFER);
  }
}

function isPositiveFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
