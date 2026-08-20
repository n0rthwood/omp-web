import { NextResponse } from "next/server";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { requireVisibleSession } from "@/lib/web-session-guard";

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

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    // omp declines to title greetings and other low-signal openers; report that
    // as a no-op instead of writing a meaningless name.
    if (!result) {
      return NextResponse.json({ title: null, skipped: true });
    }

    // The manual button is an explicit user action: write with source "user"
    // so it force-overwrites (the SDK no-ops "auto" over "user") and the
    // result is protected from future auto re-titling.
    const written = await session.inner.sessionManager.setSessionName(
      result.title,
      "user",
    );
    if (!written) {
      // A source-"user" write is only refused when the session was released
      // (or the cleaned title came back empty) — same shape as the check above.
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
