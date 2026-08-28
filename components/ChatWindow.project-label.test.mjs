import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { projectBasename } = await jiti.import("./ChatWindow.tsx");

test("projectBasename returns the last path segment", () => {
  assert.equal(projectBasename("/home/user/my-project"), "my-project");
});

test("projectBasename trims a trailing slash", () => {
  assert.equal(projectBasename("/home/user/my-project/"), "my-project");
});

test("projectBasename handles a bare root path by falling back to the input", () => {
  assert.equal(projectBasename("/"), "/");
});

test("projectBasename supports Windows-style separators", () => {
  assert.equal(projectBasename("C:\\Users\\dev\\my-project"), "my-project");
});
