/**
 * Web-side terminal relay (issue #94, contract §6).
 *
 * The PTYs live in the terminal-host daemon (ops/terminal-host/), a separate
 * supervised process, so terminals survive omp-web restarts. This module
 * keeps the old service's exported surface — every function is now ASYNC and
 * forwards to the daemon over its unix socket. HTTP/SSE semantics are
 * unchanged: `subscribeTerminal` still delivers the buffered replay (and the
 * exit state, if already exited) to the listener BEFORE any live output and
 * before its promise resolves; routes must never re-send the buffer.
 *
 * Daemon auto-start: when the socket is absent the relay runs
 * `systemctl --user start omp-terminal-host.service` (unit installed by the
 * .deb). If systemctl fails — dev machines without the unit — it falls back
 * to spawning `ops/terminal-host/main.ts` directly as a detached Bun child.
 * Tests/dev isolate themselves with OMP_TERMINAL_HOST_SOCK (see protocol.ts).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "bun";
import type { TerminalInfo } from "../api-types";
import {
  responseResult,
  terminalHostSocketPath,
  type TerminalHello,
  type TerminalRequest,
  type TerminalResponse,
  type TerminalResult,
  type TerminalStreamEvent,
  type TerminalWireFrame,
  type WriteResult,
} from "../../ops/terminal-host/protocol";

export type { TerminalStreamEvent, WriteResult };
type TerminalListener = (event: TerminalStreamEvent) => void;

const PROTOCOL = "omp-terminal-host/1";
const REQUEST_TIMEOUT_MS = 15_000;

/** Request payload without the relay-assigned correlation id (distributive, keeps discriminants). */
type TerminalRequestPayload = TerminalRequest extends infer R ? (R extends { id: string } ? Omit<R, "id"> : never) : never;

interface Subscription {
  listener: TerminalListener;
  detach: () => void;
}

interface Pending {
  resolve: (response: TerminalResponse) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

interface RelayState {
  socket: Socket<RelayState> | null;
  connecting: Promise<Socket<RelayState>> | null;
  greeted: boolean;
  inbound: string;
  /** Outbound bytes the kernel has not accepted yet (Bun UDS writes are partial+drop). */
  queue: Uint8Array[];
  pending: Map<string, Pending>;
  /** Live attach subscriptions keyed by attach request id. */
  subscriptions: Map<string, Subscription>;
  nextId: number;
  /** Daemon pid from the hello handshake; white-box test/ops seam. */
  daemonPid: number | null;
}

declare global {
  var __ompTerminalRelay: RelayState | undefined;
}

function relay(): RelayState {
  if (!globalThis.__ompTerminalRelay) {
    globalThis.__ompTerminalRelay = {
      socket: null,
      connecting: null,
      greeted: false,
      inbound: "",
      queue: [],
      pending: new Map(),
      subscriptions: new Map(),
      nextId: 0,
      daemonPid: null,
    };
  }
  return globalThis.__ompTerminalRelay;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function enqueue(state: RelayState, frame: TerminalRequest | TerminalHello): void {
  const socket = state.socket;
  if (!socket) throw new Error("terminal-host connection is not open");
  state.queue.push(encoder.encode(JSON.stringify(frame) + "\n"));
  drainQueue(state, socket);
}

/** Write what fits; buffer the remainder and resume on drain (contract §3). */
function drainQueue(state: RelayState, socket: Socket<RelayState>): void {
  while (state.queue.length > 0) {
    const head = state.queue[0];
    let written = 0;
    try {
      written = socket.write(head);
    } catch {
      return; // socket gone; close handler resets state
    }
    if (written === head.length) {
      state.queue.shift();
      continue;
    }
    if (written > 0) state.queue[0] = head.subarray(written);
    return;
  }
}

function failAll(state: RelayState, error: Error): void {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
  // Subscriptions die with the connection; the SSE route closes the stream
  // and the client reconnects, getting a fresh attach with replay.
  state.subscriptions.clear();
  state.queue.length = 0;
  state.socket = null;
  state.greeted = false;
  state.inbound = "";
}

function handleFrame(state: RelayState, frame: TerminalWireFrame): void {
  if ("type" in frame && frame.type === "hello") return; // greeting already observed in data handler
  if ("type" in frame && frame.type === "event") {
    const subscription = state.subscriptions.get(frame.id);
    // Events for an attach whose response has not been delivered yet cannot
    // occur: the daemon queues the response first and we process in order.
    if (subscription) subscription.listener(frame.event);
    return;
  }
  const pending = state.pending.get(frame.id);
  if (!pending) return; // late response after timeout — nothing to resolve
  state.pending.delete(frame.id);
  clearTimeout(pending.timer);
  pending.resolve(frame);
}

async function connectSocket(socketPath: string): Promise<Socket<RelayState>> {
  const state = relay();
  const { promise, resolve, reject } = Promise.withResolvers<Socket<RelayState>>();
  let settled = false;
  const socket = await Bun.connect<RelayState>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = state;
        state.socket = socket;
        enqueue(state, { type: "hello", protocol: PROTOCOL });
      },
      data(socket, chunk) {
        const st = socket.data;
        st.inbound += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = st.inbound.indexOf("\n")) !== -1) {
          const line = st.inbound.slice(0, newline);
          st.inbound = st.inbound.slice(newline + 1);
          if (!line.trim()) continue;
          let frame: TerminalWireFrame;
          try {
            frame = JSON.parse(line) as TerminalWireFrame;
          } catch {
            continue;
          }
          if (!st.greeted) {
            if ("type" in frame && frame.type === "hello") {
              st.greeted = true;
              st.daemonPid = frame.pid;
              settled = true;
              resolve(socket);
            }
            continue;
          }
          handleFrame(st, frame);
        }
      },
      drain(socket) {
        drainQueue(socket.data, socket);
      },
      close(socket) {
        const st = socket.data;
        if (!settled) {
          settled = true;
          reject(new Error("terminal-host connection closed during handshake"));
        }
        // A superseded stale socket must not wipe the live connection's state.
        if (st.socket === socket) failAll(st, new Error("terminal-host connection closed"));
      },
      error(_socket, error) {
        if (!settled) {
          settled = true;
          reject(new Error(`terminal-host connection failed: ${error.message}`));
        }
      },
    },
  });
  return promise.then(() => socket);
}

let startingDaemon: Promise<void> | null = null;

/**
 * Start the daemon when its socket is absent: prefer the installed user
 * unit; fall back to a detached direct spawn for dev machines (documented
 * in the module header). Resolves once the socket answers or throws.
 */
async function ensureDaemon(socketPath: string): Promise<void> {
  if (existsSync(socketPath)) {
    // A socket file may be stale (daemon crashed). Try connecting first;
    // only start a new daemon when the connect fails.
    try {
      const probe = await Bun.connect({ unix: socketPath, socket: { data() {}, open(s) { s.end(); }, error() {}, close() {} } });
      probe.end();
      return;
    } catch { /* stale socket — start below */ }
  }
  if (!startingDaemon) {
    startingDaemon = (async () => {
      const systemctl = Bun.spawnSync(["systemctl", "--user", "start", "omp-terminal-host.service"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if (systemctl.exitCode !== 0) {
        // Dev fallback: no installed unit. Spawn the daemon entry directly,
        // detached so it outlives this web process exactly like the unit would.
        // CAVEAT: detached:true escapes the process group but NOT the service
        // cgroup — a systemd stop/restart of the web unit with KillMode=
        // control-group still reaps this daemon (and its PTYs die with it).
        // The packaged own-unit topology (omp-terminal-host.service) is the
        // supported path; this fallback is for bare dev runs only.
        // import.meta.dir is Bun-only (webpack bundles it as undefined); the
        // launch cwd is the repo root (bin/omp-web.js pins it for next start),
        // while import.meta.dir is <root>/lib/terminals — hence two shapes.
        const entry = import.meta.dir
          ? join(import.meta.dir, "..", "..", "ops", "terminal-host", "main.ts")
          : join(process.cwd(), "ops", "terminal-host", "main.ts");
        const child = spawn(process.execPath, [entry], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, OMP_TERMINAL_HOST_SOCK: socketPath },
        });
        child.unref();
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const probe = await Bun.connect({ unix: socketPath, socket: { data() {}, open(s) { s.end(); }, error() {}, close() {} } });
          probe.end();
          return;
        } catch {
          await Bun.sleep(100);
        }
      }
      throw new Error(`terminal-host daemon did not come up at ${socketPath}`);
    })().finally(() => {
      startingDaemon = null;
    });
  }
  return startingDaemon;
}

async function ensureConnected(): Promise<Socket<RelayState>> {
  const state = relay();
  if (state.socket && state.greeted) return state.socket;
  if (!state.connecting) {
    state.connecting = (async () => {
      const socketPath = terminalHostSocketPath();
      try {
        return await connectSocket(socketPath);
      } catch {
        await ensureDaemon(socketPath);
        return await connectSocket(socketPath);
      }
    })().finally(() => {
      relay().connecting = null;
    });
  }
  return state.connecting;
}

async function request<T extends TerminalResult>(req: TerminalRequestPayload): Promise<T> {
  const state = await ensureConnected();
  const st = state.data;
  const id = `relay-${st.nextId++}`;
  const { promise, resolve, reject } = Promise.withResolvers<TerminalResponse>();
  const timer = setTimeout(() => {
    st.pending.delete(id);
    reject(new Error(`terminal-host request timed out: ${req.type}`));
  }, REQUEST_TIMEOUT_MS);
  st.pending.set(id, { resolve, reject, timer });
  try {
    enqueue(st, { ...req, id });
  } catch (error) {
    st.pending.delete(id);
    clearTimeout(timer);
    throw error;
  }
  return responseResult<T>(await promise);
}

export async function listTerminals(cwd: string): Promise<TerminalInfo[]> {
  return request<TerminalInfo[]>({ type: "list", cwd });
}

export async function getTerminalInfo(id: string): Promise<TerminalInfo | undefined> {
  return (await request<TerminalInfo | null>({ type: "info", terminalId: id })) ?? undefined;
}

export async function createTerminal(options: { cwd: string; cols?: number; rows?: number; name?: string }): Promise<TerminalInfo> {
  return request<TerminalInfo>({ type: "create", ...options });
}

export async function writeToTerminal(id: string, data: string): Promise<WriteResult> {
  return request<WriteResult>({ type: "write", terminalId: id, data });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<WriteResult> {
  return request<WriteResult>({ type: "resize", terminalId: id, cols, rows });
}

/**
 * Subscribe to a terminal's event stream. The returned promise resolves with
 * the unsubscribe function only AFTER the daemon's attach response has been
 * delivered to `listener` — the buffered scrollback as a single `replay`
 * frame and, if the shell already exited, an `exit` frame — exactly like the
 * old in-process service delivered them synchronously before returning.
 * Routes must NOT re-send the buffer (that doubles scrollback on connect),
 * and the client's replay-gate/input-suppression rules are unchanged.
 *
 * Resolves `undefined` when the terminal does not exist.
 */
export async function subscribeTerminal(id: string, listener: TerminalListener): Promise<(() => void) | undefined> {
  const state = await ensureConnected();
  const st = state.data;
  const attachId = `relay-${st.nextId++}`;
  const { promise, resolve, reject } = Promise.withResolvers<TerminalResponse>();
  const timer = setTimeout(() => {
    st.pending.delete(attachId);
    reject(new Error("terminal-host attach timed out"));
  }, REQUEST_TIMEOUT_MS);
  const subscription: Subscription = {
    listener,
    detach: () => {
      st.subscriptions.delete(attachId);
      // Best-effort detach; a dead connection needs no detach frame.
      if (st.socket && st.greeted) {
        try {
          enqueue(st, { id: `relay-${st.nextId++}`, type: "detach", terminalId: id });
        } catch { /* connection already gone */ }
      }
    },
  };
  st.pending.set(attachId, { resolve, reject, timer });
  try {
    enqueue(st, { id: attachId, type: "attach", terminalId: id });
  } catch (error) {
    st.pending.delete(attachId);
    clearTimeout(timer);
    throw error;
  }
  const response = await promise;
  clearTimeout(timer);
  if (!response.ok) throw new Error(response.error);
  const attach = responseResult<{ found: boolean; replay?: string; exited?: boolean; exitCode?: number | null }>(response);
  if (!attach.found) return undefined;
  st.subscriptions.set(attachId, subscription);
  // Replay before live, exit before the promise resolves — the daemon
  // guarantees no live event precedes this response on the wire, and the
  // subscription is only registered now, after the replay was delivered.
  if (attach.replay) listener({ type: "replay", data: attach.replay });
  if (attach.exited) listener({ type: "exit", exitCode: attach.exitCode ?? null });
  return () => subscription.detach();
}

export async function closeTerminal(id: string): Promise<void> {
  await request<null>({ type: "close", terminalId: id });
}

/** White-box pid access for kill-verification in tests (daemon-side registry). */
export async function terminalPid(id: string): Promise<number | undefined> {
  return (await request<number | null>({ type: "pid", terminalId: id })) ?? undefined;
}

/** White-box daemon pid for tests (from the hello handshake). */
export function terminalHostPid(): number | undefined {
  return relay().daemonPid ?? undefined;
}

/**
 * White-box test seam: hard-close the relay's UDS connection, simulating the
 * web process dying. The daemon must keep every PTY alive; the next request
 * transparently reconnects.
 */
export function disconnectTerminalHostForTest(): void {
  const state = relay();
  state.socket?.end();
}
