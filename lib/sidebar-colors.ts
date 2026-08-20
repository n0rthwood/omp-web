/**
 * Age-color ramp for the sidebar's auto-collapse strip mode (issue #22).
 *
 * 100 hourly buckets keyed by hours-since-`modified`: bucket 0 is the most
 * recent hour (deepest color), bucket 99 is hours 99-100 (palest, still
 * blue-tinted so it never reads as a "broken"/unstyled pure-white chip on
 * the light theme's own near-white sidebar background). Sessions older than
 * 100 hours are uncolored (`bucketFor` returns `null`) — the caller falls
 * back to the default, unthemed row style.
 *
 * The strip renders on the sidebar background in both the light and dark
 * (titanium) themes, so every bucket's `{ bg, fg }` pair must hold WCAG AA
 * contrast (>= 4.5:1) on its own, independent of the surrounding theme —
 * see sidebar-colors.test.mjs for the from-scratch contrast assertion
 * across all 100 entries.
 */

export interface SidebarAgeColor {
  bg: string;
  fg: string;
}

const BUCKET_COUNT = 100;

/** Deepest ramp color — bucket 0 (most recent hour). */
const DEEP = { h: 224, s: 70, l: 32 };
/** Palest ramp color — bucket 99 (hours 99-100). Deliberately off-white and
 *  blue-tinted, not pure #ffffff, so it stays visually distinct from an
 *  unstyled row on a near-white sidebar background. */
const PALE = { h: 222, s: 40, l: 95 };

// Near-white / near-black text, not pure #ffffff/#000000, for a touch of
// the same blue-tinted character as the ramp itself. Chosen (and verified
// by the unit test) to keep contrast >= 4.5:1 against every bucket in the
// ramp above, with comfortable margin over the WCAG AA floor.
const FG_LIGHT = "#fefeff";
const FG_DARK = "#000103";

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function relativeLuminance(hex: string): number {
  const clean = hex.slice(1);
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linearize = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 100-entry age-bucket palette: index 0 (most recent) -> deep blue, index 99
 *  (oldest still-colored) -> pale blue-white. `fg` is whichever of the two
 *  candidate text colors yields the higher contrast against `bg`. */
export const SIDEBAR_AGE_BUCKETS: readonly SidebarAgeColor[] = Array.from(
  { length: BUCKET_COUNT },
  (_, i) => {
    const t = i / (BUCKET_COUNT - 1);
    const bg = hslToHex(
      lerp(DEEP.h, PALE.h, t),
      lerp(DEEP.s, PALE.s, t),
      lerp(DEEP.l, PALE.l, t),
    );
    const fg = contrastRatio(bg, FG_LIGHT) >= contrastRatio(bg, FG_DARK) ? FG_LIGHT : FG_DARK;
    return { bg, fg };
  },
);

/**
 * Map a session's `modified` timestamp to an age bucket (0 = most recent
 * hour, 99 = hours 99-100). Returns `null` when the session is 100+ hours
 * old (uncolored) or either timestamp fails to parse. Future `modified`
 * values (clock skew) clamp to bucket 0 rather than going negative.
 */
export function bucketFor(modified: Date | string, now: Date | string = new Date()): number | null {
  const modifiedMs = modified instanceof Date ? modified.getTime() : new Date(modified).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(modifiedMs) || !Number.isFinite(nowMs)) return null;
  const hours = (nowMs - modifiedMs) / 3_600_000;
  if (hours >= BUCKET_COUNT) return null;
  return Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor(hours)));
}

/** `{ bg, fg }` for a session's `modified` timestamp, or `null` when the
 *  session is old enough to render with the default (uncolored) row style. */
export function colorFor(modified: Date | string, now: Date | string = new Date()): SidebarAgeColor | null {
  const bucket = bucketFor(modified, now);
  return bucket === null ? null : SIDEBAR_AGE_BUCKETS[bucket];
}
