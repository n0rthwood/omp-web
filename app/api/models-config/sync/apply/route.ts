import { NextResponse } from "next/server";
import {
  applyDeclarationLayer,
  defaultSyncDeps,
  parseSyncRequest,
  SyncValidationError,
} from "@/lib/models-config-sync";
import { hasJsonContentType } from "@/lib/request-security";
import { requireAdminApi } from "../../../web-users/_guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/models-config/sync/apply
 *
 * body: an export payload + `{ sections, dryRun?, prune? }`.
 *
 * Idempotent merge: provider blocks replace same-id entries (remote-only
 * providers survive unless `prune`), roles / allow-list / fallback chains are
 * replaced wholesale. Writes are backed up to `.bak.sync-<ts>` and land
 * atomically; `dryRun` returns the diff and preflight warnings without
 * touching the disk.
 */
export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  let request;
  try {
    request = parseSyncRequest({
      payload: input.payload,
      sections: input.sections,
      dryRun: input.dryRun,
      prune: input.prune,
    });
  } catch (error) {
    if (error instanceof SyncValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const deps = await defaultSyncDeps();
    return NextResponse.json(applyDeclarationLayer(request, deps), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SyncValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unable to apply the declaration layer";
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 500 });
  }
}