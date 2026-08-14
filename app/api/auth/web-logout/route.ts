import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { WEB_SESSION_COOKIE, cookieAttrs, revokeWebSession } from "@/lib/web-sessions";
import { parseCookieValue } from "@/lib/web-auth-context";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// POST /api/auth/web-logout - revoke the session and clear the cookie.
// State-changing: the origin check in isApiRequestAllowed is the CSRF guard
// for the ambient cookie.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: NO_STORE },
    );
  }

  const raw = parseCookieValue(req.headers.get("cookie"), WEB_SESSION_COOKIE);
  if (raw) revokeWebSession(raw);

  return NextResponse.json(
    { ok: true },
    {
      headers: {
        ...NO_STORE,
        "Set-Cookie": `${WEB_SESSION_COOKIE}=; ${cookieAttrs(req.headers.get("host"), 0)}`,
      },
    },
  );
}
