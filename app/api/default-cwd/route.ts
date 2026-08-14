import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { isAdmin } from "@/lib/web-visibility";

// POST /api/default-cwd
// Creates ~/omp-cwd-<YYYYMMDD> if it doesn't exist and returns the path.
// Admin-only (issue #7 decision): scratch-cwd creation under the server home
// is an admin action; restricted users pick a workspace from their visible
// projects instead of minting arbitrary home-directory working copies.
export async function POST(req: Request) {
  try {
    const user = await getWebUserOrSynthetic(req);
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (!isAdmin(user)) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = join(homedir(), `omp-cwd-${date}`);
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
