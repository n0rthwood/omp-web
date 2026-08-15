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
    ["POST", "/api/skills/search"],
    ["GET", "/api/skills"],
    ["GET", "/api/terminals/term-1/events"],
    ["POST", "/api/terminals/term-1/input"],
    ["DELETE", "/api/terminals/term-1"],
    ["POST", "/api/worktrees"],
    ["GET", "/api/theme"],
    ["GET", "/api/updates"],
    ["POST", "/api/cwd/validate"],
    ["GET", "/api/home"],
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
});

test("denies methods a route does not export", () => {
  assert.equal(isProxyablePath("POST", "/api/sessions"), false);
  assert.equal(isProxyablePath("DELETE", "/api/agent/new"), false);
  assert.equal(isProxyablePath("PUT", "/api/settings"), false);
  assert.equal(isProxyablePath("POST", "/api/git/status"), false);
  assert.equal(isProxyablePath("GET", "/api/cwd/validate"), false);
  assert.equal(isProxyablePath("PUT", "/api/terminals/term-1/input"), false);
});

test("lowercase methods and trailing slashes normalize", () => {
  assert.equal(isProxyablePath("get", "/api/sessions"), true);
  assert.equal(isProxyablePath("GET", "/api/sessions/"), true);
  assert.equal(isProxyablePath("post", "/api/auth/web-login"), false);
});
