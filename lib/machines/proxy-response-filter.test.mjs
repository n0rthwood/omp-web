import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./proxy-response-filter.ts");
}

const ADMIN = { username: "root", role: "admin", visibleProjects: "*", machines: "*" };
const STAR_USER = { username: "granted", role: "user", visibleProjects: "*", machines: ["gpu-1"] };
const LIMITED_USER = {
  username: "limited",
  role: "user",
  visibleProjects: ["/opt/granted/a", "/opt/granted/b"],
  machines: ["gpu-1"],
};

const PAYLOAD = {
  sessions: [
    { id: "s-granted", cwd: "/opt/granted/a", projectRoot: "/opt/granted/a" },
    { id: "s-other", cwd: "/opt/other/wsc_dev", projectRoot: "/opt/other/wsc_dev" },
    { id: "s-worktree", cwd: "/opt/granted/b-wt", projectRoot: "/opt/granted/b" },
  ],
  runningSessionIds: ["s-granted", "s-other"],
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("admin user -> the same Response object, unbuffered", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const response = jsonResponse(PAYLOAD);
  const result = await applySessionListVisibilityFilter(ADMIN, response);
  assert.equal(result, response);
});

test("\"*\" visibleProjects -> the same Response object, unbuffered", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const response = jsonResponse(PAYLOAD);
  const result = await applySessionListVisibilityFilter(STAR_USER, response);
  assert.equal(result, response);
});

test("non-JSON content-type -> the same Response object", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const response = new Response("event: x\ndata: y\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  const result = await applySessionListVisibilityFilter(LIMITED_USER, response);
  assert.equal(result, response);
});

test("status 404 -> the same Response object", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const response = jsonResponse({ error: "not found" }, 404);
  const result = await applySessionListVisibilityFilter(LIMITED_USER, response);
  assert.equal(result, response);
});

test("status 502 -> the same Response object", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const response = jsonResponse({ error: "bad gateway" }, 502);
  const result = await applySessionListVisibilityFilter(LIMITED_USER, response);
  assert.equal(result, response);
});

test("valid payload -> filtered sessions and runningSessionIds", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const response = jsonResponse(PAYLOAD);
  const result = await applySessionListVisibilityFilter(LIMITED_USER, response);
  assert.notEqual(result, response);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(
    body.sessions.map((s) => s.id).sort(),
    ["s-granted", "s-worktree"],
  );
  assert.deepEqual(body.runningSessionIds, ["s-granted"]);
});

test("payload missing a `sessions` key -> passthrough of the original text", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const text = JSON.stringify({ notSessions: true });
  const response = new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  const result = await applySessionListVisibilityFilter(LIMITED_USER, response);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), text);
});

test("entry with neither cwd nor projectRoot is dropped, list still 200 (never a 500)", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const payload = {
    sessions: [
      { id: "s-ok", cwd: "/opt/granted/a", projectRoot: "/opt/granted/a" },
      { id: "s-malformed", name: "no anchors at all" },
    ],
    runningSessionIds: ["s-ok", "s-malformed"],
  };
  const result = await applySessionListVisibilityFilter(LIMITED_USER, jsonResponse(payload));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.sessions.map((s) => s.id), ["s-ok"]);
  assert.deepEqual(body.runningSessionIds, ["s-ok"]);
});

test("entry missing cwd but carrying a granted projectRoot is kept (projectRoot is a visibility anchor)", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const payload = {
    sessions: [
      { id: "s-wt", projectRoot: "/opt/granted/b" },
      { id: "s-other", cwd: "/opt/other", projectRoot: "/opt/other" },
    ],
    runningSessionIds: [],
  };
  const result = await applySessionListVisibilityFilter(LIMITED_USER, jsonResponse(payload));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.sessions.map((s) => s.id), ["s-wt"]);
});

test("invalid JSON -> original text re-wrapped with the same status", async () => {
  const { applySessionListVisibilityFilter } = await loadSubject();
  const text = "not json{{{";
  const response = new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  const result = await applySessionListVisibilityFilter(LIMITED_USER, response);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), text);
});

test("isSessionListProxyPath matches only GET /api/sessions", async () => {
  const { isSessionListProxyPath } = await loadSubject();
  assert.equal(isSessionListProxyPath("GET", "/api/sessions"), true);
  assert.equal(isSessionListProxyPath("POST", "/api/sessions"), false);
  assert.equal(isSessionListProxyPath("GET", "/api/sessions/some-id"), false);
  assert.equal(isSessionListProxyPath("GET", "/api/health"), false);
});

const STATIC_LIST = {
  machineId: "gpu-1",
  mappings: [
    { id: "m-visible", projectRoot: "/opt/granted/a" },
    { id: "m-worktree", projectRoot: "/opt/granted/b" },
    { id: "m-hidden", projectRoot: "/opt/other" },
    { id: "m-legacy" },
  ],
};

test("static list filter: non-admin keeps only project-visible rows; legacy stays hidden", async () => {
  const { applyStaticMappingListVisibilityFilter } = await loadSubject();
  const result = await applyStaticMappingListVisibilityFilter(LIMITED_USER, jsonResponse(STATIC_LIST));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.mappings.map((m) => m.id), ["m-visible", "m-worktree"]);
  assert.equal(body.machineId, "gpu-1");
});

test("static list filter: '*' visibility keeps rooted rows but still hides legacy", async () => {
  const { applyStaticMappingListVisibilityFilter } = await loadSubject();
  const result = await applyStaticMappingListVisibilityFilter(STAR_USER, jsonResponse(STATIC_LIST));
  const body = await result.json();
  assert.deepEqual(body.mappings.map((m) => m.id), ["m-visible", "m-worktree", "m-hidden"]);
});

test("static list filter: admin response passes through unbuffered", async () => {
  const { applyStaticMappingListVisibilityFilter } = await loadSubject();
  const response = jsonResponse(STATIC_LIST);
  assert.equal(await applyStaticMappingListVisibilityFilter(ADMIN, response), response);
});

test("static list filter: non-200 and non-JSON pass through untouched", async () => {
  const { applyStaticMappingListVisibilityFilter } = await loadSubject();
  const error = jsonResponse({ error: "boom" }, 502);
  assert.equal(await applyStaticMappingListVisibilityFilter(LIMITED_USER, error), error);
  const sse = new Response("event: x\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  assert.equal(await applyStaticMappingListVisibilityFilter(LIMITED_USER, sse), sse);
});

test("static item read filter: hidden or legacy row reads as 404 for non-admins", async () => {
  const { applyStaticMappingItemVisibilityFilter } = await loadSubject();
  const hidden = await applyStaticMappingItemVisibilityFilter(LIMITED_USER, jsonResponse({ mapping: { id: "m-hidden", projectRoot: "/opt/other" } }));
  assert.equal(hidden.status, 404);
  const legacy = await applyStaticMappingItemVisibilityFilter(STAR_USER, jsonResponse({ mapping: { id: "m-legacy" } }));
  assert.equal(legacy.status, 404);
  const visible = await applyStaticMappingItemVisibilityFilter(LIMITED_USER, jsonResponse({ mapping: { id: "m-visible", projectRoot: "/opt/granted/a" } }));
  assert.equal(visible.status, 200);
  assert.equal((await visible.json()).mapping.id, "m-visible");
  const adminResponse = jsonResponse({ mapping: { id: "m-legacy" } });
  assert.equal(await applyStaticMappingItemVisibilityFilter(ADMIN, adminResponse), adminResponse);
});

test("static mutation gate: visible row proceeds, hidden/legacy denied, admin skips the probe", async () => {
  const { staticMappingMutationGate } = await loadSubject();
  let probes = 0;
  const row = (mapping) => async () => {
    probes += 1;
    return jsonResponse({ mapping });
  };

  assert.equal(await staticMappingMutationGate(LIMITED_USER, row({ id: "m-visible", projectRoot: "/opt/granted/a" })), null);
  const hidden = await staticMappingMutationGate(LIMITED_USER, row({ id: "m-hidden", projectRoot: "/opt/other" }));
  assert.equal(hidden.status, 404);
  const legacy = await staticMappingMutationGate(STAR_USER, row({ id: "m-legacy" }));
  assert.equal(legacy.status, 404);

  const before = probes;
  assert.equal(await staticMappingMutationGate(ADMIN, row({ id: "m-hidden", projectRoot: "/opt/other" })), null);
  assert.equal(probes, before, "admin must not probe");
});

test("static mutation gate: upstream errors surface; transport failure is fail-closed 502", async () => {
  const { staticMappingMutationGate } = await loadSubject();
  const notFound = await staticMappingMutationGate(LIMITED_USER, async () => jsonResponse({ error: "Static mapping not found" }, 404));
  assert.equal(notFound.status, 404);
  const unreachable = await staticMappingMutationGate(LIMITED_USER, async () => {
    throw new Error("connection refused");
  });
  assert.equal(unreachable.status, 502);
});

test("static mutation gate: a probe that cannot confirm a visible row fails closed (never forwards)", async () => {
  const { staticMappingMutationGate } = await loadSubject();
  // 200 but non-JSON: must not pass the probe body through as a success.
  const nonJson = await staticMappingMutationGate(LIMITED_USER, async () =>
    new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
  assert.equal(nonJson.status, 404);
  // 200 JSON but unparseable: fail closed, body not consumed-and-dropped.
  const badJson = await staticMappingMutationGate(LIMITED_USER, async () =>
    new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(badJson.status, 404);
  // 200 JSON without a mapping object: fail closed.
  const noMapping = await staticMappingMutationGate(LIMITED_USER, async () => jsonResponse({ ok: true }));
  assert.equal(noMapping.status, 404);
});

test("static proxy path predicates match only their exact surfaces", async () => {
  const {
    isStaticMappingListProxyPath,
    isStaticMappingItemReadProxyPath,
    isStaticMappingMutationProxyPath,
    isStaticMappingCreateProxyPath,
  } = await loadSubject();
  assert.equal(isStaticMappingListProxyPath("GET", "/api/static-mappings"), true);
  assert.equal(isStaticMappingListProxyPath("POST", "/api/static-mappings"), false);
  assert.equal(isStaticMappingListProxyPath("GET", "/api/static-mappings/x"), false);
  assert.equal(isStaticMappingItemReadProxyPath("GET", "/api/static-mappings/x"), true);
  assert.equal(isStaticMappingItemReadProxyPath("GET", "/api/static-mappings"), false);
  assert.equal(isStaticMappingMutationProxyPath("PATCH", "/api/static-mappings/x"), true);
  assert.equal(isStaticMappingMutationProxyPath("DELETE", "/api/static-mappings/x"), true);
  assert.equal(isStaticMappingMutationProxyPath("GET", "/api/static-mappings/x"), false);
  assert.equal(isStaticMappingMutationProxyPath("POST", "/api/static-mappings"), false);
  assert.equal(isStaticMappingCreateProxyPath("POST", "/api/static-mappings"), true);
  assert.equal(isStaticMappingCreateProxyPath("GET", "/api/static-mappings"), false);
  assert.equal(isStaticMappingCreateProxyPath("POST", "/api/static-mappings/x"), false);
});
