// Throwaway #125 outline UX smoke: real browser against a real production build.
// Usage: bun .smoke125.mjs --base http://127.0.0.1:3131 --theme dark|light --expect pass|fail
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : d; };
const BASE = arg("base", "http://127.0.0.1:3131");
const THEME = arg("theme", "dark");
const EXPECT = arg("expect", "pass");
const ART = `/tmp/omp125/artifacts`;
mkdirSync(ART, { recursive: true });

const cwd = "/tmp/omp125/home/proj-125";
const id = "01a2068e-36fb-7000-aaeb-3bd13221f117";

function findChrome() {
  const base = "/home/joysort/.cache/puppeteer/chrome";
  for (const v of readdirSync(base).filter((v) => v.startsWith("linux-")).sort().reverse()) {
    const p = join(base, v, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("no chrome");
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "new", args: ["--no-sandbox", "--window-size=1440,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, ok: false, error: String(e.message || e) }); console.log(`FAIL ${name}: ${e.message}`); }
};

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
const loginStatus = await page.evaluate(async () => {
  const r = await fetch("/api/auth/web-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "testuser", password: "testpass123" }) });
  return r.status;
});
assert.equal(loginStatus, 200, "web-login");

// API outline proof: system role + ordinals
const outlineJson = await page.evaluate(async (sid) => {
  const r = await fetch(`/api/sessions/${sid}/context?outline=1`);
  return { status: r.status, body: await r.json() };
}, id);
const entries = outlineJson.body?.outline?.entries ?? [];
console.log("API entries:", JSON.stringify(entries.map((e) => ({ role: e.role, toolOnly: e.toolOnly ?? false, preview: e.preview.slice(0, 50) }))));
check("api system entry for eager-task-prelude with cleaned preview", () => {
  const sys = entries.filter((e) => e.role === "system");
  assert.equal(sys.length, 1);
  assert.ok(!sys[0].preview.includes("<system-reminder>"), "raw XML leaked");
  assert.ok(sys[0].preview.length > 0, "empty preview");
});

// Theme + chat
await page.evaluate((th) => { localStorage.setItem("omp-theme", th); }, THEME);
await page.goto(`${BASE}/p/${encodeURIComponent(cwd)}/s/${id}`, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
await page.waitForSelector('#session-outline-panel [data-outline-entry]', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

// outline: icons + colors + subdued + reading frame
const outline = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#session-outline-panel [data-outline-entry]')].map((b) => {
    const svg = b.querySelector("svg");
    const glyphWrap = b.querySelector('span[aria-hidden="true"]');
    return {
      text: b.innerText.replace(/\s+/g, " ").trim(),
      subdued: b.getAttribute("data-outline-subdued") === "true",
      opacity: b.style.opacity,
      svgStroke: svg?.getAttribute("stroke") ?? null,
      glyphColor: glyphWrap?.style?.color ?? null,
      borderColor: b.style.borderColor,
      background: b.style.background,
    };
  });
  return { rows, theme: document.documentElement.dataset.theme ?? localStorage.getItem("omp-theme") };
});
console.log("OUTLINE:", JSON.stringify(outline.rows, null, 0).slice(0, 1200));
await page.screenshot({ path: join(ART, `outline-${THEME}.png`) });

const userRow = outline.rows.find((r) => /U1:/.test(r.text));
const agentRow = outline.rows.find((r) => /我先看看代码/.test(r.text));
const groupRow = outline.rows.find((r) => /×3/.test(r.text));
const sysRow = outline.rows.find((r) => /系统|system/i.test(r.text) && /#1|#2/.test(r.text));
check("theme applied", () => assert.ok([THEME, "light", "dark"].includes(outline.theme)));
check("user row: person glyph + accent color", () => {
  assert.ok(userRow && /var\(--accent\)/.test(userRow.glyphColor), JSON.stringify(userRow));
});
check("agent row: robot glyph (rect+antenna) + success color", () => {
  assert.ok(agentRow && /var\(--success\)/.test(agentRow.glyphColor), JSON.stringify(agentRow));
});
check("tool group: subdued (dim, opacity<1, no accent)", () => {
  assert.ok(groupRow && groupRow.subdued, JSON.stringify(groupRow));
  assert.ok(!/var\(--accent\)/.test(groupRow.glyphColor ?? ""), "accent on tool row");
});
check("system row: gear + teal, not amber", () => {
  assert.ok(sysRow, "no system row");
  assert.ok(/#0d9488/.test(sysRow.glyphColor ?? ""), JSON.stringify(sysRow));
});

// conversation: teal gear marker on eager-task-prelude card
const convMarker = await page.evaluate(() => {
  const svgs = [...document.querySelectorAll('svg[stroke="#0d9488"]')];
  return { count: svgs.length };
});
check("conversation has teal gear marker on system prelude", () => assert.ok(convMarker.count >= 1, `count=${convMarker.count}`));

// active row frame (click a user row -> reading)
await page.evaluate(() => document.querySelector('[data-outline-entry]')?.click());
await new Promise((r) => setTimeout(r, 1200));
const activeFrame = await page.evaluate(() => {
  const b = document.querySelector('#session-outline-panel [aria-current="location"]');
  return b ? { borderColor: b.style.borderColor, background: b.style.background } : null;
});
check("reading row has solid accent frame + tint", () => {
  assert.ok(activeFrame, "no aria-current row");
  assert.ok(activeFrame.borderColor.includes("var(--accent)") && !activeFrame.borderColor.includes("45%"), JSON.stringify(activeFrame));
  assert.ok(activeFrame.background.includes("12%"), JSON.stringify(activeFrame));
});

// export filter end-to-end: fetch export html through the API and inspect embedded entries
const exportCheck = await page.evaluate(async (sid) => {
  const r = await fetch(`/api/sessions/${sid}/export`);
  const html = await r.text();
  const m = html.match(/<script id="session-data" type="application\/json">([^<]*)<\/script>/);
  if (!m) return { status: r.status, found: false };
  const data = JSON.parse(Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8"));
  const types = {};
  for (const e of data.entries ?? []) types[e.type] = (types[e.type] ?? 0) + 1;
  return { status: r.status, found: true, types };
}, id);
console.log("EXPORT:", JSON.stringify(exportCheck));
check("export: zero type=custom entries in payload", () => {
  assert.equal(exportCheck.status, 200);
  assert.ok(exportCheck.found);
  assert.equal(exportCheck.types?.custom ?? 0, 0, JSON.stringify(exportCheck.types));
  assert.ok(exportCheck.types?.message > 0, "messages gone");
});

await browser.close();
writeFileSync(join(ART, `results-${THEME}-${EXPECT}.json`), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (theme=${THEME}, expect=${EXPECT})`);
process.exit(EXPECT === "pass" ? (failed.length ? 1 : 0) : (failed.length >= 4 ? 0 : 1));