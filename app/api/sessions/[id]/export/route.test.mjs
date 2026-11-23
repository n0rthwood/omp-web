// Unit tests for the export custom-marker filter (#121 follow-up):
// the omp CLI export embeds the raw journal as base64 JSON in
// <script id="session-data">; out-of-band type:"custom" markers render as
// empty rows in the remote viewer. The filter drops ONLY those markers,
// re-links parentId chains and data.leafId through dropped customs (the
// viewer's buildTree pushes unknown-parent nodes as roots and boot navigates
// to leafId), and falls back to the original html on any malformed input.
// Pure unit test of the helper — no server spin-up.
// Individually runnable: bun test "app/api/sessions/[id]/export/route.test.mjs"
import assert from "node:assert/strict";
import test from "node:test";

const { stripCustomEntriesFromExportHtml } = await import("./route.ts");

function embed(data) {
  const b64 = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return `<!doctype html><html><head><title>export</title></head><body><div id="app">viewer</div><script id="session-data" type="application/json">${b64}</script><script src="https://build.stencil.so/export-viewer.js"></script></body></html>`;
}

function decode(html) {
  const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html);
  assert.ok(match, "session-data script tag must survive");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function msg(id, parentId, text) {
  return {
    type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text },
  };
}
function marker(id, parentId, customType) {
  return { type: "custom", id, parentId, customType, timestamp: "2026-01-01T00:00:00.000Z" };
}

test("drops only type:custom entries; rest of html byte-identical", () => {
  const entries = [
    msg("m1", null, "hello"),
    marker("c1", "m1", "tool_execution_start"),
    marker("c2", "c1", "system-prompt-digest"),
    msg("m2", "c2", "world"),
  ];
  const html = embed({ header: { id: "s1" }, entries, leafId: "m2" });
  const out = stripCustomEntriesFromExportHtml(html);
  assert.notEqual(out, html);
  const data = decode(out);
  assert.deepEqual(data.entries.map((e) => e.id), ["m1", "m2"]);
  assert.deepEqual(data.entries[0], entries[0]);
  // Outside the script tag the html must be untouched.
  const tagRe = /<script id="session-data" type="application\/json">[^<]*<\/script>/;
  assert.equal(out.replace(tagRe, "TAG"), html.replace(tagRe, "TAG"));
  // Untouched sibling fields survive.
  assert.deepEqual(data.header, { id: "s1" });
});

test("kept non-custom entry kinds pass through untouched", () => {
  const entries = [
    msg("m1", null, "q"),
    { type: "custom_message", id: "cm1", parentId: "m1", customType: "async-result", message: { role: "custom", content: "sub" } },
    { type: "model_usage", id: "mu1", parentId: "cm1", usage: { input: 1 } },
    { type: "title_change", id: "t1", parentId: "mu1", title: "T" },
    { type: "model_change", id: "mc1", parentId: "t1", model: "m" },
    marker("c1", "mc1", "omp-web:prompt-profile"),
  ];
  const out = stripCustomEntriesFromExportHtml(embed({ entries, leafId: "c1" }));
  const data = decode(out);
  assert.deepEqual(data.entries.map((e) => e.type), [
    "message", "custom_message", "model_usage", "title_change", "model_change",
  ]);
});

test("re-links parentId through dropped customs to nearest kept ancestor", () => {
  const entries = [
    msg("m1", null, "first"),
    marker("c1", "m1", "tool_execution_start"),
    marker("c2", "c1", "system-prompt-digest"),
    msg("m2", "c2", "second"),
    { type: "message", id: "tr1", parentId: "c2", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "toolResult", content: "ok" } },
  ];
  const data = decode(stripCustomEntriesFromExportHtml(embed({ entries, leafId: "tr1" })));
  assert.deepEqual(data.entries.map((e) => e.id), ["m1", "m2", "tr1"]);
  assert.equal(data.entries[1].parentId, "m1");
  assert.equal(data.entries[2].parentId, "m1");
});

test("custom chain rooted at null keeps children as roots (parentId null)", () => {
  const entries = [
    marker("c1", null, "system-prompt-digest"),
    msg("m1", "c1", "hello"),
  ];
  const data = decode(stripCustomEntriesFromExportHtml(embed({ entries, leafId: "m1" })));
  assert.deepEqual(data.entries.map((e) => e.id), ["m1"]);
  assert.equal(data.entries[0].parentId, null);
});

test("leafId pointing at a dropped custom is remapped to nearest kept ancestor", () => {
  const entries = [
    msg("m1", null, "q"),
    msg("m2", "m1", "a"),
    marker("c1", "m2", "tool_execution_start"),
    marker("c2", "c1", "omp-web:prompt-profile"),
  ];
  const data = decode(stripCustomEntriesFromExportHtml(embed({ entries, leafId: "c2" })));
  assert.equal(data.leafId, "m2");
  assert.deepEqual(data.entries.map((e) => e.id), ["m1", "m2"]);
});

test("leafId on a kept entry is untouched; subSessions left alone", () => {
  const sub = { entries: [marker("sc1", null, "tool_execution_start")], leafId: "sc1" };
  const entries = [msg("m1", null, "q"), marker("c1", "m1", "x")];
  const data = decode(stripCustomEntriesFromExportHtml(embed({ entries, leafId: "m1", subSessions: { "sub:1": sub } })));
  assert.equal(data.leafId, "m1");
  assert.deepEqual(data.subSessions, { "sub:1": sub });
});

test("no custom entries → original html returned verbatim", () => {
  const html = embed({ entries: [msg("m1", null, "q")], leafId: "m1" });
  assert.equal(stripCustomEntriesFromExportHtml(html), html);
});

test("html without the session-data script → unchanged", () => {
  const html = "<!doctype html><html><body>plain export, no data</body></html>";
  assert.equal(stripCustomEntriesFromExportHtml(html), html);
});

test("malformed base64 payload → unchanged", () => {
  const html = '<html><script id="session-data" type="application/json">!!!not-base64!!!</script></html>';
  assert.equal(stripCustomEntriesFromExportHtml(html), html);
});

test("valid base64 of non-JSON → unchanged", () => {
  const b64 = Buffer.from("this is not json", "utf8").toString("base64");
  const html = `<html><script id="session-data" type="application/json">${b64}</script></html>`;
  assert.equal(stripCustomEntriesFromExportHtml(html), html);
});

test("entries not an array → unchanged", () => {
  const html = embed({ entries: { nope: true }, leafId: "x" });
  assert.equal(stripCustomEntriesFromExportHtml(html), html);
});

test("payload without entries field → unchanged", () => {
  const html = embed({ header: { id: "s" }, leafId: "x" });
  assert.equal(stripCustomEntriesFromExportHtml(html), html);
});
