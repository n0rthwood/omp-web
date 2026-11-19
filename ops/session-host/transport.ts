/**
 * Thin UDS transport shell for one session host (issue #94, contract §§1-3).
 *
 * Responsibilities are deliberately limited to lifecycle + byte pump:
 * - listen on `~/.omp/run/omp-web-hosts/<sessionId>.sock` (stale-socket unlink
 *   only after a live-owner probe proves nobody is answering),
 * - multi-client attach with a byte ring buffer + last-seen-seq gap replay,
 * - partial-write outbound queueing (Bun UDS `socket.write` is PARTIAL and
 *   DROPS unaccepted bytes — contract §3), behind an EventEmitter adapter
 *   installed as `process.stdout` before `runRpcMode` (contract §2). The
 *   adapter ALWAYS accepts (#98): the host owns bounded buffering (droppable
 *   transient-progress lane + must-deliver queue) so the SDK writer never
 *   spools command responses behind a progress flood,
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
import { OMP_WEB_HOST_RUN_SUBDIR, type HostHelloFrame, type HostHistoryBoundary } from "../../lib/session-host-protocol";

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
/**
 * Droppable transient progress lane (#98): ONLY these unchunked frame types
 * may be shed per client when its bulk backlog exceeds BULK_QUEUE_BYTES.
 * Everything else — responses, lifecycle, message frames, and EVERY rpc_chunk
 * line — is must-deliver: dropping a chunk would tear a logical sequence the
 * decoder cannot recover. tool_stream_update is volatile tool progress; its
 * terminal outcome arrives via tool_execution_end (must-deliver), and the
 * SDK's streaming-edit abort guard runs host-side before this transport.
 */
const BULK_FRAME_TYPES: Record<string, true> = {
  subagent_progress: true,
  tool_execution_update: true,
  tool_stream_update: true,
};
/** Per-client ceiling for queued droppable progress bytes (#98). */
const BULK_QUEUE_BYTES = 512 * 1024;
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
  /** Droppable transient progress (#98); counted against BULK_QUEUE_BYTES. */
  bulk: boolean;
}

interface ClientState {
  socket: Socket<{ client: ClientState | null }>;
  queue: QueueEntry[];
  queuedBytes: number;
  /** Queued bytes belonging to the droppable bulk lane (#98). */
  bulkQueuedBytes: number;
  /** Bulk frames shed for this client so far (diagnostics on detach). */
  droppedBulkFrames: number;
  /** Authoritative ring position after transient frames skipped for this client. */
  skippedSeq: number | null;
  /** Bytes still unaccepted from the socket's most recent partial write. */
  inFlight: number;
  closed: boolean;
  /** Inbound line accumulator (frames are one JSON object per line). */
  pending: string;
}

/**
 * One-pass classification of an outbound write (#98), shared by the ring's
 * sequence alignment and the droppable lane. One adapter write is one logical
 * frame: an unchunked frame or a single rpc_chunk line.
 */
interface OutboundFrameInfo {
  type?: string;
  /** False only for a non-leading rpc_chunk line of a chunk sequence. */
  seqStart: boolean;
  chunkId?: string;
  /** Unchunked transient progress: droppable per client under backlog. */
  bulk: boolean;
}

/**
 * Shared one-line classifier (#98 contract): type / sequence-start / chunkId /
 * droppable-bulk, extracted from a line or its bounded head prefix (all three
 * fields lead the JSON object; never decode a whole multi-MiB write). Reused
 * by the tap, ring alignment, the droppable lane — and #99's transient
 * snapshot map. One classification, one convention.
 */
export function classifyOutboundLine(line: string): OutboundFrameInfo {
  const type = /^\{(?:"id":(?:"[^"]*"|null),)?"type":"([a-z_]+)"/.exec(line)?.[1];
  if (type === "rpc_chunk") {
    // Chunk line: index 0 opens a logical sequence; later lines belong to the
    // chunkId's sequence. Field order varies, so match independently.
    return {
      type,
      seqStart: /"index":0(?![0-9])/.test(line),
      chunkId: /"chunkId":"([^"]*)"/.exec(line)?.[1],
      bulk: false,
    };
  }
  return {
    type,
    seqStart: true,
    chunkId: undefined,
    bulk: type !== undefined && Object.hasOwn(BULK_FRAME_TYPES, type),
  };
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
  /**
   * Fresh journal-mode attach (#99): capture the atomic journal/live boundary
   * SYNCHRONOUSLY inside the attach handshake (durable flush + seq snapshot in
   * one callback). No historical replay follows; the ack carries the boundary.
   */
  onJournalAttach?: () => HostHistoryBoundary;
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
  /** Current ring end seq (#99): the wire position a host snapshot splices at. */
  currentSeq(): number;
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
  // #98: the front is always a logical-frame start (never a mid-chunk line),
  // so a full replay can never begin inside an rpc_chunk sequence.
  const ring: Array<{ end: number; bytes: Uint8Array; seqStart: boolean; chunkId?: string }> = [];
  let ringBytes = 0;
  let seq = 0;
  /** Verbatim SDK startup `ready` line, kept past ring eviction for re-attach. */
  let readyBytes: Uint8Array | undefined;

  function ringAppend(bytes: Uint8Array, info: OutboundFrameInfo): number {
    seq += bytes.length;
    ring.push({ end: seq, bytes, seqStart: info.seqStart, chunkId: info.chunkId });
    ringBytes += bytes.length;
    while (ringBytes > RING_BUFFER_BYTES && ring.length > 1) {
      const dropped = ring.shift();
      if (dropped) ringBytes -= dropped.bytes.length;
    }
    // #98: byte eviction can land mid-sequence; drop leading non-start entries
    // so the front always begins a logical frame. While a single >cap chunk
    // sequence is in flight nothing complete is replayable, so the ring may
    // empty until the next sequence start arrives.
    while (ring.length > 0 && !ring[0].seqStart) {
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
    let i = 0;
    if (from > 0) {
      while (i < ring.length && ring[i].end <= from) i++;
      if (i < ring.length) {
        const first = ring[i];
        const start = first.end - first.bytes.length;
        if (from > start) {
          if (first.chunkId !== undefined) {
            // Torn chunk line: its JSON is unrecoverable and the rest of the
            // sequence would be orphaned — skip the whole sequence (#98).
            while (i < ring.length && ring[i].chunkId === first.chunkId) i++;
          } else {
            // Partial non-chunk frame: keep exact byte/seq accounting (#94).
            out.push(first.bytes.subarray(from - start));
            i++;
          }
        } else if (!first.seqStart) {
          // Reconnect landed exactly on a mid-sequence line: a fresh decoder
          // cannot start mid-sequence — skip the orphan chunk tail (#98).
          const chunkId = first.chunkId;
          while (i < ring.length && !ring[i].seqStart && ring[i].chunkId === chunkId) i++;
        }
      }
    }
    for (; i < ring.length; i++) out.push(ring[i].bytes);
    return out;
  }

  // -------------------------------------------------------------- output ----
  // EventEmitter adapter satisfying the RpcOutputWriter sink contract
  // (rpc-output.ts), deliberately ALWAYS-ACCEPT (#98): write(data, cb)
  // buffers host-side, invokes cb(null) exactly once per write, and always
  // returns true — never "drain"/"close"/"error" while active. Signalling
  // backpressure would latch the SDK writer's sticky disk-spool mode,
  // FIFO-starving command responses behind megabytes of progress frames
  // (incident 01a1efa0, #98). The host owns buffering instead: the seq ring
  // (32 MiB, sequence-aligned eviction) plus per-client queues — transient
  // progress is droppable past BULK_QUEUE_BYTES, everything else detaches the
  // client past CLIENT_QUEUE_BYTES and reconnects replay from the ring.
  // Detached clients are normal — never surface them as errors.
  const openPrompts = new Set<string>();

  function tapOutbound(bytes: Uint8Array): OutboundFrameInfo {
    // One adapter write carries one logical frame (possibly rpc_chunk lines).
    // Activity/response-admission frames are small and lead with "type" (or
    // "id" then "type" for SDK responses); a bounded prefix keeps multi-MiB
    // message frames out of the decode path. Classification runs ONCE per
    // write even without tap callbacks: ring alignment and the droppable
    // lane consume the same result (#98).
    const prefix = TEXT_DECODER.decode(bytes.subarray(0, Math.min(bytes.length, TAP_PREFIX_BYTES)));
    const info: OutboundFrameInfo = { seqStart: true, bulk: false };
    for (const line of prefix.split("\n")) {
      const cls = classifyOutboundLine(line);
      const type = cls.type;
      if (!type) continue;
      info.type = type;
      info.seqStart = cls.seqStart;
      info.chunkId = cls.chunkId;
      info.bulk = cls.bulk;
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
    return info;
  }

  const stdoutAdapter: StdoutAdapter = Object.assign(new EventEmitter(), {
    write(data: string | Uint8Array, cb?: (error?: Error | null) => void): boolean {
      if (closed) {
        cb?.(null);
        return true;
      }
      const bytes = typeof data === "string" ? TEXT_ENCODER.encode(data) : data;
      const info = tapOutbound(bytes);
      const endSeq = ringAppend(bytes, info);
      if (clients.size === 0) {
        // No attached client: bytes are ring-buffered for the next attach.
        cb?.(null);
        return true;
      }
      for (const client of clients) enqueue(client, bytes, info, endSeq);
      // Always-accept (#98): exactly one callback per write, never a false
      // return — the SDK writer must never enter its FIFO disk-spool mode.
      cb?.(null);
      return true;
    },
    // Sink contract: the host never closes stdout while active; shutdown goes
    // through closeInput() → SDK EOF teardown instead.
    end(): void { /* intentional no-op */ },
  });

  function enqueue(client: ClientState, bytes: Uint8Array, info: OutboundFrameInfo, endSeq?: number): void {
    if (client.closed) return;
    if (info.bulk && client.bulkQueuedBytes + bytes.length > BULK_QUEUE_BYTES) {
      // #98 droppable lane: transient progress beyond the per-client budget
      // is shed so command responses never queue behind a bulk backlog. The
      // adapter already accepted the write; the ring keeps the bytes for
      // replay. Must-deliver frames (incl. every rpc_chunk) never land here.
      client.droppedBulkFrames++;
      if (endSeq !== undefined) client.skippedSeq = endSeq;
      return;
    }
    if (client.skippedSeq !== null) {
      const checkpoint = client.skippedSeq;
      client.skippedSeq = null;
      // Skipped bytes still advance the host's ring. Coalesce their position
      // into one control frame before the next delivered logical frame.
      enqueue(client, TEXT_ENCODER.encode(`${JSON.stringify({ type: "host_seq", seq: checkpoint })}\n`), { seqStart: true, bulk: false });
      if (client.closed) return;
    }
    client.queue.push({ bytes, offset: 0, bulk: info.bulk });
    client.queuedBytes += bytes.length;
    if (info.bulk) client.bulkQueuedBytes += bytes.length;
    if (client.queuedBytes > CLIENT_QUEUE_BYTES) {
      // A client that far behind on MUST-DELIVER traffic cannot catch up on a
      // live stream; detach it (its reconnect replays from the ring). Never
      // kill the host for it.
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
      if (entry.bulk) client.bulkQueuedBytes -= entry.bytes.length;
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
    if (client.droppedBulkFrames > 0) {
      process.stderr.write(
        `[omp-web-host] slow client detached after dropping ${client.droppedBulkFrames} bulk frames\n`,
      );
    }
    // Always-accept (#98): write callbacks already settled at the adapter;
    // queued frames die with the client (the ring holds them for replay).
    client.queue.length = 0;
    client.queuedBytes = 0;
    client.bulkQueuedBytes = 0;
    client.inFlight = 0;
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
    const line = JSON.stringify(frame);
    const bytes = TEXT_ENCODER.encode(`${line}\n`);
    // Host mirror frames are single-line and never rpc_chunk; same classifier.
    const info = classifyOutboundLine(line);
    const endSeq = ringAppend(bytes, info);
    for (const client of clients) enqueue(client, bytes, info, endSeq);
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
    // Handshake: host_hello first (raw, unsequenced), then the attach ack.
    // Legacy attach replays the client's gap from its last-seen seq BEFORE the
    // ack; journal-mode attach (#99) NEVER replays history — the boundary is
    // captured synchronously here (durable flush + seq in one callback) so the
    // journal view and the live stream splice with no gap and no duplication.
    // Everything is enqueued synchronously inside the socket data callback,
    // so no live frame can interleave ahead of the handshake.
    const hostInfo: OutboundFrameInfo = { seqStart: true, bulk: false };
    enqueue(client, helloBytes, hostInfo);
    if (readyBytes) enqueue(client, readyBytes, hostInfo);
    const journalMode = frame.historyMode === "journal";
    let boundary: HostHistoryBoundary | undefined;
    let boundaryError: string | undefined;
    if (journalMode) {
      // Capture can throw (latched disk failure, mid-rewrite atomic batch).
      // An exception escaping the socket data callback would kill the host
      // and strand the live session — surface it on the ack instead.
      try {
        boundary = options.onJournalAttach?.();
      } catch (error) {
        boundaryError = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[omp-web-host] journal attach boundary capture failed: ${boundaryError}\n`);
      }
    }
    if (!journalMode) {
      const lastSeen = typeof frame.lastSeenSeq === "number" && frame.lastSeenSeq >= 0 ? frame.lastSeenSeq : 0;
      // Legacy gap replay is must-deliver; the bulk drop policy applies to
      // the live flood only. Journal-mode NEVER replays — even when capture
      // fails: the ack carries boundaryError and the client's next
      // get_history_anchor rejects retryably (#100 preserves the view).
      for (const chunk of replayFrom(lastSeen)) enqueue(client, chunk, hostInfo);
    }
    enqueue(client, TEXT_ENCODER.encode(`${JSON.stringify({
      type: "host_attach",
      seq,
      ...(boundary ? { boundary } : {}),
      ...(boundaryError ? { boundaryError } : {}),
    })}\n`), hostInfo);
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
          bulkQueuedBytes: 0,
          droppedBulkFrames: 0,
          skippedSeq: null,
          inFlight: 0,
          closed: false,
          pending: "",
        };
        // Bun.listen's seed data object is shared; each socket needs its own
        // identity or one client's drain resumes another client's queue.
        socket.data = { client };
        clients.add(client);
        // Greet immediately so liveness probes see a live owner. The wrapper
        // treats host_hello as a mirror; RpcClient ignores unknown frames.
        const hostInfo: OutboundFrameInfo = { seqStart: true, bulk: false };
        enqueue(client, helloBytes, hostInfo);
        if (readyBytes) enqueue(client, readyBytes, hostInfo);
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
    currentSeq: () => seq,
    close,
  };
}