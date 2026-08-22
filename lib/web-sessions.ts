import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { isIP } from "net";
import { dirname, join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const WEB_SESSION_COOKIE = "omp-web-session";

export const DEFAULT_SESSION_TTL_DAYS = 30;

/**
 * Sliding-TTL refresh interval. `lookupWebSession` only rewrites the store
 * (advancing `expires`/`lastUsed`) when the session has been idle for at
 * least this long, so hot sessions cost zero disk writes.
 */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const MS_PER_DAY = 86_400_000;

export type StoredWebSession = {
  username: string;
  /** epoch ms */
  created: number;
  /** epoch ms — slid forward on lookup */
  expires: number;
  /** epoch ms of the last lookup that passed the expiry check */
  lastUsed: number;
};

type SessionsFile = { sessions: Record<string, StoredWebSession> };

type SessionsCache = { value: SessionsFile; mtimeMs: number };

declare global {
  // eslint-disable-next-line no-var
  var __ompWebSessions: SessionsCache | undefined;
}

function getSessionsPath(): string {
  return process.env.OMP_WEB_SESSIONS_FILE ?? join(getAgentDir(), "omp-web-sessions.json");
}

function sessionKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function readSessions(): SessionsFile {
  const path = getSessionsPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    globalThis.__ompWebSessions = undefined;
    return { sessions: {} };
  }
  const cache = globalThis.__ompWebSessions;
  if (cache && cache.mtimeMs === mtimeMs) return cache.value;
  let value: SessionsFile;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionsFile;
    value = parsed && typeof parsed.sessions === "object" ? parsed : { sessions: {} };
  } catch {
    value = { sessions: {} };
  }
  globalThis.__ompWebSessions = { value, mtimeMs };
  return value;
}

function writeSessions(store: SessionsFile): void {
  const path = getSessionsPath();
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`);
  globalThis.__ompWebSessions = existsSync(path)
    ? { value: store, mtimeMs: statSync(path).mtimeMs }
    : undefined;
}
/**
 * True for hosts that are reachable over plain HTTP in practice and must NOT
 * get the `Secure` cookie flag (a browser rejects a `Secure` cookie sent over
 * HTTP, which breaks login):
 * - loopback literals (`localhost`, `127.0.0.1`, `::1`),
 * - RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16),
 * - IPv6 unique-local (fc00::/7).
 * Everything else — a public hostname/IP, or an unknown host — is treated as
 * public, so `Secure` stays on.
 */
function isNonPublicHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end !== -1) h = h.slice(1, end);
  } else {
    const colon = h.indexOf(":");
    // A single colon separates host from port; more colons mean a bare IPv6 literal.
    if (colon !== -1 && h.indexOf(":", colon + 1) === -1) h = h.slice(0, colon);
  }
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(h) === 6) return /^f[cd]/.test(h);
  return false;
}

/**
 * `Set-Cookie` attribute string (name/value excluded) for the session cookie.
 * Host-only cookie (no Domain) so it never leaks to sibling subdomains.
 */
export function cookieAttrs(
  host: string | null | undefined,
  ttlDays: number = DEFAULT_SESSION_TTL_DAYS,
): string {
  const attrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlDays * 86_400)}`;
  return host !== null && host !== undefined && isNonPublicHost(host) ? attrs : `${attrs}; Secure`;
}

/**
 * Create an opaque server-side session. The raw id (32 random bytes,
 * base64url) is returned exactly once and never persisted — the store is
 * keyed by its sha256 hex.
 */
export function createWebSession(
  username: string,
  ttlDays: number = DEFAULT_SESSION_TTL_DAYS,
  host?: string | null,
): { raw: string; cookieAttrs: string; expires: number } {
  const raw = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expires = now + ttlDays * MS_PER_DAY;
  const store = readSessions();
  store.sessions[sessionKey(raw)] = { username, created: now, expires, lastUsed: now };
  writeSessions(store);
  return { raw, cookieAttrs: cookieAttrs(host, ttlDays), expires };
}

/**
 * Resolve a session cookie value to its user. Rejected (null) when unknown or
 * expired; expired entries are dropped from the store. Sliding TTL: when the
 * session has been idle for over an hour, `expires` is slid forward and the
 * store rewritten — otherwise this is a pure read.
 */
export function lookupWebSession(
  raw: string,
  ttlDays: number = DEFAULT_SESSION_TTL_DAYS,
): { username: string } | null {
  const key = sessionKey(raw);
  const store = readSessions();
  const record = store.sessions[key];
  if (!record) return null;
  const now = Date.now();
  if (record.expires <= now) {
    delete store.sessions[key];
    writeSessions(store);
    return null;
  }
  if (now - record.lastUsed > REFRESH_INTERVAL_MS) {
    record.lastUsed = now;
    record.expires = now + ttlDays * MS_PER_DAY;
    writeSessions(store);
  }
  return { username: record.username };
}

export function revokeWebSession(raw: string): void {
  const key = sessionKey(raw);
  const store = readSessions();
  if (!(key in store.sessions)) return;
  delete store.sessions[key];
  writeSessions(store);
}

/** Revokes every session belonging to `username` (account deletion). */
export function revokeSessionsForUser(username: string): number {
  const store = readSessions();
  let revoked = 0;
  for (const key of Object.keys(store.sessions)) {
    if (store.sessions[key].username === username) {
      delete store.sessions[key];
      revoked++;
    }
  }
  if (revoked > 0) writeSessions(store);
  return revoked;
}

export function purgeExpiredWebSessions(): void {
  const store = readSessions();
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(store.sessions)) {
    if (store.sessions[key].expires <= now) {
      delete store.sessions[key];
      changed = true;
    }
  }
  if (changed) writeSessions(store);
}
