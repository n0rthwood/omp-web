import { NextResponse } from "next/server";
import { attachLiveHostIfExists, getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { requireVisibleSession } from "@/lib/web-session-guard";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;
  try {
    // Defect 2: a host that survived a web restart is discovered and
    // re-attached here; getRpcSession alone misses it (registry is per-process).
    const rpc = getRpcSession(id) ?? await attachLiveHostIfExists(id);
    if (rpc?.isAlive()) {
      // #99: the snapshot's END seq lets the browser order activePartial
      // against its SSE history boundary (partial.hostSeq ≤ this hostSeq).
      const { state, hostSeq } = await rpc.getStateSnapshot();
      return NextResponse.json({ running: true, state, hostSeq });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
