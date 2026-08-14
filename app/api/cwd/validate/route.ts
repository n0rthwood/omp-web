import { NextResponse } from "next/server";
import { realpathSync, statSync } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { normalizeDirectory } from "@/lib/directory-browser";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { isAdmin, isPathVisible } from "@/lib/web-visibility";


// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
// User role (issue #7): the canonical cwd must be inside a visible project
// root; otherwise 403 and the directory is NOT added to the allowed roots.
export async function POST(req: Request) {
  try {
    const user = await getWebUserOrSynthetic(req);
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeDirectory(cwd);
    let canonicalCwd: string;
    try {
      const stat = statSync(normalizedCwd);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
      }
      canonicalCwd = realpathSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!isAdmin(user) && !isPathVisible(user, canonicalCwd)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    allowFileRoot(canonicalCwd);
    return NextResponse.json({ success: true, cwd: canonicalCwd });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
