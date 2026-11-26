/**
 * Runtime usage-provider registry (issue #148).
 *
 * The SDK resolves a usage probe per provider id (`defaultUsageProvider()` maps
 * `zai`, `anthropic`, … only), so a provider that speaks a supported upstream
 * under a different id — `zhipu-coding-plan` vs the SDK's `zai` — would stay
 * presence-only in the status strip. `authStorage.usage.setProvider()` is the
 * sanctioned seam: runtime overrides are consulted before the built-in
 * resolver, survive store swaps (`adoptRuntimeProviders`) and are picked up by
 * every consumer of the shared runtime (status poller, health scan).
 *
 * Adding a provider = one entry here plus its adapter. No poller, strip or
 * route change is needed: a provider with reports + windows already renders
 * through the generic branch in lib/provider-status.ts.
 *
 * A usage probe must also follow the credential inference would actually use:
 * when a shadowing source (models.yml `apiKey` pin / runtime override / config
 * fallback) owns the provider, stored rows are unreachable for inference and a
 * probe of them reports another account's quota or nothing; non-shadowing
 * sources (login rows, OAuth, env) keep the SDK's per-credential behaviour so
 * key pools are still probed key by key. `followsInferenceCredential` adds that
 * semantic to every registry entry, so a future adapter inherits it.
 *
 * Future adapter: Bailian Token Plan consumed quota lives behind the console
 * gateway (`/tokenplan/personal/api/v2/usage`) and needs a console-cookie
 * credential the fleet does not have — see .gh-issue/zhipu-usage-strip.md.
 */

import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { zaiUsageProvider } from "@oh-my-pi/pi-ai";
import type { UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";

/** Provider id the strip and models.yml use for the domestic GLM Coding Plan. */
export const ZHIPU_PROVIDER = "zhipu-coding-plan";

/** Domestic GLM Coding Plan origin; the SDK only defaults to the international api.z.ai. */
export const ZHIPU_USAGE_BASE_URL = "https://open.bigmodel.cn";

/** The SDK's ZAI probe, which owns the monitor endpoint, payload parsing and caching. */
const ZAI_PROVIDER = "zai";

function zaiParams(params: UsageFetchParams): UsageFetchParams {
  // models.yml carries the coding-plan base URL (…/api/coding/paas/v4); the SDK
  // keeps only the origin, so it passes through untouched. Absent/blank falls
  // back to the domestic origin instead of the SDK's international default.
  const baseUrl = params.baseUrl?.trim() ? params.baseUrl : ZHIPU_USAGE_BASE_URL;
  return { ...params, provider: ZAI_PROVIDER, baseUrl };
}

/** Re-attribute an SDK report (and its limit scopes) to the configured provider id. */
function reattribute(report: UsageReport, provider: string): UsageReport {
  return {
    ...report,
    provider,
    limits: report.limits.map((limit) => ({
      ...limit,
      scope: { ...limit.scope, provider },
    })),
  };
}

/**
 * GLM Coding Plan quota (5h / weekly tokens, monthly requests) for
 * `zhipu-coding-plan`. Delegates to the SDK's ZAI probe, which already parses
 * the domestic `unit` codes and the raw-key `Authorization` header.
 */
export const zhipuCodingPlanUsageProvider: UsageProvider = {
  id: ZHIPU_PROVIDER,
  cacheVersion: zaiUsageProvider.cacheVersion,
  async fetchUsage(params, ctx) {
    const report = await zaiUsageProvider.fetchUsage(zaiParams(params), ctx);
    return report ? reattribute(report, params.provider) : null;
  },
  supports: (params) =>
    params.provider === ZHIPU_PROVIDER &&
    (zaiUsageProvider.supports?.(zaiParams(params)) ?? false),
};

/**
 * The slice of `authStorage.keys` the inference-following wrapper needs.
 * Structural so the wrapper stays testable without a real AuthStorage.
 */
export interface InferenceKeySource {
  source(provider: string): { kind: string } | undefined;
  peek(provider: string): Promise<string | undefined>;
}

/** Source kinds that sit above stored login/OAuth rows in inference precedence. */
const SHADOWING_SOURCE_KINDS: Record<string, true> = { config: true, runtime: true };

/**
 * Wrap a probe so it follows the credential inference would use.
 *
 * `supports`/`id`/`cacheVersion` pass through untouched: the SDK evaluates
 * `supports` on the original params before `fetchUsage` runs, so only the
 * credential is substituted here.
 */
export function followsInferenceCredential(probe: UsageProvider, keys: InferenceKeySource): UsageProvider {
  return {
    ...probe,
    async fetchUsage(params, ctx) {
      const kind = keys.source(params.provider)?.kind;
      if (kind !== undefined && SHADOWING_SOURCE_KINDS[kind]) {
        const apiKey = await keys.peek(params.provider);
        // No resolvable inference key: keep the original credential rather than
        // sending an empty Authorization header.
        if (apiKey) params = { ...params, credential: { type: "api_key", apiKey } };
      }
      return probe.fetchUsage(params, ctx);
    },
  };
}

/** Registry of runtime usage-provider overrides, keyed by provider id. */
export const USAGE_PROVIDER_OVERRIDES: Readonly<Record<string, UsageProvider>> = {
  [ZHIPU_PROVIDER]: zhipuCodingPlanUsageProvider,
};

/** Install every registry entry on a runtime's auth storage (idempotent). */
export function installUsageProviderOverrides(authStorage: AuthStorage): void {
  for (const [provider, usageProvider] of Object.entries(USAGE_PROVIDER_OVERRIDES)) {
    authStorage.usage.setProvider(provider, followsInferenceCredential(usageProvider, authStorage.keys));
  }
}