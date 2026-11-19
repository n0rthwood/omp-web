import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { resolveSessionPath, buildSessionContext, getHistoricalContextUsage } from "@/lib/session-reader";
import {
  readSessionHistory,
  readSessionOutline,
  parseJournalAnchor,
  clampHistoryLimit,
  HistoryTargetUnavailableError,
  type JournalAnchor,
} from "@/lib/session-history";
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

    // ------------------------------------------------------------ #99/#104 --
    // Bounded window path: `?tail=N` (latest durable messages),
    // `?before=<entryId>&limit=N` / `?after=<entryId>&limit=N` paging,
    // `?around=<entryId>&limit=N` (inclusive centered window, #104) or
    // `?outline=1` (metadata-only transcript outline, #104), with an optional
    // `anchor=<JournalAnchor JSON>` bounding the durable position. Reads go
    // through the journal reader — NEVER get_entries on this path, even for
    // a live session (the host flushes at boundary capture).
    const tailParam = url.searchParams.get("tail");
    const before = url.searchParams.get("before") ?? undefined;
    const after = url.searchParams.get("after") ?? undefined;
    const around = url.searchParams.get("around") ?? undefined;
    const outlineMode = url.searchParams.has("outline");
    if (outlineMode && url.searchParams.get("outline") !== "1") {
      return NextResponse.json({ error: "outline must be 1" }, { status: 400 });
    }
    const windowModes = [tailParam !== null, before !== undefined, after !== undefined, around !== undefined, outlineMode];
    if (windowModes.filter(Boolean).length > 1) {
      return NextResponse.json({ error: "tail, before, after, around and outline are mutually exclusive" }, { status: 400 });
    }
    if (outlineMode && url.searchParams.has("limit")) {
      return NextResponse.json({ error: "outline does not accept limit" }, { status: 400 });
    }
    if (windowModes.some(Boolean)) {
      const limitParam = tailParam ?? url.searchParams.get("limit");
      if (limitParam !== null && (!Number.isInteger(Number(limitParam)) || Number(limitParam) < 1)) {
        return NextResponse.json({ error: "tail/limit must be a positive integer" }, { status: 400 });
      }
      // after WITHOUT an explicit limit = full warm delta up to the anchor
      // (Journal99 semantics); every other window clamps into [1, 100].
      const limit = outlineMode ? undefined
        : limitParam !== null ? clampHistoryLimit(Number(limitParam))
        : after !== undefined ? undefined
        : clampHistoryLimit(undefined);
      let anchor: JournalAnchor | null = null;
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
      if (outlineMode) {
        // Metadata-only outline (#104): no bodies, no export, no get_entries.
        const outline = await readSessionOutline(filePath, {
          ...(leafIdParam !== null ? { leafId: leafIdParam } : {}),
          ...(anchor ? { anchor } : {}),
        });
        return NextResponse.json({ outline });
      }
      if (!existsSync(filePath)) {
        if (around !== undefined) {
          // Transient unpersisted session: the target cannot be included.
          return NextResponse.json(
            { error: "history target unavailable: not_found", code: "history_target_unavailable" },
            { status: 404 },
          );
        }
        // Transient unpersisted session: nothing durable to page yet.
        return NextResponse.json({
          context: { messages: [], entryIds: [], thinkingLevel: "off", model: null },
          historyPage: {
            anchor: anchor ?? { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 },
            hasEarlier: false,
            headEntryId: null,
            hasLater: false,
            tailEntryId: null,
          },
        });
      }
      const history = await readSessionHistory(filePath, {
        ...(limit !== undefined ? { limit } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(around !== undefined ? { around } : {}),
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
    if (error instanceof HistoryTargetUnavailableError) {
      // around/outline navigation failures are structured, never a silent
      // tail fallback: stale snapshot → 409, missing/non-visible → 404.
      return NextResponse.json(
        { error: error.message, code: "history_target_unavailable" },
        { status: error.reason === "stale_anchor" ? 409 : 404 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
