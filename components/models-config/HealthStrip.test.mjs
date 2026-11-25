// Health strip + its details panel (issue #139; panel gaps closed by #145):
//   T1 no scan → nothing rendered.
//   T2 only credentials that failed are counted, never unconfigured providers.
//   T2 a clean scan shows one separator, not the label's own plus a second one.
//   T3 the panel lists the failures and the providers still usable.
//   T4 the "N min ago" clock ticks.
// Individually runnable: bun test components/models-config/HealthStrip.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { HealthStrip, HealthDetails } = await jiti.import("./HealthStrip.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const { enLocale } = await jiti.import("../../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../../lib/i18n/messages/zh-CN.ts");

/** Shaped like a real gateway scan: a few usable rows, real failures, and a long tail of never-configured catalog providers. */
function scan(overrides = {}) {
  return {
    scannedAt: Date.now() - 4 * 60_000,
    providers: {
      "alibaba-token-plan": { state: "ok" },
      anthropic: { state: "expiring", expiresAt: Date.now() + 3_600_000, account: "ops@example.com" },
      "bailian-token-plan": { state: "ok" },
      deepseek: { state: "missing", cause: "No credentials configured" },
      google: { state: "disabled", cause: "deleted by user" },
      groq: { state: "missing", cause: "No credentials configured" },
      "xai-oauth": { state: "disabled", cause: "oauth refresh failed: invalid_grant" },
      ...overrides,
    },
    availableModelCount: 744,
    disabledModelCount: 32,
  };
}

function renderElement(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

function renderStrip(health) {
  return renderElement(React.createElement(HealthStrip, { health }));
}

function details(health) {
  const failing = Object.entries(health.providers).filter(([, entry]) => entry.state === "disabled");
  return renderElement(React.createElement(HealthDetails, { health, failing }));
}

// ── T1 ──────────────────────────────────────────────────────────────────────

test("renders nothing without a scan", () => {
  assert.equal(renderStrip(null), "");
});

// ── T2 ──────────────────────────────────────────────────────────────────────

test("the strip counts only credentials that failed, never providers that were never configured", () => {
  const html = renderStrip(scan());
  assert.match(html, /Model health scan: 4 min ago/);
  assert.match(html, /2 credentials invalid/);
  assert.match(html, /744 available/);
  // `missing` (deepseek, groq) is not a broken credential; `expiring` still works.
  assert.doesNotMatch(html, /[3456] credentials invalid/);
});

test("a scan with no failure shows no invalid count at all", () => {
  const html = renderStrip(scan({ google: { state: "ok" }, "xai-oauth": { state: "ok" } }));
  assert.doesNotMatch(html, /credentials invalid/);
});

test("a clean scan shows one separator between the label and the available count", () => {
  const text = (health) => renderStrip(health).replace(/<[^>]+>/g, "");
  // The label ends in its own "·"; the second one belongs to the invalid count.
  assert.match(text(scan({ google: { state: "ok" }, "xai-oauth": { state: "ok" } })), /min ago ·744 available· details/);
  assert.match(text(scan()), /min ago ·2 credentials invalid·744 available· details/);
});

// ── T3 ──────────────────────────────────────────────────────────────────────

test("the panel lists each failed credential with its cause and the providers still usable", () => {
  const html = details(scan());
  assert.match(html, /Invalid credentials \(2\)/);
  assert.match(html, /google/);
  assert.match(html, /deleted by user/);
  assert.match(html, /xai-oauth/);
  assert.match(html, /oauth refresh failed: invalid_grant/);
  // Available = ok + expiring; unconfigured and dead providers are absent.
  const row = html.slice(html.indexOf('data-testid="health-available-providers"'));
  assert.match(row, /● 744 available/);
  assert.ok(row.includes("Available providers: alibaba-token-plan · anthropic · bailian-token-plan"));
  assert.doesNotMatch(row, /deepseek|groq|google|xai-oauth/);
});

test("a clean scan says nothing is failing and still names the usable providers", () => {
  const html = details({ ...scan(), providers: { joyai: { state: "ok" } } });
  assert.match(html, /Invalid credentials \(0\)/);
  assert.match(html, /No invalid credentials/);
  assert.match(html, /Available providers: joyai/);
});

test("with nothing usable the available row shows a dash instead of an empty list", () => {
  const html = details({ ...scan(), providers: { google: { state: "disabled", cause: "deleted by user" } } });
  assert.match(html, /Available providers: —/);
});

// ── T4 ──────────────────────────────────────────────────────────────────────

test("the minutes-ago clock keeps ticking instead of freezing at mount", async () => {
  const source = await readFile(new URL("./HealthStrip.tsx", import.meta.url), "utf8");
  assert.match(source, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 30_000\)/);
  assert.doesNotMatch(source, /const \[now\] = useState/);
});

test("every health string is translated in both locales", () => {
  for (const key of [
    "models.healthStrip", "models.healthFailing", "models.healthAvailable", "models.healthDetails",
    "models.healthFailingTitle", "models.healthNoneFailing", "models.healthAvailableProviders", "models.healthNote",
  ]) {
    assert.equal(typeof enLocale.messages[key], "string", `en missing ${key}`);
    assert.equal(typeof zhCNLocale.messages[key], "string", `zh-CN missing ${key}`);
    assert.notEqual(enLocale.messages[key], zhCNLocale.messages[key], `${key} is untranslated`);
  }
});
