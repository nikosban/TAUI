/**
 * SVG export.
 *
 * Two structural decisions, both about column alignment:
 *
 * **One `<text>` per row, one `<tspan>` per style run.** A `<text>` per *cell*
 * would quadruple the file for a full-screen mockup; a single `<text>` per row
 * cannot express a row whose foreground changes. Runs are the middle ground.
 *
 * **Every run pins `x` and `textLength`.** Without them the renderer uses the
 * font's own advances, and any font substitution — inevitable, since the viewer
 * may not have the authoring font — drifts columns apart. `lengthAdjust` is
 * `spacingAndGlyphs`, so a run occupies exactly `len × cellW` whatever font
 * resolves. This is the same failure the canvas renderer avoids by positioning
 * each glyph explicitly.
 *
 * Core cannot measure a font, so cell metrics arrive as options. The defaults are
 * a plausible 13px monospace cell, not a measurement.
 */

import { ansi256ToRgb, type Color } from "../model/color.js";
import type { TuiDocument } from "../model/document.js";
import { composite, type ResolvedCell, type ResolvedGrid } from "./composite.js";

/** How to paint the two colours SVG has no notion of. */
export interface SvgTheme {
  /** CSS colour for `{ kind: "default" }` foreground. */
  readonly defaultFg: string;
  /** CSS colour for `{ kind: "default" }` background. */
  readonly defaultBg: string;
}

export const DEFAULT_SVG_THEME: SvgTheme = {
  defaultFg: "#d8dee9",
  defaultBg: "#0d0f12",
};

export interface ToSvgOptions {
  /** Cell width in user units. Default 8. */
  readonly cellW?: number;
  /** Cell height in user units. Default 16. */
  readonly cellH?: number;
  /** Font size in user units. Default 13. */
  readonly fontSize?: number;
  /**
   * Baseline offset within the cell. Default `cellH * 0.78`, which sits a 13px
   * glyph plausibly inside a 16-unit cell.
   */
  readonly baseline?: number;
  readonly fontFamily?: string;
  readonly theme?: SvgTheme;
  /**
   * Paint a page-wide background rect. Default `true`.
   *
   * When false the SVG is transparent wherever a cell's background is `default`,
   * which is what you want when embedding it over an existing page.
   */
  readonly pageBackground?: boolean;
}

const DEFAULT_FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** XML text-node escaping. */
const escapeText = (s: string): string =>
  s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** XML attribute-value escaping; adds the quote characters. */
const escapeAttr = (s: string): string =>
  escapeText(s).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");

const hex = (n: number): string => n.toString(16).padStart(2, "0");

/** A Color as a CSS colour string, using xterm's RGB for the indexed forms. */
export function colorToCss(color: Color, theme: SvgTheme, layer: "fg" | "bg"): string {
  switch (color.kind) {
    case "default":
      return layer === "fg" ? theme.defaultFg : theme.defaultBg;
    case "rgb":
      return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
    case "ansi16":
    case "ansi256": {
      const [r, g, b] = ansi256ToRgb(color.index);
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    }
  }
}

/** The effective colours of a cell, after `inverse` has swapped them. */
function effectiveColors(
  cell: ResolvedCell,
  theme: SvgTheme,
): { readonly fg: string; readonly bg: string } {
  const fg = colorToCss(cell.fg, theme, "fg");
  const bg = colorToCss(cell.bg, theme, "bg");
  // Inverse is a rendering instruction, not stored colour, so it is applied here
  // rather than being baked into the document.
  return cell.inverse === true ? { fg: bg, bg: fg } : { fg, bg };
}

/** Whether a cell needs a background rect at all. */
const paintsBackground = (cell: ResolvedCell): boolean =>
  cell.inverse === true || cell.bg.kind !== "default";

/** The run-identity of a cell's text styling. */
const textKey = (cell: ResolvedCell, theme: SvgTheme): string => {
  const { fg } = effectiveColors(cell, theme);
  return [fg, cell.bold ?? false, cell.italic ?? false, cell.underline ?? false].join("|");
};

interface Run {
  readonly start: number;
  chars: string;
  readonly cell: ResolvedCell;
}

/** Groups a row into maximal runs sharing `key`. */
function runsOf(row: readonly ResolvedCell[], key: (cell: ResolvedCell) => string): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  let currentKey = "";
  for (const [col, cell] of row.entries()) {
    const cellKey = key(cell);
    if (current === null || cellKey !== currentKey) {
      current = { start: col, chars: cell.char, cell };
      currentKey = cellKey;
      runs.push(current);
      continue;
    }
    current.chars += cell.char;
  }
  return runs;
}

export function toSvg(doc: TuiDocument, opts: ToSvgOptions = {}): string {
  return gridToSvg(composite(doc), opts);
}

/** `toSvg` over an already-composited grid. */
export function gridToSvg(grid: ResolvedGrid, opts: ToSvgOptions = {}): string {
  const cellW = opts.cellW ?? 8;
  const cellH = opts.cellH ?? 16;
  const fontSize = opts.fontSize ?? 13;
  const baseline = opts.baseline ?? cellH * 0.78;
  const fontFamily = opts.fontFamily ?? DEFAULT_FONT_STACK;
  const theme = opts.theme ?? DEFAULT_SVG_THEME;

  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const width = cols * cellW;
  const height = rows * cellH;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="${escapeAttr(fontFamily)}" ` +
      `font-size="${fontSize}">`,
  );

  if (opts.pageBackground !== false) {
    parts.push(`<rect width="${width}" height="${height}" fill="${escapeAttr(theme.defaultBg)}"/>`);
  }

  // Backgrounds first, as one rect per run, so they sit under every glyph.
  const rects: string[] = [];
  for (const [rowIndex, row] of grid.entries()) {
    for (const run of runsOf(row, (cell) => effectiveColors(cell, theme).bg)) {
      if (!paintsBackground(run.cell)) continue;
      const { bg } = effectiveColors(run.cell, theme);
      rects.push(
        `<rect x="${run.start * cellW}" y="${rowIndex * cellH}" ` +
          `width="${run.chars.length * cellW}" height="${cellH}" fill="${escapeAttr(bg)}"/>`,
      );
    }
  }
  if (rects.length > 0) parts.push(`<g>${rects.join("")}</g>`);

  for (const [rowIndex, row] of grid.entries()) {
    const spans: string[] = [];
    for (const run of runsOf(row, (cell) => textKey(cell, theme))) {
      // Spaces at a run's edges paint nothing — the background rect already did —
      // so they are dropped and `x` moves in to compensate. Without this an
      // all-default row becomes one tspan spanning every column: correct, but it
      // makes a mostly-empty mockup far larger than it needs to be. Interior
      // spaces are kept, because they hold the columns apart.
      const lead = run.chars.length - run.chars.trimStart().length;
      const chars = run.chars.trim();
      if (chars === "") continue;
      const { fg } = effectiveColors(run.cell, theme);
      const attrs = [
        `x="${(run.start + lead) * cellW}"`,
        `textLength="${chars.length * cellW}"`,
        `lengthAdjust="spacingAndGlyphs"`,
        `fill="${escapeAttr(fg)}"`,
      ];
      if (run.cell.bold === true) attrs.push(`font-weight="bold"`);
      if (run.cell.italic === true) attrs.push(`font-style="italic"`);
      if (run.cell.underline === true) attrs.push(`text-decoration="underline"`);
      spans.push(`<tspan ${attrs.join(" ")}>${escapeText(chars)}</tspan>`);
    }
    if (spans.length === 0) continue;
    // No whitespace between tspans: with xml:space="preserve" an indented child
    // would render as a literal space and shift the row.
    parts.push(
      `<text xml:space="preserve" y="${rowIndex * cellH + baseline}">${spans.join("")}</text>`,
    );
  }

  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}
