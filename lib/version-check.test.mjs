import assert from "node:assert/strict";
// `bun:test` (not `node:test`) — bun 1.3.x cannot run `node:test`'s runner
// across multiple files in one `bun test` invocation; see
// lib/title-annotations.test.ts for the same choice.
import { test } from "bun:test";
import { serverVersionFromHealth, shouldShowBanner } from "./version-check.ts";

test("serverVersionFromHealth: extracts a non-empty ompWebVersion string", () => {
  assert.equal(
    serverVersionFromHealth({ ok: true, ompWebVersion: "0.5.4", ompVersion: "17.3.0" }),
    "0.5.4",
  );
});

test("serverVersionFromHealth: missing field yields undefined", () => {
  assert.equal(serverVersionFromHealth({ ok: true }), undefined);
  assert.equal(serverVersionFromHealth({}), undefined);
});

test("serverVersionFromHealth: non-string or empty values yield undefined", () => {
  assert.equal(serverVersionFromHealth({ ompWebVersion: 7 }), undefined);
  assert.equal(serverVersionFromHealth({ ompWebVersion: null }), undefined);
  assert.equal(serverVersionFromHealth({ ompWebVersion: "" }), undefined);
});

test("serverVersionFromHealth: non-object payloads yield undefined", () => {
  assert.equal(serverVersionFromHealth(null), undefined);
  assert.equal(serverVersionFromHealth("0.5.4"), undefined);
  assert.equal(serverVersionFromHealth(42), undefined);
});

test("shouldShowBanner: mismatched versions show the banner", () => {
  assert.equal(shouldShowBanner("0.3.8", "0.5.4", null), true);
});

test("shouldShowBanner: rollback (server older than client) also shows", () => {
  assert.equal(shouldShowBanner("0.5.4", "0.3.8", null), true);
});

test("shouldShowBanner: matching versions never show", () => {
  assert.equal(shouldShowBanner("0.5.4", "0.5.4", null), false);
});

test("shouldShowBanner: unknown or empty versions never show", () => {
  assert.equal(shouldShowBanner(undefined, "0.5.4", null), false);
  assert.equal(shouldShowBanner("0.3.8", undefined, null), false);
  assert.equal(shouldShowBanner("", "0.5.4", null), false);
  assert.equal(shouldShowBanner("0.3.8", "", null), false);
});

test("shouldShowBanner: dismissal suppresses only the dismissed server version", () => {
  // Same mismatch the user dismissed: stays hidden on every later poll.
  assert.equal(shouldShowBanner("0.3.8", "0.5.4", "0.5.4"), false);
  // A further upgrade re-shows the banner.
  assert.equal(shouldShowBanner("0.3.8", "0.5.5", "0.5.4"), true);
  // A rollback to an unseen server version re-shows too.
  assert.equal(shouldShowBanner("0.5.4", "0.3.8", "0.5.3"), true);
});

test("shouldShowBanner: matching versions stay hidden regardless of dismissal", () => {
  assert.equal(shouldShowBanner("0.5.4", "0.5.4", "0.5.3"), false);
});
