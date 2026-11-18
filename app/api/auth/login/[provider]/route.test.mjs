import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");

// Regression for #26: a remote browser can never reach this server's own
// localhost callback listener, so `info.launchUrl` (an SDK-hosted loopback
// shortcut) must never become the browser-facing `url`. Given both an
// `info.launchUrl` (e.g. "http://localhost:1455/auth/callback") and a real
// `info.url` (e.g. "https://console.anthropic.com/oauth/authorize?..."),
// the payload sent to the browser must resolve to `info.url`.
const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const onAuthSource = source.slice(
  source.indexOf("onAuth: (info: OAuthAuthInfo)"),
  source.indexOf("onProgress:"),
);

test("auth SSE event forwards the real provider authorization URL, never the SDK loopback launchUrl", () => {
  assert.match(onAuthSource, /url:\s*info\.url,/);
  assert.doesNotMatch(onAuthSource, /info\.launchUrl/);
  assert.doesNotMatch(onAuthSource, /fullUrl/);
});

// Runtime companion to the source guard: an auth info carrying BOTH url and
// launchUrl must emit only the provider URL over SSE.
test("auth event payload contains info.url only, even when the SDK also supplies launchUrl", async (t) => {
  const login = scriptedLogin(t, {
    authInfo: {
      url: "https://claude.ai/oauth/authorize?state=abc123",
      launchUrl: "http://localhost:54545/launch",
      instructions: "Complete login in your browser.",
    },
    pastes: ["code-1"],
  });
  const stream = await openLogin("anthropic");
  const auth = await stream.nextType("auth");
  assert.equal(auth.url, "https://claude.ai/oauth/authorize?state=abc123");
  assert.equal(auth.instructions, "Complete login in your browser.");
  assert.ok(!JSON.stringify(auth).includes("launchUrl"));
  assert.ok(!JSON.stringify(auth).includes("/launch"));
  assert.equal(login.calls, 1);
  await postOk("anthropic", auth.token, "code-1");
  await stream.nextType("success");
  assert.equal(await stream.next(), null);
});

// --- helpers ---------------------------------------------------------------

function fixture(t, loginImpl) {
  const previous = {
    runtime: globalThis.__ompRuntimePromise,
    modelsCache: globalThis.__ompModelsCacheState,
    callbacks: globalThis.__ompLoginCallbacks,
  };
  globalThis.__ompRuntimePromise = Promise.resolve({
    authStorage: { oauth: { login: loginImpl } },
  });
  globalThis.__ompModelsCacheState = undefined;
  globalThis.__ompLoginCallbacks = undefined;
  t.after(() => {
    globalThis.__ompRuntimePromise = previous.runtime;
    globalThis.__ompModelsCacheState = previous.modelsCache;
    globalThis.__ompLoginCallbacks = previous.callbacks;
  });
}

/**
 * Stub login that reproduces the real SDK callback order
 * (onAuth -> onProgress("Waiting...") -> manual-input requests -> exchange ->
 * success) without binding ports or touching the network. Each expected paste
 * consumes one onManualCodeInput call, exactly like the SDK's wait loop.
 */
function scriptedLogin(t, { authInfo, pastes = [], prompts = [], exchangeError } = {}) {
  const state = { calls: 0, manualCalls: 0, promptCalls: 0, exchanged: [], promptsAnswered: [] };
  const impl = async (provider, ctrl) => {
    state.calls += 1;
    state.provider = provider;
    ctrl.onAuth(authInfo ?? { url: "https://provider.example/oauth/authorize?state=st-1" });
    ctrl.onProgress("Waiting for browser authentication...");
    for (let i = 0; i < pastes.length; i += 1) {
      state.manualCalls += 1;
      const value = await ctrl.onManualCodeInput(ctrl.signal);
      state.exchanged.push(value);
    }
    for (const prompt of prompts) {
      state.promptCalls += 1;
      const answer = await ctrl.onPrompt(prompt);
      state.promptsAnswered.push(answer);
    }
    if (exchangeError) throw new Error(exchangeError);
    ctrl.onProgress("Exchanging authorization code for tokens...");
    return { type: "oauth" };
  };
  fixture(t, impl);
  return state;
}

function params(provider) {
  return { params: Promise.resolve({ provider }) };
}

function post(provider, body, { raw } = {}) {
  return POST(
    new Request(`http://localhost/api/auth/login/${provider}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    params(provider)
  );
}

async function postOk(provider, token, code) {
  const res = await post(provider, { token, code });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, provider });
}

async function openLogin(provider) {
  const abort = new AbortController();
  const res = await GET(
    new Request(`http://localhost/api/auth/login/${provider}`, { signal: abort.signal }),
    params(provider)
  );
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Single-consumer queue: every parsed frame is buffered; next()/nextType()
  // are the only readers, so skipped events can never strand a waiter.
  const queue = [];
  const waiters = [];
  let closed = false;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!frame.startsWith("data: ")) continue;
          queue.push(JSON.parse(frame.slice(6)));
          const waiter = waiters.shift();
          if (waiter) waiter();
        }
      }
    } catch {
      // reader cancelled
    } finally {
      closed = true;
      while (waiters.length) waiters.shift()();
    }
  })();
  const next = (timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      if (closed) return resolve(null);
      const timer = setTimeout(() => reject(new Error("timed out waiting for SSE event")), timeoutMs);
      waiters.push(() => {
        clearTimeout(timer);
        resolve(queue.length ? queue.shift() : null);
      });
    });
  return {
    next,
    async nextType(type, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for "${type}" event`);
        const event = await next(remaining);
        if (event === null) throw new Error(`stream closed before "${type}" event`);
        if (event.type === type) return event;
      }
    },
    async cancel() {
      abort.abort();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// --- POST validation (no pending login required for shape errors) ----------

test("POST rejects malformed bodies and missing fields with stable machine codes", async (t) => {
  fixture(t, async () => {
    throw new Error("login must not be called");
  });
  const badJson = await post("anthropic", undefined, { raw: "{" });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).code, "invalid_json");

  for (const body of [
    {},
    { token: "anthropic-1-x" },
    { code: "abc" },
    { token: "", code: "abc" },
    { token: 5, code: "abc" },
    { token: "anthropic-1-x", code: 42 },
  ]) {
    const res = await post("anthropic", body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "missing_fields");
  }

  // Present but blank code is a distinct, retryable input error.
  const blank = await post("anthropic", { token: "anthropic-1-x", code: "   " });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).code, "invalid_input");

  const unknown = await post("anthropic", { token: "anthropic-1-nope", code: "abc" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "unknown_token");
});

test("POST rejects a token minted for a different provider without consuming it", async (t) => {
  const login = scriptedLogin(t, { pastes: ["code-ok"] });
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  const res = await post("openai-codex", { token: auth.token, code: "abc" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "token_provider_mismatch");
  // Token must survive the cross-provider attempt.
  await postOk("anthropic", auth.token, "code-ok");
  await stream.nextType("success");
  assert.deepEqual(login.exchanged, ["code-ok"]);
});

// --- reject-then-retry with the SAME token (issue #90 core regression) -----

test("invalid pastes are rejected synchronously and the same token stays retryable", async (t) => {
  const login = scriptedLogin(t, {
    authInfo: { url: "https://claude.ai/oauth/authorize?code=true&state=st-42" },
    pastes: ["final-code"],
  });
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  assert.equal(auth.token.startsWith("anthropic-"), true);
  // The SDK's progress message follows auth; it must not disturb the token.
  const progress = await stream.nextType("progress");
  assert.equal(progress.message, "Waiting for browser authentication...");

  // No code in the pasted URL.
  const noCode = await post("anthropic", { token: auth.token, code: "http://localhost:54545/callback?error=access_denied" });
  assert.equal(noCode.status, 400);
  assert.equal((await noCode.json()).code, "missing_code");

  // State mismatch.
  const wrongState = await post("anthropic", { token: auth.token, code: "http://localhost:54545/callback?code=c1&state=WRONG" });
  assert.equal(wrongState.status, 400);
  assert.equal((await wrongState.json()).code, "state_mismatch");

  // Same token, valid paste completes the login.
  await postOk("anthropic", auth.token, "http://localhost:54545/callback?code=final-code&state=st-42");
  await stream.nextType("success");
  assert.equal(await stream.next(), null);
  assert.deepEqual(login.exchanged, ["http://localhost:54545/callback?code=final-code&state=st-42"]);
  // Rejects never reached the SDK loop: exactly one manual-input request.
  assert.equal(login.manualCalls, 1);

  // Token consumed: a further paste is a clean 404, not a silent hang.
  const after = await post("anthropic", { token: auth.token, code: "again" });
  assert.equal(after.status, 404);
  assert.equal((await after.json()).code, "unknown_token");
});

test("scripted flow accepts bare code, code#state and query-string pastes in sequence", async (t) => {
  const pastes = ["bare-code", "code-2#st-9", "?code=code-3&state=st-9"];
  const login = scriptedLogin(t, {
    authInfo: { url: "https://auth.openai.com/oauth/authorize?state=st-9" },
    pastes,
  });
  const stream = await openLogin("openai-codex");
  t.after(() => stream.cancel());
  let token = (await stream.nextType("auth")).token;
  // The scripted login emits its waiting-progress frame before the first wait.
  await stream.nextType("progress");
  for (const paste of pastes) {
    await postOk("openai-codex", token, paste);
    // Each accepted paste resolves one SDK wait; the next wait re-arms the
    // input with a fresh token, exactly like the real re-prompt loop.
    const event = await stream.next();
    if (event.type === "input_rejected") token = event.token;
    else {
      // Final paste: the exchange progress precedes success.
      assert.equal(event.type, "progress");
      assert.equal((await stream.next()).type, "success");
    }
  }
  assert.deepEqual(login.exchanged, pastes);
  assert.equal(login.manualCalls, pastes.length);
});

test("providers without a state parameter skip the state check", async (t) => {
  const login = scriptedLogin(t, {
    authInfo: { url: "https://provider.example/oauth/authorize" },
    pastes: ["http://localhost:1234/callback?code=c1&state=anything"],
  });
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  await postOk("anthropic", auth.token, "http://localhost:1234/callback?code=c1&state=anything");
  await stream.nextType("success");
  assert.equal(login.exchanged.length, 1);
});

// --- defense-in-depth: SDK re-prompt surfaces a fresh token over SSE -------

test("if the SDK silently re-prompts, input_rejected carries the fresh token", async (t) => {
  // Stub mimics the SDK's silent-drop loop: it discards the first paste and
  // calls onManualCodeInput again, exactly like #waitForCallback does.
  const state = { manualCalls: 0, accepted: [] };
  fixture(t, async (provider, ctrl) => {
    ctrl.onAuth({ url: "https://claude.ai/oauth/authorize?state=st-7" });
    ctrl.onProgress("Waiting for browser authentication...");
    for (;;) {
      state.manualCalls += 1;
      const input = await ctrl.onManualCodeInput(ctrl.signal);
      if (input === "good-code") {
        state.accepted.push(input);
        return { type: "oauth" };
      }
      // silently dropped -> loop re-prompts
    }
  });
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  // Accept a paste the stub will drop (pre-validation passes: it has a code).
  await postOk("anthropic", auth.token, "dropped-code");
  const rejected = await stream.nextType("input_rejected");
  assert.equal(typeof rejected.token, "string");
  assert.notEqual(rejected.token, auth.token);
  assert.match(rejected.message, /rejected/i);
  // Old token is gone; the fresh one works.
  const stale = await post("anthropic", { token: auth.token, code: "good-code" });
  assert.equal(stale.status, 404);
  await postOk("anthropic", rejected.token, "good-code");
  await stream.nextType("success");
  assert.deepEqual(state.accepted, ["good-code"]);
  assert.equal(state.manualCalls, 2);
});

// --- prompt tokens are free-form answers, not OAuth codes ------------------

test("prompt_request tokens bypass code/state validation", async (t) => {
  const login = scriptedLogin(t, {
    prompts: [{ message: "Enter your enterprise URL", placeholder: "https://…" }],
  });
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const prompt = await stream.nextType("prompt_request");
  assert.equal(prompt.message, "Enter your enterprise URL");
  assert.equal(prompt.placeholder, "https://…");
  // A value with no OAuth code would be rejected on a manual token.
  await postOk("anthropic", prompt.token, "https://gateway.corp.example");
  await stream.nextType("success");
  assert.deepEqual(login.promptsAnswered, ["https://gateway.corp.example"]);
});

// --- lifecycle: errors, cancellation, registry cleanup, cache invalidation --

test("unknown provider closes the stream with an error event", async (t) => {
  fixture(t, async () => {
    throw new Error("login must not be called");
  });
  const stream = await openLogin("not-a-provider");
  const event = await stream.nextType("error");
  assert.match(event.message, /Unknown provider/);
  assert.equal(await stream.next(), null); // stream closed
});

test("exchange failure surfaces as an SSE error and cleans the registry", async (t) => {
  const login = scriptedLogin(t, { pastes: ["c1"], exchangeError: "token exchange failed: 400 invalid_grant" });
  const stream = await openLogin("anthropic");
  const auth = await stream.nextType("auth");
  await postOk("anthropic", auth.token, "c1");
  const error = await stream.nextType("error");
  assert.match(error.message, /invalid_grant/);
  assert.equal(await stream.next(), null);
  assert.equal(globalThis.__ompLoginCallbacks.size, 0);
  assert.equal(login.exchanged.length, 1);
});

test("client disconnect cancels the login and leaves no pending tokens", async (t) => {
  const state = { signal: undefined, settled: false, manualRejected: false };
  fixture(t, async (provider, ctrl) => {
    state.signal = ctrl.signal;
    ctrl.onAuth({ url: "https://claude.ai/oauth/authorize?state=st-1" });
    await ctrl.onManualCodeInput(ctrl.signal).then(
      () => {
        state.settled = true;
      },
      () => {
        state.manualRejected = true;
      }
    );
    throw new Error("Login cancelled");
  });
  const stream = await openLogin("anthropic");
  const auth = await stream.nextType("auth");
  assert.equal(globalThis.__ompLoginCallbacks.has(auth.token), true);
  await stream.cancel();
  await tick();
  assert.equal(state.signal.aborted, true);
  assert.equal(state.settled, false);
  assert.equal(state.manualRejected, true);
  assert.equal(globalThis.__ompLoginCallbacks.size, 0);
  const res = await post("anthropic", { token: auth.token, code: "late-code" });
  assert.equal(res.status, 404);
});

test("successful login invalidates the models cache and the omp runtime", async (t) => {
  const previous = {
    runtime: globalThis.__ompRuntimePromise,
    modelsCache: globalThis.__ompModelsCacheState,
    callbacks: globalThis.__ompLoginCallbacks,
  };
  globalThis.__ompModelsCacheState = { entries: new Map([["x", {}]]), inFlight: new Map(), generation: 7 };
  globalThis.__ompLoginCallbacks = undefined;
  globalThis.__ompRuntimePromise = Promise.resolve({
    authStorage: {
      oauth: {
        login: async (provider, ctrl) => {
          ctrl.onAuth({ url: "https://claude.ai/oauth/authorize?state=st-1" });
          await ctrl.onManualCodeInput(ctrl.signal);
          return { type: "oauth" };
        },
      },
    },
  });
  t.after(() => {
    globalThis.__ompRuntimePromise = previous.runtime;
    globalThis.__ompModelsCacheState = previous.modelsCache;
    globalThis.__ompLoginCallbacks = previous.callbacks;
  });
  const stream = await openLogin("anthropic");
  const auth = await stream.nextType("auth");
  await postOk("anthropic", auth.token, "c1");
  await stream.nextType("success");
  assert.equal(globalThis.__ompModelsCacheState.generation, 8);
  assert.equal(globalThis.__ompModelsCacheState.entries.size, 0);
  assert.equal(globalThis.__ompRuntimePromise, undefined);
});

// --- real SDK flows (stubbed provider HTTP, real callback servers) ---------

function stubAnthropicFetch(calls) {
  return async (url, init) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? "GET", body: init?.body });
    if (href.startsWith("https://api.anthropic.com/v1/oauth/token")) {
      // Identity fully populated so the anthropic-identity hook makes no
      // bootstrap call.
      return Response.json({
        access_token: "stub-access",
        refresh_token: "stub-refresh",
        expires_in: 3600,
        account: { uuid: "acct-1", email_address: "user@example.com" },
        organization: { uuid: "org-1", name: "Test Org" },
      });
    }
    throw new Error(`unexpected network call in test: ${href}`);
  };
}

function jwtWithClaims(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

function stubCodexFetch(calls) {
  const accessToken = jwtWithClaims({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex", chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "codex@example.com" },
  });
  return async (url, init) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? "GET", body: init?.body });
    if (href.startsWith("https://auth.openai.com/oauth/token")) {
      return Response.json({ access_token: accessToken, refresh_token: "stub-refresh", expires_in: 3600, id_token: accessToken });
    }
    throw new Error(`unexpected network call in test: ${href}`);
  };
}

/**
 * Drives the route against the REAL SDK login (real KDL rule, PKCE, state,
 * loopback callback server) with only the provider's HTTP endpoints stubbed
 * via ctrl.fetch. No credentials are stored: the stub replaces
 * authStorage.oauth.login's persistence layer entirely.
 */
function realSdkFixture(t, providerId, stubFetch) {
  const def = getProviderDefinition(providerId);
  assert.ok(def?.login, `${providerId} must have a login flow`);
  const calls = [];
  const previous = {
    runtime: globalThis.__ompRuntimePromise,
    modelsCache: globalThis.__ompModelsCacheState,
    callbacks: globalThis.__ompLoginCallbacks,
  };
  globalThis.__ompRuntimePromise = Promise.resolve({
    authStorage: {
      oauth: {
        login: async (id, ctrl) => {
          assert.equal(id, providerId);
          return def.login({ ...ctrl, fetch: stubFetch(calls) });
        },
      },
    },
  });
  globalThis.__ompModelsCacheState = undefined;
  globalThis.__ompLoginCallbacks = undefined;
  t.after(() => {
    globalThis.__ompRuntimePromise = previous.runtime;
    globalThis.__ompModelsCacheState = previous.modelsCache;
    globalThis.__ompLoginCallbacks = previous.callbacks;
  });
  return calls;
}

async function pasteVariants(t, providerId, stubFetch, { callbackPath, makePaste }) {
  const calls = realSdkFixture(t, providerId, stubFetch);
  const stream = await openLogin(providerId);
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  const authorize = new URL(auth.url);
  const state = authorize.searchParams.get("state");
  assert.ok(state, "authorize URL must carry CSRF state");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const redirectUri = authorize.searchParams.get("redirect_uri");
  assert.ok(redirectUri.includes(callbackPath));
  // progress arrives right after auth and must not invalidate the token
  await stream.nextType("progress");

  // Reject a state-mismatched paste first; the SAME token must survive.
  const mismatch = await post(providerId, { token: auth.token, code: makePaste(redirectUri, "probe-code", "WRONG-STATE") });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, "state_mismatch");
  const noCode = await post(providerId, { token: auth.token, code: `${redirectUri}?error=access_denied` });
  assert.equal(noCode.status, 400);
  assert.equal((await noCode.json()).code, "missing_code");

  // Valid full redirect URL completes the real flow.
  await postOk(providerId, auth.token, makePaste(redirectUri, "real-code", state));
  await stream.nextType("success");
  assert.equal(await stream.next(), null);
  assert.equal(globalThis.__ompLoginCallbacks.size, 0);

  const exchange = calls.find((call) => call.url.includes("/oauth/token"));
  assert.ok(exchange, "token exchange must have been attempted");
  assert.equal(exchange.method, "POST");
  return { calls, exchange, state, redirectUri };
}

test("anthropic: real SDK flow completes from a pasted redirect URL after rejects", async (t) => {
  const { exchange, state } = await pasteVariants(t, "anthropic", stubAnthropicFetch, {
    callbackPath: "/callback",
    makePaste: (redirectUri, code, pasteState) => `${redirectUri}?code=${code}&state=${pasteState}`,
  });
  const body = JSON.parse(exchange.body);
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.code, "real-code");
  assert.equal(body.state, state);
  assert.ok(body.code_verifier, "PKCE verifier must be sent");
});

test("openai-codex: real SDK flow completes from a pasted redirect URL after rejects", async (t) => {
  const { exchange, redirectUri } = await pasteVariants(t, "openai-codex", stubCodexFetch, {
    callbackPath: "/auth/callback",
    makePaste: (redirectUri, code, pasteState) => `${redirectUri}?code=${code}&state=${pasteState}`,
  });
  assert.equal(redirectUri, "http://localhost:1455/auth/callback");
  const body = new URLSearchParams(exchange.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "real-code");
  assert.ok(body.get("code_verifier"), "PKCE verifier must be sent");
  assert.equal(body.get("redirect_uri"), redirectUri);
});

test("anthropic: real SDK flow accepts a bare code paste (no state)", async (t) => {
  const calls = realSdkFixture(t, "anthropic", stubAnthropicFetch);
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  const state = new URL(auth.url).searchParams.get("state");
  await postOk("anthropic", auth.token, "bare-code-xyz");
  await stream.nextType("success");
  const exchange = calls.find((call) => call.url.includes("/oauth/token"));
  const body = JSON.parse(exchange.body);
  assert.equal(body.code, "bare-code-xyz");
  // Bare code carries no state; the SDK exchanges with its own generated state.
  assert.equal(body.state, state);
});

test("openai-codex: real SDK flow accepts a code#state paste", async (t) => {
  const calls = realSdkFixture(t, "openai-codex", stubCodexFetch);
  const stream = await openLogin("openai-codex");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  const state = new URL(auth.url).searchParams.get("state");
  await postOk("openai-codex", auth.token, `frag-code#${state}`);
  await stream.nextType("success");
  const exchange = calls.find((call) => call.url.includes("/oauth/token"));
  const body = new URLSearchParams(exchange.body);
  assert.equal(body.get("code"), "frag-code");
});

test("anthropic: real SDK flow accepts a query-string paste (?code=…&state=…)", async (t) => {
  const calls = realSdkFixture(t, "anthropic", stubAnthropicFetch);
  const stream = await openLogin("anthropic");
  t.after(() => stream.cancel());
  const auth = await stream.nextType("auth");
  const state = new URL(auth.url).searchParams.get("state");
  await postOk("anthropic", auth.token, `?code=query-code&state=${state}`);
  await stream.nextType("success");
  const exchange = calls.find((call) => call.url.includes("/oauth/token"));
  assert.equal(JSON.parse(exchange.body).code, "query-code");
});

test("real SDK flow: disconnect aborts the login and frees the callback port", async (t) => {
  realSdkFixture(t, "anthropic", stubAnthropicFetch);
  const stream = await openLogin("anthropic");
  const auth = await stream.nextType("auth");
  const port = new URL(new URL(auth.url).searchParams.get("redirect_uri")).port;
  await stream.cancel();
  // The SDK stops its loopback listener in login()'s finally; give the
  // abort -> rejection -> cleanup chain a moment to run.
  await tick(250);
  assert.equal(globalThis.__ompLoginCallbacks.size, 0);
  // A fresh bind on the same port proves the listener is gone.
  const probe = Bun.serve({ port: Number(port), hostname: "localhost", fetch: () => new Response("ok") });
  probe.stop(true);
});