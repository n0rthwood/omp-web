import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { diffProviderModels, type ModelSnapshot } from "@/lib/models-config-diff";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { hasJsonContentType } from "@/lib/request-security";
import { requireAdminApi } from "../../web-users/_guard";

export const dynamic = "force-dynamic";

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
  const providerName = typeof body === "object" && body !== null && !Array.isArray(body)
    && typeof (body as Record<string, unknown>).providerName === "string"
    ? ((body as Record<string, string>).providerName).trim()
    : "";
  if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });

  try {
    const { modelRegistry } = await getOmpRuntime();
    if (!modelRegistry.hasProvider(providerName)) {
      return NextResponse.json({ error: `Unknown provider: ${providerName}` }, { status: 404 });
    }

    // Snapshot before the refresh: the registry is mutated in place, so this is
    // the only chance to see what the provider looked like beforehand.
    const before: ModelSnapshot[] = modelRegistry.getProviderModels(providerName).map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: model.input,
      reasoning: model.reasoning,
      cost: model.cost,
    }));

    // Refresh the shared registry in place: existing sessions hold this exact
    // instance. A refresh may mutate it even when discovery or config fails.
    try {
      await modelRegistry.refreshProvider(providerName, "online", { refreshCommandCredentials: true });
    } finally {
      invalidateModelsCache();
    }

    const after: ModelSnapshot[] = modelRegistry.getProviderModels(providerName).map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: model.input,
      reasoning: model.reasoning,
      cost: model.cost,
    }));
    const diff = diffProviderModels(before, after);

    const configError = modelRegistry.getError();
    if (configError) {
      return NextResponse.json({ error: (configError.message || "Invalid model configuration").slice(0, 500) }, { status: 502 });
    }

    // The SDK records many discovery failures instead of rejecting. Cached
    // fallback can also contain an error, or be stale without an error string.
    const discovery = modelRegistry.getProviderDiscoveryState(providerName);
    if (discovery?.error || discovery?.status === "unavailable" || discovery?.status === "unauthenticated"
      || discovery?.status === "idle" || discovery?.status === "cached" || discovery?.stale) {
      const message = discovery.error || `Provider discovery ${discovery.status}; a fresh model list is unavailable`;
      return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 });
    }

    if (discovery?.status === "empty") {
      return NextResponse.json({ success: true, discoveryStatus: "empty", warning: "Provider returned no models", diff });
    }
    if (!discovery) {
      return NextResponse.json({
        success: true,
        warning: "Provider configuration was reloaded, but no online discovery status was reported",
        diff,
      });
    }
    return NextResponse.json({ success: true, discoveryStatus: discovery.status, diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model refresh failed";
    return NextResponse.json({ error: message.slice(0, 500) || "Model refresh failed" }, { status: 502 });
  }
}