import { NextResponse } from "next/server";
import { ensureProviderStatusPoller } from "@/lib/provider-status";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/provider-status — cached provider quota/health snapshot (issue #134).
// Authenticated like /api/health (middleware gate; any logged-in user, no admin
// requirement). Starts the keepalive poller on first request; the response is
// the process-wide snapshot — secret-free by construction (labels/counts only).
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const snapshot = ensureProviderStatusPoller();
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
