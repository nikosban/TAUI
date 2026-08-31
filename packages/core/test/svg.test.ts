/**
 * SVG export.
 *
 * The load-bearing property is column alignment: every run must pin `x` and
 * `textLength`, because the viewer will not have the authoring font and the
 * font it substitutes will have different advances.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { drawBox } from "../src/ops/box.js";
import { drawText, setCell } from "../src/ops/draw.js";
import { colorToCss, DEFAULT_SVG_THEME, gridToSvg, toSvg } from "../src/render/svg.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const doc = (cols: number, rows: number): TuiDocument =>
  createDocument(cols, rows, { idGen: sequentialIdGen() });

/** Every attribute of every tag of a given name. */
const tags = (svg: string, name: string): string[] =>
  svg.match(new RegExp(`<${name}\\b[^>]*>`, "gu")) ?? [];

describe("document structure", () => {
  it("sizes the canvas from the grid and the cell metrics", () => {
    const svg = toSvg(doc(10, 4), { cellW: 8, cellH: 16 });
    expect(svg).toContain(`width="80"`);
    expect(svg).toContain(`height="64"`);
    expect(svg).toContain(`viewBox="0 0 80 64"`);
  });

  it("honours custom metrics", () => {
    const svg = toSvg(doc(2, 2), { cellW: 10, cellH: 20, fontSize: 17 });
    expect(svg).toContain(`width="20"`);
    expect(svg).toContain(`height="40"`);
    expect(svg).toContain(`font-size="17"`);
  });

  it("rejects invalid metrics before emitting malformed or unbounded geometry", () => {
    for (const options of [
      { cellW: 0 },
      { cellH: Number.POSITIVE_INFINITY },
      { fontSize: Number.NaN },
      { baseline: -1 },
    ]) {
      expect(() => toSvg(doc(2, 2), options), JSON.stringify(options)).toThrow(/finite positive/u);
    }
  });

  it("rejects finite metrics whose derived geometry overflows", () => {
    expect(() => toSvg(doc(2, 2), { cellW: Number.MAX_VALUE })).toThrow(/remain finite/u);
    expect(() =>
      toSvg(doc(2, 2), { cellH: Number.MAX_VALUE / 2, baseline: Number.MAX_VALUE }),
    ).toThrow(/remain finite/u);
  });

  it("declares the SVG namespace and a monospace stack", () => {
    const svg = toSvg(doc(2, 1));
    expect(svg).toContain(`xmlns="http://www.w3.org/2000/svg"`);
    expect(svg).toContain("monospace");
  });

  it("paints a page background by default and omits it on request", () => {
    expect(toSvg(doc(2, 1))).toContain(DEFAULT_SVG_THEME.defaultBg);
    const bare = toSvg(doc(2, 1), { pageBackground: false });
    expect(tags(bare, "rect")).toHaveLength(0);
  });

  it("emits no text element for an entirely blank row", () => {
    // A blank row has nothing to draw; an empty <text> would just be noise.
    expect(tags(toSvg(doc(4, 3)), "text")).toHaveLength(0);
  });

  it("ends with a newline, so the file is well-formed for a shell redirect", () => {
    expect(toSvg(doc(1, 1)).endsWith("</svg>\n")).toBe(true);
  });
});

describe("column alignment", () => {
  it("pins x and textLength on every run", () => {
    const d = drawText(doc(12, 1), "l1", 0, 3, "abc", STYLE);
    const spans = tags(toSvg(d, { cellW: 8 }), "tspan");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toContain(`x="24"`);
    expect(spans[0]).toContain(`textLength="24"`);
    expect(spans[0]).toContain(`lengthAdjust="spacingAndGlyphs"`);
  });

  it("gives every run an x equal to its column times the cell width", () => {
    // The property that makes font substitution harmless: no run's position
    // depends on the width of the run before it.
    let d = doc(20, 1);
    d = drawText(d, "l1", 0, 0, "aa", { fg: { kind: "ansi16", index: 1 }, bg: DEFAULT_COLOR });
    d = drawText(d, "l1", 0, 2, "bbb", { fg: { kind: "ansi16", index: 2 }, bg: DEFAULT_COLOR });
    d = drawText(d, "l1", 0, 5, "c", { fg: { kind: "ansi16", index: 3 }, bg: DEFAULT_COLOR });

    const spans = tags(toSvg(d, { cellW: 8 }), "tspan");
    const xs = spans.map((s) => Number(/x="(\d+)"/u.exec(s)?.[1]));
    const lens = spans.map((s) => Number(/textLength="(\d+)"/u.exec(s)?.[1]));
    expect(xs).toEqual([0, 16, 40]);
    expect(lens).toEqual([16, 24, 8]);
  });

  it("puts the baseline inside the cell and advances it per row", () => {
    let d = doc(3, 3);
    d = drawText(d, "l1", 0, 0, "a", STYLE);
    d = drawText(d, "l1", 2, 0, "b", STYLE);
    const svg = toSvg(d, { cellH: 20, baseline: 15 });
    const ys = tags(svg, "text").map((t) => Number(/y="([\d.]+)"/u.exec(t)?.[1]));
    expect(ys).toEqual([15, 55]);
  });

  it("emits no whitespace between tspans", () => {
    // With xml:space="preserve" an indented child would render as a literal
    // space and shift everything after it one column right.
    let d = doc(6, 1);
    d = drawText(d, "l1", 0, 0, "ab", { fg: { kind: "ansi16", index: 1 }, bg: DEFAULT_COLOR });
    d = drawText(d, "l1", 0, 2, "cd", { fg: { kind: "ansi16", index: 2 }, bg: DEFAULT_COLOR });
    expect(toSvg(d)).not.toMatch(/<\/tspan>\s+<tspan/u);
  });

  it("declares xml:space=preserve, so interior spaces survive", () => {
    const d = drawText(doc(8, 1), "l1", 0, 0, "a  b", STYLE);
    const svg = toSvg(d);
    expect(svg).toContain(`xml:space="preserve"`);
    expect(svg).toContain("a  b");
  });
});

describe("style runs", () => {
  it("splits a row where the foreground changes", () => {
    let d = drawText(doc(4, 1), "l1", 0, 0, "aa", STYLE);
    d = drawText(d, "l1", 0, 2, "bb", { fg: { kind: "ansi16", index: 1 }, bg: DEFAULT_COLOR });
    expect(tags(toSvg(d), "tspan")).toHaveLength(2);
  });

  it("keeps one run where the style is unchanged", () => {
    const d = drawText(doc(6, 1), "l1", 0, 0, "abcdef", STYLE);
    expect(tags(toSvg(d), "tspan")).toHaveLength(1);
  });

  it("carries bold, italic, and underline onto the run", () => {
    const d = setCell(doc(1, 1), "l1", 0, 0, {
      char: "x",
      ...STYLE,
      bold: true,
      italic: true,
      underline: true,
    });
    const span = tags(toSvg(d), "tspan")[0] ?? "";
    expect(span).toContain(`font-weight="bold"`);
    expect(span).toContain(`font-style="italic"`);
    expect(span).toContain(`text-decoration="underline"`);
  });

  it("omits style attributes that do not apply", () => {
    const d = drawText(doc(2, 1), "l1", 0, 0, "ab", STYLE);
    const span = tags(toSvg(d), "tspan")[0] ?? "";
    expect(span).not.toContain("font-weight");
    expect(span).not.toContain("font-style");
    expect(span).not.toContain("text-decoration");
  });

  it("splits a run when only the weight changes", () => {
    let d = setCell(doc(2, 1), "l1", 0, 0, { char: "a", ...STYLE, bold: true });
    d = setCell(d, "l1", 0, 1, { char: "b", ...STYLE });
    expect(tags(toSvg(d), "tspan")).toHaveLength(2);
  });
});

describe("backgrounds", () => {
  it("emits one rect per background run, not per cell", () => {
    const d = drawText(doc(8, 1), "l1", 0, 0, "abcd", {
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 4 },
    });
    // The page background plus exactly one run rect.
    const rects = tags(toSvg(d), "rect");
    expect(rects).toHaveLength(2);
    expect(rects[1]).toContain(`width="32"`);
    expect(rects[1]).toContain(`x="0"`);
  });

  it("emits no rect for a default background", () => {
    const d = drawText(doc(4, 1), "l1", 0, 0, "abcd", STYLE);
    expect(tags(toSvg(d, { pageBackground: false }), "rect")).toHaveLength(0);
  });

  it("splits background runs where the colour changes", () => {
    let d = drawText(doc(4, 1), "l1", 0, 0, "aa", {
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 1 },
    });
    d = drawText(d, "l1", 0, 2, "bb", {
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 2 },
    });
    expect(tags(toSvg(d, { pageBackground: false }), "rect")).toHaveLength(2);
  });

  it("positions a background run on its own row", () => {
    const d = drawText(doc(4, 3), "l1", 2, 1, "xx", {
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 5 },
    });
    const rect = tags(toSvg(d, { pageBackground: false, cellW: 8, cellH: 16 }), "rect")[0] ?? "";
    expect(rect).toContain(`x="8"`);
    expect(rect).toContain(`y="32"`);
    expect(rect).toContain(`height="16"`);
  });

  it("paints a background under a run of spaces with no glyphs emitted", () => {
    // A coloured bar is spaces plus a background; the rect carries it and no
    // tspan is needed.
    const d = drawText(doc(4, 1), "l1", 0, 0, "    ", {
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi16", index: 4 },
    });
    const svg = toSvg(d, { pageBackground: false });
    expect(tags(svg, "rect")).toHaveLength(1);
    expect(tags(svg, "tspan")).toHaveLength(0);
  });
});

describe("inverse video", () => {
  it("swaps foreground and background", () => {
    const d = setCell(doc(1, 1), "l1", 0, 0, {
      char: "x",
      fg: { kind: "ansi16", index: 1 },
      bg: { kind: "ansi16", index: 4 },
      inverse: true,
    });
    const svg = toSvg(d, { pageBackground: false });
    const blue = colorToCss({ kind: "ansi16", index: 4 }, DEFAULT_SVG_THEME, "bg");
    const red = colorToCss({ kind: "ansi16", index: 1 }, DEFAULT_SVG_THEME, "fg");
    // The rect takes the original foreground; the glyph takes the background.
    expect(tags(svg, "rect")[0]).toContain(red);
    expect(tags(svg, "tspan")[0]).toContain(blue);
  });

  it("paints a rect even when the stored background is default", () => {
    // Inverse of a default-on-default cell still needs a rect, or the swap is
    // invisible.
    const d = setCell(doc(1, 1), "l1", 0, 0, { char: "x", ...STYLE, inverse: true });
    expect(tags(toSvg(d, { pageBackground: false }), "rect")).toHaveLength(1);
  });
});

describe("colour mapping", () => {
  it("emits truecolour as hex, zero-padded", () => {
    expect(colorToCss({ kind: "rgb", r: 1, g: 2, b: 255 }, DEFAULT_SVG_THEME, "fg")).toBe(
      "#0102ff",
    );
  });

  it("maps indexed colours through the xterm table", () => {
    expect(colorToCss({ kind: "ansi16", index: 1 }, DEFAULT_SVG_THEME, "fg")).toBe("#cd0000");
    expect(colorToCss({ kind: "ansi256", index: 231 }, DEFAULT_SVG_THEME, "fg")).toBe("#ffffff");
  });

  it("resolves default differently for foreground and background", () => {
    expect(colorToCss(DEFAULT_COLOR, DEFAULT_SVG_THEME, "fg")).toBe(DEFAULT_SVG_THEME.defaultFg);
    expect(colorToCss(DEFAULT_COLOR, DEFAULT_SVG_THEME, "bg")).toBe(DEFAULT_SVG_THEME.defaultBg);
  });

  it("takes a custom theme", () => {
    const svg = toSvg(drawText(doc(2, 1), "l1", 0, 0, "ab", STYLE), {
      theme: { defaultFg: "#ff0000", defaultBg: "#00ff00" },
    });
    expect(svg).toContain("#ff0000");
    expect(svg).toContain("#00ff00");
  });
});

describe("XML escaping", () => {
  it("escapes the characters that would otherwise break the document", () => {
    let d = doc(5, 1);
    for (const [i, ch] of [..."<&>\"'"].entries()) {
      d = setCell(d, "l1", 0, i, { char: ch, ...STYLE });
    }
    const svg = toSvg(d);
    expect(svg).toContain("&lt;&amp;&gt;");
    // No raw "<" survives inside text content, which is what would break parsing.
    const textContent = /<tspan\b[^>]*>(.*?)<\/tspan>/u.exec(svg)?.[1] ?? "";
    expect(textContent).not.toContain("<");
  });

  it("escapes a font family containing a quote", () => {
    const svg = toSvg(doc(1, 1), { fontFamily: `My "Font", monospace` });
    expect(svg).toContain("&quot;Font&quot;");
    expect(svg).not.toContain(`"My "Font"`);
  });

  it("keeps box-drawing characters literal, since they are valid XML text", () => {
    const d = drawBox(doc(6, 3), "l1", { top: 0, left: 0, rows: 3, cols: 6 }, "light", true, STYLE);
    const svg = toSvg(d);
    expect(svg).toContain("┌────┐");
    expect(svg).toContain("└────┘");
  });
});

describe("gridToSvg on an empty grid", () => {
  it("produces a valid zero-sized document rather than NaN dimensions", () => {
    // Unreachable through `toSvg` — a document always has at least one row — but
    // `gridToSvg` is public and must stay total.
    const svg = gridToSvg([]);
    expect(svg).toContain(`width="0"`);
    expect(svg).toContain(`height="0"`);
    expect(svg).toContain(`viewBox="0 0 0 0"`);
    expect(svg).not.toContain("NaN");
    expect(tags(svg, "tspan")).toHaveLength(0);
  });
});
