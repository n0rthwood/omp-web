// #100 behavioral regression harness — real browser against a real production
// build. Replaces the former manual DevTools injection scaffold.
//
// What it proves (hooks/useAgentSession.ts loadSession failure routing +
// components/ChatWindow.tsx refresh-error shelf):
//   1. initial load with nothing rendered + failed GET  -> fatal full-screen
//      error, no chat scroll container;
//   2. failed turn-completion refreshes (agent_end / prompt_done /
//      agent_settled) keep rendered messages, composer draft, scroll position
//      and DOM node identity; the shelf count increments per failure;
//   3. the next successful refresh clears the shelf;
//   4. a late rejection for a session the user navigated away from never
//      touches the new view.
//
// No provider is ever called: prompt POSTs are answered synthetically in the
// page and turn events are pushed through a synthetic EventSource. Session
// history is REAL — journals written through the SDK's SessionManager into a
// hermetic HOME and served by the real /api/sessions routes. Only the failure
// itself is injected (fetch wrapper), which is exactly the production
// condition #100 fixes (background GET fails after content rendered).
//
// Prerequisites: a production build served hermetically, e.g.
//   HOME=/tmp/omp100-verify.XXXX/home \
//   OMP_WEB_USERS_FILE=/tmp/omp100-verify.XXXX/users.yml \
//   OMP_WEB_HOST_RUN_DIR=/tmp/omp100-verify.XXXX/run \
//   OMP_WEB_HOSTNAME=127.0.0.1 NODE_ENV=production \
//   bun --bun node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3131
// (users file: one admin user, projects "*" — see the hermetic-test-user
// skill; credentials JSON {username,password} beside it).
//
// Run (HOME must be the SAME hermetic home the server uses):
//   HOME=/tmp/omp100-verify.XXXX/home bun ops/session-refresh-regression.mjs \
//     --base http://127.0.0.1:3131 \
//     --credentials /tmp/omp100-verify.XXXX/credentials.json \
//     --artifacts /tmp/omp100-regression-artifacts
//
// Exits 0 only when every assertion passes. Writes results.json + screenshots
// into --artifacts. Never touches real sessions, hosts, or the repo's .next.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------- args ------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = arg("base", "http://127.0.0.1:3131");
const CRED_FILE = arg("credentials", "");
const ARTIFACTS = arg("artifacts", "/tmp/omp100-regression-artifacts");
if (!CRED_FILE) {
  console.error("usage: bun ops/session-refresh-regression.mjs --credentials <json> [--base url] [--artifacts dir]");
  process.exit(2);
}
// Fixture creation is destructive to the selected session store: refuse the
// ordinary user home even if this manual harness is invoked without overrides.
if (!process.env.HOME || !/^\/tmp\/omp[^/]*\/home\/?$/.test(process.env.HOME)) {
  throw new Error("Set HOME to a disposable /tmp/omp*/home directory shared with the verification server");
}

const cred = JSON.parse(readFileSync(CRED_FILE, "utf8"));
mkdirSync(ARTIFACTS, { recursive: true });

// ------------------------------------------------------------- fixtures -----
// Two journals in the hermetic home: ALPHA (long, scrollable — 60 message
// pairs so the lazy-render window (VISIBLE_PAGE_SIZE=50) is fully loaded
// after the initial sentinel page-in and later completion events cause no
// prepend/restore layout churn) and BETA (short).
const cwd = join(process.env.HOME, "proj-100");
mkdirSync(cwd, { recursive: true });
const zeroUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function makeJournal(tag, pairs) {
  const sm = SessionManager.create(cwd);
  for (let i = 0; i < pairs; i++) {
    sm.appendMessage({ role: "user", content: `${tag} user message ${i} — synthetic #100 fixture`, timestamp: Date.now() });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `${tag} assistant reply ${i}. `.repeat(12) }],
      api: "openai-completions", provider: "synthetic", model: "synthetic-model",
      usage: zeroUsage, stopReason: "stop", timestamp: Date.now(),
    });
  }
  sm.flushSync();
  return { id: sm.getSessionId(), file: sm.getSessionFile() };
}
const alpha = makeJournal("ALPHA", 60);
const beta = makeJournal("BETA", 2);
const deeplink = (s) => `${BASE}/p/${encodeURIComponent(cwd)}/s/${s.id}`;

// --------------------------------------------------------------- chrome -----
function findChrome() {
  // Bun's userInfo().homedir() follows $HOME, which is the hermetic home here;
  // the chrome cache lives in the real user's home.
  const roots = [process.env.HOME, userInfo().homedir, join("/home", userInfo().username)].filter(Boolean);
  for (const root of new Set(roots)) {
    const base = join(root, ".cache", "puppeteer", "chrome");
    if (!existsSync(base)) continue;
    const versions = readdirSync(base).filter((v) => v.startsWith("linux-")).sort().reverse();
    for (const v of versions) {
      const p = join(base, v, "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no puppeteer chrome cache found; pass a chrome via CHROME_PATH");
}
const executablePath = process.env.CHROME_PATH || findChrome();

// ------------------------------------------- page-side interception ---------
// Installed before any app script runs. window.__qa100 controls it:
//   failIds: Set of session ids whose loadSession GET (deferThinking) fails;
//   hangIds: ids whose loadSession GET parks until release(id, status);
//   failAgent: also fail GET /api/agent/<id> (network-partition realism —
//     otherwise the 1s context-usage poll would clear the shelf);
//   prompts: recorded synthetic prompt POSTs (never reach the server);
//   sse: synthetic EventSource instances; push(event) feeds the open one.
const INTERCEPT = `
(() => {
  const origFetch = window.fetch.bind(window);
  const state = {
    failIds: new Set(), hangIds: new Set(), failAgent: false,
    failedGets: 0, prompts: [], sse: [], parked: new Map(),
  };
  const loadGet = /\\/api\\/sessions\\/([^/?]+)\\?[^"]*deferThinking/;
  const agentGet = /\\/api\\/agent\\/([^/?]+)(?:\\?|$)/;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = ((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET") {
      const m = url.match(loadGet);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (state.hangIds.has(id)) {
          return new Promise((resolve) => {
            const prev = state.parked.get(id) || [];
            prev.push(() => resolve(new Response("injected stale failure (#100)", { status: 500 })));
            state.parked.set(id, prev);
          });
        }
        if (state.failIds.has(id)) {
          state.failedGets++;
          return Promise.resolve(new Response("injected refresh failure (#100)", { status: 500 }));
        }
      }
      const a = url.match(agentGet);
      if (state.failAgent && a && !url.includes("/events")) {
        return Promise.resolve(new Response("injected state failure (#100)", { status: 500 }));
      }
    }
    if (method === "POST") {
      const a = url.match(agentGet);
      if (a) {
        let body = {};
        try { body = JSON.parse((init && init.body) || "{}"); } catch {}
        if (body.type === "prompt") {
          state.prompts.push({ id: decodeURIComponent(a[1]), promptId: body.promptId, message: body.message });
          return Promise.resolve(json({ success: true, data: { accepted: true } }));
        }
        return Promise.resolve(json({ success: true, data: {} }));
      }
    }
    return origFetch(input, init);
  };
  const OrigES = window.EventSource;
  class SyntheticES {
    constructor(url) {
      this.url = url; this.readyState = 1; this.onmessage = null; this.onerror = null;
      this._listeners = {};
      state.sse.push(this);
      setTimeout(() => {
        if (this.readyState !== 1) return;
        this.readyState = 1; // OPEN
        this._emit({ type: "connected" });
      }, 0);
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    _emit(event) {
      const e = { data: JSON.stringify(event) };
      if (this.onmessage) this.onmessage(e);
      for (const fn of this._listeners.message || []) fn(e);
    }
    close() { this.readyState = 2; }
  }
  SyntheticES.CONNECTING = 0; SyntheticES.OPEN = 1; SyntheticES.CLOSED = 2;
  window.EventSource = function (url, opts) {
    return String(url).includes("/events") ? new SyntheticES(url) : new OrigES(url, opts);
  };
  window.EventSource.OPEN = 1; window.EventSource.CLOSED = 2; window.EventSource.CONNECTING = 0;
  window.__qa100 = {
    state,
    fail(id) { state.failIds.add(id); state.failAgent = true; },
    disarm() { state.failIds.clear(); state.failAgent = false; },
    hang(id) { state.hangIds.add(id); },
    release(id) {
      state.hangIds.delete(id);
      for (const resolve of state.parked.get(id) || []) resolve();
      state.parked.delete(id);
    },
    push(event) {
      const open = state.sse.filter((s) => s.readyState === 1);
      if (!open.length) throw new Error("no open synthetic EventSource");
      open[open.length - 1]._emit(event);
    },
    lastPromptId() { return state.prompts[state.prompts.length - 1]?.promptId; },
  };
})();
`;

// ---------------------------------------------------------------- helpers ---
const results = [];
let page;
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e && e.message || e) });
    console.log(`FAIL ${name}: ${e && e.message || e}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}
const shelfCount = () => page.evaluate(() => {
  const el = document.querySelector('[data-testid="session-refresh-error"]');
  if (!el) return null;
  const m = el.textContent.match(/\((\d+)\)/);
  return m ? Number(m[1]) : null;
});
const view = () => page.evaluate(() => {
  const scroll = document.querySelector(".chat-session-scroll");
  const ta = document.querySelector("textarea");
  return {
    scrollPresent: !!scroll,
    scrollMarked: scroll ? scroll.__qa100Mark === true : false,
    taMarked: ta ? ta.__qa100Mark === true : false,
    scrollTop: scroll ? scroll.scrollTop : null,
    draft: ta ? ta.value : null,
    bodyText: document.body.innerText,
  };
});
async function markNodes() {
  await page.evaluate(() => {
    document.querySelector(".chat-session-scroll").__qa100Mark = true;
    document.querySelector("textarea").__qa100Mark = true;
  });
}
async function openFresh(url, { armInitialId = null } = {}) {
  if (page) await page.close();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(INTERCEPT);
  // Arm BEFORE any app script runs: evaluateOnNewDocument survives reloads,
  // so the very first loadSession GET already fails.
  if (armInitialId) await page.evaluateOnNewDocument(`window.__qa100.fail(${JSON.stringify(armInitialId)});`);
  // Cookie login through the real endpoint (credentials never hit the URL).
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const status = await page.evaluate(async (c) => {
    const r = await fetch("/api/auth/web-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
    return r.status;
  }, cred);
  assert.equal(status, 200, "web-login must succeed");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}
const shot = (name) => page.screenshot({ path: join(ARTIFACTS, `${name}.png`) });

// ------------------------------------------------------------------- run ----
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let exitCode = 0;
try {
  // Refresh the server's session-list cache so the fresh journals resolve.
  page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async (c) => {
    await fetch("/api/auth/web-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
    await fetch("/api/sessions?force=1");
  }, cred);

  // ---- Scenario 1: initial empty failure is fatal --------------------------
  await openFresh(deeplink(alpha), { armInitialId: alpha.id });
  // The nav resolver's plain GET still succeeds (only deferThinking GETs are
  // armed), so ChatWindow mounts and its initial loadSession fails.
  await waitFor(async () => (await page.evaluate(() => document.body.innerText)).includes("Error: HTTP 500"), 15000, "fatal initial error");
  await check("initial-failure fatal full-screen error", async () => {
    const v = await view();
    assert.equal(v.scrollPresent, false, "chat scroll container must be absent");
    assert.ok(v.bodyText.includes("Error: HTTP 500"));
  });
  await shot("01-initial-fatal");

  // ---- Scenario 2: content survives failed turn-completion refreshes -------
  await openFresh(deeplink(alpha));
  await waitFor(async () => (await view()).scrollPresent, 15000, "chat render");
  await waitFor(async () => (await view()).bodyText.includes("ALPHA assistant reply 59"), 15000, "history rendered");
  await markNodes();
  const draftText = "DRAFT-KEEP-100 unsent composer text";
  await page.type("textarea", "turn one prompt");
  await page.evaluate((id) => window.__qa100.fail(id), alpha.id);
  // Send: intercepted POST, synthetic SSE connects, no host/provider involved.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const send = btns.find((b) => b.textContent.trim() === "Send" && !b.disabled);
    if (!send) throw new Error("Send button not found/enabled");
    send.click();
  });
  await waitFor(async () => page.evaluate(() => window.__qa100.state.prompts.length === 1), 10000, "synthetic prompt admission");
  // User keeps typing the next message while the turn runs.
  await page.evaluate((t) => {
    const ta = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, draftText);
  const assistantMsg = {
    role: "assistant",
    content: [{ type: "text", text: "SYNTHETIC streamed reply for #100." }],
    api: "openai-completions", provider: "synthetic", model: "synthetic-model",
    usage: zeroUsage, stopReason: "stop", timestamp: Date.now(),
  };
  await page.evaluate(() => window.__qa100.push({ type: "agent_start" }));
  await page.evaluate((m) => window.__qa100.push({ type: "message_start", message: m }), assistantMsg);
  await page.evaluate((m) => window.__qa100.push({ type: "message_update", message: m }), assistantMsg);
  await page.evaluate((m) => window.__qa100.push({ type: "message_end", message: m }), assistantMsg);
  await sleep(300); // let completion auto-scroll finish before baselining
  // Park the scroll away from the bottom like a real user reading history:
  // a genuine wheel event marks scroll intent, which disables the hook's
  // completion auto-follow (a bare scrollTop write would be re-followed).
  const scrollBox = await (await page.$(".chat-session-scroll")).boundingBox();
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.evaluate(() => { document.querySelector(".chat-session-scroll").scrollTop = 120; });
  await page.mouse.wheel({ deltaY: 40 }); // scrolls DOWN: stays parked at 160, far from bottom
  await sleep(1300); // outlive USER_SCROLL_INTENT_MS so the next scroll event disables auto-follow
  await page.mouse.wheel({ deltaY: -40 }); // back to 120; handleScrollPositionChange now latches follow off
  await sleep(200);
  const baseline = await view();
  assert.ok(baseline.scrollTop > 0, "baseline scroll must be parked");

  const triggers = [
    ["agent_end", () => page.evaluate(() => window.__qa100.push({ type: "agent_end" }))],
    ["prompt_done", () => page.evaluate(() => window.__qa100.push({ type: "prompt_done", promptId: window.__qa100.lastPromptId() }))],
    ["agent_settled", () => page.evaluate(() => window.__qa100.push({ type: "agent_settled" }))],
  ];
  let expected = 0;
  for (const [name, fire] of triggers) {
    expected++;
    await fire();
    await waitFor(async () => (await shelfCount()) === expected, 10000, `shelf count ${expected} after ${name}`);
    await check(`survives failed refresh on ${name} (count=${expected})`, async () => {
      const v = await view();
      assert.equal(v.scrollPresent, true, "chat must stay mounted");
      assert.equal(v.scrollMarked, true, "scroll container must be the SAME DOM node");
      assert.equal(v.taMarked, true, "composer must be the SAME DOM node");
      assert.ok(v.bodyText.includes("ALPHA user message 0"), "loaded history must remain");
      assert.ok(v.bodyText.includes("SYNTHETIC streamed reply"), "streamed message must remain");
      assert.equal(v.draft, draftText, "composer draft must survive");
      assert.equal(v.scrollTop, baseline.scrollTop, "scroll position must survive");
    });
  }
  await check("failure counter matches injected GET failures", async () => {
    const failed = await page.evaluate(() => window.__qa100.state.failedGets);
    assert.equal(await shelfCount(), failed);
  });
  await shot("02-shelf-count-3");

  // ---- Scenario 3: next successful refresh clears the shelf ----------------
  await page.evaluate(() => window.__qa100.disarm());
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const send = btns.find((b) => ["Send", "Queue", "Follow-up"].includes(b.textContent.trim()) && !b.disabled);
    if (!send) throw new Error("no enabled send/queue button");
    send.click();
  });
  await waitFor(async () => page.evaluate(() => window.__qa100.state.prompts.length === 2), 10000, "second prompt admission");
  await page.evaluate(() => window.__qa100.push({ type: "agent_start" }));
  await page.evaluate((m) => window.__qa100.push({ type: "message_end", message: m }), assistantMsg);
  await page.evaluate(() => window.__qa100.push({ type: "agent_end" }));
  await page.evaluate(() => window.__qa100.push({ type: "prompt_done", promptId: window.__qa100.lastPromptId() }));
  await page.evaluate(() => window.__qa100.push({ type: "agent_settled" }));
  await waitFor(async () => (await shelfCount()) === null, 15000, "shelf cleared by successful refresh");
  await check("next success clears shelf, chat intact", async () => {
    const v = await view();
    assert.equal(v.scrollPresent, true);
    assert.ok(v.bodyText.includes("ALPHA user message 0"));
    assert.ok(!v.bodyText.includes("Session refresh failed"));
  });
  await shot("03-cleared-on-success");

  // ---- Scenario 4: stale old-session rejection is ignored ------------------
  await page.evaluate((id) => window.__qa100.hang(id), alpha.id);
  // Force a loadSession for ALPHA that parks: trigger a turn completion.
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "stale-turn trigger");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const send = btns.find((b) => ["Send", "Queue", "Follow-up"].includes(b.textContent.trim()) && !b.disabled);
    send.click();
  });
  await waitFor(async () => page.evaluate(() => window.__qa100.state.prompts.length === 3), 10000, "third prompt admission");
  await page.evaluate(() => window.__qa100.push({ type: "agent_start" }));
  await page.evaluate(() => window.__qa100.push({ type: "agent_end" })); // loadSession parks
  await waitFor(async () => page.evaluate((id) => (window.__qa100.state.parked.get(id) || []).length > 0, alpha.id), 10000, "parked ALPHA refresh");
  // Navigate to BETA via the app's own deeplink router (same-machine popstate
  // path — real in-app selection, no document reload, parked fetch survives).
  await page.evaluate((url) => {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/p/${encodeURIComponent(cwd)}/s/${beta.id}`);
  await waitFor(async () => (await view()).bodyText.includes("BETA user message 0"), 15000, "BETA rendered");
  const betaBefore = await view();
  await page.evaluate((id) => window.__qa100.release(id), alpha.id); // stale 500 lands now
  await sleep(800);
  await check("stale old-session rejection ignored", async () => {
    const v = await view();
    assert.equal(await shelfCount(), null, "no shelf on the new session");
    assert.ok(v.bodyText.includes("BETA user message 0"), "BETA history intact");
    assert.ok(!v.bodyText.includes("Error: HTTP 500"), "no fatal error on BETA");
    assert.equal(v.scrollTop, betaBefore.scrollTop, "BETA scroll untouched");
  });
  await shot("04-stale-ignored");
} catch (e) {
  exitCode = 1;
  results.push({ name: "harness-run", ok: false, error: String(e && e.stack || e) });
  console.error("HARNESS ERROR:", e);
  if (page) await shot("99-error").catch(() => {});
} finally {
  writeFileSync(join(ARTIFACTS, "results.json"), JSON.stringify({ base: BASE, alpha: alpha.id, beta: beta.id, results }, null, 2));
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed; artifacts: ${ARTIFACTS}`);
process.exit(failed.length ? 1 : exitCode);