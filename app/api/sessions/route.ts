import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { filterVisibleSessions } from "@/lib/web-visibility";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // Middleware rejects unauthenticated requests; the null check is defense
    // in depth for direct route invocation.
    const user = await getWebUserOrSynthetic(req);
    if (!user) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = filterVisibleSessions(user, mergeSessionLists(persistedSessions, runtimeSessions));
    const visibleIds = new Set(sessions.map((session) => session.id));
    const runningSessionIds = getRunningRpcSessionIds().filter((id) => visibleIds.has(id));
    return NextResponse.json(
      { sessions, runningSessionIds },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
