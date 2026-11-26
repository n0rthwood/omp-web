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
 * Bailian Token Plan (issue #150) is the second entry: its consumed quota only
 * exists behind the Alibaba console gateway, whose access token expires and is
 * renewed from OpenAPI AK/SK by the `bl` CLI itself, so the probe shells out to
 * the local `bl` instead of re-implementing that exchange. A host without `bl`
 * delegates to the SDK's own console-cookie probe and keeps today's behaviour.
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { zaiUsageProvider } from "@oh-my-pi/pi-ai";
import { alibabaTokenPlanUsageProvider } from "@oh-my-pi/pi-ai/usage/alibaba-token-plan";
import { usageStatus } from "@oh-my-pi/pi-ai/usage/shared";
import type { UsageLimit, UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";

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

// ── Bailian Token Plan via the local `bl` CLI (issue #150) ──────────────────

/** Provider id the catalog, the strip and the fleet's env key use for Bailian Token Plan. */
export const BAILIAN_TOKEN_PLAN_PROVIDER = "alibaba-token-plan";

const BL_TIMEOUT_MS = 15_000;
/** Bounded stdout: the payload is a handful of numbers, never a stream. */
const BL_STDOUT_LIMIT = 64 * 1024;

/** One `bl` invocation's outcome; injected in tests so no subprocess runs. */
export interface BlRunResult {
  ok: boolean;
  stdout: string;
}

export type BlRunner = () => Promise<BlRunResult>;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `bl` lives in a user npm prefix on this fleet, and a service's PATH does not
 * include it — resolve the binary explicitly rather than relying on `bl`.
 */
export function resolveBlBinary(): string | undefined {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.OMP_WEB_BL_BIN,
    home ? join(home, ".npm-global/bin/bl") : undefined,
    "/usr/local/bin/bl",
    "/usr/bin/bl",
    home ? join(home, ".local/bin/bl") : undefined,
  ];
  return candidates.find((candidate) => candidate && isExecutable(candidate));
}

/** Default runner: `bl usage token-plan --output json`, attributed as a script caller. */
const runBlTokenPlan: BlRunner = async () => {
  const binary = resolveBlBinary();
  if (!binary) return { ok: false, stdout: "" };
  const { promise, resolve } = Promise.withResolvers<BlRunResult>();
  execFile(
    binary,
    ["usage", "token-plan", "--output", "json"],
    {
      timeout: BL_TIMEOUT_MS,
      maxBuffer: BL_STDOUT_LIMIT,
      killSignal: "SIGKILL",
      // Minimal environment: the Bailian skill protocol's attribution for a
      // reusable (non-interactive) caller, plus what the CLI needs to find
      // its own config. Never inherit the web tier's full env.
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NO_COLOR: "1",
        BAILIAN_CALLER_TYPE: "script",
        BAILIAN_CALLER_NAME: "omp-web",
      },
    },
    (error, stdout) => resolve({ ok: error === null, stdout: typeof stdout === "string" ? stdout : "" }),
  );
  return promise;
};

/**
 * Every brace-balanced JSON object in `text`.
 *
 * `bl --output json` pretty-prints the quota object across lines and then
 * appends a second value (an update `{"warning":…}` notice), so neither
 * `JSON.parse(stdout)` nor a line-by-line parse works.
 */
export function parseJsonObjects(text: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            values.push(parsed as Record<string, unknown>);
          }
        } catch {
          // Not JSON after all (a log line with braces); keep scanning.
        }
        start = -1;
      }
    }
  }
  return values;
}

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_UNITS: Record<string, { suffix: string; hours: number }> = {
  Hour: { suffix: "h", hours: 1 },
  Day: { suffix: "d", hours: 24 },
  Week: { suffix: "w", hours: 24 * 7 },
  Month: { suffix: "mo", hours: 24 * 30 },
};
/** `bl`'s own field shape: per5HourPercentage / per1MonthResetTime, … */
const WINDOW_FIELD = /^per(\d+)(Hour|Day|Week|Month)Percentage$/;

/** `Monthly quota` / `5-hour quota`, mirroring how `bl` itself names the windows. */
function windowLabel(count: number, unit: string): string {
  const name = count === 1 && unit === "Month" ? "Monthly" : `${count}-${unit.toLowerCase()}`;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} quota`;
}

/**
 * Map `bl`'s flat quota payload to usage limits.
 *
 * The percentages are FRACTIONS (`1` means the plan is exhausted, which `bl`
 * renders as "100% used") — never treat them as 0-100.
 */
export function bailianLimitsFromPayload(payload: Record<string, unknown>, provider: string): UsageLimit[] {
  if (payload.hasQuotaData !== true) return [];
  const limits: Array<{ durationMs: number; limit: UsageLimit }> = [];
  for (const [key, rawValue] of Object.entries(payload)) {
    const match = WINDOW_FIELD.exec(key);
    const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : undefined;
    if (!match || value === undefined) continue;
    const count = Number(match[1]);
    const unit = WINDOW_UNITS[match[2]];
    if (!Number.isFinite(count) || count <= 0 || !unit) continue;
    const usedFraction = Math.min(Math.max(value, 0), 1);
    const durationMs = count * unit.hours * HOUR_MS;
    const rawReset = payload[`per${match[1]}${match[2]}ResetTime`];
    const resetsAt = typeof rawReset === "number" && Number.isFinite(rawReset) && rawReset > 0 ? rawReset : undefined;
    const id = `${count}${unit.suffix}`;
    const label = windowLabel(count, match[2]);
    limits.push({
      durationMs,
      limit: {
        id: `credits:${id}`,
        label,
        scope: { provider, windowId: id },
        window: { id, label, durationMs, ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}) },
        amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
        status: usageStatus(usedFraction),
      },
    });
  }
  return limits.sort((a, b) => a.durationMs - b.durationMs).map((entry) => entry.limit);
}

/**
 * Bailian Token Plan consumed quota, read from the local `bl` CLI.
 *
 * `bl` owns the console-gateway call AND the token renewal (it re-mints an
 * expired console token from OpenAPI AK/SK), so this probe stays a thin
 * reader. Anything that prevents a real answer — no binary, a failed run,
 * unparsable output, an account with no Token Plan — delegates to the SDK's
 * console-cookie probe, which is exactly the behaviour a host had before.
 */
export function createBailianTokenPlanUsageProvider(
  options: { run?: BlRunner; fallback?: UsageProvider } = {},
): UsageProvider {
  const run = options.run ?? runBlTokenPlan;
  const fallback = options.fallback ?? alibabaTokenPlanUsageProvider;
  return {
    id: BAILIAN_TOKEN_PLAN_PROVIDER,
    // The quota is account-scoped and read fresh from the CLI; a stale replay
    // would outlive the console session it came from.
    retainLastGoodOnFailure: false,
    supports: (params) => params.provider === BAILIAN_TOKEN_PLAN_PROVIDER,
    async fetchUsage(params, ctx) {
      const limits = await blTokenPlanLimits(run, params.provider);
      if (limits.length > 0) return { provider: params.provider, fetchedAt: Date.now(), limits };
      return fallback.fetchUsage(params, ctx);
    },
  };
}

async function blTokenPlanLimits(run: BlRunner, provider: string): Promise<UsageLimit[]> {
  let result: BlRunResult;
  try {
    result = await run();
  } catch {
    return [];
  }
  if (!result.ok || !result.stdout) return [];
  // `bl` also prints an update-notice object; the quota one is the payload
  // that carries `hasQuotaData`.
  const payload = parseJsonObjects(result.stdout).find((value) => "hasQuotaData" in value);
  return payload ? bailianLimitsFromPayload(payload, provider) : [];
}

export const bailianTokenPlanUsageProvider = createBailianTokenPlanUsageProvider();

/** Registry of runtime usage-provider overrides, keyed by provider id. */
export const USAGE_PROVIDER_OVERRIDES: Readonly<Record<string, UsageProvider>> = {
  [ZHIPU_PROVIDER]: zhipuCodingPlanUsageProvider,
  [BAILIAN_TOKEN_PLAN_PROVIDER]: bailianTokenPlanUsageProvider,
};

/** Install every registry entry on a runtime's auth storage (idempotent). */
export function installUsageProviderOverrides(authStorage: AuthStorage): void {
  for (const [provider, usageProvider] of Object.entries(USAGE_PROVIDER_OVERRIDES)) {
    authStorage.usage.setProvider(provider, followsInferenceCredential(usageProvider, authStorage.keys));
  }
}