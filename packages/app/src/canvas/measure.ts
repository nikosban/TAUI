/**
 * Font measurement. Impure — the only module besides `renderer.ts` that touches
 * a canvas context, and deliberately thin so the untested surface stays small.
 *
 * The policy it feeds is in `coverage.ts`, which is pure and fully tested.
 */

import {
  classifyCoverage,
  GLYPH_PROBES,
  type ProbeMeasurement,
  VERTICAL_PROBES,
} from "./coverage.js";
import type { CellMetrics, FontSpec } from "./metrics.js";

let sharedCtx: CanvasRenderingContext2D | null = null;

function measureContext(): CanvasRenderingContext2D {
  if (sharedCtx === null) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2d canvas context unavailable");
    sharedCtx = ctx;
  }
  return sharedCtx;
}

export function fontString(
  font: FontSpec,
  opts: { bold?: boolean; italic?: boolean } = {},
): string {
  const italic = opts.italic === true ? "italic " : "";
  const bold = opts.bold === true ? "bold " : "";
  return `${italic}${bold}${font.sizePx}px ${font.family}`;
}

/**
 * Measures the cell box for a font.
 *
 * `baselineY` centres the font's own ascent+descent box within the cell rather
 * than assuming `0.8 × fontSize`. Menlo reports ascent 13 / descent 3 at 14px, so
 * the naive ratio would sit every glyph 2.2px too high — measured in the G0 spike.
 */
export function measureFont(font: FontSpec, dpr: number): CellMetrics {
  const ctx = measureContext();
  ctx.font = fontString(font);
  const m = ctx.measureText("M");
  const cellW = m.width;
  const cellH = font.sizePx * font.lineHeightFactor;

  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  const baselineY =
    Number.isFinite(ascent) && Number.isFinite(descent)
      ? (cellH - (ascent + descent)) / 2 + ascent
      : font.sizePx * 0.8;

  return { cellW, cellH, dpr, baselineY, font };
}

/** Measures the probe set. Pair with {@link classifyCoverage} for the verdict. */
export function measureProbes(font: FontSpec): ProbeMeasurement[] {
  const ctx = measureContext();
  ctx.font = fontString(font);
  const verticalSet = new Set(VERTICAL_PROBES);

  return GLYPH_PROBES.map((glyph) => {
    const m = ctx.measureText(glyph);
    if (!verticalSet.has(glyph)) return { glyph, advance: m.width };
    // actualBoundingBox* is the *ink* extent, which is what determines whether a
    // vertical stroke reaches the next row. fontBoundingBox* would not.
    const inkHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    return { glyph, advance: m.width, inkHeight };
  });
}

/**
 * Fonts offered in the picker.
 *
 * Availability is decided by *measurement*, not `document.fonts.check()` — the G0
 * spike found that returns `true` for fonts that are not installed (it reported
 * ten available when only two existed, six of them sharing one silent fallback's
 * metrics). {@link availableFonts} therefore compares each candidate's advance
 * against a known-generic baseline and drops the ones that match it exactly.
 */
const FONT_CANDIDATES: readonly string[] = [
  "Menlo",
  "Monaco",
  "SF Mono",
  "Andale Mono",
  "Courier New",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "monospace",
];

/** A stable per-font signature: advances for a handful of distinctive glyphs. */
function signature(family: string): string {
  const ctx = measureContext();
  const font: FontSpec = { family, sizePx: 64, lineHeightFactor: 1 };
  ctx.font = fontString(font);
  return ["M", "i", "─", "║", "█", "@"].map((g) => ctx.measureText(g).width.toFixed(3)).join(",");
}

export function availableFonts(): string[] {
  // A deliberately absent family forces the generic fallback; anything sharing
  // its signature did not actually resolve.
  const fallback = signature("__tui_designer_absent_font__");
  const out: string[] = [];
  for (const family of FONT_CANDIDATES) {
    if (family === "monospace" || signature(family) !== fallback) out.push(family);
  }
  return out;
}
