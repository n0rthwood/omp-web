import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { addWorktree, listWorktrees, removeWorktree, resolveProject } from "@/lib/worktree";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserOrSynthetic, type WebUser } from "@/lib/web-auth-context";
import { isAdmin, isPathVisible } from "@/lib/web-visibility";

/** Resolve the caller's identity. The middleware gate normally rejects
 *  unauthenticated traffic before routes run; this is defense in depth. */
async function resolveUserOr401(req: Request): Promise<{ user: WebUser } | { response: NextResponse }> {
  const user = await getWebUserOrSynthetic(req);
  if (!user) {
    return { response: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }
  return { user };
}

/** 404 (not 403) so hidden project paths cannot be probed for existence. */
function notVisibleResponse(): NextResponse {
  return NextResponse.json({ error: "Not visible for this user" }, { status: 404 });
}

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

// GET /api/worktrees?cwd=  →  { projectRoot, isGit, isTopLevel, worktrees }
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = await resolveUserOr401(req);
  if ("response" in identity) return identity.response;
  const { user } = identity;

  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    // UI-level visibility (issue #7): non-admins may only inspect projects
    // beneath their visible roots; checked before the allow-list so hidden
    // paths cannot be probed.
    if (!isAdmin(user) && !isPathVisible(user, cwd)) {
      return notVisibleResponse();
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot);
    } catch {
      isGit = false;
    }
    // Normal worktree checkouts live at <projectRoot>-worktrees/<branch>,
    // outside a typical assigned root like <projectRoot> itself. Those are
    // visible when the owning project root is; a worktree deliberately placed
    // elsewhere stays visible only if its own path is.
    const standardWorktreesDir = `${project.projectRoot}-worktrees/`;
    const visibleWorktrees = isAdmin(user)
      ? worktrees
      : worktrees.filter(
          (w) =>
            isPathVisible(user, w.path)
            || (
              isPathVisible(user, project.projectRoot)
              && w.path.startsWith(standardWorktreesDir)
            ),
        );
    for (const w of visibleWorktrees) allowFileRoot(w.path);
    return NextResponse.json({
      projectRoot: project.projectRoot,
      isGit,
      isTopLevel: project.isTopLevel,
      worktrees: visibleWorktrees,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = await resolveUserOr401(req);
  if ("response" in identity) return identity.response;
  const { user } = identity;

  try {
    const body = await req.json() as { cwd?: string; branch?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }
    // Worktree management is allowed inside visible projects (user decision,
    // issue #7); hidden cwds are rejected before any git mutation.
    if (!isAdmin(user) && !isPathVisible(user, body.cwd)) {
      return notVisibleResponse();
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }

    const result = await addWorktree(body.cwd, body.branch);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/worktrees  body: { cwd, path, force? }
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = await resolveUserOr401(req);
  if ("response" in identity) return identity.response;
  const { user } = identity;

  try {
    const body = await req.json() as { cwd?: string; path?: string; force?: boolean };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.path || typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    // Same visibility decision as POST: management allowed in visible projects.
    if (!isAdmin(user) && !isPathVisible(user, body.cwd)) {
      return notVisibleResponse();
    }
    // The removal target itself must also be visible — otherwise a user could
    // remove a worktree deliberately omitted from their GET list by supplying
    // its path directly (including force: true).
    if (!isAdmin(user)) {
      const project = await resolveProject(body.cwd);
      const targetVisible =
        isPathVisible(user, body.path) || isPathVisible(user, project.projectRoot);
      if (!targetVisible) return notVisibleResponse();
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;

    await removeWorktree(body.cwd, body.path, body.force === true);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // git refuses to remove dirty worktrees without --force; surface that so
    // the UI can offer a force-remove confirmation.
    const dirty = /contains modified or untracked files|is dirty/i.test(message);
    return NextResponse.json({ error: message, dirty }, { status: dirty ? 409 : 400 });
  }
}
