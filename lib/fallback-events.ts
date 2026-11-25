/**
 * #138: cross-model retry fallback visibility.
 *
 * When a turn hits a hard model error the SDK walks `retry.fallbackChains` and
 * emits `retry_fallback_applied` (with the selector it left, the selector it
 * switched to, the role and the reason) followed by `retry_fallback_succeeded`
 * once the fallback model answers. The web hook keeps the banner state in this
 * pure module so selector parsing and the run-id guard are unit tested without
 * a DOM or a live session.
 *
 * Run-id guard: the frames arrive over the SSE stream, which can be flushed
 * late (frozen tab, reconnect replay). A frame that belongs to a settled run
 * must never resurrect — or upgrade — the banner of the run in flight, so every
 * transition carries the `promptRunIdRef` value of the run that applied it.
 */

/** Role the SDK records for an ephemeral (retry) model change. */
export const FALLBACK_MODEL_ROLE = "fallback";

export interface FallbackBanner {
  /** Selector the turn started on; "" when the applied frame was missed. */
  from: string;
  /** Selector the turn is running on now. */
  to: string;
  /** Role the fallback was resolved for ("fallback", "advisor", …). */
  role: string;
  /** Why the fallback happened, when the SDK reported a reason. */
  reason?: string;
  /** `retry_fallback_succeeded` arrived: the fallback model answered. */
  succeeded: boolean;
  /** `promptRunIdRef` of the run that applied the fallback. */
  runId: number;
}

type FallbackEvent = {
  type?: unknown;
  from?: unknown;
  to?: unknown;
  model?: unknown;
  role?: unknown;
  reason?: unknown;
};

/** `"provider/model"` → pair; null for anything without both halves. */
export function parseModelSelector(selector: string): { provider: string; modelId: string } | null {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return null;
  return { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
}

/** Trimmed string field, "" when absent — 4 call sites, one contract. */
function readSelector(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `retry_fallback_applied` → the banner to show, or null when the frame
 * carries no target selector (nothing to report).
 */
export function fallbackApplied(event: FallbackEvent, runId: number): FallbackBanner | null {
  const to = readSelector(event.to);
  if (!to) return null;
  return {
    from: readSelector(event.from),
    to,
    role: readSelector(event.role) || "default",
    reason: readSelector(event.reason) || undefined,
    succeeded: false,
    runId,
  };
}

/**
 * `retry_fallback_succeeded` → the banner to show. A frame from another run is
 * dropped (the current banner is returned unchanged); with no banner in flight
 * the frame still reports the model that answered, so a fallback applied
 * before the stream connected stays visible.
 */
export function fallbackSucceeded(
  event: FallbackEvent,
  current: FallbackBanner | null,
  runId: number,
): FallbackBanner | null {
  const model = readSelector(event.model);
  const role = readSelector(event.role) || "default";
  if (current) {
    if (current.runId !== runId) return current;
    return { ...current, to: model || current.to, role, succeeded: true };
  }
  if (!model) return null;
  return { from: "", to: model, role, succeeded: true, runId };
}