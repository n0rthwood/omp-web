import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { resolveSessionPath, buildSessionContext, getHistoricalContextUsage } from "@/lib/session-reader";
import { readSessionHistory, parseJournalAnchor, clampHistoryLimit } from "@/lib/session-history";
import { attachLiveHostIfExists, getRpcSession } from "@/lib/rpc-manager";
import { requireVisibleSession } from "@/lib/web-session-guard";
import { isApiRequestAllowed } from "@/lib/request-security";

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
  const url = new URL(req.url);
  const leafIdParam = url.searchParams.get("leafId");
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    const rpc = getRpcSession(id) ?? await attachLiveHostIfExists(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    // The journal path always comes from the AUTHORIZED session (live hello
    // or the server-side id resolution) — never from client input. Anchors
    // only bound the read position inside that file; they cannot select one.
    const filePath = liveRpc?.sessionFile || await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // ------------------------------------------------------------------ #99 --
    // Bounded window path: `?tail=N` (latest durable messages) or
    // `?before=<entryId>&limit=N` / `?after=<entryId>&limit=N` paging, with an
    // optional `anchor=<JournalAnchor JSON>` bounding the durable position.
    // Reads go through the journal reader — NEVER get_entries on this path,
    // even for a live session (the host flushes at boundary capture).
    const tailParam = url.searchParams.get("tail");
    const before = url.searchParams.get("before") ?? undefined;
    const after = url.searchParams.get("after") ?? undefined;
    if (tailParam !== null || before !== undefined || after !== undefined) {
      if (before !== undefined && after !== undefined) {
        return NextResponse.json({ error: "before and after are mutually exclusive" }, { status: 400 });
      }
      const limitParam = tailParam ?? url.searchParams.get("limit");
      if (limitParam !== null && (!Number.isInteger(Number(limitParam)) || Number(limitParam) < 1)) {
        return NextResponse.json({ error: "tail/limit must be a positive integer" }, { status: 400 });
      }
      // after WITHOUT an explicit limit = full warm delta up to the anchor
      // (Journal99 semantics); every other window clamps into [1, 100].
      const limit = limitParam !== null ? clampHistoryLimit(Number(limitParam))
        : after !== undefined ? undefined
        : clampHistoryLimit(undefined);
      let anchor = null;
      const anchorParam = url.searchParams.get("anchor");
      if (anchorParam !== null) {
        let parsed: unknown;
        try { parsed = JSON.parse(anchorParam); } catch { parsed = null; }
        anchor = parseJournalAnchor(parsed);
        if (!anchor) {
          return NextResponse.json({ error: "anchor must be a valid JournalAnchor JSON object" }, { status: 400 });
        }
      }
      // Live session without a client anchor: capture a FRESH atomic boundary
      // (durable flush included) so the window cannot mix pre/post-splice data.
      if (liveRpc && !anchor) {
        anchor = (await liveRpc.captureHistoryBoundary()).journal;
      }
      if (!existsSync(filePath)) {
        // Transient unpersisted session: nothing durable to page yet.
        return NextResponse.json({
          context: { messages: [], entryIds: [], thinkingLevel: "off", model: null },
          historyPage: {
            anchor: anchor ?? { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
            hasEarlier: false,
            headEntryId: null,
          },
        });
      }
      const history = await readSessionHistory(filePath, {
        ...(limit !== undefined ? { limit } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(leafIdParam !== null ? { leafId: leafIdParam } : {}),
        ...(anchor ? { anchor } : {}),
        deferThinking,
        deferToolResultImages,
      });
      return NextResponse.json({
        context: history.context,
        historyPage: history.page,
        ...(history.contextUsage ? { contextUsage: history.contextUsage } : {}),
      });
    }

    // ------------------------------------------------------------ legacy ----
    // No-pagination full context for explicit full-history consumers.
    const leafId = leafIdParam ?? undefined;
    const entries = liveRpc
      ? ((await liveRpc.send({ type: "get_entries" })) as { entries: unknown }).entries as never
      : (await SessionManager.open(filePath)).getEntries() as never;
    const context = buildSessionContext(entries, leafId, {
      deferThinking,
      deferToolResultImages,
    });
    const contextUsage = await getHistoricalContextUsage(entries, leafId);

    return NextResponse.json({
      context,
      ...(contextUsage ? { contextUsage } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
