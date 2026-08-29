import { describe, expect, it } from "vitest";
import {
  clampLineHeightFactor,
  classifyCoverage,
  coverageWarning,
  GLYPH_PROBES,
  type ProbeMeasurement,
  VERTICAL_PROBES,
} from "../src/canvas/coverage.js";

/**
 * Real measurements from the G0 spike (macOS, Chrome 151).
 *
 * Menlo @14px: cellW 8.4287, every probe uniform, `│` ink 17.84px (1.2744 × size).
 * Monaco @14px: cellW 8.4014, doubles/shading substituted from Menlo at 8.4287,
 * and its native `│` ink is only 11.92px (0.8516 × size).
 */
const MENLO = { cellW: 8.4287, sizePx: 14, verticalInk: 17.84 };
const MONACO = { cellW: 8.4014, sizePx: 14, verticalInk: 11.92 };

function probesFor(
  font: { cellW: number; verticalInk: number },
  overrides: Record<string, Partial<ProbeMeasurement>> = {},
): ProbeMeasurement[] {
  const verticalSet = new Set(VERTICAL_PROBES);
  return GLYPH_PROBES.map((glyph) => {
    const base: ProbeMeasurement = verticalSet.has(glyph)
      ? { glyph, advance: font.cellW, inkHeight: font.verticalInk }
      : { glyph, advance: font.cellW };
    return { ...base, ...overrides[glyph] };
  });
}

describe("classifyCoverage — the horizontal check", () => {
  it("passes a font whose probes all match cellW", () => {
    const c = classifyCoverage(probesFor(MENLO), MENLO.cellW, 16.8, MENLO.sizePx);
    expect(c.advanceOffenders).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it("flags glyphs substituted from a fallback font", () => {
    // Monaco's real failure mode: it lacks ═ ║ ╬ ░, so Chrome substitutes them
    // from Menlo at Menlo's slightly wider advance.
    const probes = probesFor(MONACO, {
      "═": { advance: 8.4287 },
      "║": { advance: 8.4287, inkHeight: 17.84 },
      "╬": { advance: 8.4287, inkHeight: 17.84 },
      "░": { advance: 8.4287 },
    });
    const c = classifyCoverage(probes, MONACO.cellW, 16.8, MONACO.sizePx, 0.01);
    expect(c.advanceOffenders.map((o) => o.glyph)).toEqual(["═", "║", "╬", "░"]);
    expect(c.ok).toBe(false);
  });

  it("tolerates subpixel noise", () => {
    const probes = probesFor(MENLO, { "┼": { advance: MENLO.cellW + 0.02, inkHeight: 17.84 } });
    expect(classifyCoverage(probes, MENLO.cellW, 16.8, MENLO.sizePx).advanceOffenders).toEqual([]);
  });

  it("reports what was expected, so the message can be specific", () => {
    const probes = probesFor(MENLO, { "─": { advance: 12 } });
    const [offender] = classifyCoverage(probes, MENLO.cellW, 16.8, MENLO.sizePx).advanceOffenders;
    expect(offender).toEqual({ glyph: "─", advance: 12, expected: MENLO.cellW });
  });
});

describe("classifyCoverage — the vertical check the spec was missing", () => {
  it("passes Menlo at the default line height of 1.2", () => {
    // cellH 16.8 vs ink 17.84 — connected, with 1.04px to spare.
    const c = classifyCoverage(probesFor(MENLO), MENLO.cellW, 14 * 1.2, 14);
    expect(c.verticalOffenders).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it("catches Menlo at line height 1.5, which the width-only probe called PASS", () => {
    // This is the exact case the G0 spike caught the spec's probe missing.
    const c = classifyCoverage(probesFor(MENLO), MENLO.cellW, 14 * 1.5, 14);
    expect(c.advanceOffenders).toEqual([]); // width check still happy…
    expect(c.verticalOffenders.length).toBeGreaterThan(0); // …but walls break
    expect(c.ok).toBe(false);
    expect(c.verticalOffenders[0]?.gapPx).toBeCloseTo(21 - 17.84, 2);
  });

  it("finds the exact line-height threshold for Menlo", () => {
    const at = (lh: number) => classifyCoverage(probesFor(MENLO), MENLO.cellW, 14 * lh, 14);
    expect(at(1.25).verticalOffenders).toEqual([]);
    expect(at(1.27).verticalOffenders).toEqual([]);
    expect(at(1.3).verticalOffenders.length).toBeGreaterThan(0);
    expect(at(1.2744).maxLineHeightFactor).toBeCloseTo(1.2744, 3);
  });

  it("rejects Monaco at every usable line height", () => {
    // Monaco's native │ spans only 0.8516 × size, so even lh 1.0 leaves a gap.
    for (const lh of [1.0, 1.1, 1.2, 1.5]) {
      const c = classifyCoverage(probesFor(MONACO), MONACO.cellW, 14 * lh, 14);
      expect(c.verticalOffenders.length, `lh ${lh}`).toBeGreaterThan(0);
    }
    expect(
      classifyCoverage(probesFor(MONACO), MONACO.cellW, 16.8, 14).maxLineHeightFactor,
    ).toBeCloseTo(0.8514, 3);
  });

  it("only checks glyphs that carry a vertical arm", () => {
    // A short ── is expected: its ink is a single horizontal stroke.
    const probes = probesFor(MENLO, { "─": { advance: MENLO.cellW, inkHeight: 1.18 } });
    expect(classifyCoverage(probes, MENLO.cellW, 16.8, 14).verticalOffenders).toEqual([]);
  });

  it("skips vertical probes with no ink measurement", () => {
    const probes = GLYPH_PROBES.map((glyph) => ({ glyph, advance: MENLO.cellW }));
    const c = classifyCoverage(probes, MENLO.cellW, 16.8, 14);
    expect(c.verticalOffenders).toEqual([]);
    expect(c.maxLineHeightFactor).toBeNull();
  });

  it("returns null maxLineHeightFactor for a zero font size", () => {
    expect(classifyCoverage(probesFor(MENLO), MENLO.cellW, 16.8, 0).maxLineHeightFactor).toBeNull();
  });

  it("uses the shortest vertical ink, not the average", () => {
    const probes = probesFor(MENLO, { "║": { advance: MENLO.cellW, inkHeight: 12 } });
    const c = classifyCoverage(probes, MENLO.cellW, 16.8, 14);
    expect(c.maxLineHeightFactor).toBeCloseTo(12 / 14, 4);
    expect(c.verticalOffenders.map((o) => o.glyph)).toEqual(["║"]);
  });
});

describe("coverageWarning", () => {
  it("says nothing when coverage is fine", () => {
    const c = classifyCoverage(probesFor(MENLO), MENLO.cellW, 16.8, 14);
    expect(coverageWarning(c, "Menlo")).toBeNull();
  });

  it("names the font and blames the font for an advance problem", () => {
    const probes = probesFor(MONACO, {
      "═": { advance: 9 },
      "║": { advance: 9, inkHeight: 17.84 },
    });
    const msg = coverageWarning(classifyCoverage(probes, MONACO.cellW, 16.8, 14), "Monaco");
    expect(msg).toContain("Monaco lacks aligned box-drawing glyphs");
    expect(msg).toContain("═ ║");
    expect(msg).toContain("Try a different font");
  });

  it("blames line height for a vertical problem, and suggests a value", () => {
    const msg = coverageWarning(classifyCoverage(probesFor(MENLO), MENLO.cellW, 21, 14), "Menlo");
    expect(msg).toContain("Vertical lines will break");
    expect(msg).toContain("3.2px gap");
    expect(msg).toContain("Reduce line height to 1.27 or below");
  });

  it("reports both problems when both are present", () => {
    const probes = probesFor(MONACO, { "═": { advance: 9 } });
    const msg = coverageWarning(classifyCoverage(probes, MONACO.cellW, 21, 14), "Monaco");
    expect(msg).toContain("lacks aligned");
    expect(msg).toContain("Vertical lines will break");
  });

  it("omits the suggestion when no ink was measured", () => {
    const probes = GLYPH_PROBES.map((glyph) => ({
      glyph,
      advance: glyph === "─" ? 99 : MENLO.cellW,
    }));
    const msg = coverageWarning(classifyCoverage(probes, MENLO.cellW, 16.8, 14), "Test");
    expect(msg).not.toContain("Reduce line height");
  });

  it("still describes a vertical break with no factor to suggest", () => {
    // `coverageWarning` is a pure formatter and must not assume its input came
    // from `classifyCoverage`, which would never produce this combination.
    const msg = coverageWarning(
      {
        ok: false,
        advanceOffenders: [],
        verticalOffenders: [{ glyph: "│", inkHeight: 10, required: 16.8, gapPx: 6.8 }],
        maxLineHeightFactor: null,
      },
      "Mystery",
    );
    expect(msg).toContain("Vertical lines will break");
    expect(msg).toContain("6.8px gap");
    expect(msg).not.toContain("Reduce line height");
  });

  it("names the worst offender when several break", () => {
    const msg = coverageWarning(
      {
        ok: false,
        advanceOffenders: [],
        verticalOffenders: [
          { glyph: "│", inkHeight: 15, required: 16.8, gapPx: 1.8 },
          { glyph: "║", inkHeight: 11, required: 16.8, gapPx: 5.8 },
        ],
        maxLineHeightFactor: 0.78,
      },
      "Mystery",
    );
    expect(msg).toContain("║");
    expect(msg).toContain("5.8px gap");
  });
});

describe("clampLineHeightFactor", () => {
  it("leaves a safe value alone", () => {
    const c = classifyCoverage(probesFor(MENLO), MENLO.cellW, 16.8, 14);
    expect(clampLineHeightFactor(1.2, c)).toBe(1.2);
  });

  it("clamps a request that would break the walls", () => {
    // The G0 finding, enforced: the user cannot silently destroy wall continuity.
    const c = classifyCoverage(probesFor(MENLO), MENLO.cellW, 16.8, 14);
    expect(clampLineHeightFactor(1.5, c)).toBeCloseTo(1.2743, 3);
    expect(clampLineHeightFactor(3, c)).toBeCloseTo(1.2743, 3);
  });

  it("never clamps below 1.0, since overlapping rows is worse", () => {
    const c = classifyCoverage(probesFor(MONACO), MONACO.cellW, 16.8, 14);
    expect(c.maxLineHeightFactor).toBeLessThan(1);
    expect(clampLineHeightFactor(1.2, c)).toBe(1);
  });

  it("passes the request through when the font was not measured", () => {
    const probes = GLYPH_PROBES.map((glyph) => ({ glyph, advance: MENLO.cellW }));
    const c = classifyCoverage(probes, MENLO.cellW, 16.8, 14);
    expect(clampLineHeightFactor(1.9, c)).toBe(1.9);
  });
});

describe("the probe sets", () => {
  it("includes every glyph the spec lists, plus heavy variants", () => {
    for (const glyph of [
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
      "░",
      "▒",
      "▓",
      "█",
    ]) {
      expect(GLYPH_PROBES, glyph).toContain(glyph);
    }
    expect(GLYPH_PROBES).toContain("━");
    expect(GLYPH_PROBES).toContain("┃");
  });

  it("excludes block elements, which would otherwise cramp every document", () => {
    // Regression guard. Menlo's █ ink spans 1.0195 × size against │'s 1.2744, so
    // treating it as a wall glyph clamped the usable line height to 1.02 and made
    // the whole canvas look squashed. Caught by looking at the rendered app.
    for (const glyph of ["█", "░", "▒", "▓"]) {
      expect(VERTICAL_PROBES, `${glyph} must not constrain line height`).not.toContain(glyph);
    }

    // With Menlo's real numbers, the default 1.2 must survive unclamped.
    const probes = probesFor(MENLO, { "█": { advance: MENLO.cellW, inkHeight: 14.27 } });
    const c = classifyCoverage(probes, MENLO.cellW, 14 * 1.2, 14);
    expect(c.ok).toBe(true);
    expect(clampLineHeightFactor(1.2, c)).toBe(1.2);
    expect(c.maxLineHeightFactor).toBeCloseTo(1.2744, 3);
  });

  it("marks only glyphs with a vertical arm as vertical probes", () => {
    for (const glyph of VERTICAL_PROBES) {
      expect(GLYPH_PROBES, `${glyph} must also be a general probe`).toContain(glyph);
    }
    // A pure horizontal rule has no vertical arm and must not be required to
    // span the cell height.
    expect(VERTICAL_PROBES).not.toContain("─");
    expect(VERTICAL_PROBES).not.toContain("━");
    expect(VERTICAL_PROBES).not.toContain("═");
  });
});
