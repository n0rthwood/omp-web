import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { grantedMachineIds } from "@/lib/machines/machine-grants";
import { LOCAL_MACHINE_ID, getMachine } from "@/lib/machines/machine-store";
import { getSharedMachineHealthProbe } from "@/lib/machines/health-probe";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { jsonError } from "../../web-users/_guard";
import type { MachineHealthReport } from "@/lib/machine-health";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/machines/health — one aggregated per-machine status for exactly
// the machines the caller could see on GET /api/machines (same grant logic;
// local always included, local is always online without a probe). Remotes are
// probed server-side through the fleet request path with a ~10s TTL cache, so
// polling switchers across tabs stay cheap. Local-only surface: never routed
// through apiPath(), never proxied (proxy-allowlist denies /api/machines/**).
//
// Route precedence note: this static `health` segment wins over the dynamic
// `[machineId]` route, same as the existing `/api/machines/test` — a machine
// literally named "health" (or "test") is therefore not addressable for
// PATCH/DELETE; machine ids like that are pathological and left unreserved.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return jsonError(403, "Untrusted API request");
  const user = await getWebUserOrSynthetic(req);
  if (!user) return jsonError(401, "Authentication required");

  const probe = getSharedMachineHealthProbe();
  const machines: MachineHealthReport[] = await Promise.all(
    grantedMachineIds(user).map(async (id): Promise<MachineHealthReport> => {
      if (id === LOCAL_MACHINE_ID) return { id, state: "online" };
      const stored = getMachine(id);
      // Granted ids are pruned against the live registry; a miss here means
      // the machine was deleted between pruning and probing.
      if (!stored) return { id, state: "offline", reason: "Machine was removed from the fleet" };
      return probe.probe(stored);
    }),
  );
  return NextResponse.json({ machines }, { headers: NO_STORE });
}
