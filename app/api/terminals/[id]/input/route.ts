import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import { writeToTerminal } from "@/lib/terminals/terminal-service";

export const dynamic = "force-dynamic";

// POST /api/terminals/[id]/input body: { data: string }
// Writes `data` verbatim to the pty (already ANSI-encoded by the client).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isTerminalFeatureAvailable()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await params;
  let data: unknown;
  try {
    ({ data } = await req.json() as { data?: unknown });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
  if (typeof data !== "string") {
    return NextResponse.json({ error: "data must be a string" }, { status: 400 });
  }

  switch (writeToTerminal(id, data)) {
    case "not-found":
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    case "exited":
      return NextResponse.json({ error: "Terminal has exited" }, { status: 409 });
  }
  // 204, not a JSON body: this is the hottest route in the app — one request
  // per keystroke — and nothing reads the response. Errors keep their bodies.
  return new Response(null, { status: 204 });
}
