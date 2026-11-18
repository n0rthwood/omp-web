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
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
