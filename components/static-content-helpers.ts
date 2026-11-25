/**
 * Browser-safe helpers shared by the Settings static-content manager
 * (`StaticContentConfig`) and the aggregate discovery list
 * (`StaticContentList`, issue #136). No Node-only imports.
 */

import { STATIC_MAPPING_LIFECYCLES, STATIC_MAPPING_STATES, type StaticMapping } from "@/lib/static-mappings";
import { LOCAL_MACHINE_ID } from "@/lib/api-path";
import type { AccessNoticeVariant } from "./AccessNotice";

const STATIC_MAPPING_STRING_FIELDS = [
  "id",
  "label",
  "entryFile",
  "createdAt",
  "updatedAt",
  "writeDir",
  "publicPath",
] as const;

export type StaticApiError = Error & { status?: number };

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok || body.error) {
    const error = new Error(body.error ?? `HTTP ${response.status}`) as StaticApiError;
    error.status = response.status;
    throw error;
  }
  return body;
}

export function accessVariant(status: number | undefined): AccessNoticeVariant | null {
  if (status === 403) return "no-permission";
  if (status === 404) return "not-found";
  if (status === 502 || status === 503 || status === 504) return "offline";
  return null;
}

export function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function publicPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}

/** Browser-safe structural check for one `/api/static-mappings` row. Only the
 *  fields the aggregate list renders and links are required; `projectRoot` is
 *  deliberately optional because historical rows omit it and the server
 *  already gates those to admins. This is a shape check, never an
 *  authorization decision. */
export function isStaticMapping(value: unknown): value is StaticMapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  for (const field of STATIC_MAPPING_STRING_FIELDS) {
    if (typeof row[field] !== "string") return false;
  }
  if (typeof row.persistent !== "boolean" || typeof row.contentRetained !== "boolean") return false;
  if (!STATIC_MAPPING_LIFECYCLES.includes(row.lifecycle as StaticMapping["lifecycle"])) return false;
  if (!STATIC_MAPPING_STATES.includes(row.state as StaticMapping["state"])) return false;
  return true;
}

/** Validate one machine's `mappings` payload. Returns `null` when the payload
 *  is not an array or holds any row the browser cannot render, so the caller
 *  records a compact per-machine failure instead of crashing the aggregate. */
export function validatedStaticMappings(value: unknown): StaticMapping[] | null {
  if (!Array.isArray(value)) return null;
  const rows: unknown[] = value;
  return rows.every(isStaticMapping) ? (rows as StaticMapping[]) : null;
}

/** Validate a whole `/api/static-mappings` response body. A proxy error page,
 *  `null`, a primitive, or an array is not the documented envelope and must
 *  yield `null` before `.mappings` is read. */
export function validatedStaticResponseMappings(value: unknown): StaticMapping[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("mappings" in value)) return null;
  return validatedStaticMappings(value.mappings);
}

/** Origin-relative link for an aggregate row. A remote host builds its own
 *  `publicPath` from its host-local identity (`getStaticPublicMachineId`),
 *  which can be "local" or a name the gateway registry doesn't know — the
 *  gateway `/static/<machineId>/...` route resolves the first segment via
 *  the registry id, so remote rows are rebuilt from the registry machine id,
 *  mapping id, and the registered entry file. Only the local machine's own
 *  publicPath is trusted verbatim. */
export function aggregatePublicHref(entry: { machineId: string; mapping: StaticMapping }): string {
  if (entry.machineId === LOCAL_MACHINE_ID) return publicPath(entry.mapping.publicPath);
  const entrySegments = entry.mapping.entryFile.split("/").map((segment) => encodeURIComponent(segment));
  return `/static/${encodeURIComponent(entry.machineId)}/${encodeURIComponent(entry.mapping.id)}/${entrySegments.join("/")}`;
}

/** Per-machine fetch outcome for the aggregate discovery list. A failed
 *  machine contributes zero mappings — its rows must never leak from stale
 *  or partial responses. */
export interface StaticMachineResult {
  machineId: string;
  machineName: string;
  mappings: StaticMapping[];
  failure: { status: number | null; message: string } | null;
}

export interface StaticAggregateEntry {
  machineId: string;
  machineName: string;
  mapping: StaticMapping;
}

function createdAtMs(mapping: StaticMapping): number | null {
  const ms = Date.parse(mapping.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/** Flatten per-machine results into one list, newest `createdAt` first.
 *  Ties break deterministically by machine id, then mapping id. */
export function aggregateStaticMappings(results: StaticMachineResult[]): StaticAggregateEntry[] {
  const entries: StaticAggregateEntry[] = [];
  for (const result of results) {
    if (result.failure) continue;
    // All-or-nothing per machine, matching load-time validation: one row the
    // browser cannot render invalidates the whole payload, so a malformed
    // response never leaks rows (or crashes rendering) via a caller that
    // skipped validation.
    if (!result.mappings.every(isStaticMapping)) continue;
    for (const mapping of result.mappings) {
      entries.push({ machineId: result.machineId, machineName: result.machineName, mapping });
    }
  }
  entries.sort((a, b) => {
    const aTime = createdAtMs(a.mapping);
    const bTime = createdAtMs(b.mapping);
    if (aTime !== bTime) {
      if (aTime === null) return 1;
      if (bTime === null) return -1;
      return bTime > aTime ? 1 : -1;
    }
    return a.machineId.localeCompare(b.machineId) || a.mapping.id.localeCompare(b.mapping.id);
  });
  return entries;
}
