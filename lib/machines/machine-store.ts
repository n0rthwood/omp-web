import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import type { MachineAuthMode, SafeMachine, UserVisibleMachine } from "../api-types";

export type { MachineAuthMode, SafeMachine, UserVisibleMachine } from "../api-types";

/** The synthetic local machine id — never stored, never deletable. */
export const LOCAL_MACHINE_ID = "local";

export interface StoredMachine {
  id: string;
  name: string;
  baseUrl: string;
  authMode: MachineAuthMode;
  token?: string;
  username?: string;
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}


export interface MachineInput {
  id?: string;
  name: string;
  baseUrl: string;
  authMode: MachineAuthMode;
  token?: string | null;
  username?: string | null;
  headers?: Record<string, string>;
}

export interface MachinePatch {
  name?: string;
  baseUrl?: string;
  authMode?: MachineAuthMode;
  token?: string | null;
  username?: string | null;
  headers?: Record<string, string>;
}

export class MachineValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "MachineValidationError";
    this.field = field;
  }
}

// --- mtime+size-keyed global cache (lib/web-users.ts shape, plus size) --------

interface MachinesCache {
  path: string;
  mtimeMs: number;
  size: number;
  value: StoredMachine[];
}
declare global {
  // eslint-disable-next-line no-var
  var __ompMachinesCache: MachinesCache | undefined;
}

export function getMachinesFilePath(): string {
  return process.env.OMP_WEB_MACHINES_FILE ?? join(getAgentDir(), "omp-web-machines.json");
}

// --- validation ----------------------------------------------------------------

/** 1..39 chars, lowercase alnum and inner hyphens — never a leading or trailing one. */
const MACHINE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
/** Visible ASCII plus tab and space — what a header value may legally carry. */
const HEADER_VALUE_RE = /^[\t\x20-\x7e]*$/;
const FORBIDDEN_HEADER_NAMES: Record<string, true> = {
  "host": true,
  "authorization": true,
  "cookie": true,
  "content-length": true,
  "connection": true,
  "transfer-encoding": true,
};

function isMachineAuthMode(value: string): value is MachineAuthMode {
  return value === "bearer" || value === "basic" || value === "none";
}

/** Shape-only check (does not exclude `local`) — used to validate `machines`
 *  grant arrays on `StoredWebUser` without pulling in the full create/update
 *  validation path. */
export function isValidMachineId(id: string): boolean {
  return MACHINE_ID_RE.test(id);
}

function validateId(id: string): void {
  if (!MACHINE_ID_RE.test(id) || id === LOCAL_MACHINE_ID) {
    throw new MachineValidationError("id", "id must match ^[a-z0-9][a-z0-9-]{0,38}$ and not be \"local\"");
  }
}

function validateName(name: string): void {
  if (name.length < 1 || name.length > 64) {
    throw new MachineValidationError("name", "name must be 1..64 characters");
  }
}

/** http/https URLs reduced to their origin — no credentials, path, query, hash. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MachineValidationError("baseUrl", "baseUrl must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MachineValidationError("baseUrl", "baseUrl must use http or https");
  }
  return url.origin;
}

function validateHeaders(headers: Record<string, string>): void {
  for (const rawName of Object.keys(headers)) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME_RE.test(name)) {
      throw new MachineValidationError("headers", `invalid header name: ${rawName}`);
    }
    if (Object.hasOwn(FORBIDDEN_HEADER_NAMES, name)) {
      throw new MachineValidationError("headers", `header not allowed: ${name}`);
    }
    const value = headers[rawName];
    if (typeof value !== "string") {
      throw new MachineValidationError("headers", "header values must be strings");
    }
    // Rejected here rather than at use time: a stray newline from a paste
    // otherwise throws inside every proxied fetch, turning one bad character
    // into a permanently broken machine instead of a 400 on save.
    if (!HEADER_VALUE_RE.test(value)) {
      throw new MachineValidationError("headers", `invalid header value for ${name}`);
    }
  }
}

function validateCredential(authMode: MachineAuthMode, token: string | undefined | null): void {
  if (authMode === "none") return;
  if (typeof token !== "string" || token.length === 0) {
    throw new MachineValidationError("token", `token is required when authMode is "${authMode}"`);
  }
  if (!HEADER_VALUE_RE.test(token)) {
    throw new MachineValidationError("token", "token contains characters that cannot be sent in a header");
  }
}

/** Lowercase static headers (validated), dropping undefined/null values. */
function normalizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "machine";
}

function uniqueId(base: string, existing: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    const tail = `-${suffix}`;
    // Trim the cut edge: truncating mid-slug can land on a hyphen, and an id
    // never ends (or doubles) one.
    candidate = base.slice(0, 39 - tail.length).replace(/-+$/, "") + tail;
    suffix += 1;
  }
  return candidate;
}

// --- persistence ---------------------------------------------------------------

function parseStoredMachine(value: unknown): StoredMachine | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const baseUrl = record.baseUrl;
  const authMode = record.authMode;
  if (typeof id !== "string" || typeof name !== "string" || typeof baseUrl !== "string") {
    return null;
  }
  if (typeof authMode !== "string" || !isMachineAuthMode(authMode)) return null;
  const headers =
    typeof record.headers === "object" && record.headers !== null
      ? normalizeHeaders(
          Object.fromEntries(
            Object.entries(record.headers).filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"),
          ),
        )
      : {};
  return {
    id,
    name,
    baseUrl,
    authMode,
    ...(typeof record.token === "string" ? { token: record.token } : {}),
    ...(typeof record.username === "string" ? { username: record.username } : {}),
    headers,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
  };
}

function readMachinesFile(): StoredMachine[] {
  const path = getMachinesFilePath();
  let mtimeMs: number;
  let size: number;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    // Size joins the key because two writes can land in the same mtime tick —
    // an external edit would otherwise be served from a stale cache entry.
    size = stats.size;
  } catch {
    globalThis.__ompMachinesCache = undefined;
    return [];
  }

  const cache = globalThis.__ompMachinesCache;
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs && cache.size === size) {
    return cache.value;
  }

  let machines: StoredMachine[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list =
      typeof parsed === "object" && parsed !== null && "machines" in parsed && Array.isArray(parsed.machines)
        ? parsed.machines
        : [];
    machines = list.map(parseStoredMachine).filter((m): m is StoredMachine => m !== null);
  } catch {
    machines = [];
  }
  globalThis.__ompMachinesCache = { path, mtimeMs, size, value: machines };
  return machines;
}

function writeMachinesFile(machines: StoredMachine[]): void {
  const path = getMachinesFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ machines }, null, 2) + "\n");
  const stats = statSync(path);
  globalThis.__ompMachinesCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, value: machines };
}

// --- safe projection -----------------------------------------------------------

const LOCAL_EPOCH = "2026-01-01T00:00:00.000Z";
const LOCAL_MACHINE: SafeMachine = {
  id: LOCAL_MACHINE_ID,
  name: "This machine",
  baseUrl: "",
  authMode: "none",
  hasCredential: false,
  headerNames: [],
  createdAt: LOCAL_EPOCH,
  updatedAt: LOCAL_EPOCH,
  isLocal: true,
};

/** The synthetic local machine, always first in listings. Its display name
 *  comes from `OMP_WEB_MACHINE_NAME` so a fleet operator can name each
 *  instance after its host instead of the generic default. */
export function getLocalSafeMachine(): SafeMachine {
  const name = process.env.OMP_WEB_MACHINE_NAME?.trim();
  return { ...LOCAL_MACHINE, ...(name ? { name } : {}) };
}

export function toSafeMachine(machine: StoredMachine): SafeMachine {
  return {
    id: machine.id,
    name: machine.name,
    baseUrl: machine.baseUrl,
    authMode: machine.authMode,
    hasCredential:
      machine.authMode !== "none" && typeof machine.token === "string" && machine.token.length > 0,
    headerNames: machine.headers ? Object.keys(machine.headers).sort() : [],
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
    isLocal: machine.id === LOCAL_MACHINE_ID,
  };
}

/** The user-role projection — drops the remote origin and header names. */
export function toUserVisibleMachine(input: SafeMachine): UserVisibleMachine {
  return {
    id: input.id,
    name: input.name,
    authMode: input.authMode,
    hasCredential: input.hasCredential,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    isLocal: input.isLocal,
  };
}

// --- public API ----------------------------------------------------------------

export function listMachines(): StoredMachine[] {
  return readMachinesFile().map((machine) => ({ ...machine }));
}

export function listSafeMachines(): SafeMachine[] {
  return [getLocalSafeMachine(), ...readMachinesFile().map(toSafeMachine)];
}

export function getMachine(id: string): StoredMachine | null {
  const machine = readMachinesFile().find((candidate) => candidate.id === id);
  return machine ? { ...machine } : null;
}

export function createMachine(input: MachineInput): StoredMachine {
  if (typeof input.name !== "string") throw new MachineValidationError("name", "name must be a string");
  validateName(input.name);
  if (typeof input.baseUrl !== "string") throw new MachineValidationError("baseUrl", "baseUrl must be a string");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (typeof input.authMode !== "string" || !isMachineAuthMode(input.authMode)) {
    throw new MachineValidationError("authMode", "authMode must be \"bearer\", \"basic\" or \"none\"");
  }
  validateCredential(input.authMode, input.token);
  const headers = normalizeHeaders(input.headers);
  validateHeaders(headers);

  const machines = readMachinesFile();
  const existing = new Set(machines.map((machine) => machine.id));
  // An id is optional; when the caller does provide one it must be valid,
  // never silently coerced into something else.
  let id = input.id === undefined ? slugify(input.name) : input.id;
  validateId(id);
  id = uniqueId(id, existing);

  const now = new Date().toISOString();
  const machine: StoredMachine = {
    id,
    name: input.name,
    baseUrl,
    authMode: input.authMode,
    ...(input.authMode !== "none" && typeof input.token === "string"
      ? { token: input.token }
      : {}),
    ...(input.authMode === "basic" && input.username
      ? { username: input.username }
      : {}),
    headers,
    createdAt: now,
    updatedAt: now,
  };
  writeMachinesFile([...machines, machine]);
  return { ...machine };
}

export function updateMachine(id: string, patch: MachinePatch): StoredMachine | null {
  const machines = readMachinesFile();
  const machine = machines.find((candidate) => candidate.id === id);
  if (!machine) return null;

  const next: StoredMachine = { ...machine };
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string") throw new MachineValidationError("name", "name must be a string");
    validateName(patch.name);
    next.name = patch.name;
  }
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== "string") throw new MachineValidationError("baseUrl", "baseUrl must be a string");
    next.baseUrl = normalizeBaseUrl(patch.baseUrl);
    // A credential is bound to the origin it was issued for. Silently carrying
    // it to a new origin would let anyone who can PATCH deliver the stored
    // secret to a host of their choosing.
    if (next.baseUrl !== machine.baseUrl && patch.token === undefined && machine.token) {
      throw new MachineValidationError(
        "token",
        "re-enter the credential when changing the base URL",
      );
    }
  }
  if (patch.authMode !== undefined) {
    if (typeof patch.authMode !== "string" || !isMachineAuthMode(patch.authMode)) {
      throw new MachineValidationError("authMode", "authMode must be \"bearer\", \"basic\" or \"none\"");
    }
    next.authMode = patch.authMode;
  }
  if (patch.headers !== undefined) {
    const headers = normalizeHeaders(patch.headers);
    validateHeaders(headers);
    next.headers = headers;
  }
  // `token: null` clears the credential; omitted `token` keeps it.
  if (patch.token === null) {
    delete next.token;
    delete next.username;
  } else if (patch.token !== undefined) {
    if (typeof patch.token !== "string") throw new MachineValidationError("token", "token must be a string");
    next.token = patch.token;
  }
  if (patch.username === null) {
    delete next.username;
  } else if (patch.username !== undefined) {
    if (typeof patch.username !== "string") {
      throw new MachineValidationError("username", "username must be a string");
    }
    next.username = patch.username;
  }
  // Switching authentication off retires the secret rather than parking it on
  // disk, where `hasCredential: false` would misreport what the file holds.
  if (next.authMode === "none") {
    delete next.token;
    delete next.username;
  }
  validateCredential(next.authMode, next.token);

  next.updatedAt = new Date().toISOString();
  writeMachinesFile(machines.map((candidate) => (candidate === machine ? next : candidate)));
  return { ...next };
}

export function deleteMachine(id: string): boolean {
  const machines = readMachinesFile();
  if (!machines.some((candidate) => candidate.id === id)) return false;
  writeMachinesFile(machines.filter((candidate) => candidate.id !== id));
  return true;
}
