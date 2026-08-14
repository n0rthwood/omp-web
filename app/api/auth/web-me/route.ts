import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserFromRequest } from "@/lib/web-auth-context";
import { authEnabled } from "@/lib/web-users";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/auth/web-me - who am I? Always 200; `user` is null when
// unauthenticated. `authRequired` lets clients distinguish an auth-disabled
// install (no login needed) from a logged-out browser.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  const user = await getWebUserFromRequest(req);
  return NextResponse.json({ user, authRequired: authEnabled() }, { headers: NO_STORE });
}
