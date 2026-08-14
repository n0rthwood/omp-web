import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { WEB_SESSION_COOKIE, createWebSession } from "@/lib/web-sessions";
import {
  getEffectiveWebUsers,
  readWebUsersConfig,
  toSafeWebUser,
  verifyWebPassword,
} from "@/lib/web-users";

export const dynamic = "force-dynamic";

/**
 * Failed-login throttle (issue #7). In-memory and per-username only — good
 * enough for the threat model: network attackers are stopped by the proxy
 * trust gate, this just blunts online credential stuffing against a single
 * account. A process restart clears the counters.
 */
const MAX_CONSECUTIVE_FAILURES = 5;
const LOCKOUT_MS = 30_000;

type LoginAttemptState = { failures: number; lockedUntil: number };

declare global {
  // eslint-disable-next-line no-var
  var __ompWebLoginRateLimit: Map<string, LoginAttemptState> | undefined;
}

function rateLimitMap(): Map<string, LoginAttemptState> {
  globalThis.__ompWebLoginRateLimit ??= new Map();
  return globalThis.__ompWebLoginRateLimit;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

// POST /api/auth/web-login - exchange username/password for a session cookie
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

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (
    typeof username !== "string" || username.length === 0
    || typeof password !== "string" || password.length === 0
  ) {
    return NextResponse.json(
      { error: "Username and password are required" },
      { status: 400, headers: NO_STORE },
    );
  }

  // Lockout check before touching the credential store.
  const key = username.toLowerCase();
  const attempts = rateLimitMap();
  const state = attempts.get(key);
  if (state && state.lockedUntil > Date.now()) {
    return NextResponse.json(
      { error: "Too many attempts, try again shortly" },
      { status: 401, headers: NO_STORE },
    );
  }
  // An expired lockout starts a fresh failure count instead of re-locking on
  // the very next typo.
  const failures = (state?.lockedUntil ? 0 : (state?.failures ?? 0)) + 1;

  const user = getEffectiveWebUsers().find((candidate) => candidate.username === key) ?? null;
  if (!user || !verifyWebPassword(password, user.passwordHash)) {
    attempts.set(key, {
      failures,
      lockedUntil: failures >= MAX_CONSECUTIVE_FAILURES ? Date.now() + LOCKOUT_MS : 0,
    });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401, headers: NO_STORE });
  }

  attempts.delete(key);
  const ttlDays = readWebUsersConfig().sessions.ttlDays || 30;
  const session = createWebSession(user.username, ttlDays, req.headers.get("host"));
  return NextResponse.json(
    { user: toSafeWebUser(user) },
    {
      status: 200,
      headers: {
        ...NO_STORE,
        "Set-Cookie": `${WEB_SESSION_COOKIE}=${session.raw}; ${session.cookieAttrs}`,
      },
    },
  );
}
