// Allow-list overview: provider grouping, counts, collapse threshold, keyword
// narrowing (issue #147). The DOM interaction (toggle clicks) is covered by the
// integration stage's browser run; here the grouping is pure and the collapsed
// default is asserted on the rendered markup.
// Individually runnable: bun test components/models-config/AllowListTab.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AllowListOverview, OverviewGroup, buildAllowListOverview, overviewShowsIds, COLLAPSE_THRESHOLD } = await jiti.import("./AllowListOverview.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");

/** `{ provider: { hidden, visible } }` → a `?all=1`-shaped `modelList`. */
function fixture(spec) {
  const models = [];
  for (const [provider, counts] of Object.entries(spec)) {
    for (let i = 0; i < counts.hidden; i++) {
      models.push({ id: `${provider}-h${i}`, name: `${provider} h${i}`, provider, hidden: true });
    }
    for (let i = 0; i < counts.visible; i++) {
      models.push({ id: `${provider}-v${i}`, name: `${provider} v${i}`, provider, hidden: false });
    }
  }
  return models;
}

function renderHtml(models) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(AllowListOverview, { models })),
  );
}

test("no per-model verdict (older remote) renders no overview at all", () => {
  const models = fixture({ openrouter: { hidden: 0, visible: 3 } })
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }));
  const data = buildAllowListOverview(models);
  assert.equal(data.hasVerdicts, false);
  assert.deepEqual(data.groups, []);
  assert.equal(renderHtml(models), "");
});

test("providers with hidden models come first, most hidden first, then by name", () => {
  const data = buildAllowListOverview(fixture({
    "zhipu-coding-plan": { hidden: 0, visible: 18 },
    anthropic: { hidden: 22, visible: 7 },
    openrouter: { hidden: 629, visible: 7 },
    "bailian-token-plan": { hidden: 0, visible: 11 },
    xai: { hidden: 37, visible: 0 },
    "alibaba-token-plan": { hidden: 8, visible: 0 },
    "openai-codex": { hidden: 0, visible: 8 },
    joyai: { hidden: 0, visible: 2 },
  }));
  assert.deepEqual(data.groups.map((group) => group.provider), [
    "openrouter",
    "xai",
    "anthropic",
    "alibaba-token-plan",
    "bailian-token-plan",
    "joyai",
    "openai-codex",
    "zhipu-coding-plan",
  ]);
  assert.equal(data.hiddenTotal, 696);
  assert.equal(data.visibleTotal, 53);
  assert.equal(data.total, 749);
});

test("each group counts hidden and visible models and sorts its hidden ids", () => {
  const data = buildAllowListOverview(fixture({
    anthropic: { hidden: 2, visible: 7 },
    xai: { hidden: 0, visible: 2 },
  }));
  const anthropic = data.groups.find((group) => group.provider === "anthropic");
  assert.equal(anthropic.hidden.length, 2);
  assert.equal(anthropic.visible, 7);
  assert.equal(anthropic.total, 9);
  assert.deepEqual(anthropic.hidden, ["anthropic/anthropic-h0", "anthropic/anthropic-h1"]);
  const xai = data.groups.find((group) => group.provider === "xai");
  assert.equal(xai.hidden.length, 0);
  assert.equal(xai.visible, 2);
});

test("a provider with nothing hidden is a compact row: name and visible count only", () => {
  const html = renderHtml(fixture({ "zhipu-coding-plan": { hidden: 0, visible: 18 }, openrouter: { hidden: 1, visible: 7 } }));
  const row = html.slice(html.indexOf('data-provider="zhipu-coding-plan"'));
  const compact = row.slice(0, row.indexOf("</div>", row.indexOf("data-visible")));
  assert.match(compact, /18 visible/);
  assert.doesNotMatch(compact, />0 hidden</);
  assert.doesNotMatch(compact, /allow-list-overview-model/);
  assert.doesNotMatch(compact, /allow-list-overview-toggle/);
});

test("a group with more than 12 hidden models starts collapsed and lists its ids when expanded", () => {
  assert.equal(COLLAPSE_THRESHOLD, 12);

  const small = buildAllowListOverview(fixture({ anthropic: { hidden: 12, visible: 0 } }));
  assert.equal(small.groups[0].collapsedByDefault, false);
  const smallHtml = renderHtml(fixture({ anthropic: { hidden: 12, visible: 0 } }));
  assert.doesNotMatch(smallHtml, /allow-list-overview-toggle/);
  assert.match(smallHtml, /anthropic\/anthropic-h11/);

  const large = buildAllowListOverview(fixture({ openrouter: { hidden: 13, visible: 0 } }));
  assert.equal(large.groups[0].collapsedByDefault, true);
  const largeHtml = renderHtml(fixture({ openrouter: { hidden: 13, visible: 0 } }));
  assert.match(largeHtml, /allow-list-overview-toggle/);
  assert.match(largeHtml, /aria-expanded="false"/);
  assert.match(largeHtml, /Show all 13/);
  assert.doesNotMatch(largeHtml, /allow-list-overview-model/);
});

test("the keyword narrows the hidden ids, case-insensitively, and leaves the counts alone", () => {
  const models = fixture({ openrouter: { hidden: 3, visible: 7 } });
  models[0].id = "qwen4-max-preview";
  models[1].id = "qwen3-max";
  models[2].id = "deepseek-v4";
  const all = buildAllowListOverview(models);
  const narrowed = buildAllowListOverview(models, "  QWEN4 ");
  assert.deepEqual(narrowed.groups[0].matches, ["openrouter/qwen4-max-preview"]);
  assert.deepEqual(narrowed.groups[0].hidden, ["openrouter/deepseek-v4", "openrouter/qwen3-max", "openrouter/qwen4-max-preview"]);
  assert.equal(narrowed.groups[0].visible, 7);
  assert.equal(narrowed.hiddenTotal, 3);
  assert.equal(narrowed.matchedTotal, 1);
  assert.equal(all.matchedTotal, 3);
  assert.equal(buildAllowListOverview(models, "nope").matchedTotal, 0);
});

test("the summary line states the configured total and the hidden total", () => {
  const html = renderHtml(fixture({ openrouter: { hidden: 629, visible: 7 }, joyai: { hidden: 0, visible: 2 } }));
  assert.match(html, /638 models configured, 629 hidden by the allow-list/);
  assert.match(html, /data-testid="allow-list-overview"/);
});

test("an expanded large group lists every hidden id", () => {
  const group = buildAllowListOverview(fixture({ openrouter: { hidden: 629, visible: 7 } })).groups[0];
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(OverviewGroup, { group: { ...group, collapsedByDefault: false } })),
  );
  assert.equal([...html.matchAll(/data-testid="allow-list-overview-model"/g)].length, 629);
  assert.match(html, /openrouter\/openrouter-h628/);
});

test("a group that shrank to the threshold lists its ids even when it was mounted collapsed", () => {
  const large = buildAllowListOverview(fixture({ openrouter: { hidden: 13, visible: 0 } })).groups[0];
  assert.equal(large.collapsedByDefault, true);
  // Mounted while it was large and never opened: the seeded state is closed.
  assert.equal(overviewShowsIds(large, false, false), false);

  // The allow-list widens and the same group drops to the threshold. Its toggle
  // is gone, so the ids must be listed instead of staying stuck behind the
  // closed state it was mounted with.
  const shrunk = buildAllowListOverview(fixture({ openrouter: { hidden: 12, visible: 0 } })).groups[0];
  assert.equal(shrunk.collapsedByDefault, false);
  assert.equal(overviewShowsIds(shrunk, false, false), true);
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(OverviewGroup, { group: shrunk })),
  );
  assert.doesNotMatch(html, /allow-list-overview-toggle/);
  assert.equal([...html.matchAll(/data-testid="allow-list-overview-model"/g)].length, 12);
});

test("a filter shows a collapsed group's matches and drops its toggle", () => {
  const group = buildAllowListOverview(fixture({ openrouter: { hidden: 13, visible: 0 } })).groups[0];
  const narrowed = { ...group, matches: group.matches.filter((selector) => selector.endsWith("-h1")) };
  assert.deepEqual(narrowed.matches, ["openrouter/openrouter-h1"]);
  assert.equal(overviewShowsIds(narrowed, false, false), false);
  assert.equal(overviewShowsIds(narrowed, true, false), true);

  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(OverviewGroup, { group: narrowed, filterActive: true })),
  );
  assert.equal([...html.matchAll(/data-testid="allow-list-overview-model"/g)].length, 1);
  assert.match(html, /openrouter\/openrouter-h1</);
  assert.doesNotMatch(html, /allow-list-overview-toggle/);
});