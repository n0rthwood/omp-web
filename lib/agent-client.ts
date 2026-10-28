import { apiPath } from "./api-path";

// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

/**
 * The human-readable failure reason for an API response: the server's own
 * `error` field when present, otherwise a bare status line. Shared by every
 * client fetch so a rejected request surfaces e.g. "database disk image is
 * malformed" instead of an opaque "HTTP 500" (#83).
 */
export function apiErrorMessage(
  status: number,
  body: { error?: unknown } | null | undefined,
): string {
  return typeof body?.error === "string" && body.error ? body.error : `HTTP ${status}`;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sessionId)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      apiErrorMessage(res.status, body),
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
