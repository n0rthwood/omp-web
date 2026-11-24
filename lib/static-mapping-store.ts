import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { withFileLockSync, writePrivateFileAtomicSync } from "./atomic-file";
import {
  STATIC_MAPPING_LIFECYCLES,
  STATIC_MAPPING_STATES,
  type StaticMapping,
  type StaticMappingCreateInput,
  type StaticMappingLifecycle,
  type StaticMappingPatchInput,
  type StaticMappingState,
} from "./static-mappings";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAPPING_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MACHINE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const ENTRY_SEGMENT_RE = /^[^\\/\u0000]+$/;
const MAX_LABEL_LENGTH = 200;
const MAX_SESSION_ID_LENGTH = 256;

export const LOCAL_STATIC_MACHINE_ID = "local";

export interface StaticMappingRecord {
  id: string;
  label: string;
  lifecycle: StaticMappingLifecycle;
  state: StaticMappingState;
  /** Provenance only. Never use this value for authorization. */
  sessionId?: string;
  entryFile: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  contentRetained: boolean;
}

export class StaticMappingError extends Error {
  readonly status: number;
  readonly field?: string;

  constructor(message: string, status = 400, field?: string) {
    super(message);
    this.name = "StaticMappingError";
    this.status = status;
    this.field = field;
  }
}


interface StaticMappingsCache {
  path: string;
  mtimeMs: number;
  size: number;
  value: StaticMappingRecord[];
}

declare global {
  var __ompStaticMappingsCache: StaticMappingsCache | undefined;
  var __ompStaticMappingCleanupTimer: NodeJS.Timeout | undefined;
}

function cloneRecord(record: StaticMappingRecord): StaticMappingRecord {
  return { ...record };
}

function cloneRecords(records: StaticMappingRecord[]): StaticMappingRecord[] {
  return records.map(cloneRecord);
}

export function getStaticMappingsFilePath(): string {
  return process.env.OMP_WEB_STATIC_MAPPINGS_FILE
    ?? join(getAgentDir(), "omp-web-static-mappings.json");
}

export function getStaticRootPath(): string {
  return process.env.OMP_WEB_STATIC_ROOT ?? join(getAgentDir(), "static");
}

/** The stable fleet-visible identity used in publicPath and /static URLs. */
export function getStaticPublicMachineId(): string {
  const configured = process.env.OMP_WEB_MACHINE_ID?.trim().toLowerCase();
  if (configured && MACHINE_ID_RE.test(configured)) return configured;

  const name = process.env.OMP_WEB_MACHINE_NAME?.trim().normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/g, "");
  return name && MACHINE_ID_RE.test(name) ? name : LOCAL_STATIC_MACHINE_ID;
}

export function isLocalStaticMachineId(machineId: string): boolean {
  return machineId === LOCAL_STATIC_MACHINE_ID || machineId === getStaticPublicMachineId();
}

export function isValidStaticMappingId(id: string): boolean {
  return typeof id === "string" && MAPPING_ID_RE.test(id);
}

export function validateStaticMappingId(id: string): void {
  if (!isValidStaticMappingId(id)) {
    throw new StaticMappingError(
      "mapping id must be a lowercase safe path segment (1..64 characters)",
      400,
      "id",
    );
  }
}

/** Validate a relative asset segment before it reaches either fs or fetch URL parsing. */
export function isValidStaticAssetSegment(segment: string): boolean {
  return (
    typeof segment === "string"
    && segment.length > 0
    && segment !== "."
    && segment !== ".."
    && ENTRY_SEGMENT_RE.test(segment)
  );
}

export function validateStaticAssetSegments(segments: readonly string[]): void {
  if (segments.some((segment) => !isValidStaticAssetSegment(segment))) {
    throw new StaticMappingError("asset path is invalid", 400, "path");
  }
}

/**
 * Fixed index fallback order for a bare mapping URL (`/static/<machine>/<mapping>`).
 * Only these two names are ever tried; a directory is never listed.
 */
const INDEX_FILE_SEGMENTS: readonly string[][] = [["index.html"], ["index.htm"]];

function normalizeEntryFile(input: unknown): string {
  if (input === undefined) return "index.html";
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) {
    throw new StaticMappingError("entryFile must be a non-empty relative path", 400, "entryFile");
  }
  const segments = input.split(/[\\/]/g);
  validateStaticAssetSegments(segments);
  return segments.join("/");
}

function normalizeLabel(input: unknown, fallback: string): string {
  if (input === undefined) return fallback;
  if (typeof input !== "string") throw new StaticMappingError("label must be a string", 400, "label");
  const label = input.trim();
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    throw new StaticMappingError(`label must be 1..${MAX_LABEL_LENGTH} characters`, 400, "label");
  }
  return label;
}

function normalizeSessionId(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_SESSION_ID_LENGTH) {
    throw new StaticMappingError("sessionId must be a non-empty string", 400, "sessionId");
  }
  return input;
}

function parseIsoDate(input: unknown, field: string): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) {
    throw new StaticMappingError(`${field} must be an ISO date`, 400, field);
  }
  return new Date(input).toISOString();
}

function ttlExpiry(ttlSeconds: unknown, nowMs: number): string {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds)) {
    throw new StaticMappingError("ttlSeconds must be an integer", 400, "ttlSeconds");
  }
  if (ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new StaticMappingError(`ttlSeconds must be 1..${MAX_TTL_SECONDS}`, 400, "ttlSeconds");
  }
  return new Date(nowMs + ttlSeconds * 1000).toISOString();
}

function defaultExpiry(nowMs: number): string {
  return new Date(nowMs + DEFAULT_TTL_SECONDS * 1000).toISOString();
}

function normalizeLifecycle(value: unknown, fallback: StaticMappingLifecycle): StaticMappingLifecycle {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !STATIC_MAPPING_LIFECYCLES.includes(value as StaticMappingLifecycle)) {
    throw new StaticMappingError("lifecycle must be persistent or temporary", 400, "lifecycle");
  }
  return value as StaticMappingLifecycle;
}

function lifecycleFromInput(
  lifecycle: unknown,
  persistent: unknown,
  fallback: StaticMappingLifecycle,
  hasTemporaryFields: boolean,
): StaticMappingLifecycle {
  if (persistent !== undefined && typeof persistent !== "boolean") {
    throw new StaticMappingError("persistent must be a boolean", 400, "persistent");
  }
  const alias = persistent === undefined ? undefined : persistent ? "persistent" : "temporary";
  if (lifecycle !== undefined && alias !== undefined && lifecycle !== alias) {
    throw new StaticMappingError("lifecycle and persistent disagree", 400, "lifecycle");
  }
  return normalizeLifecycle(lifecycle ?? alias, hasTemporaryFields && fallback === "persistent" ? "temporary" : fallback);
}

function parseStoredRecord(value: unknown): StaticMappingRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !isValidStaticMappingId(record.id)) return null;
  const lifecycle = normalizePersistedLifecycle(record.lifecycle);
  const state = normalizePersistedState(record.state);
  const createdAt = normalizePersistedDate(record.createdAt) ?? new Date(0).toISOString();
  const updatedAt = normalizePersistedDate(record.updatedAt) ?? createdAt;
  const entryFile = normalizePersistedEntryFile(record.entryFile);
  const expiresAt = normalizePersistedDate(record.expiresAt);
  const sessionId = typeof record.sessionId === "string" && record.sessionId.length > 0
    ? record.sessionId.slice(0, MAX_SESSION_ID_LENGTH)
    : undefined;
  return {
    id: record.id,
    label: typeof record.label === "string" && record.label.length > 0
      ? record.label.slice(0, MAX_LABEL_LENGTH)
      : record.id,
    lifecycle,
    state,
    ...(sessionId ? { sessionId } : {}),
    entryFile,
    createdAt,
    updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof record.revokedAt === "string" && Number.isFinite(Date.parse(record.revokedAt))
      ? { revokedAt: new Date(record.revokedAt).toISOString() }
      : {}),
    contentRetained: record.contentRetained === undefined ? true : record.contentRetained === true,
  };
}

function normalizePersistedLifecycle(value: unknown): StaticMappingLifecycle {
  return value === "persistent" ? "persistent" : "temporary";
}

function normalizePersistedState(value: unknown): StaticMappingState {
  return STATIC_MAPPING_STATES.includes(value as StaticMappingState) ? value as StaticMappingState : "active";
}

function normalizePersistedDate(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

function normalizePersistedEntryFile(value: unknown): string {
  try {
    return normalizeEntryFile(value);
  } catch {
    return "index.html";
  }
}

function readMappingsFile(): StaticMappingRecord[] {
  const metadataPath = getStaticMappingsFilePath();
  let mtimeMs: number;
  let size: number;
  try {
    const stats = statSync(metadataPath);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    globalThis.__ompStaticMappingsCache = undefined;
    return [];
  }
  const cache = globalThis.__ompStaticMappingsCache;
  if (cache && cache.path === metadataPath && cache.mtimeMs === mtimeMs && cache.size === size) {
    return cache.value;
  }

  let mappings: StaticMappingRecord[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
    const values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && Array.isArray((parsed as Record<string, unknown>).mappings)
      ? (parsed as { mappings: unknown[] }).mappings
      : [];
    mappings = values.map(parseStoredRecord).filter((value): value is StaticMappingRecord => value !== null);
  } catch {
    mappings = [];
  }
  globalThis.__ompStaticMappingsCache = { path: metadataPath, mtimeMs, size, value: mappings };
  return mappings;
}

function writeMappingsFile(mappings: StaticMappingRecord[]): void {
  const metadataPath = getStaticMappingsFilePath();
  mkdirSync(dirname(metadataPath), { recursive: true });
  writePrivateFileAtomicSync(metadataPath, JSON.stringify({ mappings }, null, 2) + "\n");
  const stats = statSync(metadataPath);
  globalThis.__ompStaticMappingsCache = {
    path: metadataPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    value: mappings,
  };
}

function mappingLockPath(): string {
  return `${getStaticMappingsFilePath()}.lock`;
}

function staticRootResolved(): string {
  const root = resolve(getStaticRootPath());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StaticMappingError("static content root is not a directory", 500);
  }
  return realpathSync(root);
}

export function getStaticMappingRoot(id: string): string {
  validateStaticMappingId(id);
  return join(resolve(getStaticRootPath()), id);
}

function ensureMappingRoot(id: string, requireEmpty = false): string {
  const staticRoot = staticRootResolved();
  const root = getStaticMappingRoot(id);
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new StaticMappingError("mapping content directory is not a real directory", 409);
    }
    if (requireEmpty && readdirSync(root).length > 0) {
      throw new StaticMappingError("mapping content directory is not empty", 409, "id");
    }
  } else {
    mkdirSync(root, { recursive: false, mode: 0o700 });
  }
  const realRoot = realpathSync(root);
  const rel = relative(staticRoot, realRoot);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    throw new StaticMappingError("mapping content escapes the static root", 409);
  }
  return root;
}

function removeMappingContent(id: string): boolean {
  const root = getStaticMappingRoot(id);
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch {
    return false;
  }
  try {
    if (stat.isSymbolicLink()) {
      unlinkSync(root);
      return true;
    }
    const staticRoot = staticRootResolved();
    const realRoot = realpathSync(root);
    const rel = relative(staticRoot, realRoot);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function parseCreateExpiry(input: StaticMappingCreateInput, lifecycle: StaticMappingLifecycle, nowMs: number): string | undefined {
  if (lifecycle === "persistent") return undefined;
  if (input.ttlSeconds !== undefined && input.expiresAt !== undefined) {
    throw new StaticMappingError("provide ttlSeconds or expiresAt, not both", 400, "expiresAt");
  }
  if (input.ttlSeconds !== undefined) return ttlExpiry(input.ttlSeconds, nowMs);
  if (input.expiresAt !== undefined) return parseIsoDate(input.expiresAt, "expiresAt");
  return defaultExpiry(nowMs);
}

function parsePatchExpiry(
  input: StaticMappingPatchInput,
  lifecycle: StaticMappingLifecycle,
  current: StaticMappingRecord,
  nowMs: number,
): string | undefined {
  if (lifecycle === "persistent") return undefined;
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null && input.expiresAt !== undefined && input.expiresAt !== null) {
    throw new StaticMappingError("provide ttlSeconds or expiresAt, not both", 400, "expiresAt");
  }
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null) return ttlExpiry(input.ttlSeconds, nowMs);
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const expiresAt = parseIsoDate(input.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= nowMs) {
      throw new StaticMappingError("expiresAt must be in the future", 400, "expiresAt");
    }
    return expiresAt;
  }
  if (input.expiresAt === null) return defaultExpiry(nowMs);
  if (current.lifecycle === "temporary" && current.expiresAt) {
    if (Date.parse(current.expiresAt) <= nowMs) {
      throw new StaticMappingError("expiresAt must be in the future", 400, "expiresAt");
    }
    return current.expiresAt;
  }
  return defaultExpiry(nowMs);
}

function toRecordResponse(record: StaticMappingRecord): StaticMapping {
  const entrySegments = record.entryFile.split("/").map((segment) => encodeURIComponent(segment));
  const machineId = getStaticPublicMachineId();
  return {
    ...cloneRecord(record),
    persistent: record.lifecycle === "persistent",
    writeDir: getStaticMappingRoot(record.id),
    publicPath: `/static/${encodeURIComponent(machineId)}/${encodeURIComponent(record.id)}/${entrySegments.join("/")}`,
  };
}

/** Convert persisted metadata to the UI/skill response, including local paths and URL. */
export function toStaticMapping(record: StaticMappingRecord): StaticMapping {
  return toRecordResponse(record);
}

export function sweepExpiredStaticMappings(nowMs = Date.now()): number {
  return withFileLockSync(mappingLockPath(), () => {
    const stored = readMappingsFile();
    const revoked = stored.filter((mapping) => mapping.state === "revoked");
    const mappings = revoked.length > 0
      ? stored.filter((mapping) => mapping.state !== "revoked")
      : stored;
    if (revoked.length > 0) {
      // Remove legacy revoked rows left by older releases. Retained bytes are
      // intentionally left on disk; rows with deleted content are cleaned up.
      writeMappingsFile(mappings);
      for (const mapping of revoked) {
        if (!mapping.contentRetained) removeMappingContent(mapping.id);
      }
    }
    const expired = mappings.filter((mapping) =>
      mapping.state === "active"
      && mapping.lifecycle === "temporary"
      && typeof mapping.expiresAt === "string"
      && Date.parse(mapping.expiresAt) <= nowMs,
    );
    const staleExpired = mappings.filter((mapping) => mapping.state === "expired" && !mapping.contentRetained);
    if (expired.length === 0) {
      for (const mapping of staleExpired) removeMappingContent(mapping.id);
      return 0;
    }
    const expiredIds = new Set(expired.map((mapping) => mapping.id));
    const now = new Date(nowMs).toISOString();
    const next = mappings.map((mapping) => expiredIds.has(mapping.id)
      ? { ...mapping, state: "expired" as const, contentRetained: false, updatedAt: now }
      : mapping);
    writeMappingsFile(next);
    for (const mapping of [...expired, ...staleExpired]) removeMappingContent(mapping.id);
    return expired.length;
  });
}

export function listStaticMappings(): StaticMappingRecord[] {
  sweepExpiredStaticMappings();
  return cloneRecords(readMappingsFile());
}

export function getStaticMapping(id: string): StaticMappingRecord | null {
  validateStaticMappingId(id);
  sweepExpiredStaticMappings();
  const mapping = readMappingsFile().find((candidate) => candidate.id === id);
  return mapping ? cloneRecord(mapping) : null;
}

export function createStaticMapping(input: StaticMappingCreateInput = {}): StaticMappingRecord {
  const nowMs = Date.now();
  const id = input.id === undefined ? randomUUID().replace(/_/g, "-") : input.id;
  validateStaticMappingId(id);
  const hasTemporaryFields = input.ttlSeconds !== undefined || input.expiresAt !== undefined;
  const lifecycle = lifecycleFromInput(input.lifecycle, input.persistent, "temporary", hasTemporaryFields);
  const label = normalizeLabel(input.label, id);
  const entryFile = normalizeEntryFile(input.entryFile);
  const sessionId = normalizeSessionId(input.sessionId);
  const expiresAt = parseCreateExpiry(input, lifecycle, nowMs);
  return withFileLockSync(mappingLockPath(), () => {
    const mappings = readMappingsFile();
    if (mappings.some((mapping) => mapping.id === id)) {
      throw new StaticMappingError("mapping id already exists", 409, "id");
    }
    ensureMappingRoot(id, true);
    const now = new Date(nowMs).toISOString();
    const mapping: StaticMappingRecord = {
      id,
      label,
      lifecycle,
      state: "active",
      ...(sessionId ? { sessionId } : {}),
      entryFile,
      createdAt: now,
      updatedAt: now,
      ...(expiresAt ? { expiresAt } : {}),
      contentRetained: true,
    };
    try {
      writeMappingsFile([...mappings, mapping]);
    } catch (error) {
      removeMappingContent(id);
      throw error;
    }
    return cloneRecord(mapping);
  });
}

export function updateStaticMapping(id: string, input: StaticMappingPatchInput): StaticMappingRecord | null {
  validateStaticMappingId(id);
  return withFileLockSync(mappingLockPath(), () => {
    const mappings = readMappingsFile();
    const current = mappings.find((mapping) => mapping.id === id);
    if (!current) return null;
    if (current.state === "revoked") {
      throw new StaticMappingError("mapping is no longer active", 409);
    }
    const nowMs = Date.now();
    const hasTemporaryFields = (input.ttlSeconds !== undefined && input.ttlSeconds !== null)
      || (input.expiresAt !== undefined && input.expiresAt !== null);
    const clearsExpiry = input.expiresAt === null
      && (input.ttlSeconds === undefined || input.ttlSeconds === null)
      && input.lifecycle === undefined
      && input.persistent === undefined;
    const lifecycle = clearsExpiry
      ? "persistent"
      : lifecycleFromInput(input.lifecycle, input.persistent, current.lifecycle, hasTemporaryFields);
    const label = normalizeLabel(input.label, current.label);
    const entryFile = normalizeEntryFile(input.entryFile ?? current.entryFile);
    const expiresAt = parsePatchExpiry(input, lifecycle, current, nowMs);
    const reactivating = current.state === "expired"
      && (
        lifecycle === "persistent"
        || (expiresAt !== undefined && Date.parse(expiresAt) > nowMs)
      );
    if (reactivating) ensureMappingRoot(id);
    const updated: StaticMappingRecord = {
      ...current,
      label,
      lifecycle,
      entryFile,
      state: reactivating ? "active" : current.state,
      contentRetained: reactivating ? true : current.contentRetained,
      updatedAt: new Date(nowMs).toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    };
    if (!expiresAt) delete updated.expiresAt;
    writeMappingsFile(mappings.map((mapping) => mapping.id === id ? updated : mapping));
    return cloneRecord(updated);
  });
}

export function revokeStaticMapping(id: string, content: "delete" | "retain" = "retain"): {
  mapping: StaticMappingRecord;
  contentDeleted: boolean;
} | null {
  validateStaticMappingId(id);
  if (content !== "delete" && content !== "retain") {
    throw new StaticMappingError("content must be delete or retain", 400, "content");
  }
  return withFileLockSync(mappingLockPath(), () => {
    const mappings = readMappingsFile();
    const current = mappings.find((mapping) => mapping.id === id);
    if (!current) return null;
    const now = new Date().toISOString();
    const snapshot: StaticMappingRecord = {
      ...current,
      state: "revoked",
      revokedAt: current.revokedAt ?? now,
      updatedAt: now,
      contentRetained: content === "delete" ? false : current.contentRetained,
    };
    // Revocation is an unbind operation: remove metadata first so a failed
    // content delete cannot leave an active mapping behind.
    writeMappingsFile(mappings.filter((mapping) => mapping.id !== id));
    const contentDeleted = content === "delete" ? removeMappingContent(id) : false;
    return { mapping: cloneRecord(snapshot), contentDeleted };
  });
}

/**
 * Resolve an existing file while enforcing registered active state, realpath
 * containment, and symlink rejection. This is the only fs path resolver used
 * by the internal and public static routes. An empty segment list (a bare
 * mapping URL) resolves to index.html, then index.htm; if neither exists it
 * resolves to null (404). Directories are never listed.
 */
export function resolveStaticMappingFile(
  id: string,
  segments: readonly string[],
): { mapping: StaticMappingRecord; filePath: string; stat: Stats } | null {
  validateStaticMappingId(id);
  if (segments.length > 0) validateStaticAssetSegments(segments);
  const mapping = getStaticMapping(id);
  if (!mapping || mapping.state !== "active" || !mapping.contentRetained) return null;
  const root = getStaticMappingRoot(id);
  let realRoot: string;
  let realStaticRoot: string;
  try {
    const rootStat = lstatSync(root);
    const staticRootPath = resolve(getStaticRootPath());
    const staticRootStat = lstatSync(staticRootPath);
    if (
      !rootStat.isDirectory()
      || rootStat.isSymbolicLink()
      || !staticRootStat.isDirectory()
      || staticRootStat.isSymbolicLink()
    ) return null;
    realStaticRoot = realpathSync(staticRootPath);
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const rootRel = relative(realStaticRoot, realRoot);
  if (rootRel.startsWith("..") || isAbsolute(rootRel) || rootRel === "") return null;
  const candidates = segments.length > 0 ? [segments] : INDEX_FILE_SEGMENTS;
  for (const candidate of candidates) {
    const requested = resolve(root, ...candidate);
    if (!requested.startsWith(`${root}/`)) continue;
    let realFile: string;
    try {
      realFile = realpathSync(requested);
    } catch {
      continue;
    }
    const rel = relative(realRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") continue;
    let stat: Stats;
    try {
      stat = statSync(realFile);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    return { mapping, filePath: realFile, stat };
  }
  return null;
}

/** Run one immediate persisted sweep and install one bounded process timer. */
export function startStaticMappingCleanup(): void {
  try {
    sweepExpiredStaticMappings();
  } catch (error) {
    console.error("omp-web static mapping cleanup failed during startup", error);
  }
  if (globalThis.__ompStaticMappingCleanupTimer) return;
  const timer = setInterval(() => {
    try {
      sweepExpiredStaticMappings();
    } catch (error) {
      console.error("omp-web static mapping cleanup failed", error);
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();
  globalThis.__ompStaticMappingCleanupTimer = timer;
}

export function staticMappingResponse(record: StaticMappingRecord): StaticMapping {
  return toRecordResponse(record);
}
