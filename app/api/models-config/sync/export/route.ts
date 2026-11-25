import { NextResponse } from "next/server";
import { exportDeclarationLayer, defaultSyncDeps } from "@/lib/models-config-sync";
import { requireAdminApi } from "../../../web-users/_guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/models-config/sync/export
 *
 * The declaration layer only — models.yml provider blocks (OAuth subscription
 * providers withheld) plus config.yml roles / allow-list / fallback chains.
 * No credential value is ever read: `apiKey` fields are bare env-var names.
 */
export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  try {
    const deps = await defaultSyncDeps();
    return NextResponse.json(exportDeclarationLayer(deps), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export the declaration layer";
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 500 });
  }
}