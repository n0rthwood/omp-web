import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  beginOAuthVerification,
  clearOAuthLoginError,
  failOAuthVerification,
  oauthInputRequest,
  OAUTH_POST_ERROR_KEYS,
  OAUTH_SERVER_MESSAGE_KEYS,
  reduceOAuthLoginEvent,
  refreshProviderModels,
  serializeHeaderRows,
  setCompatBool,
  updateHeaderRow,
} = await jiti.import("./models-config-helpers.ts");
const { apiPath, getCurrentMachineId, setCurrentMachineId } = await jiti.import("../lib/api-path.ts");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { translateMessage } = await jiti.import("../lib/i18n/format.ts");

test("disabling the developer role writes an explicit false override", () => {
  assert.deepEqual(
    setCompatBool({ compat: { supportsStore: true } }, "supportsDeveloperRole", false),
    { compat: { supportsStore: true, supportsDeveloperRole: false } },
  );
});

test("editing a header preserves row order and stable identities", () => {
  const rows = [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two" },
  ];
  const updated = updateHeaderRow(rows, 10, { name: "X-First-Edited" });

  assert.deepEqual(updated.map(({ id, name }) => ({ id, name })), [
    { id: 10, name: "X-First-Edited" },
    { id: 11, name: "X-Second" },
  ]);
  assert.deepEqual(serializeHeaderRows(updated), {
    "X-First-Edited": "one",
    "X-Second": "two",
  });
});

test("blank header drafts are omitted until they have a name", () => {
  const rows = [
    { id: 1, name: "X-Existing", value: "kept" },
    { id: 2, name: "", value: "draft value" },
  ];

  assert.deepEqual(serializeHeaderRows(rows), { "X-Existing": "kept" });
  assert.deepEqual(
    serializeHeaderRows(updateHeaderRow(rows, 2, { name: "X-Draft" })),
    { "X-Existing": "kept", "X-Draft": "draft value" },
  );
});

test("refresh posts the saved provider to the selected fleet machine and reloads models", async () => {
  const previousMachineId = getCurrentMachineId();
  let request;
  let modelReloads = 0;
  try {
    setCurrentMachineId("remote #1");
    const result = await refreshProviderModels("provider-a", () => { modelReloads += 1; }, async (url, options) => {
      request = { url, options };
      return Response.json({ success: true, discoveryStatus: "empty", warning: "No models reported" });
    });

    assert.equal(request.url, "/api/machines/remote%20%231/api/models-config/refresh-provider");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(request.options.body), { providerName: "provider-a" });
    assert.equal(result.discoveryStatus, "empty");
    assert.equal(result.warning, "No models reported");
    assert.equal(modelReloads, 1);
  } finally {
    setCurrentMachineId(previousMachineId);
  }
});

test("refresh surfaces server failure and still reloads models after a possible partial change", async () => {
  let modelReloads = 0;
  await assert.rejects(
    refreshProviderModels("provider-a", () => { modelReloads += 1; }, async () => (
      Response.json({ error: "Discovery unavailable" }, { status: 502 })
    )),
    { message: "Discovery unavailable" },
  );
  assert.equal(modelReloads, 1);
});

test("refresh reloads models when the connection fails or an error response is not JSON", async () => {
  let modelReloads = 0;
  const offline = new Error("connection lost");
  await assert.rejects(
    refreshProviderModels("provider-a", () => { modelReloads += 1; }, async () => { throw offline; }),
    (error) => error === offline,
  );
  await assert.rejects(
    refreshProviderModels("provider-a", () => { modelReloads += 1; }, async () => new Response("bad gateway", { status: 502 })),
    { message: "HTTP 502" },
  );
  assert.equal(modelReloads, 2);
});

// ── OAuth login state (issue #90) ────────────────────────────────────────────
// The paste input must survive the SDK's immediate progress event and any
// rejected paste. These reducer tests prove the input request (and its token)
// stays mounted from auth until success/error, and that a rejected paste can
// be retried without restarting login.

const AUTH_URL = "https://auth.example.com/authorize?state=csrf-state-1";
const authEvent = { type: "auth", url: AUTH_URL, instructions: null, token: "prov-1-abc" };
const progressEvent = { type: "progress", message: "Waiting for browser authentication..." };

test("progress after auth keeps the paste input request and token (issue #90)", () => {
  const auth = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  assert.equal(auth.phase, "auth");
  assert.equal(oauthInputRequest(auth)?.token, "prov-1-abc");

  // The SDK fires onProgress immediately after onAuth. It must NOT replace the
  // auth request with a bare progress phase (the original bug).
  const after = reduceOAuthLoginEvent(auth, progressEvent);
  const request = oauthInputRequest(after);
  assert.ok(request, "input request must survive the progress event");
  assert.equal(request.token, "prov-1-abc");
  assert.equal(request.url, AUTH_URL);
  assert.equal(request.progress, "Waiting for browser authentication...");
});

test("repeated progress updates never drop the kept input request", () => {
  let state = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  state = reduceOAuthLoginEvent(state, progressEvent);
  // A paste is submitted: verification keeps the request alive.
  state = beginOAuthVerification(state);
  assert.equal(state.phase, "progress");
  assert.equal(oauthInputRequest(state)?.token, "prov-1-abc");
  // Further SDK progress while verifying must not wipe the request or token.
  state = reduceOAuthLoginEvent(state, { type: "progress", message: "Exchanging authorization code for tokens..." });
  const request = oauthInputRequest(state);
  assert.ok(request, "input request must survive progress while verifying");
  assert.equal(request.token, "prov-1-abc");
  assert.equal(state.message, "Exchanging authorization code for tokens...");
});

test("a rejected paste restores the input with an inline error and the same retryable token", () => {
  let state = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  state = reduceOAuthLoginEvent(state, progressEvent);
  state = beginOAuthVerification(state);

  // Synchronous 4xx: token NOT consumed, same token valid for retry.
  state = failOAuthVerification(state, "No authorization code found in the pasted input");
  const request = oauthInputRequest(state);
  assert.ok(request, "input must be usable again after a rejected paste");
  assert.equal(request.token, "prov-1-abc", "same token must remain retryable");
  assert.equal(request.error, "No authorization code found in the pasted input");

  // A second paste with the same token succeeds (200 -> verifying, then SSE success).
  state = beginOAuthVerification(state);
  assert.equal(state.phase, "progress");
  assert.equal(oauthInputRequest(state)?.token, "prov-1-abc");
  assert.equal(oauthInputRequest(state)?.error, null, "stale error cleared on retry");
  state = reduceOAuthLoginEvent(state, { type: "success" });
  assert.equal(state.phase, "success");
  assert.equal(oauthInputRequest(state), null);
});

test("editing the paste input clears the stale inline error", () => {
  let state = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  state = beginOAuthVerification(state);
  state = failOAuthVerification(state, "State does not match");
  assert.equal(oauthInputRequest(state)?.error, "State does not match");
  state = clearOAuthLoginError(state);
  assert.equal(oauthInputRequest(state)?.error, null);
  assert.equal(oauthInputRequest(state)?.token, "prov-1-abc");
});

test("input_rejected SSE re-arms the input with the fresh token", () => {
  let state = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  state = beginOAuthVerification(state);
  // Defense-in-depth: the SDK dropped an accepted paste and re-armed manual
  // input with a NEW token the client must adopt instead of the consumed one.
  state = reduceOAuthLoginEvent(state, {
    type: "input_rejected",
    token: "prov-2-fresh",
    message: "The pasted input was rejected (no authorization code, or state mismatch). Paste the redirect URL or code again.",
  });
  const request = oauthInputRequest(state);
  assert.ok(request, "input must be re-armed after input_rejected");
  assert.equal(request.token, "prov-2-fresh", "fresh token must replace the consumed one");
  assert.match(request.error, /rejected/);
});

test("input_rejected without a token keeps the current request alive", () => {
  let state = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  state = reduceOAuthLoginEvent(state, progressEvent);
  state = reduceOAuthLoginEvent(state, { type: "input_rejected", message: "rejected" });
  const request = oauthInputRequest(state);
  assert.ok(request);
  assert.equal(request.token, "prov-1-abc");
  assert.equal(request.error, "rejected");
});

test("prompt requests keep their input through progress and rejection", () => {
  let state = reduceOAuthLoginEvent({ phase: "connecting" }, {
    type: "prompt_request", message: "Enter your enterprise URL", placeholder: "https://…", token: "prov-9-prompt",
  });
  assert.equal(state.phase, "prompt");
  assert.equal(oauthInputRequest(state)?.token, "prov-9-prompt");
  state = reduceOAuthLoginEvent(state, progressEvent);
  assert.equal(oauthInputRequest(state)?.token, "prov-9-prompt");
  state = beginOAuthVerification(state);
  state = failOAuthVerification(state, "bad input");
  assert.equal(oauthInputRequest(state)?.token, "prov-9-prompt");
  assert.equal(oauthInputRequest(state)?.error, "bad input");
});

test("device_code and select flows are unaffected by the paste-input changes", () => {
  const device = reduceOAuthLoginEvent({ phase: "connecting" }, {
    type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device",
    intervalSeconds: 5, expiresInSeconds: 900,
  });
  assert.equal(device.phase, "device_code");
  assert.equal(device.userCode, "ABCD-1234");
  assert.equal(oauthInputRequest(device), null, "device_code has no paste input");

  let select = reduceOAuthLoginEvent({ phase: "connecting" }, {
    type: "select_request", message: "Choose an account", options: [{ id: "a", label: "Account A" }], token: "prov-5-sel",
  });
  assert.equal(select.phase, "select");
  assert.equal(oauthInputRequest(select), null, "select has no paste input");
  // Selecting keeps the options usable; a failed selection restores them.
  select = beginOAuthVerification(select);
  assert.equal(select.verifying, true);
  select = failOAuthVerification(select, "selection failed");
  assert.equal(select.verifying, false);
  assert.equal(select.error, "selection failed");
  assert.equal(select.options.length, 1);
  assert.equal(select.token, "prov-5-sel");
});

test("terminal success/error/cancelled end the flow and drop the input", () => {
  const auth = reduceOAuthLoginEvent({ phase: "connecting" }, authEvent);
  assert.equal(reduceOAuthLoginEvent(auth, { type: "success" }).phase, "success");
  const err = reduceOAuthLoginEvent(auth, { type: "error", message: "OAuth callback cancelled: TimeoutError" });
  assert.equal(err.phase, "error");
  assert.equal(err.message, "OAuth callback cancelled: TimeoutError");
  assert.equal(reduceOAuthLoginEvent(auth, { type: "cancelled" }).phase, "idle");
  assert.equal(oauthInputRequest(err), null);
  // A late progress event must not resurrect a terminal state.
  assert.equal(reduceOAuthLoginEvent(err, progressEvent).phase, "error");
});

test("every POST error code and server progress message maps to a present locale key", () => {
  const messages = { en: enLocale.messages, "zh-CN": zhCNLocale.messages };
  const codes = ["missing_fields", "invalid_json", "invalid_input", "missing_code", "state_mismatch", "unknown_token", "token_provider_mismatch"];
  assert.deepEqual(Object.keys(OAUTH_POST_ERROR_KEYS).sort(), [...codes].sort());
  for (const key of Object.values(OAUTH_POST_ERROR_KEYS)) {
    for (const locale of ["en", "zh-CN"]) {
      const value = translateMessage(locale, key, messages);
      assert.notEqual(value, key, `${locale} missing ${key}`);
      assert.ok(value.length > 0);
    }
  }
  for (const key of Object.values(OAUTH_SERVER_MESSAGE_KEYS)) {
    for (const locale of ["en", "zh-CN"]) {
      assert.notEqual(translateMessage(locale, key, messages), key, `${locale} missing ${key}`);
    }
  }
});

test("OAuth copy keys exist in both locales with matching interpolation placeholders", () => {
  const copyKeys = [
    "models.oauthAlreadyConnected", "models.oauthConnectAccount", "models.oauthPasteHint",
    "models.oauthBrowserNotOpened", "models.oauthOpenLoginPage", "models.oauthPastePlaceholder",
    "models.oauthEnterValue", "models.oauthVerifying", "models.oauthConnectionLost",
    "models.oauthServerError", "models.oauthDeviceCodeHint", "models.oauthExpiresIn",
  ];
  const placeholders = (value) => [...value.matchAll(/\{([\w.-]+)\}/g)].map((m) => m[1]).sort();
  for (const key of copyKeys) {
    const en = enLocale.messages[key];
    const zh = zhCNLocale.messages[key];
    assert.ok(en, `en missing ${key}`);
    assert.ok(zh, `zh-CN missing ${key}`);
    assert.deepEqual(placeholders(en), placeholders(zh), `placeholder mismatch for ${key}`);
  }
  // Interpolation actually substitutes.
  const messages = { en: enLocale.messages, "zh-CN": zhCNLocale.messages };
  assert.match(translateMessage("en", "models.oauthConnectAccount", messages, { provider: "Anthropic" }), /Anthropic/);
  assert.match(translateMessage("zh-CN", "models.oauthServerError", messages, { status: 500 }), /500/);
  assert.match(translateMessage("en", "models.oauthExpiresIn", messages, { minutes: 15 }), /15/);
});

test("OAuth login and paste POST use the selected fleet machine path", () => {
  const previousMachineId = getCurrentMachineId();
  try {
    setCurrentMachineId("remote #1");
    const loginPath = apiPath(`/api/auth/login/${encodeURIComponent("anthropic")}`);
    assert.equal(loginPath, "/api/machines/remote%20%231/api/auth/login/anthropic");
  } finally {
    setCurrentMachineId(previousMachineId);
  }
});
