import { ensureModelsHealthSnapshot } from "@/lib/models-health";

export const dynamic = "force-dynamic";

/**
 * Per-provider credential state + merged model counts (issue #139).
 *
 * Same permission model as `/api/models` (no extra gate). The body is
 * secret-free: provider ids, states, disable causes and account labels only.
 * The first request awaits the initial scan, so a fresh process answers with
 * real data instead of an empty snapshot.
 */
export async function GET() {
  const snapshot = await ensureModelsHealthSnapshot();
  if (!snapshot) {
    return Response.json({ error: "Model health scan is unavailable" }, { status: 503 });
  }
  return Response.json({
    scannedAt: snapshot.scannedAt,
    providers: snapshot.providers,
    availableModelCount: snapshot.availableModelCount,
    disabledModelCount: snapshot.disabledModelCount,
  });
}