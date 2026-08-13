import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isTerminalFeatureAvailable } from "@/lib/terminals/terminal-gate";
import { createTerminal, listTerminals } from "@/lib/terminals/terminal-service";

export const dynamic = "force-dynamic";

// GET /api/terminals?cwd=<abs path> - list terminals for a cwd
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isTerminalFeatureAvailable()) {
    // Same body shape as any other "not found" — do not leak why.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return NextResponse.json(listTerminals(cwd));
}

// POST /api/terminals body: { cwd, cols?, rows?, name? }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isTerminalFeatureAvailable()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { cwd?: string; cols?: number; rows?: number; name?: string };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // cols/rows default 80/24 inside createTerminal when omitted or invalid.
    return NextResponse.json(
      createTerminal({ cwd: body.cwd, cols: body.cols, rows: body.rows, name: body.name }),
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
