import { resolveSessionPath } from "@/lib/session-reader";
import { attachLiveHostIfExists, getRpcSession, startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { requireVisibleSession } from "@/lib/web-session-guard";

const OMITTED_EVENT_TYPES: Record<string, true> = { turn_start: true, turn_end: true, tool_execution_update: true };

function toClientEvent(event: AgentEvent): AgentEvent | null {
  if (OMITTED_EVENT_TYPES[event.type]) return null;
  if (event.type === "message_update") {
    const clientEvent = { ...event };
    delete clientEvent.assistantMessageEvent;
    return clientEvent;
  }
  if (event.type === "agent_end") return { type: "agent_end", hostSeq: event.hostSeq };
  return event;
}

/** Cap for frames buffered while the boundary control round-trips (#99). */
const PRE_BOUNDARY_BUFFER_LIMIT = 4096;

/**
 * Volatile pre-boundary frames: latest-snapshot-wins per key, safe to
 * coalesce/drop under backlog because a fresher snapshot (or the durable
 * journal) supersedes them. Everything else is must-deliver: overflowing it
 * fails the stream recoverably instead of silently losing durable events.
 */
function volatileKey(event: AgentEvent): string | null {
  if (event.type === "message_update" || event.type === "message_start") {
    return typeof event.messageId === "string" ? `message:${event.messageId}` : "message:*";
  }
  if (event.type === "subagent_progress") {
    const payload = event.payload;
    if (typeof payload === "object" && payload !== null && "progress" in payload) {
      const progress = payload.progress;
      if (typeof progress === "object" && progress !== null && "id" in progress && typeof progress.id === "string") {
        return `subagent:${progress.id}`;
      }
    }
    return "subagent:*";
  }
  return null;
}

/**
 * Pending-dialog STATE, never journal history. The wrapper's onEvent replays
 * outstanding extension_ui_requests to each new listener; those replays are
 * filtered here and re-delivered ONCE as an explicit current-state snapshot
 * after connected (no fake seq). Live dialog frames still flow as events.
 */
function isUiState(event: AgentEvent): boolean {
  return event.type === "extension_ui_request";
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;


  // Fast path: already-running session; otherwise re-attach a host that
  // survived a web restart (defect 2), spawning only when none answers.
  let session = getRpcSession(id) ?? await attachLiveHostIfExists(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    try {
      ({ session } = await startRpcSession(id, filePath, undefined));
    } catch (error) {
      // Surface the real cause (e.g. the foreign-lease refusal) instead of a
      // bare failure string; the client shows this text on reconnect errors.
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Failed to start agent: ${message}`, { status: 500 });
    }
  }
  const liveSession = session;
  let cancelStream: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // Independent once-flags: an enqueue failure must still run the REAL
      // cleanup (unsubscribe + heartbeat clear), never leak them.
      let cleanedUp = false;
      let streamDead = false;
      // Handles are assigned below; cleanup closures may run during the
      // synchronous onEvent subscribe (pending-UI replay overflow), before
      // the consts initialize — the initialized flags keep that safe.
      let unsubscribeReady = false;
      let heartbeatReady = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        streamDead = true;
        if (heartbeatReady) clearInterval(heartbeat);
        if (unsubscribeReady) unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      cancelStream = cleanup;
      const encode = (data: unknown) => {
        if (streamDead) return;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const failRecoverable = (message: string) => {
        if (streamDead) return;
        encode({ type: "error", error: message, recoverable: true });
        cleanup();
      };

      // #99 splice: subscribe BEFORE requesting the fresh boundary so no
      // frame can slip between the two. Events arriving while the boundary
      // control round-trips are buffered; once it resolves, the first frame
      // is `connected` carrying the atomic boundary, then ONLY frames whose
      // logical END seq is strictly past it. History comes from the journal
      // (detail ?tail&anchor) — this stream NEVER replays historical frames.
      let boundarySeq: number | null = null;
      const preBoundaryBuffer: AgentEvent[] = [];
      const volatileSlots = new Map<string, number>();
      // Ids of dialogs already delivered as current state after connected —
      // a buffered live copy of the same dialog must not duplicate it.
      const stateDeliveredUiIds = new Set<string>();
      const unsubscribe = liveSession.onEvent((event) => {
        // Subscribe-time replay of pending dialogs: dropped here; the
        // explicit snapshot below delivers them after the boundary.
        if (boundarySeq === null && isUiState(event)) return;
        const clientEvent = toClientEvent(event);
        if (!clientEvent) return;
        if (boundarySeq === null) {
          const key = volatileKey(clientEvent);
          if (key !== null) {
            // Coalesce volatile snapshots: keep only the latest per key.
            const slot = volatileSlots.get(key);
            if (slot !== undefined) {
              preBoundaryBuffer[slot] = clientEvent;
              return;
            }
            if (preBoundaryBuffer.length < PRE_BOUNDARY_BUFFER_LIMIT) {
              volatileSlots.set(key, preBoundaryBuffer.length);
              preBoundaryBuffer.push(clientEvent);
            }
            return;
          }
          if (preBoundaryBuffer.length >= PRE_BOUNDARY_BUFFER_LIMIT) {
            // Must-deliver backlog: never silently discard durable events.
            // Fail recoverably — reconnect captures a fresh journal anchor.
            failRecoverable("Event backlog before history boundary exceeded buffer; reconnect to resync");
            return;
          }
          preBoundaryBuffer.push(clientEvent);
          return;
        }
        const hostSeq = clientEvent.hostSeq;
        if (isUiState(clientEvent) && typeof clientEvent.id === "string" && stateDeliveredUiIds.has(clientEvent.id)) return;
        if (typeof hostSeq === "number" && hostSeq > boundarySeq) encode(clientEvent);
      });
      unsubscribeReady = true;
      // A synchronous cleanup during subscribe (replay overflow) already
      // released everything it could; release the now-bound listener too.
      if (cleanedUp) unsubscribe();

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        if (streamDead) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
      heartbeatReady = true;
      if (cleanedUp) clearInterval(heartbeat);

      // Cleanup when client disconnects
      req.signal?.addEventListener("abort", cleanup);

      void liveSession.captureHistoryBoundary().then((boundary) => {
        if (streamDead) return;
        boundarySeq = boundary.seq;
        encode({ type: "connected", sessionId: id, historyBoundary: boundary });
        // Explicit CURRENT STATE: outstanding blocking dialogs, delivered
        // once after the splice — not historical events, no invented seq.
        for (const dialog of liveSession.pendingExtensionUiRequests()) {
          const clientDialog = toClientEvent(dialog);
          if (!clientDialog) continue;
          if (typeof clientDialog.id === "string") stateDeliveredUiIds.add(clientDialog.id);
          encode(clientDialog);
        }
        // Frames admitted before the boundary resolved: deliver exactly the
        // post-boundary ones, in order. Pre-boundary content is journal-side
        // (or the bounded activePartial in get_state) — never re-sent here.
        for (const event of preBoundaryBuffer) {
          const hostSeq = event.hostSeq;
          if (isUiState(event) && typeof event.id === "string" && stateDeliveredUiIds.has(event.id)) continue;
          if (typeof hostSeq === "number" && hostSeq > boundarySeq) encode(event);
        }
        preBoundaryBuffer.length = 0;
        volatileSlots.clear();
      }).catch((error) => {
        if (streamDead) return;
        const message = error instanceof Error ? error.message : String(error);
        failRecoverable(`Failed to capture history boundary: ${message}`);
      });
    },
    cancel() {
      // Consumer cancelled the body: release listener + heartbeat too.
      cancelStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
