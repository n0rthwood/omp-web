import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import { resizeTerminal } from "@/lib/terminals/terminal-service";

export const dynamic = "force-dynamic";

// POST /api/terminals/[id]/resize body: { cols: number, rows: number }
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
  let cols: unknown;
  let rows: unknown;
  try {
    ({ cols, rows } = await req.json() as { cols?: unknown; rows?: unknown });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
  const isValid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!isValid(cols) || !isValid(rows)) {
    return NextResponse.json({ error: "cols and rows must be positive finite numbers" }, { status: 400 });
  }

  switch (resizeTerminal(id, cols, rows)) {
    case "not-found":
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    case "exited":
      return NextResponse.json({ error: "Terminal has exited" }, { status: 409 });
  }
  // 204: nothing reads the body, and a resize fires on every panel drag frame.
  return new Response(null, { status: 204 });
}
