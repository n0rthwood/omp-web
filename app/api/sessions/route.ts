import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { refreshHostDiscovery } from "@/lib/session-host-transport";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { filterVisibleSessions } from "@/lib/web-visibility";
import { readJournalMessageStatsCached } from "@/lib/journal-stats";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Fill in role counts for rows that carry none: a session host from a release
 * before role counts existed, or a client-built optimistic row. Journals are
 * read once per (mtime, size) so this stays cheap on repeat refreshes.
 */
async function withRoleCounts(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  return Promise.all(sessions.map(async (session) => {
    if (session.userMessages !== undefined || !session.path) return session;
    const stats = await readJournalMessageStatsCached(session.path);
    if (!stats) return session;
    return {
      ...session,
      messageCount: stats.messageCount,
      firstMessage: stats.firstUserMessage || session.firstMessage,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolResultMessages: stats.toolResultMessages,
    };
  }));
}

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
    // Defect 2: merge hosts that survived a web restart into the runtime list.
    await refreshHostDiscovery();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const merged = await withRoleCounts(mergeSessionLists(persistedSessions, runtimeSessions));
    // Hide rows that render as "(no messages)": no user message anywhere in the
    // journal and no title either. Those are abandoned drafts and harness
    // probes (an ensure_session with no prompt, a message-less stub) and carry
    // no information a reader can act on. A title is user intent worth keeping
    // visible, a transient row is a conversation being typed into right now,
    // and a row whose journal could not be read stays rather than vanishing.
    const sessions = filterVisibleSessions(user, merged).filter(
      (session) => session.transient === true
        || session.userMessages === undefined
        || session.userMessages > 0
        || Boolean(session.name),
    );
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
