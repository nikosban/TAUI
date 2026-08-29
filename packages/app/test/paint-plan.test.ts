import {
  composite,
  createDocument,
  drawBox,
  drawLine,
  drawText,
  parseText,
  sequentialIdGen,
  setCell,
  type TuiDocument,
  toText,
} from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import type { DrawCmd, TextRunCmd } from "../src/canvas/draw-cmd.js";
import type { CellMetrics, GridSize, Viewport } from "../src/canvas/metrics.js";
import {
  buildPaintPlan,
  cssColor,
  type Overlays,
  planCaret,
  planCellBackgrounds,
  planCursor,
  planGlyphs,
  planGrid,
  planSelection,
  planUnderlines,
  type Theme,
} from "../src/canvas/paint-plan.js";

const M: CellMetrics = {
  cellW: 8,
  cellH: 16,
  dpr: 1,
  baselineY: 12,
  font: { family: "Menlo", sizePx: 14, lineHeightFactor: 1.2 },
};

const THEME: Theme = {
  voidFill: "#101010",
  defaultFg: "#e0e0e0",
  defaultBg: "#181818",
  gridLine: "#282828",
  selectionStroke: "#6fa8ff",
  cursorStroke: "#ffcc66",
  caretFill: "#ffcc66",
  caretText: "#181818",
  ansi16: [
    "#000000",
    "#cc0000",
    "#4e9a06",
    "#c4a000",
    "#3465a4",
    "#75507b",
    "#06989a",
    "#d3d7cf",
    "#555753",
    "#ef2929",
    "#8ae234",
    "#fce94f",
    "#729fcf",
    "#ad7fa8",
    "#34e2e2",
    "#eeeeec",
  ],
};

const NO_OVERLAYS: Overlays = {
  showGrid: false,
  selection: null,
  cursor: null,
  marqueePhase: 0,
  dragRect: null,
  caret: null,
};

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;

function inputFor(doc: TuiDocument, over: Partial<Overlays> = {}, vp: Partial<Viewport> = {}) {
  const size: GridSize = { cols: doc.cols, rows: doc.rows };
  const viewport: Viewport = {
    scrollX: 0,
    scrollY: 0,
    // Big enough that nothing is culled unless a test asks for it.
    widthPx: doc.cols * M.cellW,
    heightPx: doc.rows * M.cellH,
    zoom: 1,
    ...vp,
  };
  return {
    grid: composite(doc),
    size,
    metrics: M,
    viewport,
    overlays: { ...NO_OVERLAYS, ...over },
    theme: THEME,
  };
}

/**
 * Reconstructs the document text from a paint plan, by mapping each glyph's
 * pixel position back to a cell.
 *
 * This is the G1 acceptance check in executable form: if the planner puts a glyph
 * at the wrong x or y, the reconstruction disagrees with `toText` and names the
 * row. It verifies the whole geometry chain — metrics, run batching, per-glyph
 * advance — with no DOM and no pixel comparison.
 */
function textFromPlan(plan: readonly DrawCmd[], m: CellMetrics, size: GridSize): string {
  const rows: string[][] = Array.from({ length: size.rows }, () =>
    Array.from({ length: size.cols }, () => " "),
  );
  for (const cmd of plan) {
    if (cmd.t !== "text") continue;
    const run = cmd as TextRunCmd;
    const row = Math.round((run.y - m.baselineY) / m.cellH);
    for (const [i, char] of Array.from(run.text).entries()) {
      const col = Math.round((run.x + i * run.advance) / m.cellW);
      const target = rows[row];
      if (target === undefined) throw new Error(`glyph ${char} mapped to row ${row}, out of range`);
      if (col < 0 || col >= size.cols) {
        throw new Error(`glyph ${char} mapped to col ${col}, out of range`);
      }
      target[col] = char;
    }
  }
  return rows.map((r) => r.join("").replace(/\s+$/u, "")).join("\n");
}

describe("the G1 acceptance criterion: the plan reproduces toText exactly", () => {
  /** A fixture exercising junctions, styles, and every drawing op. */
  function fixture(): TuiDocument {
    let d = createDocument(40, 10, { idGen: sequentialIdGen() });
    const id = d.activeLayerId;
    d = drawBox(d, id, { top: 0, left: 0, rows: 4, cols: 20 }, "light", true, STYLE);
    d = drawBox(d, id, { top: 0, left: 19, rows: 4, cols: 21 }, "light", true, STYLE);
    d = drawBox(d, id, { top: 3, left: 0, rows: 4, cols: 40 }, "double", true, STYLE);
    d = drawLine(d, id, { row: 3, col: 28 }, { row: 6, col: 28 }, "heavy", true, STYLE);
    d = drawText(d, id, 1, 2, "CPU  42%", STYLE);
    d = drawText(d, id, 1, 21, "MEM  71%", STYLE);
    d = drawText(d, id, 4, 2, "requests/sec", STYLE);
    d = drawText(d, id, 8, 0, "░▒▓█ blocks", STYLE);
    d = setCell(d, id, 9, 0, { char: "!", ...STYLE, bold: true });
    return d;
  }

  it("round-trips a feature-complete fixture", () => {
    const doc = fixture();
    const plan = buildPaintPlan(inputFor(doc));
    expect(textFromPlan(plan, M, { cols: doc.cols, rows: doc.rows })).toBe(toText(doc));
  });

  it("holds at every zoom level", () => {
    const doc = fixture();
    for (const zoom of [0.5, 0.75, 1, 1.25, 2, 4]) {
      const scaled: CellMetrics = M;
      const input = inputFor(
        doc,
        {},
        {
          zoom,
          widthPx: doc.cols * M.cellW * zoom,
          heightPx: doc.rows * M.cellH * zoom,
        },
      );
      const plan = buildPaintPlan(input);
      // Reconstruct using the zoomed cell box.
      const zoomedMetrics: CellMetrics = {
        ...scaled,
        cellW: M.cellW * zoom,
        cellH: M.cellH * zoom,
        baselineY: M.baselineY * zoom,
      };
      expect(
        textFromPlan(plan, zoomedMetrics, { cols: doc.cols, rows: doc.rows }),
        `zoom ${zoom}`,
      ).toBe(toText(doc));
    }
  });

  it("holds with a fractional cellW, as every real font has", () => {
    // Menlo @14px. If the planner accumulated instead of multiplying, the
    // reconstruction would drift and this would fail.
    const fractional: CellMetrics = { ...M, cellW: 8.4287, cellH: 16.8, baselineY: 13.4 };
    const doc = fixture();
    const input = {
      ...inputFor(doc),
      metrics: fractional,
      viewport: {
        scrollX: 0,
        scrollY: 0,
        widthPx: doc.cols * fractional.cellW,
        heightPx: doc.rows * fractional.cellH,
        zoom: 1,
      },
    };
    const plan = buildPaintPlan(input);
    expect(textFromPlan(plan, fractional, { cols: doc.cols, rows: doc.rows })).toBe(toText(doc));
  });

  it("holds for a wide document where drift would accumulate", () => {
    const doc = parseText("─".repeat(120), { idGen: sequentialIdGen() }).doc;
    const fractional: CellMetrics = { ...M, cellW: 8.4287, cellH: 16.8, baselineY: 13.4 };
    const input = {
      grid: composite(doc),
      size: { cols: doc.cols, rows: doc.rows },
      metrics: fractional,
      viewport: {
        scrollX: 0,
        scrollY: 0,
        widthPx: doc.cols * fractional.cellW,
        heightPx: doc.rows * fractional.cellH,
        zoom: 1,
      },
      overlays: NO_OVERLAYS,
      theme: THEME,
    };
    const plan = buildPaintPlan(input);
    expect(textFromPlan(plan, fractional, { cols: 120, rows: 1 })).toBe(toText(doc));
  });
});

describe("robustness", () => {
  it("survives a grid shorter than its declared size", () => {
    // A caller can hand over a stale composite while `size` already reflects a
    // resize. Painting the rows that exist beats throwing mid-frame.
    const doc = drawText(
      createDocument(6, 4, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "ab",
      STYLE,
    );
    const truncated = {
      ...inputFor(doc),
      grid: composite(doc).slice(0, 2), // claims 4 rows, supplies 2
    };
    expect(() => buildPaintPlan(truncated)).not.toThrow();
    const runs = planGlyphs(truncated).filter((c) => c.t === "text");
    expect(runs).toHaveLength(1);
  });

  it("survives rows shorter than the declared column count", () => {
    const doc = drawText(
      createDocument(6, 1, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "abc",
      STYLE,
    );
    const ragged = {
      ...inputFor(doc),
      grid: composite(doc).map((row) => row.slice(0, 2)),
    };
    const runs = planGlyphs(ragged).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs[0]?.text).toBe("ab");
  });
});

describe("device pixel ratio isolation", () => {
  it("affects only grid hairline width, never geometry", () => {
    // The renderer applies setTransform(dpr, …) once, so the plan stays in CSS
    // pixels. The single exception is a hairline, which is 1/dpr CSS px by
    // definition.
    let doc = createDocument(10, 4, { idGen: sequentialIdGen() });
    doc = drawBox(doc, "l1", { top: 0, left: 0, rows: 4, cols: 10 }, "light", true, STYLE);
    doc = drawText(doc, "l1", 1, 1, "hi", STYLE);

    const at = (dpr: number) =>
      buildPaintPlan({
        ...inputFor(doc, { showGrid: true, cursor: { row: 1, col: 1 } }),
        metrics: { ...M, dpr },
      });

    const one = at(1);
    const two = at(2);
    expect(two).toHaveLength(one.length);

    for (const [i, cmd] of one.entries()) {
      const other = two[i];
      if (cmd.t === "lines") {
        expect(other?.t).toBe("lines");
        if (other?.t !== "lines") throw new Error("expected lines");
        expect(cmd.lineWidth).toBe(1);
        expect(other.lineWidth).toBe(0.5);
        // Geometry itself is unchanged.
        expect(other.segments).toEqual(cmd.segments);
      } else {
        expect(other, `command ${i} (${cmd.t}) must not depend on dpr`).toEqual(cmd);
      }
    }
  });
});

describe("paint order", () => {
  it("clears to the void, then paints the document background over it", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    const plan = buildPaintPlan(inputFor(doc));
    expect(plan[0]).toEqual({ t: "clear", fill: THEME.voidFill });
    expect(plan[1]).toEqual({ t: "rect", x: 0, y: 0, w: 32, h: 32, fill: THEME.defaultBg });
  });

  it("puts the document rect at the scrolled origin, leaving the void visible", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    const plan = buildPaintPlan(inputFor(doc, {}, { scrollX: -8, scrollY: -16 }));
    expect(plan[1]).toEqual({ t: "rect", x: 8, y: 16, w: 32, h: 32, fill: THEME.defaultBg });
  });

  it("emits overlays after cells", () => {
    const doc = drawText(
      createDocument(6, 2, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "hi",
      STYLE,
    );
    const plan = buildPaintPlan(
      inputFor(doc, {
        showGrid: true,
        cursor: { row: 0, col: 0 },
        selection: { top: 0, left: 0, rows: 1, cols: 2 },
      }),
    );
    const kinds = plan.map((c) => c.t);
    expect(kinds.indexOf("text")).toBeLessThan(kinds.indexOf("lines"));
    expect(kinds.indexOf("lines")).toBeLessThan(kinds.lastIndexOf("stroke"));
  });
});

describe("planGlyphs", () => {
  it("batches a same-style run into one command", () => {
    const doc = drawText(
      createDocument(10, 1, { idGen: sequentialIdGen() }),
      "l1",
      0,
      2,
      "hello",
      STYLE,
    );
    const runs = planGlyphs(inputFor(doc)).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      t: "text",
      x: 16,
      y: 12,
      text: "hello",
      fill: THEME.defaultFg,
      bold: false,
      italic: false,
      advance: 8,
    });
  });

  it("carries the cell advance, not the font's own", () => {
    // The executor positions each glyph at x + i*advance, so column position is
    // independent of the font's metrics.
    const doc = drawText(
      createDocument(6, 1, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "abc",
      STYLE,
    );
    const runs = planGlyphs(inputFor(doc)).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs[0]?.advance).toBe(M.cellW);
  });

  it("breaks a run on a style change", () => {
    let doc = createDocument(6, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, "l1", 0, 0, { char: "a", ...STYLE });
    doc = setCell(doc, "l1", 0, 1, { char: "b", ...STYLE, bold: true });
    doc = setCell(doc, "l1", 0, 2, { char: "c", ...STYLE });
    const runs = planGlyphs(inputFor(doc)).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs.map((r) => [r.text, r.bold])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
  });

  it("breaks a run on a colour change", () => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, "l1", 0, 0, { char: "a", fg: { kind: "ansi16", index: 1 }, bg: STYLE.bg });
    doc = setCell(doc, "l1", 0, 1, { char: "b", fg: { kind: "ansi16", index: 2 }, bg: STYLE.bg });
    const runs = planGlyphs(inputFor(doc)).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.fill).toBe(THEME.ansi16[1]);
    expect(runs[1]?.fill).toBe(THEME.ansi16[2]);
  });

  it("breaks a run on a space and emits nothing for blank rows", () => {
    const doc = drawText(
      createDocument(10, 2, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "ab cd",
      STYLE,
    );
    const runs = planGlyphs(inputFor(doc)).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs.map((r) => r.text)).toEqual(["ab", "cd"]);
    expect(runs[1]?.x).toBe(24); // column 3
  });

  it("emits no glyph commands for an empty document", () => {
    const doc = createDocument(8, 3, { idGen: sequentialIdGen() });
    expect(planGlyphs(inputFor(doc))).toEqual([]);
  });

  it("swaps fg and bg for an inverse cell", () => {
    let doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, "l1", 0, 0, {
      char: "x",
      fg: { kind: "ansi16", index: 1 },
      bg: { kind: "ansi16", index: 2 },
      inverse: true,
    });
    const runs = planGlyphs(inputFor(doc)).filter((c) => c.t === "text") as TextRunCmd[];
    expect(runs[0]?.fill).toBe(THEME.ansi16[2]);
  });

  it("skips cells scrolled out of view", () => {
    const doc = drawText(
      createDocument(40, 1, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "x".repeat(40),
      STYLE,
    );
    const runs = planGlyphs(inputFor(doc, {}, { scrollX: 80, widthPx: 40 })).filter(
      (c) => c.t === "text",
    ) as TextRunCmd[];
    // Columns 10..14 only.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.text).toHaveLength(5);
  });
});

describe("planCellBackgrounds", () => {
  it("merges a horizontal run of one colour into a single rect", () => {
    const doc = drawText(createDocument(8, 1, { idGen: sequentialIdGen() }), "l1", 0, 1, "abc", {
      fg: STYLE.fg,
      bg: { kind: "ansi16", index: 4 },
    });
    const rects = planCellBackgrounds(inputFor(doc));
    expect(rects).toEqual([{ t: "rect", x: 8, y: 0, w: 24, h: 16, fill: THEME.ansi16[4] }]);
  });

  it("emits nothing for default backgrounds", () => {
    const doc = drawText(
      createDocument(8, 1, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "abc",
      STYLE,
    );
    expect(planCellBackgrounds(inputFor(doc))).toEqual([]);
  });

  it("splits runs when the colour changes", () => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, "l1", 0, 0, { char: "a", fg: STYLE.fg, bg: { kind: "ansi16", index: 1 } });
    doc = setCell(doc, "l1", 0, 1, { char: "b", fg: STYLE.fg, bg: { kind: "ansi16", index: 2 } });
    const rects = planCellBackgrounds(inputFor(doc));
    expect(rects).toHaveLength(2);
  });

  it("draws a background for an inverse cell whose bg is default", () => {
    let doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, "l1", 0, 0, { char: "x", ...STYLE, inverse: true });
    const rects = planCellBackgrounds(inputFor(doc));
    expect(rects).toHaveLength(1);
    expect((rects[0] as { fill: string }).fill).toBe(THEME.defaultFg);
  });
});

describe("planUnderlines", () => {
  it("emits one underline per underlined cell", () => {
    const doc = drawText(createDocument(6, 1, { idGen: sequentialIdGen() }), "l1", 0, 1, "ab", {
      ...STYLE,
      underline: true,
    });
    expect(planUnderlines(inputFor(doc))).toEqual([
      { t: "underline", x: 8, y: 15, w: 8, stroke: THEME.defaultFg },
      { t: "underline", x: 16, y: 15, w: 8, stroke: THEME.defaultFg },
    ]);
  });

  it("emits nothing without underlines", () => {
    const doc = drawText(
      createDocument(6, 1, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "ab",
      STYLE,
    );
    expect(planUnderlines(inputFor(doc))).toEqual([]);
  });
});

describe("planGrid", () => {
  it("is omitted when disabled", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    expect(planGrid(inputFor(doc, { showGrid: false }))).toEqual([]);
  });

  it("is omitted below 100% zoom, per the spec", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    expect(planGrid(inputFor(doc, { showGrid: true }, { zoom: 0.75 }))).toEqual([]);
    expect(planGrid(inputFor(doc, { showGrid: true }, { zoom: 1 }))).toHaveLength(1);
  });

  it("batches all lines into one command with hairline width", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    const [cmd] = planGrid(inputFor(doc, { showGrid: true }));
    expect(cmd?.t).toBe("lines");
    if (cmd?.t !== "lines") throw new Error("expected lines");
    // 5 verticals (cols 0..4) + 3 horizontals (rows 0..2).
    expect(cmd.segments).toHaveLength(8);
    expect(cmd.lineWidth).toBe(1);
  });

  it("uses a true hairline at high dpr", () => {
    const doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    const input = { ...inputFor(doc, { showGrid: true }), metrics: { ...M, dpr: 2 } };
    const [cmd] = planGrid(input);
    if (cmd?.t !== "lines") throw new Error("expected lines");
    expect(cmd.lineWidth).toBe(0.5);
  });
});

describe("planCaret", () => {
  it("draws an inverse-video block over the caret cell", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    const cmds = planCaret(inputFor(doc, { caret: { row: 1, col: 2 } }));
    expect(cmds).toEqual([{ t: "rect", x: 16, y: 16, w: 8, h: 16, fill: THEME.caretFill }]);
  });

  it("redraws the glyph under the caret so the character stays readable", () => {
    // A solid block alone would hide whatever the caret sits on.
    const doc = drawText(
      createDocument(6, 2, { idGen: sequentialIdGen() }),
      "l1",
      0,
      1,
      "Q",
      STYLE,
    );
    const cmds = planCaret(inputFor(doc, { caret: { row: 0, col: 1 } }));
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).toEqual({
      t: "text",
      x: 8,
      y: 12,
      text: "Q",
      fill: THEME.caretText,
      bold: false,
      italic: false,
      advance: 8,
    });
  });

  it("preserves bold and italic when redrawing the glyph", () => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, "l1", 0, 0, { char: "B", ...STYLE, bold: true, italic: true });
    const cmds = planCaret(inputFor(doc, { caret: { row: 0, col: 0 } }));
    expect(cmds[1]).toMatchObject({ bold: true, italic: true });
  });

  it("emits only the block over an empty cell", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    expect(planCaret(inputFor(doc, { caret: { row: 1, col: 1 } }))).toHaveLength(1);
  });

  it("emits nothing without a caret", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    expect(planCaret(inputFor(doc))).toEqual([]);
  });

  it("survives a caret outside the supplied grid", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    const stale = { ...inputFor(doc, { caret: { row: 9, col: 9 } }), grid: composite(doc) };
    expect(() => planCaret(stale)).not.toThrow();
    expect(planCaret(stale)).toHaveLength(1);
  });

  it("is painted last, over every other layer", () => {
    const doc = drawText(
      createDocument(6, 2, { idGen: sequentialIdGen() }),
      "l1",
      0,
      0,
      "hi",
      STYLE,
    );
    const plan = buildPaintPlan(
      inputFor(doc, { caret: { row: 0, col: 0 }, showGrid: true, cursor: { row: 1, col: 1 } }),
    );
    const lastRect = plan.map((c) => c.t).lastIndexOf("rect");
    expect(plan.map((c) => c.t).indexOf("lines")).toBeLessThan(lastRect);
  });
});

describe("planSelection and planCursor", () => {
  it("draws the selection as an animated dashed rect", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    const [cmd] = planSelection(
      inputFor(doc, { selection: { top: 1, left: 2, rows: 2, cols: 3 }, marqueePhase: 7 }),
    );
    expect(cmd).toEqual({
      t: "stroke",
      x: 16,
      y: 16,
      w: 24,
      h: 32,
      stroke: THEME.selectionStroke,
      lineWidth: 1,
      dash: [4, 3],
      dashOffset: -7,
    });
  });

  it("advances the marquee with the phase", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    const at = (phase: number) =>
      planSelection(
        inputFor(doc, { selection: { top: 0, left: 0, rows: 1, cols: 1 }, marqueePhase: phase }),
      );
    expect((at(0)[0] as { dashOffset: number }).dashOffset).toBe(0);
    expect((at(3)[0] as { dashOffset: number }).dashOffset).toBe(-3);
  });

  it("draws an undashed rect for a drag in progress", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    const [cmd] = planSelection(inputFor(doc, { dragRect: { top: 0, left: 0, rows: 2, cols: 2 } }));
    expect(cmd?.t).toBe("stroke");
    // Absent rather than set-to-undefined, so the command serialises cleanly.
    expect(cmd).not.toHaveProperty("dash");
  });

  it("draws both a drag rect and a selection when both are present", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    expect(
      planSelection(
        inputFor(doc, {
          dragRect: { top: 0, left: 0, rows: 1, cols: 1 },
          selection: { top: 1, left: 1, rows: 1, cols: 1 },
        }),
      ),
    ).toHaveLength(2);
  });

  it("outlines the cursor cell", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    expect(planCursor(inputFor(doc, { cursor: { row: 2, col: 1 } }))).toEqual([
      { t: "stroke", x: 8, y: 32, w: 8, h: 16, stroke: THEME.cursorStroke, lineWidth: 1 },
    ]);
  });

  it("emits nothing without a cursor or selection", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    expect(planCursor(inputFor(doc))).toEqual([]);
    expect(planSelection(inputFor(doc))).toEqual([]);
  });
});

describe("cssColor", () => {
  it("maps default to the theme's fg or bg by role", () => {
    expect(cssColor({ kind: "default" }, "fg", THEME)).toBe(THEME.defaultFg);
    expect(cssColor({ kind: "default" }, "bg", THEME)).toBe(THEME.defaultBg);
  });

  it("maps ansi16 through the theme palette", () => {
    expect(cssColor({ kind: "ansi16", index: 3 }, "fg", THEME)).toBe(THEME.ansi16[3]);
  });

  it("falls back when an ansi16 index is somehow out of range", () => {
    expect(cssColor({ kind: "ansi16", index: 99 }, "fg", THEME)).toBe(THEME.defaultFg);
    expect(cssColor({ kind: "ansi16", index: 99 }, "bg", THEME)).toBe(THEME.defaultBg);
  });

  it("maps rgb to hex", () => {
    expect(cssColor({ kind: "rgb", r: 255, g: 128, b: 0 }, "fg", THEME)).toBe("#ff8000");
    expect(cssColor({ kind: "rgb", r: 0, g: 0, b: 0 }, "fg", THEME)).toBe("#000000");
  });

  it("clamps out-of-range rgb rather than emitting invalid css", () => {
    expect(cssColor({ kind: "rgb", r: 300, g: -5, b: 128 }, "fg", THEME)).toBe("#ff0080");
  });

  it("maps the low 16 ansi256 indices onto the theme palette", () => {
    expect(cssColor({ kind: "ansi256", index: 5 }, "fg", THEME)).toBe(THEME.ansi16[5]);
  });

  it("maps the ansi256 colour cube", () => {
    // 16 is the cube origin (black); 231 is its opposite corner (white).
    expect(cssColor({ kind: "ansi256", index: 16 }, "fg", THEME)).toBe("#000000");
    expect(cssColor({ kind: "ansi256", index: 231 }, "fg", THEME)).toBe("#ffffff");
    // 21 = pure blue at the top cube level.
    expect(cssColor({ kind: "ansi256", index: 21 }, "fg", THEME)).toBe("#0000ff");
  });

  it("maps every one of the 216 cube indices to a valid, distinct colour", () => {
    // Sweeping the whole cube exercises all six level arms on all three axes.
    const seen = new Set<string>();
    for (let index = 16; index < 232; index++) {
      const css = cssColor({ kind: "ansi256", index }, "fg", THEME);
      expect(css, `index ${index}`).toMatch(/^#[0-9a-f]{6}$/u);
      seen.add(css);
    }
    // The cube has no duplicate entries.
    expect(seen.size).toBe(216);
  });

  it("maps the ansi256 greyscale ramp", () => {
    expect(cssColor({ kind: "ansi256", index: 232 }, "fg", THEME)).toBe("#080808");
    expect(cssColor({ kind: "ansi256", index: 255 }, "fg", THEME)).toBe("#eeeeee");
  });

  it("falls back for an ansi256 index below the palette", () => {
    const bare: Theme = { ...THEME, ansi16: [] };
    expect(cssColor({ kind: "ansi256", index: 3 }, "fg", bare)).toBe(bare.defaultFg);
  });
});
