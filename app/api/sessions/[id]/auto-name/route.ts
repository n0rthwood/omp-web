import { NextResponse } from "next/server";
import { attachLiveHostIfExists, getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { requireVisibleSession } from "@/lib/web-session-guard";

const SESSION_CLOSED_TITLE_ERROR = "The session was closed while its title was being generated. Please try again.";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id) ?? await attachLiveHostIfExists(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    // The host owns title generation AND the source-"user" write: the manual
    // button is an explicit user action, so it force-overwrites (the SDK
    // no-ops "auto" over "user") and protects the name from auto re-titling.
    // A refused write surfaces as the host's exact 409 message.
    const result = await session.send({ type: "auto_name" }) as { title: string | null; skipped?: boolean };

    if (!session.isAlive()) {
      return NextResponse.json({ error: SESSION_CLOSED_TITLE_ERROR }, { status: 409 });
    }

    // omp declines to title greetings and other low-signal openers; report that
    // as a no-op instead of writing a meaningless name.
    if (result.skipped || !result.title) {
      return NextResponse.json({ title: null, skipped: true });
    }
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: message === SESSION_CLOSED_TITLE_ERROR ? 409 : 500 },
    );
  }
}
