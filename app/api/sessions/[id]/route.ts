import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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
import { attachLiveHostIfExists, getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { FOREIGN_LEASE_ERROR } from "@/lib/session-host-transport";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireVisibleSession } from "@/lib/web-session-guard";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";

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

    // Live hosts own the journal: read over the wire. The read-only
    // SessionManager fallback is for dead sessions' history files only —
    // the web tier never writes .jsonl (issue #94).
    const mirror = liveRpc?.sessionInfo;
    const sm = liveRpc ? undefined : await SessionManager.open(resolvedPath!);
    const liveEntries = liveRpc
      ? (await liveRpc.send({ type: "get_entries" })) as { entries: unknown; leafId: string | null }
      : undefined;
    const filePath = liveRpc?.sessionFile || sm?.getSessionFile() || resolvedPath || "";
    const entries = (liveEntries ? liveEntries.entries : sm!.getEntries()) as never;
    const leafId = liveEntries ? liveEntries.leafId : sm!.getLeafId();
    const liveTree = liveRpc
      ? (await liveRpc.send({ type: "get_tree" })) as { tree: SessionTreeNode[] }
      : undefined;
    const tree = projectTreeForResponse(liveTree ? liveTree.tree : sm!.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });
    const contextUsage = await getHistoricalContextUsage(entries, leafId);
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    const header = sm ? sm.getHeader() : (filePath ? readSessionHeader(filePath) : null);
    let modified = header?.timestamp ?? mirror?.created ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header || mirror ? {
      path: filePath,
      id: header?.id ?? mirror!.sessionId,
      cwd: header?.cwd ?? mirror?.cwd ?? "",
      name: sm ? sm.getSessionName() : mirror?.name,
      created: header?.timestamp ?? mirror!.created,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
          const msg = context.messages.find((m) => m.role === "user")!;
          const c = (msg as { content: unknown }).content;
          return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
        })()
        : "(no messages)",
      parentSessionId,
      transient: mirror ? !mirror.persisted : !filePath || !existsSync(filePath),
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
      filePath,
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
