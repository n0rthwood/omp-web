import assert from "node:assert/strict";
import test from "node:test";
import { isProxyablePath } from "./proxy-allowlist.ts";

test("allows a representative path per route family", () => {
  const allowed = [
    ["GET", "/api/sessions"],
    ["GET", "/api/sessions/abc123"],
    ["PATCH", "/api/sessions/abc123"],
    ["DELETE", "/api/sessions/abc123"],
    ["GET", "/api/sessions/abc123/entries/e1/thinking"],
    ["GET", "/api/sessions/abc123/export"],
    ["POST", "/api/agent/new"],
    ["GET", "/api/agent/abc123"],
    ["GET", "/api/agent/abc123/events"],
    ["POST", "/api/agent/abc123/uploads"],
    ["GET", "/api/agent/running/events"],
    ["POST", "/api/agent/abc123"],
    ["GET", "/api/auth/providers"],
    ["POST", "/api/auth/login/openai"],
    ["GET", "/api/files/home/user/notes.txt"],
    ["POST", "/api/files/home/user/notes.txt"],
    ["GET", "/api/git/status"],
    ["GET", "/api/health"],
    ["GET", "/api/models"],
    ["PUT", "/api/models-config"],
    ["GET", "/api/provider-status"],
    ["POST", "/api/skills/search"],
    ["GET", "/api/skills"],
    ["GET", "/api/service/restart"],
    ["POST", "/api/service/restart"],
    ["GET", "/api/terminals/term-1/events"],
    ["POST", "/api/terminals/term-1/input"],
    ["DELETE", "/api/terminals/term-1"],
    ["POST", "/api/worktrees"],
    ["GET", "/api/theme"],
    ["GET", "/api/updates"],
    ["POST", "/api/cwd/validate"],
    ["GET", "/api/home"],
    ["GET", "/api/static-mappings"],
    ["POST", "/api/static-mappings"],
    ["GET", "/api/static-mappings/map-1"],
    ["PATCH", "/api/static-mappings/map-1"],
    ["DELETE", "/api/static-mappings/map-1"],
    ["GET", "/api/static/map-1"],
    ["GET", "/api/static/map-1/index.html"],
    ["GET", "/api/static/map-1/assets/app.js"],
  ];
  for (const [method, path] of allowed) {
    assert.equal(isProxyablePath(method, path), true, `${method} ${path}`);
  }
});

test("denies fleet and user-management surfaces outright", () => {
  const denied = [
    ["GET", "/api/machines"],
    ["POST", "/api/machines"],
    ["GET", "/api/machines/remote-1/api/sessions"], // no fleet-in-fleet recursion
    ["GET", "/api/machines/health"], // the aggregate route is gateway-local, never proxied
    ["PATCH", "/api/machines/remote-1"],
    ["DELETE", "/api/machines/remote-1"],
    ["GET", "/api/web-users"],
    ["POST", "/api/web-users"],
    ["PATCH", "/api/web-users/omp"],
    ["DELETE", "/api/web-users/alice/tokens/laptop"],
    ["POST", "/api/auth/web-login"],
    ["POST", "/api/auth/web-logout"],
    ["POST", "/api/updates"], // self-update through the proxy: never
  ];
  for (const [method, path] of denied) {
    assert.equal(isProxyablePath(method, path), false, `${method} ${path}`);
  }
});

test("denies unknown paths", () => {
  assert.equal(isProxyablePath("GET", "/api/no-such-route"), false);
  assert.equal(isProxyablePath("GET", "/api/sessions/abc/entries"), false);
  assert.equal(isProxyablePath("GET", "/api/v2/sessions"), false);
  assert.equal(isProxyablePath("GET", "/api"), false);
  assert.equal(isProxyablePath("GET", "/health"), false);
  assert.equal(isProxyablePath("GET", "/api/static"), false);
});

test("denies methods a route does not export", () => {
  assert.equal(isProxyablePath("POST", "/api/sessions"), false);
  assert.equal(isProxyablePath("DELETE", "/api/agent/new"), false);
  assert.equal(isProxyablePath("PUT", "/api/settings"), false);
  assert.equal(isProxyablePath("POST", "/api/git/status"), false);
  assert.equal(isProxyablePath("POST", "/api/provider-status"), false);
  assert.equal(isProxyablePath("GET", "/api/cwd/validate"), false);
  assert.equal(isProxyablePath("PUT", "/api/terminals/term-1/input"), false);
  assert.equal(isProxyablePath("GET", "/api/agent/abc123/uploads"), false);
  assert.equal(isProxyablePath("POST", "/api/static/map-1"), false);
  assert.equal(isProxyablePath("POST", "/api/static/map-1/index.html"), false);
});

test("lowercase methods and trailing slashes normalize", () => {
  assert.equal(isProxyablePath("get", "/api/sessions"), true);
  assert.equal(isProxyablePath("GET", "/api/sessions/"), true);
  assert.equal(isProxyablePath("post", "/api/auth/web-login"), false);
});

test("dot segments cannot smuggle a denied route past the table", () => {
  // `fetch` resolves the URL before sending it, so a table match on the
  // unresolved path would authorize /api/files/* and request /api/web-users.
  const smuggled = [
    ["POST", "/api/files/../../api/web-users/omp/tokens"],
    ["GET", "/api/files/../../api/web-users"],
    ["GET", "/api/files/../../api/machines"],
    ["POST", "/api/files/../../api/updates"],
    ["POST", "/api/files/../../api/auth/web-login"],
    ["GET", "/api/files/.././../api/web-users"],
    ["GET", "/api/files/./notes.txt"],
    ["GET", "/api/sessions/.."],
    ["GET", "/api/files//notes.txt"],
  ];
  for (const [method, path] of smuggled) {
    assert.equal(isProxyablePath(method, path), false, `${method} ${path} must not be proxyable`);

    // Belt and braces: whatever the table says, the resolved path must never
    // be one of the surfaces the deny list names.
    const resolved = new URL(path, "http://remote.test").pathname;
    const denied = resolved === "/api/machines" || resolved.startsWith("/api/machines/")
      || resolved === "/api/web-users" || resolved.startsWith("/api/web-users/")
      || resolved === "/api/auth/web-login" || resolved === "/api/auth/web-logout"
      || (method === "POST" && resolved === "/api/updates");
    if (denied) assert.equal(isProxyablePath(method, resolved), false, `${method} ${resolved} is a denied surface`);
  }
});

test("allows only the provider refresh POST through the transport allow-list", () => {
  const path = "/api/models-config/refresh-provider";
  assert.equal(isProxyablePath("POST", path), true);
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    assert.equal(isProxyablePath(method, path), false, `${method} must not be proxyable`);
  }
  assert.equal(isProxyablePath("POST", `${path}/other`), false);
});
