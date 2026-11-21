import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionTreeNode as SdkSessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionTreeNode } from "@/lib/types";
import type { ContextUsage } from "@/lib/omp-types";
import { planModeInfoFromEntries, type WebPlanModeInfo } from "@/lib/plan-mode-web";

import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  getHistoricalContextUsage,
  readSessionHeader,
} from "@/lib/session-reader";
import { readSessionHistory, readJournalTitle, parseJournalAnchor, clampHistoryLimit } from "@/lib/session-history";
import { attachLiveHostIfExists, getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { FOREIGN_LEASE_ERROR } from "@/lib/session-host-transport";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireVisibleSession } from "@/lib/web-session-guard";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { readJournalMessageStatsCached } from "@/lib/journal-stats";

/** Pre-order depth-first walk of the spine tree (parents before children,
 *  siblings in array order — children are timestamp-sorted by the reader). */
function walkTreeNodes(nodes: SessionTreeNode[], visit: (entry: SessionTreeNode["entry"]) => void): void {
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node.entry);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

function entryTimestampMs(entry: SessionTreeNode["entry"]): number {
  const ts = Date.parse(entry.timestamp);
  return Number.isNaN(ts) ? 0 : ts;
}

/** Earliest-timestamp user message text across ALL branches of the spine. */
function firstUserMessageFromTree(nodes: SessionTreeNode[]): string {
  let best: { ts: number; text: string } | undefined;
  walkTreeNodes(nodes, (entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return;
    const ts = entryTimestampMs(entry);
    if (best && ts >= best.ts) return;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find((block) => block.type === "text") as { text?: string } | undefined)?.text ?? ""
        : "";
    best = { ts, text };
  });
  return best?.text || "(no messages)";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;
  try {
    const rpc = getRpcSession(id) ?? await attachLiveHostIfExists(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const mirror = liveRpc?.sessionInfo;
    const filePath = liveRpc?.sessionFile || resolvedPath || "";

    // ------------------------------------------------------------------ #99 --
    // Bounded tail path: `?tail=N[&anchor=<JournalAnchor JSON>]`. The context
    // holds only the latest N durable messages; earlier history pages in via
    // the context route. NEVER get_entries / full-history RPC on this path.
    const tailParam = searchParams.get("tail");
    if (tailParam !== null) {
      const tail = Number(tailParam);
      if (!Number.isInteger(tail) || tail < 1) {
        return NextResponse.json({ error: "tail must be a positive integer" }, { status: 400 });
      }
      const limit = clampHistoryLimit(tail);
      let anchor = null;
      const anchorParam = searchParams.get("anchor");
      if (anchorParam !== null) {
        let parsed: unknown;
        try { parsed = JSON.parse(anchorParam); } catch { parsed = null; }
        anchor = parseJournalAnchor(parsed);
        if (!anchor) {
          return NextResponse.json({ error: "anchor must be a valid JournalAnchor JSON object" }, { status: 400 });
        }
      }
      // A live session with no client anchor needs a FRESH atomic boundary —
      // even for an existing long-lived wrapper whose attach anchor is stale.
      let historyBoundary;
      if (liveRpc && !anchor) {
        historyBoundary = await liveRpc.captureHistoryBoundary();
        anchor = historyBoundary.journal;
      }
      // Transient unpersisted session: no durable journal exists yet; the
      // whole conversation is live-stream territory (empty window + anchor).
      const journalOnDisk = Boolean(filePath) && existsSync(filePath);
      const transientLive = Boolean(liveRpc) && !journalOnDisk;
      const readPath = filePath;
      if (!readPath && !transientLive) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const history = readPath && !transientLive
        ? await readSessionHistory(readPath, {
          limit,
          ...(anchor ? { anchor } : {}),
          deferThinking,
          deferToolResultImages,
        })
        : undefined;
      const page = history?.page ?? {
        anchor: anchor ?? { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
        hasEarlier: false,
        headEntryId: null,
      };
      const context = history?.context ?? { messages: [], entryIds: [], thinkingLevel: "off", model: null };
      // Tree comes from the journal reader's metadata spine for BOTH live and
      // dead anchored reads — SDK get_tree carries full message bodies over
      // the realtime pipe and would reintroduce the #98 flood. Transient live
      // sessions have no durable journal yet: empty tree.
      const tree = projectTreeForResponse(history?.tree ?? []);
      const liveState = liveRpc
        ? (await liveRpc.send({ type: "get_state" })) as { planMode?: WebPlanModeInfo; contextUsage?: ContextUsage | null }
        : undefined;
      // Dead sessions derive plan mode from the spine tree's mode_change
      // entries — chronological last-wins (branch-safe), no full get_entries.
      const planMode = liveState?.planMode ?? (history?.tree
        ? (() => {
          const modeEntries: { ts: number; entry: Parameters<typeof planModeInfoFromEntries>[0][number] }[] = [];
          walkTreeNodes(history.tree!, (entry) => {
            // Discriminated narrowing: mode/data are the only fields the
            // plan-mode reader consumes; no unsafe cast of the whole entry.
            if (entry.type === "mode_change") {
              modeEntries.push({ ts: entryTimestampMs(entry), entry: { type: entry.type, mode: entry.mode, data: entry.data } });
            }
          });
          modeEntries.sort((a, b) => a.ts - b.ts);
          return planModeInfoFromEntries(modeEntries.map((item) => item.entry));
        })()
        : undefined);
      const contextUsage = liveState ? liveState.contextUsage ?? undefined : history?.contextUsage;
      // Header metadata comes from the reader's indexing pass (title slot
      // folded in) — no extra header read, no fleet-wide listAllSessions scan.
      const header = history?.header ?? (filePath ? readSessionHeader(filePath) : null);
      // Name: live mirror first; dead sessions prefer the bounded O(1)
      // title-slot read (authoritative for v3 renames), then header.title.
      const deadTitle = !liveRpc && filePath ? await readJournalTitle(filePath) : undefined;
      let modified = header?.timestamp ?? mirror?.created ?? new Date().toISOString();
      try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
      const parentSessionId = header?.parentSession
        ? await resolveSessionIdByPath(header.parentSession)
        : undefined;
      // Role counts: the live mirror carries them once its host is new enough;
      // a dead session reads the journal directly (same reader the list uses).
      const roleCounts = mirror ?? (filePath ? await readJournalMessageStatsCached(filePath) : undefined);
      const info = header || mirror ? {
        path: filePath,
        id: header?.id ?? mirror!.sessionId,
        cwd: header?.cwd ?? mirror?.cwd ?? "",
        name: mirror?.name ?? deadTitle ?? header?.title,
        created: header?.timestamp ?? mirror!.created,
        modified,
        messageCount: mirror?.messageCount ?? page.anchor.entryCount,
        ...(roleCounts?.userMessages !== undefined ? { userMessages: roleCounts.userMessages } : {}),
        ...(roleCounts?.assistantMessages !== undefined ? { assistantMessages: roleCounts.assistantMessages } : {}),
        ...(roleCounts?.toolResultMessages !== undefined ? { toolResultMessages: roleCounts.toolResultMessages } : {}),
        firstMessage: mirror?.firstMessage ?? (history?.tree ? firstUserMessageFromTree(history.tree) : "(no messages)"),
        parentSessionId,
        transient: mirror ? !mirror.persisted : !journalOnDisk,
      } : null;
      return NextResponse.json({
        sessionId: id,
        filePath,
        info,
        leafId: page.anchor.leafId,
        tree,
        context,
        totalActiveMs: history?.totalActiveMs ?? 0,
        ...(planMode ? { planMode } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        historyPage: page,
        ...(historyBoundary ? { historyBoundary } : {}),
      });
    }

    // ------------------------------------------------------------ legacy ----
    // Explicit full-history consumers (export, full reload) keep the
    // no-pagination shape: live entries over the wire, dead via read-only
    // SessionManager. The web tier never writes .jsonl (issue #94).
    const sm = liveRpc ? undefined : await SessionManager.open(resolvedPath!);
    const liveEntries = liveRpc
      ? (await liveRpc.send({ type: "get_entries" })) as { entries: unknown; leafId: string | null }
      : undefined;
    const legacyFilePath = liveRpc?.sessionFile || sm?.getSessionFile() || resolvedPath || "";
    const entries = (liveEntries ? liveEntries.entries : sm!.getEntries()) as never;
    const leafId = liveEntries ? liveEntries.leafId : sm!.getLeafId();
    const liveTree = liveRpc
      ? (await liveRpc.send({ type: "get_tree" })) as { tree: SdkSessionTreeNode[] }
      : undefined;
    const tree = projectTreeForResponse(liveTree ? liveTree.tree : sm!.getTree());
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });
    const contextUsage = await getHistoricalContextUsage(entries, leafId);
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    const header = sm ? sm.getHeader() : (legacyFilePath ? readSessionHeader(legacyFilePath) : null);
    let modified = header?.timestamp ?? mirror?.created ?? new Date().toISOString();
    try { modified = statSync(legacyFilePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const roleCounts = mirror ?? (legacyFilePath ? await readJournalMessageStatsCached(legacyFilePath) : undefined);
    const info = header || mirror ? {
      path: legacyFilePath,
      id: header?.id ?? mirror!.sessionId,
      cwd: header?.cwd ?? mirror?.cwd ?? "",
      name: sm ? sm.getSessionName() : mirror?.name,
      created: header?.timestamp ?? mirror!.created,
      modified,
      messageCount: context.messages.length,
      ...(roleCounts?.userMessages !== undefined ? { userMessages: roleCounts.userMessages } : {}),
      ...(roleCounts?.assistantMessages !== undefined ? { assistantMessages: roleCounts.assistantMessages } : {}),
      ...(roleCounts?.toolResultMessages !== undefined ? { toolResultMessages: roleCounts.toolResultMessages } : {}),
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
          const msg = context.messages.find((m) => m.role === "user")!;
          const c = (msg as { content: unknown }).content;
          return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
        })()
        : "(no messages)",
      parentSessionId,
      transient: mirror ? !mirror.persisted : !legacyFilePath || !existsSync(legacyFilePath),
    } : null;

    // Plan mode display must survive the TUI↔Web boundary: the host's
    // get_state carries the live mode; sessions with no live host derive it
    // from the journal.
    const liveState = liveRpc
      ? (await liveRpc.send({ type: "get_state" })) as { planMode?: WebPlanModeInfo }
      : undefined;
    const planMode = liveState?.planMode ?? planModeInfoFromEntries(entries);
    return NextResponse.json({
      sessionId: id,
      filePath: legacyFilePath,
      info,
      leafId,
      tree,
      context,
      totalActiveMs,
      planMode,
      ...(contextUsage ? { contextUsage } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await params;
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const rpc = getRpcSession(id) ?? await attachLiveHostIfExists(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Renames are writes: route them through the lease-owning host (attach
    // when live, spawn otherwise). A foreign lease refuses at spawn — the
    // web tier never writes .jsonl itself (issue #94).
    const session = liveRpc ?? (await startRpcSession(id, filePath!, undefined)).session;
    await session.send({ type: "set_session_name", name: name.trim() });
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === FOREIGN_LEASE_ERROR) {
      return NextResponse.json({ error: FOREIGN_LEASE_ERROR }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;
  try {
    const rpc = getRpcSession(id) ?? await attachLiveHostIfExists(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Deletion is a write (unlink + cascade re-parenting of child journals):
    // only the lease-owning host may do it (issue #94). The host reparents
    // children under held child leases, unlinks the target last, and tears
    // itself down after the response — treat the response as terminal.
    const session = liveRpc ?? (await startRpcSession(id, filePath!, undefined)).session;
    const result = await session.send({ type: "delete_session" }) as {
      reparented?: number;
      refusedForeign?: string[];
    } | null;
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({
      ok: true,
      ...(result?.refusedForeign?.length ? { refusedForeign: result.refusedForeign } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === FOREIGN_LEASE_ERROR) {
      return NextResponse.json({ error: FOREIGN_LEASE_ERROR }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
