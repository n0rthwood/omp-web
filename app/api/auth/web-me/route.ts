import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { authEnabled } from "@/lib/web-users";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/auth/web-me - who am I? Always 200; `user` is null when
// unauthenticated on an auth-enabled install. When auth is disabled the
// synthetic __anonymous admin is returned so clients keep full-UI behavior;
// `authRequired` distinguishes the two installs.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  const user = await getWebUserOrSynthetic(req);
  return NextResponse.json({ user, authRequired: authEnabled() }, { headers: NO_STORE });
}
