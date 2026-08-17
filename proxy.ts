import { NextResponse, type NextRequest } from "next/server";
import { isAdminOnlyLocalApiPath } from "@/lib/admin-api-policy";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { isWebPasswordEnabled } from "@/lib/web-auth";
import { getWebUserFromRequest } from "@/lib/web-auth-context";
import { authEnabled } from "@/lib/web-users";

/** Reachable without a credential: login must work while auth blocks the rest. */
const AUTH_EXEMPT_API_PATHS: Record<string, true> = {
  "/api/auth/web-login": true,
  "/api/auth/web-me": true,
};

export async function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");

  // 1. Trust gate: host allow-list + origin check run BEFORE any auth logic,
  //    so an untrusted request can never probe the authentication state.
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { pathname } = request.nextUrl;

  // 2. Auth endpoints are exempt: web-login must be reachable to log in at
  //    all; web-me reports the (possibly null) identity itself.
  if (isApiRequest && Object.hasOwn(AUTH_EXEMPT_API_PATHS, pathname)) {
    return NextResponse.next();
  }

  // 3. Resolve the unified identity (cookie session → Bearer token → legacy
  //    Basic env bridge). Routes re-resolve per request; nothing is attached.
  const user = await getWebUserFromRequest(request);

  // 4. Authentication gate.
  if (authEnabled() && !user) {
    if (isApiRequest) {
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      // The Basic challenge is shown only while the OMP_WEB_PASSWORD
      // migration bridge is active — it invites clients that can use it.
      if (isWebPasswordEnabled()) {
        headers["WWW-Authenticate"] = 'Basic realm="omp-web", charset="UTF-8"';
      }
      return NextResponse.json({ error: "Authentication required" }, { status: 401, headers });
    }
    const next = encodeURIComponent(pathname + request.nextUrl.search);
    return NextResponse.redirect(new URL(`/login?next=${next}`, request.nextUrl), 302);
  }

  // 5. Authorization: user role may not touch admin-only surfaces. Skipped
  //    entirely when auth is disabled — a no-auth install has no roles.
  if (
    authEnabled()
    && user?.role !== "admin"
    && isAdminOnlyLocalApiPath(request.method, pathname)
  ) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
