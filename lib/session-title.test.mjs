import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findFirstUserMessage, findFirstTitleSource, truncateTitle, isDeclinedTitle, normalizeWebGeneratedTitle, prependIssueAnnotationPrefix, shouldAutoGenerateTitle } = await jiti.import("./session-title.ts");

test("finds the first user message with usable text", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "image", data: "…", mimeType: "image/png" }] },
    { role: "user", content: [{ type: "text", text: "  Fix the SSE reconnect  " }] },
    { role: "user", content: "later" },
  ];
  assert.equal(findFirstUserMessage(messages), "Fix the SSE reconnect");
});

test("accepts plain string content", () => {
  assert.equal(findFirstUserMessage([{ role: "user", content: "Ship the release" }]), "Ship the release");
});

test("returns undefined when no user turn carries text", () => {
  assert.equal(findFirstUserMessage([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
});

test("collapses whitespace and caps the title length", () => {
  assert.equal(truncateTitle("  Improve   worktree\ngrouping "), "Improve worktree grouping");
  assert.equal(Array.from(truncateTitle("x".repeat(200))).length, 150);
});

test("normalizeWebGeneratedTitle accepts SDK-rejected 81-150 character web titles", () => {
  const title = "x".repeat(100);
  assert.equal(normalizeWebGeneratedTitle(`<title>${title}</title>`), title);
});

test("normalizeWebGeneratedTitle caps web titles at 150 characters", () => {
  const normalized = normalizeWebGeneratedTitle(`<title>${"x".repeat(160)}</title>`);
  assert.equal(Array.from(normalized).length, 150);
});

test("prependIssueAnnotationPrefix adds literal issue refs before local human-only titles", () => {
  assert.equal(
    prependIssueAnnotationPrefix("Fix login redirect", "Please fix #12; related context rel #10 and rel #7."),
    "(#12 · rel #10, #7) Fix login redirect",
  );
});

test("prependIssueAnnotationPrefix keeps local fallback titles within the 150 character web cap", () => {
  const result = prependIssueAnnotationPrefix("x".repeat(145), "Fix #14.");
  assert.equal(Array.from(result).length, 150);
  assert.match(result, /^\(#14/);
});

test("prependIssueAnnotationPrefix does not title a session from issue refs alone", () => {
  assert.equal(prependIssueAnnotationPrefix("", "Fix #14."), "");
});

test("prependIssueAnnotationPrefix places the annotation as a leading prefix, never a trailing suffix (regression guard for #47)", () => {
  const result = prependIssueAnnotationPrefix("Fix login redirect", "Please fix #12.");
  assert.match(result, /^\(#12\)\s/);
  assert.equal(result.endsWith("(#12)"), false);
});

test("prependIssueAnnotationPrefix leaves an exactly-150-character annotated title untruncated", () => {
  const base = "x".repeat(144);
  const result = prependIssueAnnotationPrefix(base, "Fix #14.");
  assert.equal(result, `(#14) ${base}`);
  assert.equal(Array.from(result).length, 150);
});

test("prependIssueAnnotationPrefix truncates a title past 150 characters without cutting the annotation prefix in half", () => {
  const result = prependIssueAnnotationPrefix("x".repeat(200), "Fix #14.");
  assert.equal(Array.from(result).length, 150);
  assert.equal(result.startsWith("(#14) "), true);
  assert.equal(result, `(#14) ${"x".repeat(144)}`);
});

test("falls back to the compaction summary after compaction removed all user messages", () => {
  const messages = [
    { role: "compactionSummary", summary: "  The session migrated worktrees and rebuilt the sidebar.  " },
  ];
  assert.equal(findFirstTitleSource(messages), "  The session migrated worktrees and rebuilt the sidebar.  ");
});

test("prefers a real user turn over the compaction summary", () => {
  const messages = [
    { role: "compactionSummary", summary: "stale summary" },
    { role: "user", content: "Fix the SSE reconnect" },
  ];
  assert.equal(findFirstTitleSource(messages), "Fix the SSE reconnect");
});

test("returns undefined when nothing can name the session", () => {
  assert.equal(findFirstTitleSource([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
  assert.equal(findFirstTitleSource([{ role: "compactionSummary", summary: "" }]), undefined);
});

test("isDeclinedTitle treats a literal none (any case) as a decline", () => {
  assert.equal(isDeclinedTitle("none"), true);
  assert.equal(isDeclinedTitle("None"), true);
  assert.equal(isDeclinedTitle("none issue"), false);
});

// --- shouldAutoGenerateTitle (issue #20 auto-title gate) ---

const TASK_OPENER = "Fix the flaky login redirect in the web app by tracing the auth middleware";

function gateInput(overrides = {}) {
  return {
    message: TASK_OPENER,
    hasSessionName: false,
    piNoTitle: undefined,
    extensionCommandNames: new Set(),
    ...overrides,
  };
}

test("an unnamed session with a real task opener is eligible for auto-titling", () => {
  assert.equal(shouldAutoGenerateTitle(gateInput()), true);
});

test("an already-named session (user- or auto-titled) is never re-titled by the auto trigger", () => {
  // The gate only distinguishes "named or not" — this blocks both user renames
  // and re-triggering on a name the auto path itself just set.
  assert.equal(shouldAutoGenerateTitle(gateInput({ hasSessionName: true })), false);
});

test("low-signal openers (greetings, acks, bare numbers) never trigger auto-titling", () => {
  for (const message of ["hi", "hello", "thanks", "ok", "sure", "42", "  "]) {
    assert.equal(shouldAutoGenerateTitle(gateInput({ message })), false, `expected "${message}" to be low-signal`);
  }
});

test("PI_NO_TITLE disables auto-titling even for a real task opener", () => {
  assert.equal(shouldAutoGenerateTitle(gateInput({ piNoTitle: "1" })), false);
});

test("a local extension command opener is never auto-titled", () => {
  const extensionCommandNames = new Set(["standup"]);
  assert.equal(
    shouldAutoGenerateTitle(gateInput({ message: "/standup ship the release notes", extensionCommandNames })),
    false,
  );
  // Bare command with no arguments still matches.
  assert.equal(shouldAutoGenerateTitle(gateInput({ message: "/standup", extensionCommandNames })), false);
});

test("a slash-prefixed message that is not a registered extension command still generates", () => {
  assert.equal(
    shouldAutoGenerateTitle(gateInput({ message: "/foo trace the auth middleware bug", extensionCommandNames: new Set() })),
    true,
  );
});

test("an unnamed, non-low-signal, non-command opener generates even when other sessions' commands are registered", () => {
  const extensionCommandNames = new Set(["standup", "release"]);
  assert.equal(shouldAutoGenerateTitle(gateInput({ extensionCommandNames })), true);
});
