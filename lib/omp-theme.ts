import {
  getAvailableThemes,
  getResolvedThemeColors,
  getThemeExportColors,
  isLightTheme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { WebThemeConfig, WebThemePalette } from "@/lib/settings-api";

function firstColor(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "transparent";
}

type Rgb = [red: number, green: number, blue: number];

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const hex = match[1];
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

function mixHex(from: string, to: string, amount: number): string {
  const fromRgb = parseHex(from);
  const toRgb = parseHex(to);
  if (!fromRgb || !toRgb) return from;
  const mixed = fromRgb.map((channel, index) => Math.round(channel + (toRgb[index] - channel) * amount));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

interface Hsl {
  hue: number;
  saturation: number;
  lightness: number;
}

function toHsl(value: string): Hsl | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  let hue: number;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return {
    hue: ((hue * 60) % 360 + 360) % 360,
    saturation: delta / (1 - Math.abs(2 * lightness - 1)),
    lightness,
  };
}

function fromHsl({ hue, saturation, lightness }: Hsl): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const [red, green, blue] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][Math.floor(hue / 60) % 6];
  const match = lightness - chroma / 2;
  const toHex = (channel: number) =>
    Math.round(Math.min(1, Math.max(0, channel + match)) * 255).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

/** Terminal colours below the floor are muddy; above the ceiling they are neon. */
const TERMINAL_SATURATION = { min: 0.45, max: 0.85 } as const;
/** Below this the source is treated as intentionally achromatic (monochrome themes). */
const ACHROMATIC_SATURATION = 0.08;

/**
 * Mint one terminal colour slot. omp themes carry semantic colours (error,
 * success, warning, accent) rather than the six hues a terminal needs, so
 * blue/magenta/cyan are minted from the accent at canonical terminal hues while
 * inheriting its brightness — the theme's character — and every slot's
 * saturation is clamped into a usable band.
 *
 * Both bounds come from measured failures. Without the floor, the `light`
 * theme's own low-saturation roles produced a grey-blue `#5a6a80` and a
 * grey-green `#537c53`; without the ceiling, a vivid accent landed magenta on
 * pure `#ff00ff`. Re-hueing by a *delta* rather than to a fixed hue was a third
 * failure: a teal accent turned "cyan" into green, because the result depended
 * on wherever the accent happened to sit.
 *
 * An achromatic source stays achromatic: a monochrome theme is a deliberate
 * choice, and colourising its terminal would override it.
 */
function terminalSlot(value: string, hue?: number): string {
  const hsl = toHsl(value);
  if (!hsl) return value;
  if (hsl.saturation < ACHROMATIC_SATURATION) return value;
  return fromHsl({
    hue: hue ?? hsl.hue,
    saturation: Math.min(TERMINAL_SATURATION.max, Math.max(TERMINAL_SATURATION.min, hsl.saturation)),
    lightness: hsl.lightness,
  });
}

function relativeLuminance(value: string): number | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(color: string, target: string, backgrounds: string[], minimum: number): string {
  const hasContrast = (candidate: string) => backgrounds.every((background) => {
    const ratio = contrastRatio(candidate, background);
    return ratio === null || ratio >= minimum;
  });
  if (hasContrast(color)) return color;
  if (!hasContrast(target)) return target;

  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const midpoint = (low + high) / 2;
    if (hasContrast(mixHex(color, target, midpoint))) high = midpoint;
    else low = midpoint;
  }
  return mixHex(color, target, high);
}

export async function getWebThemePalette(name: string): Promise<WebThemePalette> {
  const [colors, exported] = await Promise.all([
    getResolvedThemeColors(name),
    getThemeExportColors(name),
  ]);
  const colorScheme = isLightTheme(name) ? "light" : "dark";
  const pageBg = firstColor(exported.pageBg, colors.userMessageBg, colorScheme === "light" ? "#ffffff" : "#111318");
  const panelBg = firstColor(exported.cardBg, colors.statusLineBg, colors.toolPendingBg, pageBg);
  const hoverBg = firstColor(colors.borderMuted, colors.border, panelBg);
  const selectedBg = firstColor(colors.selectedBg, colors.borderAccent, hoverBg);
  const text = firstColor(colors.text, colorScheme === "light" ? "#17191d" : "#e5e7eb");
  const rawMuted = firstColor(colors.muted, text);
  const rawDim = firstColor(colors.dim, rawMuted);
  const muted = ensureContrast(rawMuted, text, [pageBg, panelBg], 6);
  const dim = ensureContrast(rawDim, text, [pageBg, panelBg], 5);
  const accent = firstColor(colors.accent, colors.borderAccent, text);

  // Terminal palette. A terminal needs six distinguishable hues plus two
  // neutrals, in normal and bright variants; omp themes carry semantic roles
  // instead. red/green/yellow keep the theme's own error/success/warning hues,
  // which carry meaning a user already reads elsewhere in omp, while
  // blue/magenta/cyan are minted at canonical terminal hues.
  //
  // `accent` is used only for brightness and saturation here, never for the
  // blue *hue*: plenty of omp themes have a warm accent, and anchoring blue to
  // it produced an orange "blue" (#fab387 on dark-catppuccin, #fe8019 on
  // dark-gruvbox — measured).
  //
  // Legibility is forced toward black or white, never toward `--text`: mixing a
  // hue toward a neutral text colour desaturates it, which collapsed red,
  // green, blue, magenta and cyan into five near-identical muds on the light
  // theme (#aa5555 / #537c53 / #557878 / #5b5a80 / #567b5f — measured).
  const termBg = pageBg;
  const contrastTarget = colorScheme === "dark" ? "#ffffff" : "#000000";
  const legible = (color: string) => ensureContrast(color, contrastTarget, [termBg], 4.5);
  const brighten = (color: string) =>
    colorScheme === "dark" ? mixHex(color, "#ffffff", 0.22) : mixHex(color, "#000000", 0.22);
  // A theme whose semantic roles are grey but whose accent is not (light-
  // monochrome) would otherwise get three indistinguishable greys for
  // red/green/yellow — unreadable for a `git diff` — while its blue/magenta/
  // cyan came out coloured. In that case mint the slot at its canonical hue
  // from the accent instead. A theme that is achromatic throughout keeps grey.
  const accentIsChromatic = (toHsl(accent)?.saturation ?? 0) >= ACHROMATIC_SATURATION;
  const semanticSlot = (value: string, canonicalHue: number) => {
    const slot = terminalSlot(value);
    if (!accentIsChromatic) return slot;
    const isGrey = (toHsl(slot)?.saturation ?? 0) < ACHROMATIC_SATURATION;
    return isGrey ? terminalSlot(accent, canonicalHue) : slot;
  };
  const red = legible(semanticSlot(firstColor(colors.error, colors.toolDiffRemoved, "#dc2626"), 0));
  const green = legible(semanticSlot(firstColor(colors.success, colors.toolDiffAdded, "#16a34a"), 130));
  const yellow = legible(semanticSlot(firstColor(colors.warning, colors.syntaxNumber, "#d97706"), 45));
  const blue = legible(terminalSlot(accent, 215));
  const magenta = legible(terminalSlot(accent, 300));
  const cyan = legible(terminalSlot(accent, 187));
  const black = colorScheme === "dark" ? mixHex(termBg, "#000000", 0.35) : mixHex(text, "#000000", 0.15);
  const white = mixHex(text, termBg, 0.25);

  return {
    name,
    colorScheme,
    variables: {
      "--bg": pageBg,
      "--bg-panel": panelBg,
      "--bg-hover": hoverBg,
      "--bg-selected": selectedBg,
      "--border": firstColor(colors.borderMuted, colors.border, hoverBg),
      "--text": text,
      "--text-muted": muted,
      "--text-dim": dim,
      "--accent": accent,
      "--accent-hover": mixHex(accent, text, 0.16),
      "--user-bg": firstColor(colors.userMessageBg, panelBg),
      "--assistant-bg": pageBg,
      "--tool-bg": firstColor(colors.toolPendingBg, panelBg),
      "--bg-subtle": firstColor(exported.infoBg, colors.customMessageBg, hoverBg),
      "--success": firstColor(colors.success, colors.toolDiffAdded, accent),
      "--danger": firstColor(colors.error, colors.toolDiffRemoved, "#dc2626"),
      "--warning": firstColor(colors.warning, "#d97706"),
      "--omp-md-heading": firstColor(colors.mdHeading, accent),
      "--omp-md-link": firstColor(colors.mdLink, accent),
      "--omp-md-code": firstColor(colors.mdCode, colors.syntaxString, accent),
      "--term-bg": termBg,
      "--term-fg": text,
      "--term-cursor": accent,
      "--term-cursor-accent": termBg,
      "--term-selection-bg": mixHex(selectedBg, accent, 0.35),
      "--term-black": black,
      "--term-red": red,
      "--term-green": green,
      "--term-yellow": yellow,
      "--term-blue": blue,
      "--term-magenta": magenta,
      "--term-cyan": cyan,
      "--term-white": white,
      "--term-bright-black": dim,
      "--term-bright-red": brighten(red),
      "--term-bright-green": brighten(green),
      "--term-bright-yellow": brighten(yellow),
      "--term-bright-blue": brighten(blue),
      "--term-bright-magenta": brighten(magenta),
      "--term-bright-cyan": brighten(cyan),
      "--term-bright-white": text,
    },
  };
}

export async function getWebThemeConfig(settings: Settings): Promise<WebThemeConfig> {
  const dark = settings.get("theme.dark") ?? "titanium";
  const light = settings.get("theme.light") ?? "light";
  const [darkPalette, lightPalette] = await Promise.all([
    getWebThemePalette(dark),
    getWebThemePalette(light),
  ]);
  return {
    names: { dark, light },
    palettes: { dark: darkPalette, light: lightPalette },
  };
}

export async function getAvailableWebThemes(): Promise<Array<{ name: string; colorScheme: "dark" | "light" }>> {
  const names = await getAvailableThemes();
  return names.map((name) => ({ name, colorScheme: isLightTheme(name) ? "light" : "dark" }));
}
