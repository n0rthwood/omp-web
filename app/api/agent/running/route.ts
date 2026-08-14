import { NextResponse } from "next/server";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { filterVisibleSessionIds } from "@/lib/web-session-guard";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(req: Request) {
  const user = await getWebUserOrSynthetic(req);
  const runningSessionIds = user
    ? await filterVisibleSessionIds(user, getRunningRpcSessionIds())
    : [];
  return NextResponse.json(
    { runningSessionIds },
    { headers: { "Cache-Control": "no-store" } },
  );
}
