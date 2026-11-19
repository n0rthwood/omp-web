/**
 * Session proxy (issue #94, contract §5).
 *
 * The web tier no longer runs AgentSession in-process. Each conversation lives
 * in its own `ops/session-host` process, reachable over a per-session UDS
 * (contract §3). This module keeps the exact export surface the routes and UI
 * already use, but every command is forwarded as raw NDJSON with wrapper-owned
 * `web-<n>` ids; the host owns the SDK session, extensions, plan mode, idle
 * reaping, auto-title, and all write leases.
 *
 * The wrapper taps the raw socket bytes itself: RpcClient is used only for its
 * start() lifecycle (ready interception + protocol v2 negotiation). Browser
 * events are emitted from the wrapper's own decode of forwarded frames, since
 * RpcClient drops several event types the web UI needs.
 */

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { realpathSync, statSync } from "fs";
import { join, resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { cacheSessionPath, invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "./session-reader";
import {
  FOREIGN_LEASE_ERROR,
  HostConnection,
  connectToHost,
  connectToHostWithRetry,
  findHostSocketKeyForSession,
  getDiscoveredHosts,
  hasDiscoveredLiveHost,
  hostSocketPath,
  hostUnitName,
  probeHostSocket,
  refreshHostDiscovery,
} from "./session-host-transport";
import {
  isHostHelloFrame,
  isHostSessionInfoFrame,
  type HostSessionInfoFrame,
  type HostStartOptions,
} from "./session-host-protocol";
import type { SessionInfo, SubagentSnapshot } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PromptTracker = {
  promptEvent: Record<string, unknown>;
  streamingBehavior: "steer" | "followUp" | undefined;
  settled: boolean;
};

type PendingCommand = {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

const RUNNING_STATE_EVENT_TYPES: Record<string, true> = {
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  compaction_start: true,
  compaction_end: true,
};

const MAX_SUBAGENT_HISTORY = 128;

/** How long shutdown() waits for the host to close its socket after the
 *  shutdown frame before falling back to stopping its transient unit. */
const HOST_SHUTDOWN_GRACE_MS = 5_000;

/** Read-only host queries must never hang a route; a lost response fails retryable. */
const READ_ONLY_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Bound for non-fire-and-forget mutations (steer, follow_up, set_*, compact, ...):
 * a lost ack must fail retryable, never hang the route until Cloudflare's ~100s
 * cap (#97). 30s mirrors the SDK RpcClient #send default; steer/follow_up ack
 * at ENQUEUE (not dequeue), so a healthy mid-turn steer settles in milliseconds
 * regardless of turn length. Override: OMP_WEB_MUTATION_TIMEOUT_MS (positive
 * milliseconds, default 30000) — tests use a short bound.
 */
const MUTATION_COMMAND_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OMP_WEB_MUTATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

/**
 * Pending-response bound per command (#96 read-only, #97 mutations). Returns
 * undefined for commands that must NOT time out:
 *   - prompt: fire-and-forget at admission; outcomes arrive as prompt_result (#88)
 *   - bash: interactive shell that can run for minutes; the UI owns abort_bash
 * get_* keeps the read-only bound; every other registered command (steer,
 * follow_up, set_*, compact, fork, navigate_tree, reload, auto_name, clear_queue,
 * abort*, execute_slash_command, delete_session, ...) is a bounded mutation.
 */
function pendingTimeoutMs(command: string): number | undefined {
  if (command === "prompt" || command === "bash") return undefined;
  if (command.startsWith("get_")) return READ_ONLY_COMMAND_TIMEOUT_MS;
  return MUTATION_COMMAND_TIMEOUT_MS;
}

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** Read-only reattach: never spawn when no live host answers (defect 2). */
  attachOnly?: boolean;
}

// ============================================================================
// AgentSessionWrapper — UDS proxy preserving the legacy route-facing surface
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiRequests = new Map<string, AgentEvent>();
  private pendingCommands = new Map<string, PendingCommand>();
  private requestId = 0;
  private promptRunning = false;
  private promptTrackers = new Map<string, PromptTracker>();
  /** command id → client draft identity, from the host_prompt_identity frame. */
  private promptIdentities = new Map<string, { promptId: string; streamingBehavior?: string }>();
  private streaming = false;
  private compacting = false;
  private bashRunning = false;
  private readonly subagentHistory = new Map<string, SubagentSnapshot>();
  private sessionInfoMirror: HostSessionInfoFrame | undefined;
  private realSessionIdValue: string;
  /** Socket/unit key the host was spawned under; differs from the real id
   *  after reattach (hosts spawned via /api/agent/new carry __new__ keys). */
  private hostKeyValue: string;
  private sessionFileValue: string;
  private cwdValue: string;
  private lastSeenSeq = 0;
  private sawReady = false;
  // Gap replay may re-deliver frames a connected-but-unattached client already
  // saw live (duplicate ready + live/replay copies). Dedupe by ring end offset
  // until the host_attach ack makes lastSeenSeq authoritative.
  private attached = false;
  private readonly seenFrameEnds = new Set<number>();
  private decoder = new RpcFrameDecoder();
  private decodeErrorLoggedAt = 0;
  private lineBuffer = Buffer.alloc(0);
  private readonly terminate: { allowed: boolean };
  private readonly attachToHost: () => void;
  private shutdownPromise: Promise<void> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private readonly client: RpcClient;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly connection: HostConnection,
    requested: { sessionId: string; sessionFile: string; cwd: string },
    attachOptions: { attach: () => void; terminate: { allowed: boolean }; hostKey?: string },
  ) {
    this.realSessionIdValue = requested.sessionId;
    this.hostKeyValue = attachOptions.hostKey ?? requested.sessionId;
    this.sessionFileValue = requested.sessionFile;
    this.cwdValue = requested.cwd;
    this.terminate = attachOptions.terminate;
    this.attachToHost = attachOptions.attach;
    this.client = new RpcClient({ spawn: () => this.connection.process });
    // Host exit (crash, idle reap, fork, shutdown) detaches the wrapper. The
    // host survives plain web detaches; only a real host exit lands here.
    void this.connection.process.exited.then(() => {
      if (this._alive) this.destroy();
    });
  }

  /**
   * Attach to the host and run the RpcClient lifecycle (ready + negotiate v2).
   * The tap is wired via the connection's rawStdout hook before construction.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      // Contract §3 attach handshake: the host answers hello + cached ready +
      // gap replay + host_attach(seq). Written once start() is underway so the
      // RpcClient reader is live before any host bytes arrive.
      this.attachToHost();
      await this.client.start();
    })();
    return this.startPromise;
  }

  async waitUntilReady(): Promise<void> {
    if (this.startPromise) await this.startPromise;
  }

  get sessionId(): string {
    return this.realSessionIdValue;
  }

  get sessionFile(): string {
    return this.sessionFileValue;
  }

  get cwd(): string {
    return this.cwdValue;
  }

  /** Ring position for the next host_attach (authoritative after ack). */
  get attachSeq(): number {
    return this.lastSeenSeq;
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (
      this.promptRunning
      || this.streaming
      || this.compacting
      || this.bashRunning
      || this.getSubagentSnapshots().some((s) => s.status === "pending" || s.status === "running")
    );
  }

  /** Host-pushed session_info mirror backing the synchronous session list. */
  get sessionInfo(): HostSessionInfoFrame | undefined {
    return this.sessionInfoMirror;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  // --------------------------------------------------------------------------
  // Raw stdout tap (contract §3): line-split, decode, intercept, re-forward.
  // --------------------------------------------------------------------------

  handleRawStdout(chunk: Uint8Array): void {
    this.lineBuffer = this.lineBuffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.lineBuffer, chunk]);
    for (;;) {
      const newline = this.lineBuffer.indexOf(0x0a);
      if (newline === -1) break;
      const lineBytes = this.lineBuffer.subarray(0, newline);
      this.lineBuffer = this.lineBuffer.subarray(newline + 1);
      // Ring position = cumulative byte offset AFTER this line (host seq).
      this.lastSeenSeq += lineBytes.length + 1;
      const frameEnd = this.lastSeenSeq;
      const line = lineBytes.toString("utf8").trim();
      if (!line) continue;
      this.handleLine(line, frameEnd);
    }
  }

  private handleLine(line: string, frameEnd: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // malformed host line: nothing to forward
    }
    if (isHostHelloFrame(parsed)) {
      this.realSessionIdValue = parsed.sessionId;
      this.sessionFileValue = parsed.sessionFile;
      this.cwdValue = parsed.cwd;
      return;
    }
    if (isHostSessionInfoFrame(parsed)) {
      this.sessionInfoMirror = parsed;
      invalidateSessionListCache();
      if (parsed.modelDefaultChanged) invalidateModelsCache();
      return;
    }
    if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "host_prompt_identity") {
      // Host-only draft identity (#88 / defect 2): never forwarded to the
      // browser; consumed when the SDK prompt_result settles the command.
      const commandId = "id" in parsed && typeof parsed.id === "string" ? parsed.id : undefined;
      const promptId = "promptId" in parsed && typeof parsed.promptId === "string" ? parsed.promptId : undefined;
      if (commandId && promptId) {
        this.promptIdentities.set(commandId, {
          promptId,
          ...("streamingBehavior" in parsed && typeof parsed.streamingBehavior === "string"
            ? { streamingBehavior: parsed.streamingBehavior }
            : {}),
        });
      }
      return;
    }
    if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "host_attach") {
      // host_attach.seq is the authoritative ring position — never byte-sum
      // client-side (duplicate ready + live/replay copies make that unreliable).
      if ("seq" in parsed && typeof parsed.seq === "number") this.lastSeenSeq = parsed.seq;
      this.attached = true;
      this.seenFrameEnds.clear();
      return;
    }
    // Contract §3(d): FORWARD RE-SERIALIZED DECODED frames — selective raw-line
    // forwarding corrupts the client decoder (chunked frames must reassemble
    // first). Host-only frames above never reach the client stream.
    let decoded: object | undefined;
    try {
      decoded = this.decoder.push(parsed);
    } catch (error) {
      // The SDK decoder never clears its pending chunk sequence on throw, so one
      // interrupted/truncated sequence poisons EVERY later frame. Reset and retry
      // once: a non-chunk frame that interrupted a sequence is delivered intact on
      // the retry; a genuinely corrupt chunk is dropped and the client reconciles
      // via get_entries/get_state. Throttle the log so a burst cannot flood journald.
      this.decoder = new RpcFrameDecoder();
      const now = Date.now();
      if (now - this.decodeErrorLoggedAt >= 1000) {
        this.decodeErrorLoggedAt = now;
        console.error("[omp-web] host frame decode failed (decoder reset):", error instanceof Error ? error.message : error);
      }
      try {
        decoded = this.decoder.push(parsed);
      } catch {
        return; // unrecoverable single frame; drop it, stream stays healthy
      }
    }
    if (!decoded) return; // rpc_chunk mid-reassembly: nothing to forward yet
    if (!this.attached) {
      // Pre-ack frames: the same logical frame can arrive twice (connect-time
      // live copy, then gap-replay copy). Dedupe by ring end offset.
      if (this.seenFrameEnds.has(frameEnd)) return;
      this.seenFrameEnds.add(frameEnd);
    }
    const frame = decoded as AgentEvent;
    if (frame.type === "response" && typeof frame.id === "string" && this.pendingCommands.has(frame.id)) {
      // Wrapper-owned command response: resolve here, never forward (§3a).
      this.handleResponseFrame(frame);
      return;
    }
    if (frame.type === "extension_ui_request") {
      // Browser machinery owns these; the client has no UI handling (§3b).
      this.handleExtensionUiRequest(frame);
      return;
    }
    if (frame.type === "ready") {
      // Replay may re-deliver ready after the client already consumed one;
      // forward only the first so negotiation sees exactly one ready line.
      if (this.sawReady) return;
      this.sawReady = true;
    }
    this.connection.feedStdout(Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
    this.handleFrame(frame);
  }

  private handleFrame(frame: AgentEvent): void {
    const type = frame.type;
    if (type === "response") {
      this.handleResponseFrame(frame);
      return;
    }
    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(frame);
      return;
    }
    if (type === "prompt_result") {
      this.handlePromptResult(frame);
      // fall through: also emit to listeners
    }
    if (type === "agent_start") this.streaming = true;
    if (type === "agent_end") {
      this.streaming = false;
      invalidateSessionListCache();
    }
    if (type === "agent_settled" || type === "session_settled") this.streaming = false;
    if (type === "compaction_start" || type === "auto_compaction_start") this.compacting = true;
    if (type === "compaction_end" || type === "auto_compaction_end") this.compacting = false;
    // bash has no lifecycle events on the wire; send() flips the mirror at
    // admission and the response handler clears it (host guards admission).
    if (type === "session_renamed" || type === "session_info_update") invalidateSessionListCache();
    if (type === "subagent_lifecycle" || type === "subagent_progress") this.rememberSubagentFrame(frame);
    this.emit(frame);
    if (RUNNING_STATE_EVENT_TYPES[type] || type === "subagent_lifecycle" || type === "prompt_result") {
      notifyRunningChange();
    }
  }

  private handleResponseFrame(frame: AgentEvent): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const pending = id ? this.pendingCommands.get(id) : undefined;
    if (!pending || !id) return; // negotiation / client-owned responses pass through
    this.pendingCommands.delete(id);
    clearTimeout(pending.timer);
    const command = pending.command;
    if (command === "set_model" || command === "set_role_model" || command === "reload") {
      invalidateModelsCache();
    }
    if (
      command === "set_model" || command === "set_role_model" || command === "set_thinking_level"
      || command === "set_session_name" || command === "compact" || command === "bash"
      || command === "fork" || command === "reload" || command === "auto_name"
    ) {
      invalidateSessionListCache();
    }
    if (frame.success === true) {
      if (command === "get_state") this.refreshStateMirrors(frame.data);
      if (command === "bash" || command === "abort_bash") this.bashRunning = false;
      let data = "data" in frame ? frame.data : undefined;
      if (command === "get_state") data = this.overlayState(data);
      if (pending.command === "prompt") {
        // Ack with agentInvoked === false: the prompt was never started. The
        // tracker stays in promptTrackers keyed by request id so a later
        // prompt_result (or this ack) settles it exactly once.
        const ack = data;
        if (typeof ack === "object" && ack !== null && "agentInvoked" in ack && ack.agentInvoked === false) {
          this.settlePromptById(id, undefined);
        }
      }
      pending.resolve(data);
    } else {
      const message = typeof frame.error === "string" ? frame.error : `Command failed: ${command}`;
      if (command === "bash" || command === "abort_bash") this.bashRunning = false;
      if (command === "prompt") this.settlePromptById(id, message);
      pending.reject(new Error(message));
    }
    notifyRunningChange();
  }

  /**
   * The host owns get_state; the wrapper overlays the bits it alone knows:
   * whether THIS proxy still considers a prompt in flight, and the subagent
   * history it has accumulated from forwarded frames.
   */
  private overlayState(data: unknown): unknown {
    if (typeof data !== "object" || data === null) return data;
    return {
      ...data,
      isPromptRunning: this.promptRunning,
      subagents: this.getSubagentSnapshots(),
    };
  }

  private refreshStateMirrors(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const state = data as Record<string, unknown>;
    if (typeof state.isStreaming === "boolean") this.streaming = state.isStreaming;
    if (typeof state.isCompacting === "boolean") this.compacting = state.isCompacting;
    if (typeof state.isBashRunning === "boolean") this.bashRunning = state.isBashRunning;
  }

  private handlePromptResult(frame: AgentEvent): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) return;
    const status = frame.status;
    if (status === "error") {
      const error = frame.error;
      const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "Prompt failed";
      this.settlePromptById(id, message);
    } else {
      this.settlePromptById(id, undefined);
    }
  }

  private settlePromptById(id: string, errorMessage: string | undefined): void {
    const tracker = this.promptTrackers.get(id);
    if (tracker) {
      this.promptTrackers.delete(id);
      this.promptIdentities.delete(id);
      this.settlePrompt(tracker, errorMessage);
      return;
    }
    // Tracker miss: a prompt admitted by a PREVIOUS web process settles here
    // after reattach (ring replay). The host's host_prompt_identity frame
    // carries the original draft identity; replay the same settlement events
    // so the restarted web confirms the submitter's draft. Without an identity
    // the draft is not ours — never touch it.
    const identity = this.promptIdentities.get(id);
    if (!identity) return;
    this.promptIdentities.delete(id);
    const streamingBehavior = identity.streamingBehavior === "steer" || identity.streamingBehavior === "followUp"
      ? identity.streamingBehavior
      : undefined;
    this.settlePrompt({ promptEvent: { promptId: identity.promptId, ...(streamingBehavior ? { streamingBehavior } : {}) }, streamingBehavior, settled: false }, errorMessage);
  }

  private settlePrompt(tracker: PromptTracker, errorMessage: string | undefined): void {
    if (tracker.settled) return;
    tracker.settled = true;
    this.promptRunning = false;
    if (errorMessage !== undefined) {
      invalidateSessionListCache();
      this.emit({ type: "prompt_error", errorMessage, ...tracker.promptEvent });
      if (!tracker.streamingBehavior) this.emit({ type: "prompt_done", ...tracker.promptEvent });
    } else {
      this.emit({ type: "prompt_done", ...tracker.promptEvent });
    }
    notifyRunningChange();
  }

  // --------------------------------------------------------------------------
  // Extension UI: the host owns the promises; the wrapper owns browser frames.
  // --------------------------------------------------------------------------

  private handleExtensionUiRequest(frame: AgentEvent): void {
    const method = frame.method;
    if (method === "cancel") {
      // Host-side timeout/abort: settle the original request's default on the
      // host; the browser union has no cancel member, so drop the pending frame.
      const targetId = typeof frame.targetId === "string" ? frame.targetId : undefined;
      if (targetId) this.pendingUiRequests.delete(targetId);
      return;
    }
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) return;
    const normalized = this.normalizeUiRequest(frame);
    this.pendingUiRequests.set(id, normalized);
    this.emit(normalized);
  }

  private normalizeUiRequest(frame: AgentEvent): AgentEvent {
    const out: AgentEvent = { ...frame };
    const timeout = frame.timeout;
    if (typeof timeout === "number" && timeout > 0 && out.expiresAt === undefined) {
      out.expiresAt = Date.now() + timeout;
    }
    if (frame.method === "select" && Array.isArray(frame.options)) {
      const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
      out.options = frame.options.map((label, index) => {
        if (typeof label === "object" && label !== null) return label;
        const detail = details[index];
        const description = typeof detail === "object" && detail !== null && "description" in detail
          && typeof detail.description === "string" ? detail.description : undefined;
        return { label: String(label), ...(description ? { description } : {}) };
      });
      delete out.optionDetails;
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Subagent history (wrapper-side, fed by forwarded lifecycle/progress frames)
  // --------------------------------------------------------------------------

  private rememberSubagentSnapshot(snapshot: SubagentSnapshot): void {
    this.subagentHistory.set(snapshot.id, snapshot);
    if (this.subagentHistory.size <= MAX_SUBAGENT_HISTORY) return;
    const removable = [...this.subagentHistory.values()]
      .filter((entry) => entry.status !== "pending" && entry.status !== "running")
      .sort((left, right) => left.lastUpdate - right.lastUpdate);
    while (this.subagentHistory.size > MAX_SUBAGENT_HISTORY && removable.length > 0) {
      const oldest = removable.shift();
      if (oldest) this.subagentHistory.delete(oldest.id);
    }
  }

  private rememberSubagentFrame(event: AgentEvent): void {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    if (event.type === "subagent_progress") {
      const p = payload as Record<string, unknown>;
      const progress = p.progress;
      if (typeof progress !== "object" || progress === null) return;
      const id = (progress as Record<string, unknown>).id;
      if (typeof id !== "string") return;
      const previous = this.subagentHistory.get(id);
      // Ignore progress for ids never started (same rule as the SDK registry).
      if (!previous) return;
      this.rememberSubagentSnapshot({
        ...previous,
        index: typeof p.index === "number" ? p.index : previous.index,
        agent: typeof p.agent === "string" ? p.agent : previous.agent,
        task: typeof p.task === "string" ? p.task : previous.task,
        assignment: typeof p.assignment === "string" ? p.assignment : previous.assignment,
        sessionFile: typeof p.sessionFile === "string" ? p.sessionFile : previous.sessionFile,
        parentToolCallId: typeof p.parentToolCallId === "string" ? p.parentToolCallId : previous.parentToolCallId,
        lastUpdate: Date.now(),
        progress: progress as SubagentSnapshot["progress"],
      });
      return;
    }
    if (event.type !== "subagent_lifecycle") return;
    const p = payload as Record<string, unknown>;
    const id = p.id;
    const status = p.status;
    if (typeof id !== "string" || typeof status !== "string") return;
    const previous = this.subagentHistory.get(id);
    if (!previous && status !== "started") return;
    const snapshotStatus: SubagentSnapshot["status"] = status === "started"
      ? "running"
      : status === "failed" ? "failed" : status === "aborted" ? "aborted" : "completed";
    this.rememberSubagentSnapshot({
      id,
      index: typeof p.index === "number" ? p.index : previous?.index ?? 0,
      agent: typeof p.agent === "string" ? p.agent : previous?.agent ?? id,
      agentSource: p.agentSource === "user" || p.agentSource === "project" ? p.agentSource : previous?.agentSource ?? "bundled",
      description: typeof p.description === "string" ? p.description : previous?.description,
      status: snapshotStatus,
      task: previous?.task,
      assignment: previous?.assignment,
      sessionFile: typeof p.sessionFile === "string" ? p.sessionFile : previous?.sessionFile,
      lastUpdate: Date.now(),
      parentToolCallId: typeof p.parentToolCallId === "string" ? p.parentToolCallId : previous?.parentToolCallId,
      progress: previous?.progress ? { ...previous.progress, status: snapshotStatus } : undefined,
    });
  }

  private getSubagentSnapshots(): SubagentSnapshot[] {
    return [...this.subagentHistory.values()].sort((left, right) => {
      const leftActive = left.status === "pending" || left.status === "running";
      const rightActive = right.status === "pending" || right.status === "running";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive) return left.index - right.index || left.id.localeCompare(right.id);
      return right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id);
    });
  }

  /**
   * Forward a browser command to the host over the UDS wire. The wrapper owns
   * `web-<n>` request ids (collision-free vs RpcClient's negotiate `req_N`);
   * responses are resolved from pendingCommands in the tap. The host owns ALL
   * command semantics — idle timers, extension binding, plan mode, auto-title.
   */
  async send(command: Record<string, unknown>): Promise<unknown> {
    // Fail fast on a dead connection (#97): writeBytes silently drops bytes
    // once closed, so a steer written here would 200-ack while never reaching
    // the host. Degrade (evict + destroy, detach-only) so the NEXT request
    // reattaches fresh instead of hitting this zombie via the registry fast
    // path. _alive alone is not enough: it only flips in the exited.then
    // microtask, leaving a window where the socket is already closed.
    if (!this._alive || this.connection.isClosed) {
      this.destroy();
      throw new Error("Session closed");
    }
    const type = command.type as string;
    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    // Extension-UI side channel: no web-id, host resolves its own pending UI.
    if (type === "extension_ui_response") {
      const id = command.id as string;
      const frame: Record<string, unknown> = { type, id };
      if ("value" in command) frame.value = command.value;
      if ("confirmed" in command) frame.confirmed = command.confirmed;
      if ("cancelled" in command) frame.cancelled = command.cancelled;
      this.writeFrame(frame);
      this.pendingUiRequests.delete(id);
      return null;
    }
    if (type === "extension_ui_input") {
      this.writeFrame({ type, id: command.id as string, data: command.data });
      return null;
    }

    const id = `web-${++this.requestId}`;

    if (type === "prompt") {
      // Fire and forget at admission — outcomes arrive as prompt_result (#88).
      const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
      const promptId = typeof command.promptId === "string" && command.promptId ? command.promptId : undefined;
      const promptEvent = {
        ...(promptId ? { promptId } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      };
      this.promptTrackers.set(id, { promptEvent, streamingBehavior, settled: false });
      this.promptRunning = true;
      notifyRunningChange();
      const images = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
      const frame: Record<string, unknown> = { id, type: "prompt", message: command.message };
      if (images?.length) frame.images = images;
      if (streamingBehavior) frame.streamingBehavior = streamingBehavior;
      // Draft identity rides the wire so a reattached wrapper can settle the
      // prompt after a web restart (the SDK ignores unknown command fields).
      if (promptId) frame.promptId = promptId;
      this.writeFrame(frame);
      // Fire-and-forget ack: failures are surfaced through settlePromptById
      // (prompt_error); swallowing here keeps the rejection from escaping.
      this.registerPending(id, type).catch(() => {});
      return null;
    }

    if (type === "steer" || type === "follow_up") {
      const images = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
      const frame: Record<string, unknown> = { id, type, message: command.message };
      if (images?.length) frame.images = images;
      this.writeFrame(frame);
      await this.registerPending(id, type);
      return null;
    }

    if (type === "bash") {
      // No bash lifecycle events on the wire: flip the mirror at admission and
      // clear it when the response lands (host enforces the busy guard).
      this.bashRunning = true;
      notifyRunningChange();
    }

    this.writeFrame({ id, ...command });
    return this.registerPending(id, type);
  }

  private writeFrame(frame: Record<string, unknown>): void {
    this.connection.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private registerPending(id: string, command: string): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const entry: PendingCommand = { command, resolve, reject };
    const timeoutMs = pendingTimeoutMs(command);
    if (timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        if (this.pendingCommands.get(id) !== entry) return; // already settled
        this.pendingCommands.delete(id);
        reject(new Error(`Timed out waiting for host response: ${command} (connection degraded; retry reattaches)`));
        // A command that never round-trips means this wrapper's connection is
        // degraded (#97): evict + destroy (detach-only, the host survives) so the
        // NEXT request reattaches fresh instead of reusing this zombie via the
        // registry alive fast path. destroy rejects the remaining pending and
        // clears their timers; the identity guard above keeps this a no-op if
        // the entry already settled.
        this.destroy();
      }, timeoutMs);
    }
    this.pendingCommands.set(id, entry);
    return promise;
  }

  /** Detach-only: the host survives web disconnects (contract §3). */
  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Session closed"));
    }
    this.pendingCommands.clear();
    this.promptTrackers.clear();
    this.promptIdentities.clear();
    this.pendingUiRequests.clear();
    this.subagentHistory.clear();
    try {
      this.connection.detach();
    } finally {
      try {
        this.onDestroyCallback?.();
      } finally {
        notifyRunningChange();
      }
    }
  }

  /**
   * Explicit user-driven shutdown (DELETE-session / trust reset / fork tail):
   * unlock termination, ask the host to tear down, then detach. Memoized.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return Promise.resolve();
    this.shutdownPromise = (async () => {
      this.terminate.allowed = true;
      try {
        // Ask the host to tear down and wait for it to close the socket: an
        // immediate detach would drop the queued shutdown frame and leave the
        // host (and its write lease) alive.
        this.writeFrame({ type: "shutdown" });
        const exited = this.connection.process.exited.then(() => true, () => true);
        const closed = await Promise.race([exited, Bun.sleep(HOST_SHUTDOWN_GRACE_MS).then(() => false)]);
        if (!closed) {
          // The host never answered (wedged or pre-protocol): stop its
          // transient unit — termination was explicitly requested.
          await stopHostUnit(this.hostKeyValue);
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }
}

// ============================================================================
// Registry, locks, and per-cwd starting counters (contract §5).
//
// All state lives on globalThis so it survives Next.js hot reload. Registry
// exit handlers are DETACH-ONLY (contract §3): hosts live outside this
// process's cgroup and MUST survive web restarts/upgrades — killing them here
// would defeat the entire process split.
// ============================================================================

declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompStartingSessionCwds: Map<string, number> | undefined;
  var __ompRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => globalThis.__ompSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__ompStartingSessionCwds) globalThis.__ompStartingSessionCwds = new Map();
  return globalThis.__ompStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/**
 * Read-only reattach for routes that only inspect a session (defect 2).
 * Returns the registry wrapper when alive; otherwise rediscovers surviving
 * hosts via sidecars/socket probes and attaches WITHOUT the foreign-lease
 * refusal (a live answering socket proves our own host). NEVER spawns — a
 * session with no live host stays file-only.
 */
export async function attachLiveHostIfExists(sessionId: string): Promise<AgentSessionWrapper | undefined> {
  const existing = getRegistry().get(sessionId);
  if (existing?.isAlive()) return existing;
  const inflight = getLocks().get(sessionId);
  if (inflight) {
    try { return (await inflight).session; } catch { return undefined; }
  }
  await refreshHostDiscovery();
  if (!hasDiscoveredLiveHost(sessionId) && !(await findHostSocketKeyForSession(sessionId))) return undefined;
  // Resolve the journal path so startRpcSession's cwd guard passes and the
  // journal-header candidate resolves; the hello frame fills file/cwd anyway.
  const sessionFile = (await resolveSessionPath(sessionId)) ?? "";
  try {
    const { session } = await startRpcSession(sessionId, sessionFile, undefined, { attachOnly: true });
    return session.isAlive() ? session : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Live sessions visible in the session list, computed SYNC from the
 * host-pushed session_info mirrors (contract §4). The web tier NEVER reads a
 * live session's journal: the host emits a mirror on prompt admission,
 * agent_end, prompt_result, session_renamed, session_settled, and attach, and
 * already suppresses idle empty ensure_session runtimes.
 */
export function getRpcSessionInfos(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;
    const mirror = session.sessionInfo;
    if (!mirror) continue;
    const running = session.isRunning();
    const sessionFile = mirror.sessionFile || session.sessionFile;
    sessions.push({
      path: sessionFile,
      id: mirror.sessionId || session.sessionId,
      cwd: mirror.cwd || session.cwd,
      ...(mirror.name ? { name: mirror.name } : {}),
      created: mirror.created,
      modified: mirror.modified,
      messageCount: mirror.messageCount,
      firstMessage: mirror.firstMessage,
      transient: !mirror.persisted,
      status: running ? "pending" : mirror.status,
      size: mirror.persisted && sessionFile
        ? (() => { try { return statSync(sessionFile).size; } catch { return undefined; } })()
        : undefined,
    });
  }
  // Merge surviving hosts the restarted web has not attached yet (defect 2).
  // Registry wins per id; discovery entries map the sidecar mirror exactly
  // like the registry branch. Sync — routes await refreshHostDiscovery first.
  const seen = new Set(sessions.map((info) => info.id));
  for (const [realId, entry] of getDiscoveredHosts()) {
    if (seen.has(realId) || !hasDiscoveredLiveHost(realId)) continue;
    const mirror = entry.info;
    const sessionFile = mirror.sessionFile;
    sessions.push({
      path: sessionFile,
      id: realId,
      cwd: mirror.cwd,
      ...(mirror.name ? { name: mirror.name } : {}),
      created: mirror.created,
      modified: mirror.modified,
      messageCount: mirror.messageCount,
      firstMessage: mirror.firstMessage,
      transient: !mirror.persisted,
      status: mirror.isRunning ? "pending" : mirror.status,
      size: mirror.persisted && sessionFile
        ? (() => { try { return statSync(sessionFile).size; } catch { return undefined; } })()
        : undefined,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  if (Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  )) return true;
  // Discovered surviving hosts count as busy too (defect 2).
  for (const [realId, entry] of getDiscoveredHosts()) {
    if (hasDiscoveredLiveHost(realId) && entry.info.isRunning && normalizeRpcCwd(entry.info.cwd) === targetCwd) return true;
  }
  return false;
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  // Discovered surviving hosts for this cwd must die too (defect 2): attach
  // each through the normal path, then shut it down.
  await refreshHostDiscovery();
  const attachedIds = new Set(sessions.map((session) => session.sessionId));
  let destroyed = sessions.length;
  for (const [realId, entry] of getDiscoveredHosts()) {
    if (attachedIds.has(realId) || !hasDiscoveredLiveHost(realId)) continue;
    if (normalizeRpcCwd(entry.info.cwd) !== targetCwd) continue;
    const session = await attachLiveHostIfExists(realId);
    if (!session) continue;
    await session.shutdown();
    destroyed += 1;
  }
  return destroyed;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  for (const [realId, entry] of getDiscoveredHosts()) {
    if (entry.info.isRunning && hasDiscoveredLiveHost(realId)) ids.add(realId);
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------


export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  const listeners = globalThis.__ompRunningListeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = globalThis.__ompRunningListeners;
  if (!listeners || listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

// ============================================================================
// Host lifecycle: lease probe → connect-or-spawn → attach.
// ============================================================================

// Repo root: this module lives at <root>/lib/rpc-manager.ts in every layout
// (source checkout, deb sync_app overlay, worktree). import.meta.dir is
// Bun-only — webpack compiles it to `undefined` in built server chunks — so
// the prod-build branch uses the launch cwd, which bin/omp-web.js and the
// systemd units pin to the repo root. Do NOT fall back inside resolve():
// cwd is ALREADY the root, while import.meta.dir is <root>/lib.
const HOST_REPO_ROOT = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd();

/**
 * argv for a fresh host, pinned with the host slice: flag encoding matching
 * ops/session-host/main.ts parseArgs (NOT a single JSON argument).
 */
function hostSpawnArgs(start: HostStartOptions): string[] {
  const args = [
    join(HOST_REPO_ROOT, "ops", "session-host", "main.ts"),
    "--session-id", start.sessionId,
    "--session-file", start.sessionFile,
  ];
  if (start.cwd) args.push("--cwd", start.cwd);
  // Omitted when unset (host keeps all tools active); [] means "all off".
  if (start.toolNames !== undefined) args.push("--tools", JSON.stringify(start.toolNames));
  if (start.initialModel) args.push("--model", `${start.initialModel.provider}/${start.initialModel.modelId}`);
  if (start.thinkingLevel) args.push("--thinking-level", start.thinkingLevel);
  return args;
}

/**
 * Launch one host OUTSIDE this service's cgroup (contract §1): a transient
 * user unit survives omp-web restarts. systemd-run returns before the host
 * binds its socket; connectToHostWithRetry covers that race.
 */
async function spawnSessionHost(start: HostStartOptions): Promise<void> {
  const argv = [
    "systemd-run", "--user", "--collect", `--unit=${hostUnitName(start.sessionId)}`,
  ];
  // systemd-run does NOT inherit the caller's environment: the transient unit
  // runs under the user manager's env block. Forward the isolation seams the
  // host must agree with this process on — the socket run dir (web computes
  // hostSocketPath from ITS env; a host binding the default dir would never be
  // found) and the idle-reap override. Unset vars stay unset (host defaults).
  for (const key of ["OMP_WEB_HOST_RUN_DIR", "OMP_WEB_HOST_IDLE_MS"]) {
    const value = process.env[key];
    if (value !== undefined) argv.push(`--setenv=${key}=${value}`);
  }
  argv.push(process.execPath, ...hostSpawnArgs(start));
  const proc = Bun.spawn(argv, { cwd: HOST_REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(`Failed to start session host ${start.sessionId}: ${stderr.trim() || `systemd-run exited with code ${exitCode}`}`);
  }
}

/** Explicit termination fallback: stop the host's transient unit. */
async function stopHostUnit(sessionId: string): Promise<void> {
  try {
    const proc = Bun.spawn(["systemctl", "--user", "stop", `${hostUnitName(sessionId)}.service`], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // Best effort: the unit may already be gone (--collect).
  }
}

/**
 * Foreign-lease probe (contract §5): web NEVER holds write leases. A live
 * foreign holder (TUI/CLI, or another web instance after a hot reload) means
 * the journal stays readable but cannot be modified here — refuse clearly
 * instead of letting the SDK silently fork to a sibling journal.
 */
export function refuseForeignSessionLease(sessionFile: string): void {
  const header = readSessionHeader(sessionFile);
  if (!header?.id) return;
  const lease = tryAcquireSessionLease(header.id);
  if (!lease) throw new Error(FOREIGN_LEASE_ERROR);
  lease.release();
}

/**
 * Get or attach the session host for a conversation.
 *
 * A live host answers its socket immediately (host_hello + cached ready +
 * session_info on attach) and keeps the identity it was created with — start
 * options only apply to a FRESH host, which replicates the old creation
 * preamble (rotation, model scope, trust gating, tool allow-list) itself.
 * After an idle reap or crash the next message transparently re-spawns it.
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    if (!sessionFile && !cwd) throw new Error("cwd is required for a new session");
    const finishStartingSession = trackStartingSession(cwd ?? process.cwd());

    // Defect 2: resolve the host socket key BEFORE any lease probe. A host
    // spawned via /api/agent/new lives under a __new__ temp key while routes
    // ask by real id; after a web restart the registry is empty and only the
    // socket/sidecar can bridge the two. A live answering socket proves our
    // OWN host, so the attach branch skips refuseForeignSessionLease entirely
    // (the host legitimately holds the SDK journal lease).
    const candidates: string[] = [sessionId];
    if (sessionFile) {
      const headerId = readSessionHeader(sessionFile)?.id;
      if (headerId && !candidates.includes(headerId)) candidates.push(headerId);
    }
    let hostKey: string | undefined;
    let hostHelloSessionFile: string | undefined;
    let hostHelloCwd: string | undefined;
    for (const key of candidates) {
      const hello = await probeHostSocket(hostSocketPath(key));
      if (hello && (!sessionFile || hello.sessionFile === sessionFile)) {
        hostKey = key;
        hostHelloSessionFile = hello.sessionFile;
        hostHelloCwd = hello.cwd;
        break;
      }
    }
    if (!hostKey) {
      const discoveredKey = sessionFile ? await findHostSocketKeyForSession(readSessionHeader(sessionFile)?.id ?? sessionId) : undefined;
      if (discoveredKey) {
        const hello = await probeHostSocket(hostSocketPath(discoveredKey));
        if (hello && (!sessionFile || hello.sessionFile === sessionFile)) {
          hostKey = discoveredKey;
          hostHelloSessionFile = hello.sessionFile;
          hostHelloCwd = hello.cwd;
        }
      }
    }
    if (!hostKey && options.attachOnly) throw new Error("No live host for this session");
    if (!hostKey && sessionFile) refuseForeignSessionLease(sessionFile);

    const terminate = { allowed: false };
    const earlyChunks: Buffer[] = [];
    let wrapper: AgentSessionWrapper | undefined;
    // requestTerminate must use the ANSWERED key once known: a reattach keyed
    // by real id still targets a unit named after the original __new__ key.
    let terminateKey = sessionId;
    const connectionOptions = {
      socketPath: hostSocketPath(hostKey ?? sessionId),
      allowTerminate: () => terminate.allowed,
      requestTerminate: () => { void stopHostUnit(terminateKey); },
      // The host greets on connect AND on attach, before the wrapper exists:
      // buffer those bytes and replay them into the tap once it is wired.
      rawStdout: (chunk: Uint8Array) => {
        if (wrapper) wrapper.handleRawStdout(chunk);
        else earlyChunks.push(Buffer.from(chunk));
      },
      onError: () => wrapper?.destroy(),
    };

    let connection: HostConnection | undefined;
    try {
      if (hostKey) {
        // Live host answered: attach. Lease refusal was skipped above.
        terminateKey = hostKey;
        connection = await connectToHost(connectionOptions);
      } else {
        try {
          connection = await connectToHost(connectionOptions);
        } catch {
          // No live host: lease already probed above, so the host may safely
          // unlink a stale socket and create/open the journal itself.
          await spawnSessionHost({
            sessionId,
            sessionFile,
            ...(cwd ? { cwd } : {}),
            ...(options.toolNames !== undefined ? { toolNames: options.toolNames } : {}),
            ...(options.initialModel ? { initialModel: options.initialModel } : {}),
            ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
          });
          connection = await connectToHostWithRetry(connectionOptions);
        }
      }

      const attached = connection;
      wrapper = new AgentSessionWrapper(
        attached,
        {
          sessionId,
          sessionFile: sessionFile || hostHelloSessionFile || "",
          cwd: cwd || hostHelloCwd || "",
        },
        {
          attach: () => {
            attached.process.stdin.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq: active.attachSeq })}\n`);
          },
          terminate,
          hostKey: hostKey ?? sessionId,
        },
      );
      const active = wrapper;
      for (const chunk of earlyChunks) active.handleRawStdout(chunk);
      earlyChunks.length = 0;

      await active.start();
      // Parity with the old ctor: stream subagent lifecycle/progress frames.
      await active.send({ type: "set_subagent_subscription", level: "progress" });

      const realSessionId = active.sessionId;
      if (active.sessionFile) cacheSessionPath(realSessionId, active.sessionFile);
      active.onDestroy(() => registry.delete(realSessionId));
      registry.set(realSessionId, active);
      notifyRunningChange();
      return { session: active, realSessionId };
    } catch (error) {
      wrapper?.destroy();
      connection?.detach();
      // The host exits before binding when a foreign process claimed the
      // lease between our probe and its own claim; the connect timeout would
      // otherwise mask the real cause. Re-probe so callers get the clear
      // refusal (routes map FOREIGN_LEASE_ERROR to 409).
      if (!hostKey && sessionFile) {
        try {
          refuseForeignSessionLease(sessionFile);
        } catch (refusal) {
          throw refusal;
        }
      }
      throw error;
    } finally {
      finishStartingSession();
    }
  })().finally(() => {
    locks.delete(sessionId);
  });

  locks.set(sessionId, starting);
  return starting;
}