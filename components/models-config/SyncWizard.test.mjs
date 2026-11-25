import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SyncWizard } = await jiti.import("./SyncWizard.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const { enLocale } = await jiti.import("../../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../../lib/i18n/messages/zh-CN.ts");

const MACHINES = [
  { id: "box-202", name: "172.30.3.202" },
  { id: "box-39", name: "172.30.3.39" },
];

function render(props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SyncWizard, {
        open: true,
        onClose: () => {},
        initialSections: ["providers", "roles", "enabledModels"],
        machines: MACHINES,
        ...props,
      }),
    ),
  );
}

function section(html, name) {
  const start = html.indexOf(`data-testid="sync-section-${name}"`);
  assert.ok(start >= 0, `section ${name} is rendered`);
  const next = html.indexOf('data-testid="sync-section-', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

test("step 1 presets sections from the entry point and marks OAuth as excluded", () => {
  const html = render({ initialSections: ["roles"] });
  assert.match(html, /data-testid="sync-wizard"/);
  assert.match(section(html, "roles"), /checked/);
  assert.doesNotMatch(section(html, "providers"), /checked/);
  assert.doesNotMatch(section(html, "enabledModels"), /checked/);
  assert.match(html, /anthropic \/ openai-codex \/ xai-oauth/);
});

test("the allow-list entry point presets only enabledModels", () => {
  const html = render({ initialSections: ["enabledModels"] });
  assert.match(section(html, "enabledModels"), /checked/);
  assert.doesNotMatch(section(html, "roles"), /checked/);
  assert.doesNotMatch(section(html, "providers"), /checked/);
});

test("a closed wizard renders nothing", () => {
  assert.equal(render({ open: false }), "");
});

test("step 1 offers no target list until step 2 and the next button is gated on a selection", () => {
  const html = render({ initialSections: ["providers"] });
  assert.doesNotMatch(html, /data-testid="sync-target-box-202"/);
  assert.match(html, /data-testid="sync-next"/);
  assert.match(html, /disabled/);
});

test("every wizard string is translated in both locales", () => {
  const keys = [
    "sync.title", "sync.source", "sync.close", "sync.step.sections", "sync.step.targets",
    "sync.step.push", "sync.section.providers", "sync.section.providersDetail", "sync.section.roles",
    "sync.section.rolesDetail", "sync.section.enabledModels", "sync.section.enabledModelsDetail",
    "sync.excludedNote", "sync.fallbackNote", "sync.targetsHint", "sync.noTargets", "sync.preflight",
    "sync.status.applied", "sync.status.skipped", "sync.status.failed", "sync.back", "sync.cancel",
    "sync.next", "sync.push", "sync.done",
  ];
  for (const key of keys) {
    assert.equal(typeof enLocale.messages[key], "string", `en missing ${key}`);
    assert.equal(typeof zhCNLocale.messages[key], "string", `zh-CN missing ${key}`);
    assert.notEqual(enLocale.messages[key], zhCNLocale.messages[key], `${key} is untranslated`);
  }
});