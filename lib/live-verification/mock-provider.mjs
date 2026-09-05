/**
 * A minimal, spec-compliant local `openai-completions` provider used by the
 * live #30/#31 verification harnesses.
 *
 * Speaks exactly the wire shape `@oh-my-pi/pi-ai`'s `streamOpenAICompletions`
 * expects (`POST {baseUrl}/chat/completions`, SSE `ChatCompletionChunk`
 * frames, `[DONE]` sentinel — see `postOpenAIStream` /
 * `utils/openai-http.ts` in `node_modules/@oh-my-pi/pi-ai`) so the real SDK
 * retry/fallback engine (`session/turn-recovery.ts`) drives genuine HTTP
 * turns against it — no mocking inside the agent process itself.
 *
 * Per-model-id behavior is toggled at runtime via `setBehavior`, which is how
 * the harnesses simulate "the primary provider's credential gets killed
 * mid-conversation": the model that was answering normally starts returning
 * 401 Unauthorized, exactly what a real provider does once a credential is
 * revoked. Equivalence is deliberate and stated in each harness's own
 * comments per the assignment.
 */

/** @typedef {"ok" | "unauthorized"} ModelBehavior */

export function startMockProvider() {
  /** @type {Map<string, ModelBehavior>} */
  const behavior = new Map();
  /** @type {Array<{ model: string; auth: string | null }>} */
  const requestLog = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body = await req.json();
      const model = String(body.model ?? "");
      requestLog.push({ model, auth: req.headers.get("authorization") });

      const mode = behavior.get(model) ?? "ok";
      if (mode === "unauthorized") {
        return Response.json(
          {
            error: {
              message: `Incorrect API key provided for model "${model}". The credential was revoked.`,
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
          { status: 401 },
        );
      }

      const id = `mockcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const text = `ack turn from ${model}`;
      const chunk = (choices, extra = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`;

      const sse =
        chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]) +
        chunk([{ index: 0, delta: { content: text }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }) +
        "data: [DONE]\n\n";

      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": id },
      });
    },
  });

  return {
    /** `http://127.0.0.1:<port>` — use as the `models.yml` provider `baseUrl`. */
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    /** Flip one model id's behavior. `modelId` is the bare id (e.g. `"model-a"`), not `provider/id`. */
    setBehavior(modelId, mode) {
      behavior.set(modelId, mode);
    },
    requestLog,
    stop() {
      server.stop(true);
    },
  };
}
