import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { resolveIssueTitle } from "@/lib/issue-title";

// Remote-resolve (see lib/machines/proxy-allowlist.ts): `projectRoot` only
// exists on disk on whichever machine hosts that project, so this always
// runs on the machine that owns the request — proxied like git/status,
// git/diff, worktrees — never centrally resolved on the gateway.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const user = await getWebUserOrSynthetic(req);
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const issueNumber = Number(url.searchParams.get("issueNumber"));
  const repo = url.searchParams.get("repo") ?? undefined;
  const projectRoot = url.searchParams.get("projectRoot") ?? undefined;

  // `projectRoot` drives a `git -C <projectRoot> remote get-url origin` —
  // same risk shape as app/api/git/status: gate it through the same
  // session/registered-project allow-list before touching the filesystem.
  if (projectRoot) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(projectRoot, allowedRoots) || !isExistingFilePathAllowed(projectRoot, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }

  const result = await resolveIssueTitle({
    repo,
    projectRoot,
    issueNumber,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  });

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
