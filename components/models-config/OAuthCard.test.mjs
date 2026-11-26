// OAuth card status line: the "last refresh" value (issue #145).
// Individually runnable: bun test components/models-config/OAuthCard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { OAuthCard } = await jiti.import("./OAuthCard.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");

function render(health) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(OAuthCard, {
        provider: { id: "anthropic", name: "Anthropic", loggedIn: true },
        health,
        onRefresh: () => {},
      }),
    ),
  );
}

test("the card shows when the credential was last refreshed", () => {
  const at = new Date();
  at.setHours(21, 58, 0, 0);
  const html = render({ state: "disabled", cause: "invalid_grant", lastRefreshAt: at.getTime() });
  assert.ok(
    html.includes(`last refresh <code style="font-family:var(--font-mono);color:var(--text)">${at.toLocaleString()}</code>`),
    "the scan's time is rendered next to the account and expiry",
  );
});

test("without a known refresh time the line says so instead of inventing one", () => {
  assert.match(render({ state: "ok" }), /last refresh <code style="[^"]*">—<\/code>/);
});

test("a long failure cause is clamped with an expand toggle and no overflow", () => {
  const cause = `oauth refresh failed: OAuthError: xai-oauth token refresh failed: 400 ${JSON.stringify({ error: "invalid_grant", error_description: "Invalid or unknown refresh token" })}`;
  const html = render({ state: "disabled", cause });
  assert.match(html, /Show full error/);
  assert.match(html, /display:-webkit-box/);
  assert.match(html, /-webkit-line-clamp:3/);
  assert.match(html, /overflow-wrap:anywhere/);
  // The header must not let the badge squeeze the title: title fixed, badge shrinks.
  assert.match(html, /flex:0 0 auto/);
  assert.match(html, /min-width:0/);
});

test("a short cause needs no expand toggle", () => {
  const html = render({ state: "disabled", cause: "invalid_grant" });
  assert.doesNotMatch(html, /Show full error/);
  assert.ok(html.includes("invalid_grant"));
});
