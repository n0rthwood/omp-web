import assert from "node:assert/strict";
import test from "node:test";
import { bucketFor, SIDEBAR_AGE_BUCKETS } from "./sidebar-colors.ts";

// Independent WCAG 2.x relative-luminance / contrast-ratio implementation —
// deliberately not shared with lib/sidebar-colors.ts so a bug in the
// implementation's own contrast math cannot also hide it from the test.
function relativeLuminance(hex) {
  const clean = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linearize = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

test("SIDEBAR_AGE_BUCKETS has exactly 100 entries", () => {
  assert.equal(SIDEBAR_AGE_BUCKETS.length, 100);
});

test("every bucket's fg/bg pair meets WCAG AA contrast (>= 4.5:1)", () => {
  const failures = [];
  SIDEBAR_AGE_BUCKETS.forEach((entry, i) => {
    assert.match(entry.bg, /^#[0-9a-f]{6}$/i, `bucket ${i} bg is a hex color`);
    assert.match(entry.fg, /^#[0-9a-f]{6}$/i, `bucket ${i} fg is a hex color`);
    const ratio = contrastRatio(entry.bg, entry.fg);
    if (ratio < 4.5) failures.push({ i, bg: entry.bg, fg: entry.fg, ratio });
  });
  assert.deepEqual(failures, [], `buckets failing WCAG AA: ${JSON.stringify(failures)}`);
});

test("recent buckets are darker (deeper) than older buckets — monotonic luminance ramp", () => {
  const luminances = SIDEBAR_AGE_BUCKETS.map((entry) => relativeLuminance(entry.bg));
  for (let i = 1; i < luminances.length; i++) {
    assert.ok(
      luminances[i] >= luminances[i - 1] - 1e-9,
      `bucket ${i} (L=${luminances[i]}) should not be darker than bucket ${i - 1} (L=${luminances[i - 1]})`,
    );
  }
  // Most recent (bucket 0) is the deepest; the oldest colored bucket (99) is
  // the palest — but still perceptibly off-white/blue-tinted, not pure white.
  assert.ok(luminances[0] < 0.25, "bucket 0 should be a deep, dark color");
  assert.ok(luminances[99] > 0.8, "bucket 99 should be pale/near-white");
  assert.ok(luminances[99] < 1, "bucket 99 should not be pure white (#ffffff)");
});

test("bucketFor: bucket 0 covers the most recent hour", () => {
  const now = new Date("2026-01-02T12:00:00.000Z");
  assert.equal(bucketFor(now, now), 0);
  assert.equal(bucketFor(new Date(now.getTime() - 1), now), 0);
  assert.equal(bucketFor(new Date(now.getTime() - 59 * 60_000), now), 0);
});

test("bucketFor: hourly buckets increment as the session ages", () => {
  const now = new Date("2026-01-02T12:00:00.000Z");
  assert.equal(bucketFor(new Date(now.getTime() - 61 * 60_000), now), 1);
  assert.equal(bucketFor(new Date(now.getTime() - 2 * 3_600_000), now), 2);
  assert.equal(bucketFor(new Date(now.getTime() - 50.5 * 3_600_000), now), 50);
});

test("bucketFor: bucket 99 covers hours 99-100, and 100h+ is uncolored (null)", () => {
  const now = new Date("2026-01-02T12:00:00.000Z");
  assert.equal(bucketFor(new Date(now.getTime() - 99 * 3_600_000), now), 99);
  assert.equal(bucketFor(new Date(now.getTime() - 99.99 * 3_600_000), now), 99);
  assert.equal(bucketFor(new Date(now.getTime() - 100 * 3_600_000), now), null);
  assert.equal(bucketFor(new Date(now.getTime() - 150 * 3_600_000), now), null);
});

test("bucketFor: accepts ISO strings and clamps future timestamps to bucket 0", () => {
  const now = new Date("2026-01-02T12:00:00.000Z");
  assert.equal(bucketFor("2026-01-02T11:59:00.000Z", now), 0);
  // Clock skew: a "modified" timestamp slightly after `now` still reads as
  // the most recent bucket rather than throwing or going negative.
  assert.equal(bucketFor("2026-01-02T12:05:00.000Z", now), 0);
});

test("bucketFor: invalid dates return null", () => {
  const now = new Date("2026-01-02T12:00:00.000Z");
  assert.equal(bucketFor("not-a-date", now), null);
  assert.equal(bucketFor(new Date(NaN), now), null);
});
