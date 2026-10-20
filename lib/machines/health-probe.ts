import { proxyToMachine } from "./remote-request";
import type { StoredMachine } from "./machine-store";
import type { MachineHealthReport } from "../machine-health";

/**
 * Server-side aggregate machine health probe behind
 * `GET /api/machines/health` (issue #82).
 *
 * Each remote machine is probed through the fleet proxy's own request path
 * (`proxyToMachine`) against its `/api/health`, so the probe inherits the
 * endpoint failover plan, the machine's own credential, and the 15s
 * connect bound — and its outcome feeds the endpoint-state failover map via
 * `plan.recordSuccess`/`plan.recordFailure` inside `proxyToMachine`, the
 * exact seam proxied traffic uses. No separate bookkeeping is needed here.
 *
 * Results are cached per machine id with a ~10s TTL, and concurrent callers
 * share one in-flight probe, so any number of browser tabs polling the
 * aggregate endpoint still costs at most one upstream request per machine
 * per TTL window.
 */

export const MACHINE_HEALTH_CACHE_TTL_MS = 10_000;

/** Matches the fleet probe deadline used elsewhere (`/api/machines/test`):
 *  the gateway's own verdict must always land before a client gives up. */
const PROBE_TIMEOUT_MS = 15_000;

/** Cap on the probe body read — same rationale as `/api/machines/test`: a
 *  hostile remote must not be able to OOM a process hosting live sessions. */
const BODY_READ_LIMIT = 16 * 1024;

export interface MachineHealthProbeDeps {
  now(): number;
  ttlMs: number;
  probeRemote(machine: StoredMachine): Promise<Response>;
}

export interface MachineHealthProbe {
  probe(machine: StoredMachine): Promise<MachineHealthReport>;
  clear(machineId?: string): void;
}

/**
 * The default upstream probe: one `GET /api/health` through the fleet request
 * path. The `Request` is a carrier for method/headers/timeout only —
 * `proxyToMachine` rebuilds the upstream URL from the machine's own
 * endpoints. Exported so tests can wrap it (call counting) while still
 * exercising the real proxy path.
 */
export function probeRemoteViaProxy(machine: StoredMachine): Promise<Response> {
  const request = new Request("http://omp-web-internal/api/health", {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return proxyToMachine(machine, request, "/api/health", "");
}

async function readCappedJson(upstream: Response): Promise<Record<string, unknown>> {
  let text = "";
  if (upstream.body) {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let read = 0;
    try {
      while (read < BODY_READ_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    text = text.slice(0, BODY_READ_LIMIT);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function classifyResponse(machineId: string, upstream: Response): Promise<MachineHealthReport> {
  const body = await readCappedJson(upstream);
  const reason = typeof body.error === "string" ? body.error : undefined;
  if (upstream.status === 401 || upstream.status === 403) {
    return { id: machineId, state: "unauthorized", reason: reason ?? "The configured credential was rejected." };
  }
  if (upstream.ok && body.ok === true) return { id: machineId, state: "online" };
  return { id: machineId, state: "offline", reason: reason ?? `HTTP ${upstream.status}` };
}

interface CacheEntry {
  /** The last settled verdict, fresh until `expiresAt`. */
  settled?: { report: MachineHealthReport; expiresAt: number };
  /** The probe started for the current refresh, shared by concurrent callers. */
  inflight?: Promise<MachineHealthReport>;
}

/**
 * Builds a probe over its own cache map. `deps` exists for tests (fake clock,
 * short TTL, wrapped upstream); production uses `getSharedMachineHealthProbe`
 * so the TTL cache and coalescing survive Next.js module re-evaluation.
 */
export function createMachineHealthProbe(
  deps: Partial<MachineHealthProbeDeps> = {},
  store: Map<string, CacheEntry> = new Map(),
): MachineHealthProbe {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? MACHINE_HEALTH_CACHE_TTL_MS;
  const probeRemote = deps.probeRemote ?? probeRemoteViaProxy;

  return {
    async probe(machine) {
      const entry = store.get(machine.id);
      if (entry?.settled && entry.settled.expiresAt > now()) return entry.settled.report;
      if (entry?.inflight) return entry.inflight;

      const inflight = probeRemote(machine)
        .then(
          (upstream) => classifyResponse(machine.id, upstream),
          () => ({ id: machine.id, state: "offline" as const, reason: "Connection timed out." }),
        )
        .then((report) => {
          store.set(machine.id, { settled: { report, expiresAt: now() + ttlMs } });
          return report;
        });
      store.set(machine.id, { inflight });
      return inflight;
    },
    clear(machineId) {
      if (machineId === undefined) store.clear();
      else store.delete(machineId);
    },
  };
}

declare global {
  var __ompMachineHealthProbe: MachineHealthProbe | undefined;
}

/** The process-wide probe used by `GET /api/machines/health`. */
export function getSharedMachineHealthProbe(): MachineHealthProbe {
  if (!globalThis.__ompMachineHealthProbe) {
    globalThis.__ompMachineHealthProbe = createMachineHealthProbe();
  }
  return globalThis.__ompMachineHealthProbe;
}
