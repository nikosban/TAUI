/**
 * Glyph-coverage classification. Pure — the policy half of the font check.
 *
 * ## Why this checks two things, not one
 *
 * The GUI spec says: probe `─│┌┐└┘├┤┬┴┼═║╔░▒▓█`, and warn if any probe's width
 * ≠ `cellW`. The G0 spike showed that probe is **insufficient**: it reported
 * `PASS — all 22 probe glyphs advance exactly 13.2451px` for Menlo at
 * `lineHeightFactor: 1.5`, while the vertical walls in the very same frame were
 * visibly broken into dashes.
 *
 * A box-drawing character has two independent coverage requirements:
 *
 * - **Horizontal:** its advance must equal `cellW`, or columns drift.
 * - **Vertical:** for glyphs with a vertical arm (`│ ┃ ║` and friends), its *ink*
 *   must span the full `cellH`, or the wall breaks between rows.
 *
 * These have different causes and different remedies — a bad advance means
 * "change font", a short ink extent means "reduce line height" — so they are
 * reported separately.
 *
 * Measured on macOS: Menlo's `│` ink spans 1.2744 × fontSize, so line heights up
 * to ~1.27 are safe. Monaco's spans only 0.8516, so Monaco can never draw a
 * connected vertical wall at any usable line height.
 */

/** The probe set: box drawing, heavy, double, and block elements. */
export const GLYPH_PROBES: readonly string[] = [
  "─",
  "│",
  "┌",
  "┐",
  "└",
  "┘",
  "├",
  "┤",
  "┬",
  "┴",
  "┼",
  "═",
  "║",
  "╔",
  "╬",
  "━",
  "┃",
  "╋",
  "░",
  "▒",
  "▓",
  "█",
];

/**
 * Probes that must span the full cell height, because they carry a vertical *arm*
 * that has to meet the row above and below.
 *
 * Block elements are deliberately **excluded**, even though they look like they
 * belong. Menlo's `█` ink spans only 1.0195 × font size against `│`'s 1.2744, so
 * including it clamps the usable line height to ~1.02 and cramps every document —
 * a much worse outcome than the thing it would prevent.
 *
 * The consequence is real but narrower: a column of `█` will show a hairline seam
 * between rows at line heights above ~1.02. That is a block-shading limitation to
 * document (and a reason the v2 half-block brush will want its own handling), not
 * a reason to constrain the layout of every box-drawn mockup.
 */
export const VERTICAL_PROBES: readonly string[] = ["│", "┃", "║", "├", "┤", "┼", "╬", "╋"];

/** One measured probe. `inkHeight` is only needed for vertical probes. */
export interface ProbeMeasurement {
  readonly glyph: string;
  /** `measureText(glyph).width`. */
  readonly advance: number;
  /** `actualBoundingBoxAscent + actualBoundingBoxDescent`, or undefined if unmeasured. */
  readonly inkHeight?: number;
}

interface AdvanceOffender {
  readonly glyph: string;
  readonly advance: number;
  readonly expected: number;
}

interface VerticalOffender {
  readonly glyph: string;
  readonly inkHeight: number;
  readonly required: number;
  /** How many CSS px of gap each row boundary will show. */
  readonly gapPx: number;
}

export interface GlyphCoverage {
  readonly ok: boolean;
  /** Glyphs whose advance differs from `cellW` — columns will drift. */
  readonly advanceOffenders: readonly AdvanceOffender[];
  /** Glyphs whose ink is shorter than `cellH` — vertical walls will break. */
  readonly verticalOffenders: readonly VerticalOffender[];
  /**
   * Largest `lineHeightFactor` that keeps every vertical probe connected, or
   * `null` when no ink heights were supplied.
   */
  readonly maxLineHeightFactor: number | null;
}

/** Subpixel tolerance. Font metrics are not exact binary fractions. */
const TOLERANCE_PX = 0.05;

export function classifyCoverage(
  probes: readonly ProbeMeasurement[],
  cellW: number,
  cellH: number,
  fontSizePx: number,
  tolerancePx: number = TOLERANCE_PX,
): GlyphCoverage {
  const advanceOffenders: AdvanceOffender[] = [];
  const verticalOffenders: VerticalOffender[] = [];
  let minVerticalInk = Number.POSITIVE_INFINITY;

  const verticalSet = new Set(VERTICAL_PROBES);

  for (const probe of probes) {
    if (Math.abs(probe.advance - cellW) > tolerancePx) {
      advanceOffenders.push({ glyph: probe.glyph, advance: probe.advance, expected: cellW });
    }
    if (!verticalSet.has(probe.glyph) || probe.inkHeight === undefined) continue;
    minVerticalInk = Math.min(minVerticalInk, probe.inkHeight);
    const gap = cellH - probe.inkHeight;
    if (gap > tolerancePx) {
      verticalOffenders.push({
        glyph: probe.glyph,
        inkHeight: probe.inkHeight,
        required: cellH,
        gapPx: gap,
      });
    }
  }

  const maxLineHeightFactor =
    Number.isFinite(minVerticalInk) && fontSizePx > 0 ? minVerticalInk / fontSizePx : null;

  return {
    ok: advanceOffenders.length === 0 && verticalOffenders.length === 0,
    advanceOffenders,
    verticalOffenders,
    maxLineHeightFactor,
  };
}

/**
 * A user-facing message, or `null` when coverage is fine.
 *
 * Kept here rather than in a component so the wording is testable, and so the
 * two failure modes cannot be collapsed into one vague warning.
 */
export function coverageWarning(coverage: GlyphCoverage, family: string): string | null {
  if (coverage.ok) return null;
  const parts: string[] = [];
  if (coverage.advanceOffenders.length > 0) {
    const glyphs = coverage.advanceOffenders.map((o) => o.glyph).join(" ");
    parts.push(
      `${family} lacks aligned box-drawing glyphs (${coverage.advanceOffenders.length}: ${glyphs}) — columns may drift. Try a different font.`,
    );
  }
  if (coverage.verticalOffenders.length > 0) {
    const worst = coverage.verticalOffenders.reduce((a, b) => (b.gapPx > a.gapPx ? b : a));
    const suggestion =
      coverage.maxLineHeightFactor === null
        ? ""
        : ` Reduce line height to ${coverage.maxLineHeightFactor.toFixed(2)} or below.`;
    parts.push(
      `Vertical lines will break: ${worst.glyph} leaves a ${worst.gapPx.toFixed(1)}px gap at each row boundary.${suggestion}`,
    );
  }
  return parts.join(" ");
}

/**
 * Clamps a requested `lineHeightFactor` to what the font can actually draw.
 *
 * Applied in the prefs store so a user cannot silently destroy vertical wall
 * continuity — the G0 spike's main finding. Never returns below 1.0: squeezing
 * rows tighter than the font size overlaps glyphs, which is a worse failure.
 */
export function clampLineHeightFactor(requested: number, coverage: GlyphCoverage): number {
  const max = coverage.maxLineHeightFactor;
  if (max === null) return requested;
  return Math.max(1, Math.min(requested, max));
}
