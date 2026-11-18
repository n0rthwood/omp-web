/**
 * omp-web terminal host daemon (issue #94, contract §6).
 *
 * A persistent Bun process outside the web server's cgroup that owns every
 * terminal PTY, so shells + scrollback survive omp-web restarts/upgrades.
 * Speaks NDJSON over a unix socket (see protocol.ts for the wire contract);
 * the web side is a thin async relay (lib/terminals/terminal-service.ts).
 *
 * Outbound writes are QUEUED per connection: Bun UDS socket.write is partial
 * and drops unaccepted bytes (contract §3 probe), so we write what fits,
 * buffer the remainder and resume on `drain`. Client disconnects only detach
 * subscriptions — PTYs keep running; only an explicit `close` kills a shell.
 *
 * Dev/test: OMP_TERMINAL_HOST_SOCK overrides the socket path. In production
 * the socket lives at ~/.omp/run/omp-web-hosts/terminal-host.sock and the
 * process is supervised by omp-terminal-host.service.
 */
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { terminalHostSocketPath, type TerminalRequest, type TerminalResult, type TerminalWireFrame } from "./protocol";
import {
  attachTerminal,
  closeTerminal,
  createTerminal,
  detachSubscriptions,
  getTerminalInfo,
  getTerminalPid,
  listTerminals,
  resizeTerminal,
  writeToTerminal,
  type TerminalSubscription,
} from "./terminals";

const PROTOCOL = "omp-terminal-host/1";

interface ClientState {
  /** Bytes not yet accepted by the kernel; Bun drops what write() rejects. */
  queue: Uint8Array[];
  greeted: boolean;
  /** Line accumulator for inbound NDJSON. */
  inbound: string;
  /** Active attach subscriptions, keyed by terminal id (one per terminal per client). */
  subscriptions: Map<string, TerminalSubscription>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function enqueue(socket: Socket<ClientState>, frame: TerminalWireFrame): void {
  socket.data.queue.push(encoder.encode(JSON.stringify(frame) + "\n"));
  drainQueue(socket);
}

/** Write what the kernel accepts now; keep the remainder for the drain handler. */
function drainQueue(socket: Socket<ClientState>): void {
  const queue = socket.data.queue;
  while (queue.length > 0) {
    const head = queue[0];
    let written = 0;
    try {
      written = socket.write(head);
    } catch {
      return; // socket gone; close handler clears the queue
    }
    if (written === head.length) {
      queue.shift();
      continue;
    }
    if (written > 0) queue[0] = head.subarray(written);
    return; // partial write — resume on drain
  }
}

function ok(socket: Socket<ClientState>, id: string, result: TerminalResult): void {
  enqueue(socket, { id, ok: true, result });
}

function fail(socket: Socket<ClientState>, id: string, error: string): void {
  enqueue(socket, { id, ok: false, error });
}

function handleRequest(socket: Socket<ClientState>, req: TerminalRequest): void {
  const state = socket.data;
  try {
    switch (req.type) {
      case "list":
        return ok(socket, req.id, listTerminals(req.cwd));
      case "info":
        return ok(socket, req.id, getTerminalInfo(req.terminalId) ?? null);
      case "create":
        return ok(socket, req.id, createTerminal({ cwd: req.cwd, cols: req.cols, rows: req.rows, name: req.name }));
      case "write":
        return ok(socket, req.id, writeToTerminal(req.terminalId, req.data));
      case "resize":
        return ok(socket, req.id, resizeTerminal(req.terminalId, req.cols, req.rows));
      case "pid":
        return ok(socket, req.id, getTerminalPid(req.terminalId) ?? null);
      case "attach": {
        const subscription: TerminalSubscription = {
          id: req.id,
          deliver: (event) => enqueue(socket, { type: "event", id: req.id, event }),
        };
        const attach = attachTerminal(req.terminalId, subscription);
        if (attach.found) state.subscriptions.set(req.terminalId, subscription);
        // The response (replay + already-exited state) is enqueued BEFORE any
        // live event can be: fanout only runs from timers/exit promises, never
        // synchronously inside attachTerminal.
        return ok(socket, req.id, attach);
      }
      case "detach": {
        const subscription = state.subscriptions.get(req.terminalId);
        if (subscription) {
          state.subscriptions.delete(req.terminalId);
          detachSubscriptions([subscription]);
        }
        return ok(socket, req.id, null);
      }
      case "close":
        closeTerminal(req.terminalId); // no-op for unknown/already-closed ids
        return ok(socket, req.id, null);
    }
  } catch (error) {
    fail(socket, req.id, String(error));
  }
}

/**
 * Validate an inbound request at the wire boundary. Only the fields the
 * daemon actually reads are checked; anything malformed gets an error
 * response instead of undefined behavior downstream.
 */
function parseRequest(frame: object): TerminalRequest | string {
  if (!("id" in frame) || typeof frame.id !== "string") return "Request needs a string id";
  if (!("type" in frame) || typeof frame.type !== "string") return "Request needs a string type";
  const id = frame.id;
  const terminalId = "terminalId" in frame && typeof frame.terminalId === "string" ? frame.terminalId : undefined;
  switch (frame.type) {
    case "list":
      if (!("cwd" in frame) || typeof frame.cwd !== "string") return "list needs a string cwd";
      return { id, type: "list", cwd: frame.cwd };
    case "create": {
      if (!("cwd" in frame) || typeof frame.cwd !== "string") return "create needs a string cwd";
      const cols = "cols" in frame && typeof frame.cols === "number" ? frame.cols : undefined;
      const rows = "rows" in frame && typeof frame.rows === "number" ? frame.rows : undefined;
      const name = "name" in frame && typeof frame.name === "string" ? frame.name : undefined;
      return { id, type: "create", cwd: frame.cwd, cols, rows, name };
    }
    case "info":
    case "attach":
    case "detach":
    case "close":
    case "pid":
      if (terminalId === undefined) return `${frame.type} needs a string terminalId`;
      return { id, type: frame.type, terminalId };
    case "write":
      if (terminalId === undefined) return "write needs a string terminalId";
      if (!("data" in frame) || typeof frame.data !== "string") return "write needs string data";
      return { id, type: "write", terminalId, data: frame.data };
    case "resize":
      if (terminalId === undefined) return "resize needs a string terminalId";
      if (!("cols" in frame) || typeof frame.cols !== "number" || !("rows" in frame) || typeof frame.rows !== "number") {
        return "resize needs numeric cols and rows";
      }
      return { id, type: "resize", terminalId, cols: frame.cols, rows: frame.rows };
    default:
      return `Unsupported request: ${frame.type}`;
  }
}

function handleLine(socket: Socket<ClientState>, line: string): void {
  if (!line.trim()) return;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return fail(socket, "", "Invalid JSON frame");
  }
  if (!frame || typeof frame !== "object") return fail(socket, "", "Frame must be a JSON object");
  const state = socket.data;
  if (!state.greeted) {
    if (!("type" in frame) || frame.type !== "hello" || !("protocol" in frame) || frame.protocol !== PROTOCOL) {
      fail(socket, "", "Expected hello frame");
      socket.end();
      return;
    }
    state.greeted = true;
    return enqueue(socket, { type: "hello", protocol: PROTOCOL, pid: process.pid });
  }
  const parsed = parseRequest(frame);
  if (typeof parsed === "string") {
    const id = "id" in frame && typeof frame.id === "string" ? frame.id : "";
    return fail(socket, id, parsed);
  }
  handleRequest(socket, parsed);
}

const socketPath = terminalHostSocketPath();
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
// A socket file with no live listener is stale (previous daemon crashed).
// Probe first; only unlink when nothing answers, so two daemons can never
// silently share a path.
let stale = true;
try {
  const probe = await Bun.connect({
    unix: socketPath,
    socket: { data() {}, open(s) { s.end(); }, error() {}, close() {} },
  });
  probe.end();
  stale = false;
} catch { /* nothing listening — stale socket file */ }
if (!stale) {
  console.error(`terminal-host: another daemon already owns ${socketPath}; exiting`);
  process.exit(1);
}
try { unlinkSync(socketPath); } catch { /* absent */ }

Bun.listen<ClientState>({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { queue: [], greeted: false, inbound: "", subscriptions: new Map() };
    },
    data(socket, chunk) {
      const state = socket.data;
      state.inbound += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = state.inbound.indexOf("\n")) !== -1) {
        const line = state.inbound.slice(0, newline);
        state.inbound = state.inbound.slice(newline + 1);
        handleLine(socket, line);
      }
    },
    drain(socket) {
      drainQueue(socket);
    },
    close(socket) {
      // Detach only — never kill PTYs on client disconnect (contract §6).
      detachSubscriptions(socket.data.subscriptions.values());
      socket.data.subscriptions.clear();
      socket.data.queue.length = 0;
    },
    error(socket, error) {
      console.error("terminal-host: socket error:", error.message);
      detachSubscriptions(socket.data.subscriptions.values());
      socket.data.subscriptions.clear();
      socket.data.queue.length = 0;
    },
  },
});

console.error(`terminal-host: listening on ${socketPath} (pid ${process.pid})`);

// Remove the endpoint on every exit path (signal, clean stop, crash) so the
// relay's stale-socket probe finds no corpse behind. PTYs are untouched: the
// shells are setsid session leaders and survive the daemon (contract §6).
const removeSocket = (): void => {
  try { unlinkSync(socketPath); } catch { /* already gone */ }
};
process.once("exit", removeSocket);
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
