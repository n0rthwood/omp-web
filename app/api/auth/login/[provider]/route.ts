import type { OAuthAuthInfo, OAuthPrompt, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth";
import { parseCallbackInput } from "@oh-my-pi/pi-ai/oauth/callback-server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "@/lib/omp-runtime";
import { resolveOAuthLoginId } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

// In-memory registry: loginToken -> pending browser-input request.
// `manual` entries carry the OAuth redirect URL/code and are pre-validated on
// POST; `prompt` entries are free-form provider prompts (enterprise URL, ...)
// and pass through untouched.
type PendingInput = {
  kind: "manual" | "prompt";
  expectedState: string;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
};

declare global {
  var __ompLoginCallbacks: Map<string, PendingInput> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__ompLoginCallbacks) globalThis.__ompLoginCallbacks = new Map();
  return globalThis.__ompLoginCallbacks;
}

// POST /api/auth/login/[provider] — frontend sends redirect URL or auth code.
// Invalid pastes are rejected synchronously WITHOUT consuming the token, so
// the client can retry with the same token (issue #90).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  let body: { token?: unknown; code?: unknown };
  try {
    body = (await req.json()) as { token?: unknown; code?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }
  const { token, code } = body ?? {};

  if (typeof token !== "string" || !token || typeof code !== "string") {
    return Response.json({ error: "token and code required", code: "missing_fields" }, { status: 400 });
  }
  if (!code.trim()) {
    return Response.json({ error: "code must not be empty", code: "invalid_input" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const entry = registry.get(token);
  if (!entry) {
    return Response.json({ error: "No pending login for token", code: "unknown_token" }, { status: 404 });
  }
  // Verify token belongs to this provider (token format: "<provider>-<ts>-<random>")
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider", code: "token_provider_mismatch" }, { status: 400 });
  }

  // Pre-validate manual OAuth input with the SDK's own parser and the state
  // the SDK advertised in the authorization URL. The SDK silently drops
  // code-less or state-mismatched pastes and re-prompts with a token the
  // client never sees; rejecting here keeps the current token retryable.
  if (entry.kind === "manual") {
    const parsed = parseCallbackInput(code);
    if (!parsed.code) {
      return Response.json(
        { error: "No authorization code found in the pasted input", code: "missing_code" },
        { status: 400 }
      );
    }
    if (entry.expectedState && parsed.state && parsed.state !== entry.expectedState) {
      return Response.json(
        { error: "State does not match this login attempt; paste the redirect URL from the current sign-in", code: "state_mismatch" },
        { status: 400 }
      );
    }
  }

  entry.resolve(code);
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for OAuth flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: unknown) => {
    // The client may disconnect mid-login; the SDK's final callbacks can then
    // race the stream's cancel. Dropping those frames is safe — nobody reads.
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      // stream already closed
    }
  };

  // AbortController propagates client disconnect into AuthStorage.login().
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const loginId = resolveOAuthLoginId(provider);
      if (!loginId) {
        send(controller, { type: "error", message: `Unknown provider: ${provider}` });
        controller.close();
        return;
      }
      const { authStorage } = await getOmpRuntime();

      const registry = getCallbackRegistry();
      const activeTokens = new Set<string>();
      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;
      // CSRF state the SDK put in the authorization URL; manual pastes are
      // checked against it exactly like the SDK's own callback handler.
      let expectedState = "";
      // The SDK calls onManualCodeInput once per wait; a second call means it
      // silently discarded the previous paste and is asking again.
      let manualInputCalls = 0;

      const createClientInputRequest = (kind: PendingInput["kind"]) => {
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);

        const promise = new Promise<string>((resolve, reject) => {
          registry.set(token, {
            kind,
            expectedState: kind === "manual" ? expectedState : "",
            resolve: (value) => {
              activeTokens.delete(token);
              registry.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              registry.delete(token);
              reject(error);
            },
          });
        });

        return { token, promise };
      };

      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest("manual");
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      // Cleanup: remove pending token and abort any waiting promise
      const cleanup = () => {
        for (const token of activeTokens) {
          registry.get(token)?.reject(new Error("Login cancelled"));
          registry.delete(token);
        }
        activeTokens.clear();
      };

      // Also cancel on client disconnect
      abort.signal.addEventListener("abort", cleanup);

      try {
        await authStorage.oauth.login(loginId as OAuthProviderId, {
          // Every provider prompt (enterprise URL, ...) becomes a browser
          // input request keyed by a short-lived token. Prompts are free-form
          // answers, not OAuth redirect URLs, so POST passes them through.
          onPrompt: async (prompt: OAuthPrompt) => {
            const request = createClientInputRequest("prompt");
            send(controller, {
              type: "prompt_request",
              message: prompt.message,
              placeholder: prompt.placeholder ?? null,
              token: request.token,
            });
            return request.promise;
          },
          // Manual-code flows resolve through the same pending request as the
          // auth URL so a user who pastes the redirect completes the login.
          onManualCodeInput: () => {
            manualInputCalls += 1;
            const request = getManualInputRequest();
            if (manualInputCalls > 1) {
              // Defense in depth: POST pre-validation should make this
              // unreachable, but if the SDK ever drops an accepted paste,
              // hand the client the fresh token instead of leaving it stuck
              // on a consumed one (issue #90).
              send(controller, {
                type: "input_rejected",
                token: request.token,
                message:
                  "The pasted input was rejected (no authorization code, or state mismatch). Paste the redirect URL or code again.",
              });
            }
            return request.promise;
          },
          onAuth: (info: OAuthAuthInfo) => {
            try {
              expectedState = new URL(info.url).searchParams.get("state") ?? "";
            } catch {
              expectedState = "";
            }
            const request = getManualInputRequest();
            send(controller, {
              type: "auth",
              // The provider authorization URL, always safe for a remote
              // browser. The SDK's optional same-machine loopback shortcut
              // (bound to this server's own localhost callback listener) is
              // deliberately never sent here or opened client-side.
              url: info.url,
              instructions: info.instructions ?? null,
              token: request.token,
            });
          },
          onProgress: (message: string) => {
            send(controller, { type: "progress", message });
          },
          signal: abort.signal,
        });

        invalidateModelsCache();
        invalidateOmpRuntime();
        send(controller, { type: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Login cancelled") {
          send(controller, { type: "error", message: msg });
        } else {
          send(controller, { type: "cancelled" });
        }
      } finally {
        cleanup();
        try {
          controller.close();
        } catch {
          // stream already closed (client disconnect)
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}