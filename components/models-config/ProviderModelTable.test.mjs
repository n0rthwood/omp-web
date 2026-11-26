// Provider model table: whole-row dimming (issue #145, mockup `tr.dim`).
// Individually runnable: bun test components/models-config/ProviderModelTable.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ProviderModelTable, filterProviderModelRows } = await jiti.import("./ProviderModelTable.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");

const ROWS = [
  { id: "claude-opus-5", source: "catalog", configIndex: null, entry: { id: "claude-opus-5" } },
  { id: "claude-sonnet-5", source: "catalog", configIndex: null, entry: { id: "claude-sonnet-5" } },
];

function render(props = {}) {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ProviderModelTable, {
        providerName: "anthropic",
        rows: ROWS,
        canAddModel: false,
        onUpdateModel: () => {},
        onOverrideModel: () => {},
        onCreateModel: () => {},
        ...props,
      }),
    ),
  );
  return [...html.matchAll(/<tr data-testid="provider-model-row" data-model-id="([^"]+)"([^>]*)>/g)]
    .map((match) => ({ id: match[1], attrs: match[2] }));
}

function renderHtml(props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ProviderModelTable, {
        providerName: "anthropic",
        rows: ROWS,
        canAddModel: false,
        onUpdateModel: () => {},
        onOverrideModel: () => {},
        onCreateModel: () => {},
        ...props,
      }),
    ),
  );
}

test("the table scrolls horizontally inside a styled scrollbar box", () => {
  const html = renderHtml();
  assert.match(html, /class="model-table-scroll"/);
  assert.match(html, /overflow-x:auto/);
  assert.doesNotMatch(html, /class="model-table-scroll"[^>]*overflow:hidden/);
});

test("catalog costs are rounded and zero stays 0", () => {
  const html = renderHtml({
    rows: [{ id: "m", source: "catalog", configIndex: null, entry: { id: "m", cost: { input: 0.45499999999999996, output: 1.8199999999999998 } } }],
  });
  assert.ok(html.includes("0.455 / 1.82"), html.slice(html.indexOf("0.455") - 80, html.indexOf("0.455") + 40));
  assert.doesNotMatch(html, /0\.45499999999999996/);
  assert.doesNotMatch(html, /1\.8199999999999998/);
  const zero = renderHtml({ rows: [{ id: "z", source: "catalog", configIndex: null, entry: { id: "z", cost: { input: 0, output: 0 } } }] });
  assert.ok(zero.includes("0 / 0"));
});

test("an OAuth provider with no login dims every row", () => {
  const rows = render({ loggedOut: true });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.attrs, /data-dimmed="true"/);
    assert.match(row.attrs, /color:var\(--text-dim\)/);
  }
});

test("a logged-in provider keeps its rows at full strength", () => {
  for (const row of render({ loggedOut: false })) {
    assert.doesNotMatch(row.attrs, /data-dimmed/);
    assert.doesNotMatch(row.attrs, /--text-dim/);
  }
});

test("a model the scan could not verify is dimmed on its own", () => {
  const rows = render({ health: { "anthropic/claude-sonnet-5": { state: "unverified" } } });
  assert.doesNotMatch(rows.find((row) => row.id === "claude-opus-5").attrs, /data-dimmed/);
  assert.match(rows.find((row) => row.id === "claude-sonnet-5").attrs, /data-dimmed="true"/);
});

const FILTER_ROWS = [
  { id: "anthropic/claude-sonnet-5", source: "catalog", configIndex: null, entry: { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" } },
  { id: "openrouter/free-model:free", source: "catalog", configIndex: null, entry: { id: "openrouter/free-model:free", name: "Free Model" } },
  { id: "openrouter/other:free", source: "catalog", configIndex: null, entry: { id: "openrouter/other:free", name: "Other Free" } },
  { id: "zhipu-coding-plan/glm-5.3", source: "catalog", configIndex: null, entry: { id: "zhipu-coding-plan/glm-5.3", name: "GLM 5.3" } },
];

test("the filter box sits above the table with a match count", () => {
  const html = renderHtml({ rows: FILTER_ROWS, filter: "" });
  assert.match(html, /data-testid="provider-model-filter"/);
  assert.match(html, /placeholder="Filter by id or name…"/);
  assert.match(html, /provider-model-filter-count"[^>]*>4 \/ 4</);
});

test("free narrows the table to ids containing free", () => {
  assert.deepEqual(filterProviderModelRows(FILTER_ROWS, "free").map((row) => row.id), ["openrouter/free-model:free", "openrouter/other:free"]);
  const html = renderHtml({ rows: FILTER_ROWS, filter: "free" });
  assert.match(html, /provider-model-filter-count"[^>]*>2 \/ 4</);
  assert.doesNotMatch(html, /data-model-id="anthropic\/claude-sonnet-5"/);
  assert.doesNotMatch(html, /data-model-id="zhipu-coding-plan\/glm-5.3"/);
});

test("SONNET matches case-insensitively on id and display name", () => {
  assert.deepEqual(filterProviderModelRows(FILTER_ROWS, "SONNET").map((row) => row.id), ["anthropic/claude-sonnet-5"]);
  assert.deepEqual(filterProviderModelRows(FILTER_ROWS, "sonnet").map((row) => row.id), ["anthropic/claude-sonnet-5"]);
  assert.match(renderHtml({ rows: FILTER_ROWS, filter: "Sonnet" }), /data-model-id="anthropic\/claude-sonnet-5"/);
});

test("a query with no matches renders the empty state", () => {
  const html = renderHtml({ rows: FILTER_ROWS, filter: "zzz" });
  assert.match(html, /data-testid="provider-model-filter-empty"/);
  assert.match(html, /No model matches “zzz”/);
  assert.doesNotMatch(html, /data-testid="provider-model-row"/);
  assert.match(html, /provider-model-filter-count"[^>]*>0 \/ 4</);
  assert.match(html, /data-testid="provider-model-filter-clear"/);
});

test("clearing the filter restores every row", () => {
  const cleared = renderHtml({ rows: FILTER_ROWS, filter: "" });
  assert.equal((cleared.match(/data-testid="provider-model-row"/g) ?? []).length, 4);
  assert.match(cleared, /provider-model-filter-count"[^>]*>4 \/ 4</);
  assert.doesNotMatch(cleared, /data-testid="provider-model-filter-clear"/);
  assert.doesNotMatch(cleared, /provider-model-filter-empty/);
});
