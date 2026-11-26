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
const { ProviderModelTable } = await jiti.import("./ProviderModelTable.tsx");
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
