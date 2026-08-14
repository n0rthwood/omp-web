import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { isAdmin, isPathVisible } from "@/lib/web-visibility";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
// User role (issue #7): browsing is limited to the user's visible project
// roots — the default start directory is clamped to the first one instead of
// the server home, and an explicitly requested directory outside them is
// rejected with 403. Listed entries are always children of the resolved
// (already visibility-checked) directory, so results cannot escape the
// visible roots. Admins and auth-disabled installs are unchanged.
export async function GET(request: NextRequest) {
  try {
    const user = await getWebUserOrSynthetic(request);
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const restricted = !isAdmin(user) && user.visibleProjects !== "*";

    const requested = request.nextUrl.searchParams.get("path")?.trim();

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    let candidate: string;
    if (!restricted) {
      candidate = getBrowseStartDirectory(requested);
    } else if (!requested) {
      candidate = user.visibleProjects[0];
      if (!candidate) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    } else {
      candidate = requested;
    }

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    if (restricted && !isPathVisible(user, resolved)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
