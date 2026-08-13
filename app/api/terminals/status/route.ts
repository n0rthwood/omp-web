import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";

export const dynamic = "force-dynamic";

// GET /api/terminals/status - whether the Terminal tab feature is usable.
// Deliberately no cwd and no feature gate: this route's whole job is to
// report whether the feature is on.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json({ enabled: isTerminalFeatureAvailable() });
}
