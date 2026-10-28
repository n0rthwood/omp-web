import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonStatus } from "./api-types";

const DEFAULT_PORT = 8799;
const HEALTH_TIMEOUT_MS = 2_000;
const RUN_TIMEOUT_MS = 5_000;

export interface RestartServiceConfig {
  token: string | null;
  port: number;
}

export interface RestartServiceAvailability {
  available: boolean;
  reason?: string;
  status?: DaemonStatus;
}

type DaemonResponse =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

export type RestartRunResult =
  | { kind: "started"; body: JsonObject }
  | { kind: "in-progress"; status: DaemonStatus | null }
  | { kind: "rejected-token" }
  | { kind: "unavailable"; reason: string }
  | { kind: "daemon-error"; status: number };

/** Parse the daemon env file without interpreting shell syntax. */
export function parseRestartServiceEnv(content: string): RestartServiceConfig {
  let token: string | null = null;
  let port = DEFAULT_PORT;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"')) value = value.slice(1);
    if (value.endsWith('"')) value = value.slice(0, -1);
    if (key === "RESTART_SERVICE_TOKEN") {
      token = value || null;
      continue;
    }
    if (key === "RESTART_SERVICE_PORT") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) port = parsed;
    }
  }

  return { token, port };
}

/** Read per request so a rotated daemon token takes effect immediately. */
export function resolveRestartServiceConfig(): RestartServiceConfig {
  try {
    const path = process.env.OMP_RESTART_SERVICE_ENV
      ?? join(homedir(), "omp", "ops", "env", "restart-service.env");
    return parseRestartServiceEnv(readFileSync(path, "utf8"));
  } catch {
    return { token: null, port: DEFAULT_PORT };
  }
}

function parseJsonObject(body: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    (typeof status.run_id === "string" || status.run_id === null)
    && (typeof status.pid === "number" || status.pid === null)
    && typeof status.running === "boolean"
    && (typeof status.exit_code === "number" || status.exit_code === null)
    && (typeof status.started_at === "string" || status.started_at === null)
    && (typeof status.ended_at === "string" || status.ended_at === null)
    && (typeof status.log_path === "string" || status.log_path === null)
    && Array.isArray(status.log_tail)
    && status.log_tail.every((line) => typeof line === "string")
    && (typeof status.mode === "string" || status.mode === null)
  );
}

/**
 * Use node:http rather than fetch: Bun routes loopback fetches through
 * HTTP_PROXY when configured, but this daemon must always stay local.
 */
function daemonRequest(
  port: number,
  method: string,
  path: string,
  timeoutMs: number,
  headers?: Record<string, string>,
  body?: string,
): Promise<DaemonResponse> {
  const { promise, resolve } = Promise.withResolvers<DaemonResponse>();
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  const finish = (result: DaemonResponse) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(result);
  };

  const req = request(
    {
      host: "127.0.0.1",
      port,
      method,
      path,
      headers,
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error: Error) => finish({ ok: false, reason: error.message }));
      response.on("end", () => finish({
        ok: true,
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    },
  );

  timeout = setTimeout(() => {
    const reason = `timeout after ${timeoutMs}ms`;
    req.destroy(new Error(reason));
    finish({ ok: false, reason });
  }, timeoutMs);
  req.on("error", (error: Error) => finish({ ok: false, reason: error.message }));
  req.end(body);
  return promise;
}

async function readDaemonStatus(port: number, timeoutMs: number): Promise<DaemonStatus | null> {
  const response = await daemonRequest(port, "GET", "/status", timeoutMs);
  if (!response.ok || response.status !== 200) return null;
  const status = parseJsonObject(response.body);
  return isDaemonStatus(status) ? status : null;
}

/** Probe the unauthenticated health endpoint, then return the daemon status. */
export async function getRestartServiceAvailability(
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
): Promise<RestartServiceAvailability> {
  const { port } = resolveRestartServiceConfig();
  const health = await daemonRequest(port, "GET", "/health", healthTimeoutMs);
  if (!health.ok) return { available: false, reason: health.reason };
  if (health.status !== 200) {
    return { available: false, reason: `health probe returned HTTP ${health.status}` };
  }

  const status = await readDaemonStatus(port, healthTimeoutMs);
  return status ? { available: true, status } : { available: true };
}

/** Start a daemon run after resolving its current token and port. */
export async function startRestartServiceRun(
  mode: "restart" | "upgrade",
  runTimeoutMs = RUN_TIMEOUT_MS,
): Promise<RestartRunResult> {
  const { token, port } = resolveRestartServiceConfig();
  if (!token) return { kind: "unavailable", reason: "restart service not configured" };

  const body = JSON.stringify({ mode });
  const response = await daemonRequest(
    port,
    "POST",
    "/run",
    runTimeoutMs,
    {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-Restart-Token": token,
    },
    body,
  );
  if (!response.ok) return { kind: "unavailable", reason: response.reason };

  if (response.status === 202) {
    return { kind: "started", body: parseJsonObject(response.body) ?? {} };
  }
  if (response.status === 409) {
    const body = parseJsonObject(response.body);
    const embeddedStatus = body?.status;
    let status: DaemonStatus | null;
    if (isDaemonStatus(embeddedStatus)) {
      status = embeddedStatus;
    } else if (isDaemonStatus(body)) {
      delete body.error;
      status = body;
    } else {
      status = await readDaemonStatus(port, HEALTH_TIMEOUT_MS);
    }
    return { kind: "in-progress", status };
  }
  if (response.status === 401) return { kind: "rejected-token" };
  return { kind: "daemon-error", status: response.status };
}
