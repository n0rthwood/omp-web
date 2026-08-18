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
