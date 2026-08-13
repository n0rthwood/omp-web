import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import { closeTerminal } from "@/lib/terminals/terminal-service";

export const dynamic = "force-dynamic";

// DELETE /api/terminals/[id] - kill and remove a terminal.
// Idempotent: an unknown or already-closed id is not an error — a client
// racing a page reload against a manual close must not see a failure.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isTerminalFeatureAvailable()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { id } = await params;
  closeTerminal(id); // no-op for unknown/already-closed ids
  return NextResponse.json({ closed: true });
}
