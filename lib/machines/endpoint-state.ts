/**
 * Runtime failover/failback state for fleet machines with `fallbackUrls`.
 *
 * A `StoredMachine` is re-read from disk on every request (`machine-store.ts`
 * has no long-lived instances), so which endpoint is currently active and
 * when the primary was last probed can't live on it — this module keys that
 * state by machine id in a process-global map, the same pattern
 * `lib/rpc-manager.ts` uses for `__ompStartLocks`: state that must survive
 * across independently constructed request handlers within one process.
 */

/** No more than one lazy failback probe per machine per this window. */
export const FAILBACK_PROBE_INTERVAL_MS = 5 * 60 * 1000;

interface MachineEndpointState {
  /** The endpoint last known to work; `null` means "assume the primary" (index 0). */
  activeUrl: string | null;
  /** Epoch ms of the last attempt against the primary while not active on it; 0 = never. */
  lastPrimaryProbeAt: number;
  /** Guards against a second concurrent request also probing the primary. */
  probeInFlight: boolean;
  /** Last known reachability per endpoint URL; absent = never attempted. */
  health: Map<string, boolean>;
}

declare global {
  var __ompMachineEndpointState: Map<string, MachineEndpointState> | undefined;
}

function getStateMap(): Map<string, MachineEndpointState> {
  if (!globalThis.__ompMachineEndpointState) globalThis.__ompMachineEndpointState = new Map();
  return globalThis.__ompMachineEndpointState;
}

function getOrCreateState(machineId: string): MachineEndpointState {
  const map = getStateMap();
  let state = map.get(machineId);
  if (!state) {
    state = { activeUrl: null, lastPrimaryProbeAt: 0, probeInFlight: false, health: new Map() };
    map.set(machineId, state);
  }
  return state;
}

/** `endpoints[0]` is always the primary (`machine.baseUrl`). */
export function endpointsFor(baseUrl: string, fallbackUrls: string[] | undefined): string[] {
  return [baseUrl, ...(fallbackUrls ?? [])];
}

export interface EndpointHealth {
  url: string;
  /** `null` before any request has been attempted against this URL. */
  healthy: boolean | null;
}

/** The endpoint a fresh `SafeMachine` projection should report as active, plus
 *  per-endpoint health — read-only, never advances any state itself. */
export function describeEndpoints(
  machineId: string,
  baseUrl: string,
  fallbackUrls: string[] | undefined,
): { activeUrl: string; endpoints: EndpointHealth[] } {
  const endpoints = endpointsFor(baseUrl, fallbackUrls);
  const state = getOrCreateState(machineId);
  const index = state.activeUrl ? endpoints.indexOf(state.activeUrl) : -1;
  const activeUrl = index === -1 ? endpoints[0] : endpoints[index];
  return {
    activeUrl,
    endpoints: endpoints.map((url) => ({ url, healthy: state.health.get(url) ?? null })),
  };
}

export interface AttemptPlan {
  /** Endpoint URLs to try this request, in the order to try them. Excludes
   *  the primary entirely when the failback floor hasn't elapsed yet. */
  order: string[];
  /** Records that `url` answered (any HTTP status) and becomes the sticky active endpoint. */
  recordSuccess(url: string): void;
  /** Records that `url` failed at the transport level. */
  recordFailure(url: string): void;
  /** Releases a claimed probe slot. Must be called exactly once, on every path. */
  release(): void;
}

/**
 * Plans which endpoint(s) to try for one proxied request, and claims the
 * failback probe slot synchronously (before any `await`) so two requests
 * racing on the same event-loop tick can never both decide to probe the
 * primary — the second one always observes the first's claim.
 */
export function planAttempt(machineId: string, baseUrl: string, fallbackUrls: string[] | undefined): AttemptPlan {
  const endpoints = endpointsFor(baseUrl, fallbackUrls);
  const state = getOrCreateState(machineId);
  const now = Date.now();

  const currentIndex = state.activeUrl ? endpoints.indexOf(state.activeUrl) : -1;
  const effectiveIndex = currentIndex === -1 ? 0 : currentIndex;
  const onPrimary = effectiveIndex === 0;

  const canProbePrimary =
    onPrimary || (!state.probeInFlight && now - state.lastPrimaryProbeAt >= FAILBACK_PROBE_INTERVAL_MS);

  let claimedProbe = false;
  if (canProbePrimary) {
    state.lastPrimaryProbeAt = now;
    if (!onPrimary) {
      state.probeInFlight = true;
      claimedProbe = true;
    }
  }

  const order: string[] = [];
  if (canProbePrimary) order.push(endpoints[0]);
  if (!order.includes(endpoints[effectiveIndex])) order.push(endpoints[effectiveIndex]);
  for (const url of endpoints) {
    if (url === endpoints[0] && !canProbePrimary) continue; // excluded by the failback floor
    if (!order.includes(url)) order.push(url);
  }

  let released = false;
  return {
    order,
    recordSuccess(url) {
      state.health.set(url, true);
      state.activeUrl = url;
    },
    recordFailure(url) {
      state.health.set(url, false);
    },
    release() {
      if (released) return;
      released = true;
      if (claimedProbe) state.probeInFlight = false;
    },
  };
}

/** Drops runtime failover state for a deleted machine. */
export function clearEndpointState(machineId: string): void {
  getStateMap().delete(machineId);
}
