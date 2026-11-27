import { NextResponse } from "next/server";
import { getPlanModeStartupInfo } from "@/lib/plan-mode-startup";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/plan-mode/startup?cwd=<absolute path>
//
// A brand-new chat has no session to ask, so the composer needs the mode the
// host will start it in (issue #161). `cwd` scopes the answer to the project
// layer the session host will load for that directory.
export async function GET(req: Request) {
  // Middleware rejects unauthenticated requests; the null check is defense in
  // depth for direct route invocation (getWebUserOrSynthetic substitutes the
  // synthetic admin while auth is disabled, so null means auth is on).
  const user = await getWebUserOrSynthetic(req);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: NO_STORE });
  }

  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
    return NextResponse.json(await getPlanModeStartupInfo(cwd), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}