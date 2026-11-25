import { NextResponse } from "next/server";
import { exportDeclarationLayer, defaultSyncDeps, SYNC_SCHEMA_VERSION, type SyncExportPayload } from "@/lib/models-config-sync";
import { getMachine } from "@/lib/machines/machine-store";
import { isProxyablePath, proxyToMachine } from "@/lib/machines/remote-request";
import { hasJsonContentType } from "@/lib/request-security";
import { jsonError, readJsonBody, requireAdminApi } from "../../web-users/_guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/fleet/config-sync  body: { targets: machineId[], sections, dryRun?, prune? }
 *
 * Gateway-side orchestration for the declaration-layer sync: export locally,
 * then apply on each target through the fleet proxy. Targets are processed
 * serially and one failure never blocks the rest. `/api/fleet/*` is not in the
 * proxy allow-list, so this route can never be proxied onward (no recursion).
 */

/** Cap on any upstream body this route reads — a hostile remote must not OOM us. */
const BODY_READ_LIMIT = 256 * 1024;
/** The remote route every target applies the exported payload through. */
const APPLY_PATH = "/api/models-config/sync/apply";

interface TargetResult {
  machineId: string;
  machineName: string;
  status: "applied" | "skipped" | "failed";
  detail: string;
  changed?: boolean;
  warnings?: string[];
  backupPaths?: string[];
}

async function readCappedText(upstream: Response): Promise<string> {
  if (!upstream.body) return "";
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
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
  return text.slice(0, BODY_READ_LIMIT);
}

function describeFailure(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error.slice(0, 300);
    }
  } catch {
    // fall through to the status line
  }
  return `HTTP ${status}`;
}

export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) return jsonError(415, "Content-Type must be application/json");

  const body = await readJsonBody(req);
  if (!body) return jsonError(400, "Invalid JSON body");

  const { targets, sections, dryRun, prune } = body;
  if (!Array.isArray(targets) || targets.some((id) => typeof id !== "string" || id.length === 0)) {
    return jsonError(400, "targets must be an array of machine ids");
  }
  if (!Array.isArray(sections) || sections.length === 0
    || sections.some((section) => typeof section !== "string")) {
    return jsonError(400, "sections must be a non-empty array");
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") return jsonError(400, "dryRun must be a boolean");
  if (prune !== undefined && typeof prune !== "boolean") return jsonError(400, "prune must be a boolean");

  const machineIds = [...new Set(targets as string[])];
  const requestedSections = [...new Set(sections as string[])];
  const isDryRun = dryRun === true;

  let payload: SyncExportPayload;
  try {
    payload = exportDeclarationLayer(await defaultSyncDeps());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export the local declaration layer";
    return jsonError(500, message.slice(0, 300));
  }

  const results: TargetResult[] = [];
  for (const machineId of machineIds) {
    if (machineId === "local") {
      results.push({ machineId, machineName: "This machine", status: "skipped", detail: "Source machine is not a sync target" });
      continue;
    }
    const machine = getMachine(machineId);
    if (!machine) {
      results.push({ machineId, machineName: machineId, status: "failed", detail: "Unknown machine" });
      continue;
    }
    const machineName = machine.name;
    // The allow-list is the same gate the fleet proxy catch-all applies; a
    // route missing from it must fail loudly here rather than be re-requested.
    if (!isProxyablePath("POST", APPLY_PATH)) {
      results.push({ machineId, machineName, status: "failed", detail: "Route is not proxyable" });
      continue;
    }

    const applyBody = JSON.stringify({ payload, sections: requestedSections, dryRun: isDryRun, prune: prune === true });
    const outbound = new Request("http://fleet.local/api/models-config/sync/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: applyBody,
    });

    // proxyToMachine owns endpoint failover, static header auth and the
    // connect deadline; an unreachable target answers 502 rather than throwing.
    const upstream = await proxyToMachine(machine, outbound, APPLY_PATH, "");
    const text = await readCappedText(upstream);
    if (!upstream.ok) {
      // proxyToMachine reports an unreachable target as 502 {code}.
      let code: string | undefined;
      try {
        const parsedError: unknown = JSON.parse(text);
        if (parsedError !== null && typeof parsedError === "object" && "code" in parsedError
          && typeof parsedError.code === "string") code = parsedError.code;
      } catch {
        // non-JSON error body: fall back to the status line
      }
      results.push({
        machineId,
        machineName,
        status: "failed",
        detail: code === "machine_unreachable" ? "Machine unreachable" : describeFailure(upstream.status, text),
      });
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      parsed = value as Record<string, unknown>;
    } catch {
      results.push({ machineId, machineName, status: "failed", detail: "Malformed response from target" });
      continue;
    }
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((entry): entry is string => typeof entry === "string")
      : [];
    const backupPaths = Array.isArray(parsed.backupPaths)
      ? parsed.backupPaths.filter((entry): entry is string => typeof entry === "string")
      : [];
    const changed = parsed.changed === true;
    results.push({
      machineId,
      machineName,
      status: isDryRun ? "skipped" : changed ? "applied" : "skipped",
      detail: isDryRun
        ? changed ? "Dry run: changes pending" : "Dry run: already in sync"
        : changed ? "Applied" : "Already in sync",
      changed,
      warnings,
      backupPaths,
    });
  }

  return NextResponse.json(
    {
      schemaVersion: SYNC_SCHEMA_VERSION,
      dryRun: isDryRun,
      sourceMachine: payload.sourceMachine,
      sections: requestedSections,
      excludedOAuthProviders: payload.excludedOAuthProviders,
      results,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}