import { ensureModelsHealthSnapshot } from "@/lib/models-health";
import { getProviderStatusSnapshot, stampKeepaliveTime } from "@/lib/provider-status";

export const dynamic = "force-dynamic";

/**
 * Per-provider credential state + merged model counts (issue #139).
 *
 * Same permission model as `/api/models` (no extra gate). The body is
 * secret-free: provider ids, states, disable causes and account labels only.
 * The first request awaits the initial scan, so a fresh process answers with
 * real data instead of an empty snapshot.
 *
 * A live credential's "last refresh" (issue #145) is stamped here from the
 * provider-status poller's cached snapshot: the health scan never probes
 * upstream, so it cannot know, while that poller's usage probe is the
 * keepalive that rotates an OAuth token when due.
 */
export async function GET() {
  const snapshot = await ensureModelsHealthSnapshot();
  if (!snapshot) {
    return Response.json({ error: "Model health scan is unavailable" }, { status: 503 });
  }
  const keepalive = new Map(getProviderStatusSnapshot().providers.map((entry) => [entry.id, entry.refreshedAt]));
  return Response.json({
    scannedAt: snapshot.scannedAt,
    providers: stampKeepaliveTime(snapshot.providers, keepalive),
    availableModelCount: snapshot.availableModelCount,
    disabledModelCount: snapshot.disabledModelCount,
  });
}
