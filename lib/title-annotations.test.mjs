import assert from "node:assert/strict";
import test from "node:test";
import { parseTitleAnnotations } from "./title-annotations.ts";

test("no suffix returns full text and null annotations", () => {
  const r = parseTitleAnnotations("Fix the SSE reconnect");
  assert.equal(r.text, "Fix the SSE reconnect");
  assert.equal(r.annotations, null);
});

test("single main issue", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (#12)");
  assert.deepEqual(r.annotations, { main: [12], related: [] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("many main issues", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (#12 · #13)");
  assert.deepEqual(r.annotations, { main: [12, 13], related: [] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("single related issue", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (rel #10)");
  assert.deepEqual(r.annotations, { main: [], related: [10] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("many related issues", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (rel #10, #7)");
  assert.deepEqual(r.annotations, { main: [], related: [10, 7] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("combined suffix splits main and related", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (#14 · rel #10, #7)");
  assert.deepEqual(r.annotations, { main: [14], related: [10, 7] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});

test("combined suffix with many main and many related", () => {
  const r = parseTitleAnnotations("Fix login redirect (#12 · #13 · rel #10, #7)");
  assert.deepEqual(r.annotations, { main: [12, 13], related: [10, 7] });
  assert.equal(r.text, "Fix login redirect");
});

test("suffix not at end is treated as plain text", () => {
  const r = parseTitleAnnotations("Fix (#12) the reconnect logic");
  assert.equal(r.text, "Fix (#12) the reconnect logic");
  assert.equal(r.annotations, null);
});

test("plain parenthetical with no issue numbers is not an annotation", () => {
  const r = parseTitleAnnotations("Ship the release (v2)");
  assert.equal(r.text, "Ship the release (v2)");
  assert.equal(r.annotations, null);
});

test("empty parens are not an annotation", () => {
  const r = parseTitleAnnotations("Ship the release ()");
  assert.equal(r.text, "Ship the release ()");
  assert.equal(r.annotations, null);
});

test("extracts issue numbers as number[], not strings", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (#14 · rel #10, #7)");
  assert.deepEqual(r.annotations.main, [14]);
  assert.deepEqual(r.annotations.related, [10, 7]);
  for (const n of [...r.annotations.main, ...r.annotations.related]) {
    assert.equal(typeof n, "number");
  }
});

test("trims whitespace before the suffix from the returned text", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility   (#12)");
  assert.equal(r.text, "Fix fleet proxy visibility");
});
