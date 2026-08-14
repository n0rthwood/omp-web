import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isWebPasswordEnabled } from "./web-auth";

/**
 * Multi-user web credential store for cookie/Bearer auth (issue #7).
 *
 * Users live in `~/.omp/agent/omp-web-users.yml` (override with
 * `OMP_WEB_USERS_FILE`, mainly for tests): scrypt password hashes, per-user
 * CLI Bearer tokens (sha256 of the raw token only) and the server-side
 * session-signing secret. Writes are atomic and 0600. While no file users
 * exist and `OMP_WEB_PASSWORD` is set, a synthetic env-backed admin `omp` is
 * exposed for migration — it is never persisted.
 */

export type WebUserRole = "admin" | "user";

export type StoredWebToken = {
  name: string;
  tokenHash: string; // sha256 hex of the raw token
  created: string; // ISO timestamp
};

export type StoredWebUser = {
  username: string; // unique, [a-z0-9_-]{1,32}
  role: WebUserRole;
  passwordHash: string; // "scrypt$N$r$p$saltB64$hashB64"
  projects: string[] | "*"; // canonical absolute roots; "*" = all
  tokens: StoredWebToken[];
};

export type WebUser = {
  // SAFE, resolved identity — never contains hashes
  username: string;
  role: WebUserRole;
  visibleProjects: string[] | "*";
};

export type EffectiveWebUser = Omit<StoredWebUser, "passwordHash"> & {
  passwordHash: string | null; // null when env-backed
  envBacked: boolean;
};

export type WebUsersConfig = {
  users: StoredWebUser[];
  sessions: { secret: string; ttlDays: number }; // secret: 32-byte base64
};

const USERNAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;
const DEFAULT_SESSION_TTL_DAYS = 30;
const ENV_MIGRATION_USERNAME = "omp";

declare global {
  // eslint-disable-next-line no-var
  var __ompWebUsersCache:
    | { path: string; mtimeMs: number; value: WebUsersConfig }
    | undefined;
}

export function isValidWebUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function getWebUsersFilePath(): string {
  return process.env.OMP_WEB_USERS_FILE ?? join(getAgentDir(), "omp-web-users.yml");
}

// --- scrypt password hashing -------------------------------------------------

export function hashWebPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyWebPassword(password: string, passwordHash: string | null): boolean {
  // Env-backed migration user: compare against the env password timing-safely
  // (sha256 first so unequal lengths cannot leak through timingSafeEqual).
  if (passwordHash === null) {
    const envPassword = process.env.OMP_WEB_PASSWORD;
    if (!isWebPasswordEnabled(envPassword)) return false;
    const actual = createHash("sha256").update(password, "utf8").digest();
    const expected = createHash("sha256").update(envPassword, "utf8").digest();
    return timingSafeEqual(actual, expected);
  }

  const parts = passwordHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (N !== SCRYPT_N || r !== SCRYPT_r || p !== SCRYPT_p) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const actual = scryptSync(password, salt, SCRYPT_KEYLEN, { N, r, p });
  return timingSafeEqual(actual, expected);
}

// --- yaml store ---------------------------------------------------------------

function parseStoredToken(value: unknown): StoredWebToken | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, tokenHash, created } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  if (typeof created !== "string" || created.length === 0) return null;
  return { name, tokenHash, created };
}

function parseStoredUser(value: unknown): StoredWebUser | null {
  if (typeof value !== "object" || value === null) return null;
  const { username, role, passwordHash, projects, tokens } = value as Record<string, unknown>;
  if (typeof username !== "string" || !isValidWebUsername(username)) return null;
  if (typeof passwordHash !== "string" || passwordHash.length === 0) return null;

  let parsedProjects: string[] | "*";
  if (projects === "*") parsedProjects = "*";
  else if (Array.isArray(projects) && projects.every((root) => typeof root === "string")) {
    parsedProjects = projects as string[];
  } else {
    parsedProjects = [];
  }

  return {
    username,
    role: role === "admin" ? "admin" : "user",
    passwordHash,
    projects: parsedProjects,
    tokens: Array.isArray(tokens)
      ? tokens.map(parseStoredToken).filter((token): token is StoredWebToken => token !== null)
      : [],
  };
}

function parseWebUsersConfig(raw: unknown): WebUsersConfig {
  if (typeof raw !== "object" || raw === null) return emptyConfig();
  const parsed = raw as Record<string, unknown>;
  const users = Array.isArray(parsed.users)
    ? parsed.users.map(parseStoredUser).filter((user): user is StoredWebUser => user !== null)
    : [];
  const sessions = (typeof parsed.sessions === "object" && parsed.sessions !== null
    ? parsed.sessions
    : {}) as Record<string, unknown>;
  const ttlDays =
    typeof sessions.ttlDays === "number" && Number.isFinite(sessions.ttlDays) && sessions.ttlDays > 0
      ? sessions.ttlDays
      : DEFAULT_SESSION_TTL_DAYS;
  return {
    users,
    sessions: {
      secret: typeof sessions.secret === "string" ? sessions.secret : "",
      ttlDays,
    },
  };
}

function emptyConfig(): WebUsersConfig {
  return { users: [], sessions: { secret: "", ttlDays: DEFAULT_SESSION_TTL_DAYS } };
}

export function readWebUsersConfig(): WebUsersConfig {
  const path = getWebUsersFilePath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    globalThis.__ompWebUsersCache = undefined;
    return emptyConfig();
  }

  const cache = globalThis.__ompWebUsersCache;
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.value;

  let config: WebUsersConfig;
  try {
    config = parseWebUsersConfig(parseYaml(readFileSync(path, "utf8")));
  } catch {
    config = emptyConfig();
  }
  globalThis.__ompWebUsersCache = { path, mtimeMs, value: config };
  return config;
}

export function writeWebUsersConfig(config: WebUsersConfig): void {
  const path = getWebUsersFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const next: WebUsersConfig = {
    users: config.users.map((user) => ({ ...user, tokens: [...user.tokens] })),
    sessions: {
      secret: config.sessions.secret || randomBytes(32).toString("base64"),
      ttlDays:
        config.sessions.ttlDays > 0 ? config.sessions.ttlDays : DEFAULT_SESSION_TTL_DAYS,
    },
  };

  writePrivateFileAtomicSync(path, stringifyYaml(next, { lineWidth: 0 }));
  globalThis.__ompWebUsersCache = { path, mtimeMs: statSync(path).mtimeMs, value: next };
}

/** Returns the session secret, generating + persisting it on first use. */
export function ensureWebSessionSecret(): string {
  const config = readWebUsersConfig();
  if (config.sessions.secret) return config.sessions.secret;
  writeWebUsersConfig(config);
  return readWebUsersConfig().sessions.secret;
}

/** Adds a fully-validated stored user. Returns false when the username exists. */
export function createWebUser(user: StoredWebUser): boolean {
  const config = readWebUsersConfig();
  if (config.users.some((candidate) => candidate.username === user.username)) return false;
  writeWebUsersConfig({ ...config, users: [...config.users, user] });
  return true;
}

export type WebUserUpdate = Partial<Pick<StoredWebUser, "role" | "projects">> & {
  passwordHash?: string;
};

/** Applies a partial update. Returns the updated user, or null when not found. */
export function updateWebUser(username: string, update: WebUserUpdate): StoredWebUser | null {
  const config = readWebUsersConfig();
  const user = config.users.find((candidate) => candidate.username === username);
  if (!user) return null;
  const next: StoredWebUser = {
    ...user,
    ...(update.role !== undefined ? { role: update.role } : {}),
    ...(update.projects !== undefined ? { projects: update.projects } : {}),
    ...(update.passwordHash !== undefined ? { passwordHash: update.passwordHash } : {}),
  };
  writeWebUsersConfig({
    ...config,
    users: config.users.map((candidate) => (candidate === user ? next : candidate)),
  });
  return next;
}

/** Removes a file user (and its tokens). Returns false when not found. */
export function deleteWebUser(username: string): boolean {
  const config = readWebUsersConfig();
  if (!config.users.some((candidate) => candidate.username === username)) return false;
  writeWebUsersConfig({
    ...config,
    users: config.users.filter((candidate) => candidate.username !== username),
  });
  return true;
}

/** Removes one named token. Returns false when user or token is missing. */
export function deleteWebUserToken(username: string, name: string): boolean {
  const config = readWebUsersConfig();
  const user = config.users.find((candidate) => candidate.username === username);
  if (!user || !user.tokens.some((token) => token.name === name)) return false;
  writeWebUsersConfig({
    ...config,
    users: config.users.map((candidate) =>
      candidate === user
        ? { ...candidate, tokens: candidate.tokens.filter((token) => token.name !== name) }
        : candidate,
    ),
  });
  return true;
}

// --- effective users + migration ----------------------------------------------

export function getEffectiveWebUsers(): EffectiveWebUser[] {
  const users = readWebUsersConfig().users.map((user): EffectiveWebUser => ({
    ...user,
    envBacked: false,
  }));

  const envPassword = process.env.OMP_WEB_PASSWORD;
  if (!isWebPasswordEnabled(envPassword)) return users;

  // Migration bridge: while OMP_WEB_PASSWORD is set, the legacy Basic Auth
  // identity stays available as a synthetic admin — even after file users
  // exist — so creating the first file user can never lock out every admin.
  // It retires when the operator removes the env var, and yields to a file
  // user that claims the same name. Never persisted.
  if (users.some((user) => user.username === ENV_MIGRATION_USERNAME)) return users;
  return [
    ...users,
    {
      username: ENV_MIGRATION_USERNAME,
      role: "admin",
      passwordHash: null,
      projects: "*",
      tokens: [],
      envBacked: true,
    },
  ];
}

export function authEnabled(): boolean {
  if (isWebPasswordEnabled()) return true;
  return readWebUsersConfig().users.length > 0;
}

/**
 * True when the users file itself lists at least one user — i.e. auth exists
 * beyond the OMP_WEB_PASSWORD bridge (cookie/Bearer login is enforced).
 */
export function hasStoredWebUsers(): boolean {
  return readWebUsersConfig().users.length > 0;
}

/**
 * Effective admin count for a candidate user list (used by the last-admin
 * guard). The env-backed migration admin counts whenever it would be in
 * effect: `OMP_WEB_PASSWORD` set and no file user claims its name —
 * mirroring `getEffectiveWebUsers`.
 */
export function countEffectiveAdmins(users: StoredWebUser[]): number {
  const admins = users.filter((user) => user.role === "admin").length;
  if (admins > 0) return admins;
  const bridgeInEffect =
    isWebPasswordEnabled(process.env.OMP_WEB_PASSWORD)
    && !users.some((user) => user.username === ENV_MIGRATION_USERNAME);
  return bridgeInEffect ? 1 : 0;
}

// --- Bearer tokens -------------------------------------------------------------

export function createWebUserToken(
  username: string,
  name: string,
): { raw: string; created: string } | null {
  const config = readWebUsersConfig();
  const user = config.users.find((candidate) => candidate.username === username);
  if (!user) return null;

  const raw = `web_${randomBytes(32).toString("base64url")}`;
  const created = new Date().toISOString();
  const token: StoredWebToken = {
    name,
    tokenHash: createHash("sha256").update(raw, "utf8").digest("hex"),
    created,
  };
  writeWebUsersConfig({
    ...config,
    users: config.users.map((candidate) =>
      candidate === user ? { ...candidate, tokens: [...candidate.tokens, token] } : candidate,
    ),
  });
  return { raw, created };
}

export function verifyWebBearerToken(raw: string): EffectiveWebUser | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const tokenHash = createHash("sha256").update(raw, "utf8").digest("hex");
  const user = readWebUsersConfig().users.find((candidate) =>
    candidate.tokens.some((token) => token.tokenHash === tokenHash),
  );
  return user ? { ...user, envBacked: false } : null;
}

// --- safe projection -----------------------------------------------------------

export function toSafeWebUser(user: EffectiveWebUser): WebUser {
  return {
    username: user.username,
    role: user.role,
    visibleProjects: user.projects,
  };
}
