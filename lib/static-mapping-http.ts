import {
  STATIC_MAPPING_LIFECYCLES,
  type StaticMappingCreateInput,
  type StaticMappingPatchInput,
} from "./static-mappings";
import { StaticMappingError } from "./static-mapping-store";

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "string") throw new StaticMappingError(`${key} must be a string`, 400, key);
  return value;
}
function optionalNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value !== null && typeof value !== "string") {
    throw new StaticMappingError(`${key} must be a string or null`, 400, key);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "number") throw new StaticMappingError(`${key} must be a number`, 400, key);
  return value;
}
function optionalNullableNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value !== null && typeof value !== "number") {
    throw new StaticMappingError(`${key} must be a number or null`, 400, key);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== "boolean") throw new StaticMappingError(`${key} must be a boolean`, 400, key);
  return value;
}

function optionalLifecycle(body: Record<string, unknown>): "persistent" | "temporary" | undefined {
  if (!("lifecycle" in body)) return undefined;
  const value = body.lifecycle;
  if (typeof value !== "string" || !STATIC_MAPPING_LIFECYCLES.includes(value as "persistent" | "temporary")) {
    throw new StaticMappingError("lifecycle must be persistent or temporary", 400, "lifecycle");
  }
  return value as "persistent" | "temporary";
}

export function parseStaticMappingCreateInput(body: Record<string, unknown>): StaticMappingCreateInput {
  const expiresAt = optionalString(body, "expiresAt");
  return {
    id: optionalString(body, "id"),
    label: optionalString(body, "label"),
    lifecycle: optionalLifecycle(body),
    persistent: optionalBoolean(body, "persistent"),
    ttlSeconds: optionalNumber(body, "ttlSeconds"),
    expiresAt,
    sessionId: optionalNullableString(body, "sessionId"),
    entryFile: optionalString(body, "entryFile"),
  };
}

export function parseStaticMappingPatchInput(body: Record<string, unknown>): StaticMappingPatchInput {
  let expiresAt: string | null | undefined;
  if ("expiresAt" in body) {
    const value = body.expiresAt;
    if (value !== null && typeof value !== "string") {
      throw new StaticMappingError("expiresAt must be an ISO date or null", 400, "expiresAt");
    }
    expiresAt = value as string | null;
  }
  return {
    label: optionalString(body, "label"),
    lifecycle: optionalLifecycle(body),
    persistent: optionalBoolean(body, "persistent"),
    ttlSeconds: optionalNullableNumber(body, "ttlSeconds"),
    expiresAt,
    entryFile: optionalString(body, "entryFile"),
  };
}
