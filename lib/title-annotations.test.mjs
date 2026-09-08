import assert from "node:assert/strict";
import test from "node:test";
import { parseTitleAnnotations } from "./title-annotations.ts";

test("no annotation prefix returns full text and null annotations", () => {
  const r = parseTitleAnnotations("Fix the SSE reconnect");
  assert.equal(r.text, "Fix the SSE reconnect");
  assert.equal(r.annotations, null);
});

test("single main issue", () => {
  const r = parseTitleAnnotations("(#12) Fix fleet proxy visibility");
  assert.deepEqual(r.annotations, { main: [12], related: [] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("many main issues", () => {
  const r = parseTitleAnnotations("(#12 · #13) Fix fleet proxy visibility");
  assert.deepEqual(r.annotations, { main: [12, 13], related: [] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("single related issue", () => {
  const r = parseTitleAnnotations("(rel #10) Fix fleet proxy visibility");
  assert.deepEqual(r.annotations, { main: [], related: [10] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("many related issues", () => {
  const r = parseTitleAnnotations("(rel #10, #7) Fix fleet proxy visibility");
  assert.deepEqual(r.annotations, { main: [], related: [10, 7] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("combined prefix splits main and related", () => {
  const r = parseTitleAnnotations("(#14 · rel #10, #7) Fix fleet proxy visibility");
  assert.deepEqual(r.annotations, { main: [14], related: [10, 7] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("combined prefix with many main and many related", () => {
  const r = parseTitleAnnotations("(#12 · #13 · rel #10, #7) Fix login redirect");
  assert.deepEqual(r.annotations, { main: [12, 13], related: [10, 7] });
  assert.equal(r.text, "Fix login redirect");
});

test("parenthetical not at the start is treated as plain text", () => {
  const r = parseTitleAnnotations("Fix (#12) the reconnect logic");
  assert.equal(r.text, "Fix (#12) the reconnect logic");
  assert.equal(r.annotations, null);
});

test("plain parenthetical with no issue numbers is not an annotation", () => {
  const r = parseTitleAnnotations("(v2) Ship the release");
  assert.equal(r.text, "(v2) Ship the release");
  assert.equal(r.annotations, null);
});

test("empty parens are not an annotation", () => {
  const r = parseTitleAnnotations("() Ship the release");
  assert.equal(r.text, "() Ship the release");
  assert.equal(r.annotations, null);
});

test("extracts issue numbers as number[], not strings", () => {
  const r = parseTitleAnnotations("(#14 · rel #10, #7) Fix fleet proxy visibility");
  assert.deepEqual(r.annotations.main, [14]);
  assert.deepEqual(r.annotations.related, [10, 7]);
  for (const n of [...r.annotations.main, ...r.annotations.related]) {
    assert.equal(typeof n, "number");
  }
});

test("consumes the whitespace between the prefix and the text", () => {
  const r = parseTitleAnnotations("(#12)   Fix fleet proxy visibility");
  assert.equal(r.text, "Fix fleet proxy visibility");
});
