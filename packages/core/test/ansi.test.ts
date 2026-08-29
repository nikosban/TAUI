/**
 * ANSI export.
 *
 * Escape sequences are asserted literally. `\x1b` is written as `ESC` in the
 * expectations via a helper so the strings stay readable — an inline `\x1b[31m`
 * in a diff is very easy to misread.
 */

import { describe, expect, it } from "vitest";
import {
  ansi256ToRgb,
  type Color,
  type ColorMode,
  DEFAULT_COLOR,
  downgradeColor,
  rgbToAnsi16,
  rgbToAnsi256,
} from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { drawText, setCell } from "../src/ops/draw.js";
import { toAnsi } from "../src/render/ansi.js";
import { composite } from "../src/render/composite.js";

const E = "\x1b";
const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

/**
 * ESC patterns built from a char code rather than written as a literal.
 *
 * A bare `\x1b` inside a regex literal trips `noControlCharactersInRegex`, and
 * the rule is right in general — matching ESC is exactly what this file needs to
 * do, but suppressing it four times would be worse than naming it once.
 */
const ESC_ALL = new RegExp(String.fromCharCode(27), "gu");
const SGR_ALL = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/** Renders escapes visibly, so a failure diff is readable. */
const show = (s: string): string => s.replace(ESC_ALL, "ESC").replace(/\n/gu, "\\n");

/** Drops every SGR sequence, leaving the characters a terminal would show. */
const stripSgr = (s: string): string => s.replace(SGR_ALL, "");

const doc = (cols: number, rows: number, mode: ColorMode = "ansi256"): TuiDocument =>
  createDocument(cols, rows, { colorMode: mode, idGen: sequentialIdGen() });

describe("toAnsi structure", () => {
  it("ends every row with a reset and joins rows with newlines", () => {
    const d = doc(2, 2);
    expect(show(toAnsi(d))).toBe(`  ESC[0m\\n  ESC[0mESC[0m`);
  });

  it("omits the trailing reset on request", () => {
    const d = doc(2, 1);
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`  ESC[0m`);
  });

  it("emits one line per row even for an empty document", () => {
    expect(toAnsi(doc(1, 4)).split("\n")).toHaveLength(4);
  });

  it("keeps trailing spaces, because a styled space is how a background is painted", () => {
    // The opposite of toText, which trims for readability. Trimming here would
    // silently drop paint.
    const d = setCell(doc(4, 1), "l1", 0, 0, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 1 },
    });
    const line = toAnsi(d).split("\n")[0] ?? "";
    expect(line).toContain(`${E}[41m`);
    // Four columns of content survive.
    expect(stripSgr(line)).toBe("    ");
  });
});

describe("minimal-diff encoding", () => {
  it("emits a colour once for a run, not per cell", () => {
    const red = { fg: { kind: "ansi16" as const, index: 1 }, bg: DEFAULT_COLOR };
    const d = drawText(doc(5, 1), "l1", 0, 0, "abc", red);
    // One 31 for the run, then 39 when it returns to default at the space.
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`ESC[31mabcESC[39m  ESC[0m`);
  });

  it("emits nothing between two identically styled cells", () => {
    const d = drawText(doc(3, 1), "l1", 0, 0, "xyz", STYLE);
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`xyzESC[0m`);
  });

  it("restarts style tracking each row, so a row is independently renderable", () => {
    const red = { fg: { kind: "ansi16" as const, index: 1 }, bg: DEFAULT_COLOR };
    let d = drawText(doc(2, 2), "l1", 0, 0, "aa", red);
    d = drawText(d, "l1", 1, 0, "bb", red);
    const lines = toAnsi(d, { trailingReset: false }).split("\n");
    // The second row re-declares 31 rather than relying on the first row's state.
    expect(show(lines[1] ?? "")).toBe(`ESC[31mbbESC[0m`);
  });

  it("turns flags off with their own codes rather than a full reset", () => {
    let d = setCell(doc(2, 1), "l1", 0, 0, { char: "a", ...STYLE, bold: true });
    d = setCell(d, "l1", 0, 1, { char: "b", ...STYLE });
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`ESC[1maESC[22mbESC[0m`);
  });

  it("combines several changes into one sequence", () => {
    const d = setCell(doc(1, 1), "l1", 0, 0, {
      char: "x",
      fg: { kind: "ansi16", index: 2 },
      bg: { kind: "ansi16", index: 4 },
      bold: true,
      underline: true,
    });
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`ESC[1;4;32;44mxESC[0m`);
  });
});

describe("colour encodings", () => {
  const oneCell = (fg: Color, mode: ColorMode): string => {
    const d = setCell(doc(1, 1, mode), "l1", 0, 0, { char: "x", fg, bg: DEFAULT_COLOR });
    return show(toAnsi(d, { trailingReset: false }));
  };

  it("uses the compact form for the basic 8", () => {
    expect(oneCell({ kind: "ansi16", index: 3 }, "ansi16")).toBe(`ESC[33mxESC[0m`);
  });

  it("uses the bright range at +60 for 8–15", () => {
    expect(oneCell({ kind: "ansi16", index: 12 }, "ansi16")).toBe(`ESC[94mxESC[0m`);
  });

  it("uses 38;5;n for ansi256", () => {
    expect(oneCell({ kind: "ansi256", index: 208 }, "ansi256")).toBe(`ESC[38;5;208mxESC[0m`);
  });

  it("uses 38;2;r;g;b for truecolour", () => {
    expect(oneCell({ kind: "rgb", r: 10, g: 20, b: 30 }, "rgb")).toBe(`ESC[38;2;10;20;30mxESC[0m`);
  });

  it("uses 49 for a background returning to default", () => {
    let d = setCell(doc(2, 1), "l1", 0, 0, {
      char: "a",
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 1 },
    });
    d = setCell(d, "l1", 0, 1, { char: "b", ...STYLE });
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`ESC[41maESC[49mbESC[0m`);
  });

  it("downgrades a colour richer than the document's mode", () => {
    // Pure red in an ansi16 document must not emit a truecolour sequence.
    expect(oneCell({ kind: "rgb", r: 255, g: 0, b: 0 }, "ansi16")).toBe(`ESC[91mxESC[0m`);
  });

  it("leaves a colour poorer than the mode alone rather than expanding it", () => {
    // ansi16 red in an rgb document stays 31: shorter, and the theme still applies.
    expect(oneCell({ kind: "ansi16", index: 1 }, "rgb")).toBe(`ESC[31mxESC[0m`);
  });
});

describe("colour quantisation", () => {
  it("round-trips every ansi256 index through RGB and back", () => {
    // Each index must be the nearest match to its own RGB value, or the mapping
    // is inconsistent with itself.
    for (let i = 16; i < 256; i++) {
      const [r, g, b] = ansi256ToRgb(i);
      expect(rgbToAnsi256(r, g, b), `index ${i} -> rgb(${r},${g},${b})`).toBe(i);
    }
  });

  it("maps the cube corners to the expected indices", () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
    expect(rgbToAnsi256(255, 0, 0)).toBe(196);
  });

  it("prefers the grey ramp over the cube for near-greys", () => {
    // The classic bug: cube-only quantisation bands greys visibly. rgb(90,90,90)
    // is much closer to a ramp step than to any cube level.
    const index = rgbToAnsi256(90, 90, 90);
    expect(index).toBeGreaterThanOrEqual(232);
    const [r] = ansi256ToRgb(index);
    expect(Math.abs(r - 90)).toBeLessThanOrEqual(5);
  });

  it("maps RGB to the nearest of the 16 basic colours", () => {
    expect(rgbToAnsi16(0, 0, 0)).toBe(0);
    expect(rgbToAnsi16(255, 255, 255)).toBe(15);
    expect(rgbToAnsi16(255, 0, 0)).toBe(9);
    expect(rgbToAnsi16(200, 0, 0)).toBe(1);
  });

  it("treats indices under 16 as the basic colours in ansi256ToRgb", () => {
    expect(ansi256ToRgb(1)).toEqual([205, 0, 0]);
    expect(ansi256ToRgb(15)).toEqual([255, 255, 255]);
  });

  it("clamps an out-of-range ansi256 index rather than returning undefined", () => {
    // Reachable from a hand-edited file; renderers must stay total.
    expect(ansi256ToRgb(-1)).toEqual([0, 0, 0]);
  });
});

describe("downgradeColor", () => {
  it("leaves default alone in every mode", () => {
    for (const mode of ["ansi16", "ansi256", "rgb"] as const) {
      expect(downgradeColor(DEFAULT_COLOR, mode)).toEqual(DEFAULT_COLOR);
    }
  });

  it("is identity when the colour already fits the mode", () => {
    const c: Color = { kind: "ansi256", index: 100 };
    expect(downgradeColor(c, "ansi256")).toBe(c);
    expect(downgradeColor(c, "rgb")).toBe(c);
  });

  it("takes rgb to ansi256 and to ansi16", () => {
    expect(downgradeColor({ kind: "rgb", r: 255, g: 0, b: 0 }, "ansi256")).toEqual({
      kind: "ansi256",
      index: 196,
    });
    expect(downgradeColor({ kind: "rgb", r: 255, g: 0, b: 0 }, "ansi16")).toEqual({
      kind: "ansi16",
      index: 9,
    });
  });

  it("takes ansi256 to ansi16 via RGB", () => {
    expect(downgradeColor({ kind: "ansi256", index: 196 }, "ansi16")).toEqual({
      kind: "ansi16",
      index: 9,
    });
  });
});

describe("toAnsi agrees with the grid it renders", () => {
  /** The spec's acceptance criterion, minus the human eye: strip the escapes and
   * the characters left must be exactly what composite produced. */
  it("reduces to the composited characters when SGR is stripped", () => {
    let d = doc(12, 4, "rgb");
    d = drawText(d, "l1", 0, 0, "┌──────────┐", STYLE);
    d = drawText(d, "l1", 1, 0, "│ hello    │", {
      fg: { kind: "rgb", r: 200, g: 30, b: 30 },
      bg: { kind: "ansi256", index: 236 },
    });
    d = drawText(d, "l1", 2, 0, "└──────────┘", STYLE);

    const stripped = stripSgr(toAnsi(d)).split("\n");
    const grid = composite(d).map((row) => row.map((c) => c.char).join(""));
    expect(stripped).toEqual(grid);
  });

  it("emits exactly one reset per row plus the trailing one", () => {
    const d = doc(3, 5);
    const resets = (toAnsi(d).match(new RegExp(`${String.fromCharCode(27)}\\[0m`, "gu")) ?? [])
      .length;
    expect(resets).toBe(6);
  });
});

describe("every style flag, on and off", () => {
  // Each flag has an on-code and a distinct off-code, and getting an off-code
  // wrong leaks the style across the rest of the row.
  const FLAGS = [
    ["bold", 1, 22],
    ["italic", 3, 23],
    ["underline", 4, 24],
    ["inverse", 7, 27],
  ] as const;

  it.each(FLAGS)("%s turns on with %i and off with %i", (flag, on, off) => {
    let d = setCell(doc(2, 1), "l1", 0, 0, { char: "a", ...STYLE, [flag]: true });
    d = setCell(d, "l1", 0, 1, { char: "b", ...STYLE });
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`ESC[${on}maESC[${off}mbESC[0m`);
  });

  it("sets all four at once, then clears all four at once", () => {
    let d = setCell(doc(2, 1), "l1", 0, 0, {
      char: "a",
      ...STYLE,
      bold: true,
      italic: true,
      underline: true,
      inverse: true,
    });
    d = setCell(d, "l1", 0, 1, { char: "b", ...STYLE });
    expect(show(toAnsi(d, { trailingReset: false }))).toBe(`ESC[1;3;4;7maESC[22;23;24;27mbESC[0m`);
  });
});
