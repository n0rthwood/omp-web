/**
 * Bounded registry of proxied streams the gateway currently holds open against
 * fleet machines.
 *
 * Bun caps concurrent `fetch` requests per process (`BUN_CONFIG_MAX_HTTP_REQUESTS`,
 * default 256) and queues the excess indefinitely. A proxied SSE subscription
 * whose upstream is never released therefore does not merely leak a socket — it
 * permanently consumes one of those slots, and once they are all consumed every
 * other `fetch` in the process (fleet health probes, provider API calls) stalls
 * forever. That is exactly what happened on the gateway (#84): 256 upstream SSE
 * streams, still receiving the remote's 30s heartbeat 36 hours after the browser
 * that opened them had gone.
 *
 * Releasing the upstream when the client cancels is the correct fix; this bound
 * is what makes the failure mode impossible rather than unlikely when the
 * runtime never reports the disconnect.
 *
 * State lives on `globalThis` for the same reason `rpc-manager.ts` does it:
 * Next.js re-evaluates modules, and a plain module-level Map would be silently
 * reset, losing track of streams that are still open.
 */

/** Hard ceiling on concurrently open proxied SSE streams per machine. A
 *  browser needs one stream per watched session/terminal; 24 leaves room for
 *  several tabs while keeping the worst case far below Bun's 256-request
 *  fetch cap, which this bound exists to protect. */
export const MAX_OPEN_STREAMS_PER_MACHINE = 24;

interface OpenStream {
  machineId: string;
  abort: () => void;
}

declare global {
  var __ompProxyStreams: Map<number, OpenStream> | undefined;
  var __ompProxyStreamSeq: number | undefined;
}

function streams(): Map<number, OpenStream> {
  globalThis.__ompProxyStreams ??= new Map<number, OpenStream>();
  return globalThis.__ompProxyStreams;
}

/**
 * Registers an open stream and returns its id. If the machine is over `limit`,
 * the oldest streams for that machine are aborted until it is not — insertion
 * order in the Map is open order.
 */
export function registerStream(
  machineId: string,
  abort: () => void,
  limit: number = MAX_OPEN_STREAMS_PER_MACHINE,
): number {
  const open = streams();

  if (limit > 0) {
    // Count first, then evict oldest-first, leaving room for the newcomer.
    let excess = openStreamCount(machineId) + 1 - limit;
    if (excess > 0) {
      for (const [id, entry] of open) {
        if (entry.machineId !== machineId) continue;
        // Delete before aborting: the victim's own `cancel` calls
        // `releaseStream(id)`, which must then be a harmless no-op.
        open.delete(id);
        try {
          entry.abort();
        } catch {
          // An abort that throws must not block the remaining evictions.
        }
        excess -= 1;
        if (excess <= 0) break;
      }
    }
  }

  const id = (globalThis.__ompProxyStreamSeq ?? 0) + 1;
  globalThis.__ompProxyStreamSeq = id;
  open.set(id, { machineId, abort });
  return id;
}

/** Idempotent: releasing an already-aborted id is a no-op. */
export function releaseStream(id: number): void {
  streams().delete(id);
}

/** Open stream count, for one machine or (machineId omitted) all. */
export function openStreamCount(machineId?: string): number {
  const open = streams();
  if (machineId === undefined) return open.size;
  let count = 0;
  for (const entry of open.values()) {
    if (entry.machineId === machineId) count += 1;
  }
  return count;
}
