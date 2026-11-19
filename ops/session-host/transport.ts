/**
 * Thin UDS transport shell for one session host (issue #94, contract §§1-3).
 *
 * Responsibilities are deliberately limited to lifecycle + byte pump:
 * - listen on `~/.omp/run/omp-web-hosts/<sessionId>.sock` (stale-socket unlink
 *   only after a live-owner probe proves nobody is answering),
 * - multi-client attach with a byte ring buffer + last-seen-seq gap replay,
 * - partial-write outbound queueing (Bun UDS `socket.write` is PARTIAL and
 *   DROPS unaccepted bytes — contract §3), mapped onto the SDK
 *   `RpcOutputWriter` sink contract via an EventEmitter adapter installed as
 *   `process.stdout` before `runRpcMode` (contract §2),
 * - an activity-whitelist tap used only for idle-reap bookkeeping,
 * - feeding accepted client frames into the shell-owned input ReadableStream.
 *
 * The shell NEVER interprets business commands: web-compat intercepts and the
 * SDK dispatcher own all semantics. Client disconnects detach without killing
 * the host; closing the input controller is the only clean-shutdown trigger.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { OMP_WEB_HOST_RUN_SUBDIR, type HostHelloFrame } from "../../lib/session-host-protocol";

/** Directory shared with the web wrapper and the terminal daemon (contract §0). */
export function hostsRunDir(): string {
  return process.env.OMP_WEB_HOST_RUN_DIR ?? join(homedir(), ".omp", ...OMP_WEB_HOST_RUN_SUBDIR);
}

export function sessionSocketPath(sessionId: string): string {
  return join(hostsRunDir(), `${sessionId}.sock`);
}

/**
 * Activity whitelist (contract §3): the ONLY outbound frame types the shell
 * interprets, solely to reset the idle timer. Everything else is transparent.
 */
const ACTIVITY_FRAME_TYPES: Record<string, true> = {
  agent_start: true,
  agent_end: true,
  prompt_result: true,
  session_settled: true,
  subagent_lifecycle: true,
  subagent_progress: true,
};

/**
 * Frames whose `id` names an in-flight prompt command. The idle reaper must
 * not fire between prompt admission (response frame) and the prompt's terminal
 * `prompt_result`, even when the SDK settle predicate momentarily reads quiet.
 */
const PROMPT_COMMAND_TYPES: Record<string, true> = { prompt: true, abort_and_prompt: true };

/**
 * Outbound types web-compat must observe EVEN when larger than the tap
 * prefix: available_commands_update is the extensions-bound correctness gate
 * (extensionsReady) and carries the full slash-command catalog (tens of KiB);
 * prompt_result carries the final message for auto-title; subagent frames are
 * remembered for history. Streaming message frames are deliberately absent —
 * they are the multi-MiB writes the prefix bound exists to keep undecoded.
 */
const OUTBOUND_FULL_FRAME_TYPES: Record<string, true> = {
  available_commands_update: true,
  prompt_result: true,
  subagent_lifecycle: true,
  subagent_progress: true,
};

/** Ring buffer ceiling for gap replay on reconnect (bytes of encoded frames). */
const RING_BUFFER_BYTES = 32 * 1024 * 1024;
/** Per-connection outbound queue ceiling; a slower client is detached past it. */
const CLIENT_QUEUE_BYTES = 64 * 1024 * 1024;
/** host_hello probe: how long to wait for a live owner to answer. */
const LIVE_PROBE_TIMEOUT_MS = 500;
/** Activity frames are small; never decode a whole multi-MiB write to tap them. */
const TAP_PREFIX_BYTES = 1024;

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

interface QueueEntry {
  bytes: Uint8Array;
  /** Offset of the first byte not yet handed to the socket. */
  offset: number;
  /** RpcOutputWriter per-write callback, invoked when fully accepted. */
  cb?: (error?: Error | null) => void;
  /** True for bytes originating from an adapter write (vs. host mirror frames). */
  fromAdapter: boolean;
}

interface ClientState {
  socket: Socket<{ client: ClientState | null }>;
  queue: QueueEntry[];
  queuedBytes: number;
  /** Bytes still unaccepted from the socket's most recent partial write. */
  inFlight: number;
  closed: boolean;
  /** Inbound line accumulator (frames are one JSON object per line). */
  pending: string;
}

export interface SessionTransportOptions {
  /** Requested key naming the socket (HostStartOptions.sessionId). */
  sessionId: string;
  /** Real session id (SessionManager.getSessionId()) for host_hello. */
  helloSessionId: string;
  sessionFile: string;
  cwd: string;
  /** Parsed inbound frames (already JSON.parse'd), in arrival order. */
  onFrame: (frame: unknown) => void;
  /** Any inbound frame arrived — the idle reaper treats it as activity. */
  onInboundActivity?: () => void;
  /** A client finished its attach handshake — emit the session_info mirror. */
  onAttach?: () => void;
  /** Activity-whitelist tap hit (agent/prompt/subagent lifecycle). */
  onActivity?: (frameType: string) => void;
  /** Tap a parsed SDK outbound frame AFTER it was queued (response overlays). */
  onOutboundFrame?: (frame: unknown) => void;
}

/** EventEmitter shape the SDK RpcOutputWriter requires of process.stdout. */
export interface StdoutAdapter extends EventEmitter {
  write(data: string | Uint8Array, cb?: (error?: Error | null) => void): boolean;
  end(): void;
}

export interface SessionTransport {
  /** Shell-owned RPC input: close() is the clean EOF shutdown path (§2). */
  readonly input: ReadableStream<Uint8Array>;
  /** Close the input controller exactly once (idle reap / host shutdown). */
  closeInput(): void;
  /**
   * Explicitly hand a frame to the SDK dispatcher input. The shell NEVER
   * auto-forwards: web-compat intercepts BEFORE SDK dispatch (contract §4)
   * and decides per frame what reaches the SDK.
   */
  forwardToSdk(frame: unknown): void;
  /** Emit a host-owned NDJSON frame (host_hello, session_info mirrors). */
  emitHostFrame(frame: object): void;
  /** Install as process.stdout BEFORE runRpcMode (contract §2). */
  readonly stdoutAdapter: StdoutAdapter;
  /** True while a prompt command's response was admitted but no prompt_result seen. */
  hasOpenPrompt(): boolean;
  /**
   * Release an admitted prompt that will NEVER emit prompt_result:
   * extension-handled local outcomes (rpc-mode.ts:1875) and admission errors.
   * Without this the idle guard/bash guard would stay busy forever.
   */
  releasePrompt(id: string): void;
  readonly socketPath: string;
  /** Requested key naming socket/unit (may be a temp `__new__` id, NOT the real id). */
  readonly socketKey: string;
  /** Stop listening, detach every client, resolve on server close. */
  close(): Promise<void>;
}

/**
 * Probe whether a live host already owns this socket: connect and wait for the
 * first line (a live owner emits host_hello immediately on attach). No answer
 * or connection failure ⇒ stale socket, safe to unlink (contract §1).
 */
async function socketHasLiveOwner(path: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  let sock: Socket<{ client: ClientState | null }> | undefined;
  const finish = (live: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { sock?.end(); } catch { /* already closed */ }
    resolve(live);
  };
  const timer = setTimeout(() => finish(false), LIVE_PROBE_TIMEOUT_MS);
  Bun.connect<{ client: ClientState | null }>({
    unix: path,
    socket: {
      data(_socket, data) {
        if (data.length > 0) finish(true);
      },
      open(socket) { sock = socket; },
      close() { finish(false); },
      connectError() { finish(false); },
      error() { finish(false); },
      end() { finish(false); },
    },
    data: { client: null },
  }).then(
    (socket) => { sock = socket; },
    () => finish(false),
  );
  return promise;
}

export async function createSessionTransport(options: SessionTransportOptions): Promise<SessionTransport> {
  mkdirSync(hostsRunDir(), { recursive: true, mode: 0o700 });
  const socketPath = sessionSocketPath(options.sessionId);
  try {
    // Unlink only after the liveness probe (contract §1/§3): a live owner
    // answers host_hello immediately; a stale socket file does not.
    if (await socketHasLiveOwner(socketPath)) {
      throw new Error(`Session host socket ${socketPath} already has a live owner`);
    }
    unlinkSync(socketPath);
  } catch (error) {
    // Node errno shape on fs failures; ENOENT just means no stale socket.
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  const clients = new Set<ClientState>();
  let closed = false;

  // ---------------------------------------------------------------- ring ----
  // Byte ring of every outbound frame (adapter writes + host mirror frames),
  // tagged with a monotonic seq = cumulative byte offset AFTER the frame.
  // Attach carries the client's last-seen seq; replay covers (lastSeen, end].
  const ring: Array<{ end: number; bytes: Uint8Array }> = [];
  let ringBytes = 0;
  let seq = 0;
  /** Verbatim SDK startup `ready` line, kept past ring eviction for re-attach. */
  let readyBytes: Uint8Array | undefined;

  function ringAppend(bytes: Uint8Array): number {
    seq += bytes.length;
    ring.push({ end: seq, bytes });
    ringBytes += bytes.length;
    while (ringBytes > RING_BUFFER_BYTES && ring.length > 1) {
      const dropped = ring.shift();
      if (dropped) ringBytes -= dropped.bytes.length;
    }
    return seq;
  }

  function replayFrom(lastSeen: number): Uint8Array[] {
    if (!Number.isFinite(lastSeen) || lastSeen < 0) lastSeen = 0;
    const oldestStart = ring.length > 0 ? ring[0].end - ring[0].bytes.length : seq;
    // Gap older than the retained window (or from a previous host instance):
    // replay everything retained; the client reconciles via get_entries.
    const from = lastSeen < oldestStart ? 0 : lastSeen;
    const out: Uint8Array[] = [];
    for (const entry of ring) {
      if (entry.end <= from) continue;
      const skip = Math.max(0, from - (entry.end - entry.bytes.length));
      out.push(skip > 0 ? entry.bytes.subarray(skip) : entry.bytes);
    }
    return out;
  }

  // -------------------------------------------------------------- output ----
  // EventEmitter adapter satisfying the RpcOutputWriter sink contract
  // (rpc-output.ts): write(data, cb) calls cb(null|err) when accepted, returns
  // false while backpressured, emits "drain" on recovery, never "close"/"error"
  // while active. Detached clients are normal — never surface them as errors.
  let adapterUnaccepted = 0;
  let adapterBlocked = false;

  function adapterAccepted(length: number): void {
    adapterUnaccepted = Math.max(0, adapterUnaccepted - length);
    if (adapterBlocked && adapterUnaccepted === 0) {
      adapterBlocked = false;
      stdoutAdapter.emit("drain");
    }
  }

  const openPrompts = new Set<string>();

  function tapOutbound(bytes: Uint8Array): void {
    if (!options.onActivity && !options.onOutboundFrame) return;
    // One adapter write carries one logical frame (possibly rpc_chunk lines).
    // Activity/response-admission frames are small and lead with "type" (or
    // "id" then "type" for SDK responses); a bounded prefix keeps multi-MiB
    // message frames out of the decode path.
    const prefix = TEXT_DECODER.decode(bytes.subarray(0, Math.min(bytes.length, TAP_PREFIX_BYTES)));
    for (const line of prefix.split("\n")) {
      const typeMatch = /^\{(?:"id":(?:"[^"]*"|null),)?"type":"([a-z_]+)"/.exec(line);
      if (!typeMatch) continue;
      const type = typeMatch[1];
      // Cache the verbatim startup `ready` frame so EVERY attach re-delivers
      // host_hello → ready even after ring eviction (slice B pin #1: a late
      // RpcClient.start() consumes the first ready line or times out).
      if (type === "ready" && readyBytes === undefined && line.endsWith("}") && bytes.length <= TAP_PREFIX_BYTES) {
        readyBytes = TEXT_ENCODER.encode(`${line}\n`);
      }
      if (ACTIVITY_FRAME_TYPES[type]) {
        if (type === "prompt_result") {
          const idMatch = /"id":"([^"]*)"/.exec(line);
          openPrompts.delete(idMatch?.[1] ?? "");
        }
        options.onActivity?.(type);
      } else if (type === "response" && /"success":true/.test(line)) {
        const commandMatch = /"command":"([^"]*)"/.exec(line);
        if (commandMatch && Object.hasOwn(PROMPT_COMMAND_TYPES, commandMatch[1])) {
          const idMatch = /"id":"([^"]*)"/.exec(line);
          openPrompts.add(idMatch?.[1] ?? "");
        }
      }
      // Post-write observation for web-compat (get_state overlay, response
      // mirrors, extensions-bound signal). Host-owned frames bypass this tap;
      // only SDK output lands here. Small frames observe as before; the types
      // above decode in full because skipping them would wedge extensionsReady
      // (available_commands_update routinely exceeds the prefix). Unobserved
      // large frames stay out of the decode path.
      if (options.onOutboundFrame) {
        const whole = bytes.length <= TAP_PREFIX_BYTES
          ? line
          : OUTBOUND_FULL_FRAME_TYPES[type] ? TEXT_DECODER.decode(bytes).replace(/\n$/, "") : undefined;
        if (whole && whole.length > 1 && whole.endsWith("}")) {
          try {
            options.onOutboundFrame(JSON.parse(whole));
          } catch { /* non-frame line; tap never throws */ }
        }
      }
    }
  }

  const stdoutAdapter: StdoutAdapter = Object.assign(new EventEmitter(), {
    write(data: string | Uint8Array, cb?: (error?: Error | null) => void): boolean {
      if (closed) {
        cb?.(null);
        return true;
      }
      const bytes = typeof data === "string" ? TEXT_ENCODER.encode(data) : data;
      tapOutbound(bytes);
      ringAppend(bytes);
      if (clients.size === 0) {
        // No attached client: bytes are ring-buffered for the next attach.
        cb?.(null);
        return true;
      }
      adapterUnaccepted += bytes.length;
      for (const client of clients) enqueue(client, bytes, cb, true);
      adapterBlocked = adapterUnaccepted > 0;
      return !adapterBlocked;
    },
    // Sink contract: the host never closes stdout while active; shutdown goes
    // through closeInput() → SDK EOF teardown instead.
    end(): void { /* intentional no-op */ },
  });

  function enqueue(
    client: ClientState,
    bytes: Uint8Array,
    cb: ((error?: Error | null) => void) | undefined,
    fromAdapter: boolean,
  ): void {
    if (client.closed) {
      if (fromAdapter) adapterAccepted(bytes.length);
      cb?.(null);
      return;
    }
    client.queue.push({ bytes, offset: 0, cb, fromAdapter });
    client.queuedBytes += bytes.length;
    if (client.queuedBytes > CLIENT_QUEUE_BYTES) {
      // A client that far behind cannot catch up on a live stream; detach it
      // (its reconnect replays from the ring). Never kill the host for it.
      detach(client);
      return;
    }
    pump(client);
  }

  function pump(client: ClientState): void {
    if (client.closed || client.inFlight > 0) return;
    while (client.queue.length > 0) {
      const entry = client.queue[0];
      const payload = entry.offset > 0 ? entry.bytes.subarray(entry.offset) : entry.bytes;
      let written = 0;
      try {
        written = client.socket.write(payload);
      } catch {
        detach(client);
        return;
      }
      if (written <= 0) return; // socket buffer full; resume on drain
      entry.offset += written;
      client.queuedBytes -= written;
      if (entry.offset < entry.bytes.length) {
        client.inFlight = entry.bytes.length - entry.offset;
        return;
      }
      client.queue.shift();
      if (entry.fromAdapter) adapterAccepted(entry.bytes.length);
      entry.cb?.(null);
    }
  }

  function onDrain(client: ClientState): void {
    if (client.closed) return;
    // Bun UDS socket.write DROPS the unaccepted tail (it is not buffered).
    // drain means the kernel buffer emptied; bytes after entry.offset were
    // never delivered, so rewrite them from entry.offset. Crediting inFlight
    // as flushed (the old logic) skipped the dropped tail and corrupted the
    // stream under backpressure.
    client.inFlight = 0;
    pump(client);
  }

  function detach(client: ClientState): void {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    // Account every unaccepted adapter byte as accepted so the writer's
    // pending-write count settles; the ring still holds the bytes for replay.
    // The head entry's remainder equals inFlight, so the queue walk covers it.
    let accepted = 0;
    for (const entry of client.queue) {
      if (entry.fromAdapter) accepted += entry.bytes.length - entry.offset;
      entry.cb?.(null);
    }
    client.queue.length = 0;
    client.queuedBytes = 0;
    client.inFlight = 0;
    if (accepted > 0) adapterAccepted(accepted);
    try { client.socket.end(); } catch { /* already gone */ }
  }

  // --------------------------------------------------------------- input ----
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let inputClosed = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      inputController = controller;
    },
  });

  function closeInput(): void {
    if (inputClosed) return;
    inputClosed = true;
    try { inputController?.close(); } catch { /* already closed */ }
  }

  function forwardToSdk(frame: unknown): void {
    if (inputClosed) return;
    try { inputController?.enqueue(TEXT_ENCODER.encode(`${JSON.stringify(frame)}\n`)); } catch { /* closed */ }
  }

  function emitHostFrame(frame: object): void {
    if (closed) return;
    const bytes = TEXT_ENCODER.encode(`${JSON.stringify(frame)}\n`);
    ringAppend(bytes);
    for (const client of clients) enqueue(client, bytes, undefined, false);
  }

  // host_hello is fixed for the host's lifetime; serialize once. Shape is the
  // frozen sibling protocol frame (sessionFile "" while there is no journal).
  const hello: HostHelloFrame = {
    type: "host_hello",
    protocol: "omp-web-host/1",
    sessionId: options.helloSessionId,
    sessionFile: options.sessionFile,
    cwd: options.cwd,
  };
  const helloBytes = TEXT_ENCODER.encode(`${JSON.stringify(hello)}\n`);

  function handleAttach(client: ClientState, frame: Record<string, unknown>): void {
    // Handshake: host_hello first (raw, unsequenced), then gap replay from the
    // client's last-seen seq, then host_attach(seq) so the client can track its
    // position, then live frames. Replay is enqueued synchronously inside the
    // socket data callback, so no live frame can interleave ahead of it.
    enqueue(client, helloBytes, undefined, false);
    if (readyBytes) enqueue(client, readyBytes, undefined, false);
    const lastSeen = typeof frame.lastSeenSeq === "number" ? frame.lastSeenSeq : 0;
    for (const chunk of replayFrom(lastSeen)) enqueue(client, chunk, undefined, false);
    enqueue(client, TEXT_ENCODER.encode(`${JSON.stringify({ type: "host_attach", seq })}\n`), undefined, false);
    options.onAttach?.();
  }

  // -------------------------------------------------------------- server ----
  const server = Bun.listen<{ client: ClientState | null }>({
    unix: socketPath,
    data: { client: null },
    socket: {
      open(socket) {
        const client: ClientState = {
          socket,
          queue: [],
          queuedBytes: 0,
          inFlight: 0,
          closed: false,
          pending: "",
        };
        socket.data.client = client;
        clients.add(client);
        // Greet immediately so liveness probes see a live owner. The wrapper
        // treats host_hello as a mirror; RpcClient ignores unknown frames.
        enqueue(client, helloBytes, undefined, false);
        if (readyBytes) enqueue(client, readyBytes, undefined, false);
      },
      data(socket, data) {
        const client = socket.data.client;
        if (!client || client.closed) return;
        options.onInboundActivity?.();
        client.pending += TEXT_DECODER.decode(data);
        let newline = client.pending.indexOf("\n");
        while (newline !== -1) {
          const line = client.pending.slice(0, newline).trim();
          client.pending = client.pending.slice(newline + 1);
          if (line.length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              emitHostFrame({
                type: "response",
                command: "parse",
                success: false,
                error: "Failed to parse command: malformed JSON line",
              });
              newline = client.pending.indexOf("\n");
              continue;
            }
            if (parsed !== null && typeof parsed === "object" && "type" in parsed && parsed.type === "host_attach") {
              handleAttach(client, parsed as Record<string, unknown>);
            } else {
              // Intercept-before-dispatch (contract §4): web-compat decides per
              // frame; SDK input is fed only via transport.forwardToSdk().
              try {
                options.onFrame(parsed);
              } catch (error) {
                process.stderr.write(`[omp-web-host] inbound frame handler failed: ${String(error)}\n`);
              }
            }
          }
          newline = client.pending.indexOf("\n");
        }
      },
      drain(socket) {
        const client = socket.data.client;
        if (client) onDrain(client);
      },
      close(socket) {
        const client = socket.data.client;
        if (client) detach(client);
      },
      error(socket) {
        const client = socket.data.client;
        if (client) detach(client);
      },
      end(socket) {
        const client = socket.data.client;
        if (client) detach(client);
      },
    },
  });

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const client of [...clients]) detach(client);
    try { server.stop(true); } catch { /* already stopped */ }
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  }

  return {
    input,
    closeInput,
    forwardToSdk,
    emitHostFrame,
    stdoutAdapter,
    hasOpenPrompt: () => openPrompts.size > 0,
    releasePrompt: (id) => { openPrompts.delete(id); },
    socketPath,
    socketKey: options.sessionId,
    close,
  };
}