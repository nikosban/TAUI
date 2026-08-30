import { beforeEach, describe, expect, it } from "vitest";
import { deserialize, serialize } from "../src/io/file.js";
import { parseText } from "../src/io/text-import.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import {
  createDocument,
  findLayer,
  sequentialIdGen,
  type TuiDocument,
} from "../src/model/document.js";
import { RESOURCE_LIMITS } from "../src/model/resource-policy.js";
import {
  cellsLostOnCrop,
  cellsLostOnResize,
  cropToRect,
  resizeDocument,
  resizeOffset,
  shiftAll,
} from "../src/ops/canvas.js";
import { addLayer } from "../src/ops/layers.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const ids = () => sequentialIdGen();

/** 6x4 with a distinct character per row, so movement is unambiguous. */
function grid(): TuiDocument {
  return parseText(["aaaaaa", "bbbbbb", "cccccc", "dddddd"].join("\n"), { idGen: ids() }).doc;
}

let doc: TuiDocument;

beforeEach(() => {
  doc = grid();
});

const painted = (d: TuiDocument): number =>
  d.layers.reduce((n, l) => n + Object.keys(l.cells).length, 0);

describe("resizeDocument — growing", () => {
  it("loses nothing", () => {
    const grown = resizeDocument(doc, 10, 8);
    expect(grown.cols).toBe(10);
    expect(grown.rows).toBe(8);
    expect(painted(grown)).toBe(painted(doc));
    expect(toText(grown)).toBe(`${toText(doc)}\n\n\n\n`);
  });

  it("anchors top-left by default", () => {
    expect(toText(resizeDocument(doc, 10, 8)).split("\n")[0]).toBe("aaaaaa");
  });

  it("centres content when asked, flooring the offset", () => {
    // 6 -> 10 cols is +4, so +2; 4 -> 8 rows is +4, so +2.
    const grown = resizeDocument(doc, 10, 8, "center");
    const lines = toText(grown, { trimTrailingWhitespace: false }).split("\n");
    expect(lines[0]).toBe("          ");
    expect(lines[2]).toBe("  aaaaaa  ");
    expect(lines[5]).toBe("  dddddd  ");
  });

  it("floors an odd centre offset rather than rounding up", () => {
    // The pinned rule: 6 -> 7 shifts by floor(1/2) = 0, not 1.
    expect(resizeOffset({ cols: 6, rows: 4 }, { cols: 7, rows: 5 }, "center")).toEqual({
      dRow: 0,
      dCol: 0,
    });
    expect(toText(resizeDocument(doc, 7, 5, "center")).split("\n")[0]).toBe("aaaaaa");
  });
});

describe("resizeDocument — shrinking", () => {
  it("drops cells outside the new bounds, destructively", () => {
    const shrunk = resizeDocument(doc, 3, 2);
    expect(toText(shrunk)).toBe("aaa\nbbb");
    expect(painted(shrunk)).toBe(6);
    // Growing back does not restore them.
    expect(toText(resizeDocument(shrunk, 6, 4))).toBe("aaa\nbbb\n\n");
  });

  it("shrinks from both sides when centred", () => {
    // 6 -> 4 cols is -2, so -1; 4 -> 2 rows is -2, so -1.
    const shrunk = resizeDocument(doc, 4, 2, "center");
    expect(toText(shrunk)).toBe("bbbb\ncccc");
  });

  it("reports how many cells a resize would discard, before doing it", () => {
    expect(cellsLostOnResize(doc, 6, 4)).toBe(0);
    expect(cellsLostOnResize(doc, 10, 8)).toBe(0);
    expect(cellsLostOnResize(doc, 3, 2)).toBe(24 - 6);
    expect(cellsLostOnResize(doc, 4, 2, "center")).toBe(24 - 8);
  });

  it("counts loss per layer, since that is what the user loses", () => {
    // A cell covered on two layers is two cells the user loses, not one.
    const withSecond = addLayer(doc, { idGen: sequentialIdGen("t"), activate: false });
    const two: TuiDocument = {
      ...withSecond,
      layers: withSecond.layers.map((l) =>
        l.id === "t1" ? { ...l, cells: doc.layers[0]?.cells ?? {} } : l,
      ),
    };
    expect(painted(two)).toBe(48);
    expect(cellsLostOnResize(two, 3, 4)).toBe(2 * cellsLostOnResize(doc, 3, 4));
  });
});

describe("resizeDocument — validation and identity", () => {
  it("rejects a non-positive or fractional size", () => {
    expect(() => resizeDocument(doc, 0, 4)).toThrow(/cols must be a positive integer/u);
    expect(() => resizeDocument(doc, 6, -1)).toThrow(/rows must be a positive integer/u);
    expect(() => resizeDocument(doc, 6.5, 4)).toThrow(/cols must be a positive integer/u);
  });

  it("rejects dimensions and areas beyond the central resource policy", () => {
    expect(() => resizeDocument(doc, RESOURCE_LIMITS.documentCols + 1, 1)).toThrow(/limit/u);
    expect(() => resizeDocument(doc, 501, 500)).toThrow(/document area/u);
    expect(() => resizeDocument(doc, Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(/positive integer/u);
  });

  it("returns the same document when the size is unchanged", () => {
    expect(resizeDocument(doc, 6, 4)).toBe(doc);
    expect(resizeDocument(doc, 6, 4, "center")).toBe(doc);
  });

  it("preserves the palette, colour mode, and active layer", () => {
    const rich: TuiDocument = {
      ...doc,
      colorMode: "rgb",
      palette: [{ id: "p1", name: "accent", color: { kind: "rgb", r: 1, g: 2, b: 3 } }],
    };
    const resized = resizeDocument(rich, 12, 9, "center");
    expect(resized.palette).toEqual(rich.palette);
    expect(resized.colorMode).toBe("rgb");
    expect(resized.activeLayerId).toBe(rich.activeLayerId);
    expect(resized.layers).toHaveLength(rich.layers.length);
  });

  it("remaps every layer, including locked ones", () => {
    // A lock protects against *edits*; the document changing shape underneath is
    // surgery, and leaving a locked layer behind would strand its cells.
    let two = addLayer(doc, { idGen: sequentialIdGen("t"), activate: false });
    two = {
      ...two,
      layers: two.layers.map((l) =>
        l.id === "t1" ? { ...l, locked: true, cells: doc.layers[0]!.cells } : l,
      ),
    };
    const shifted = resizeDocument(two, 6, 4, "center"); // no-op size
    expect(shifted).toBe(two);

    const grown = resizeDocument(two, 10, 8, "center");
    const lockedLayer = findLayer(grown, "t1");
    // Its cells moved with everything else.
    expect(lockedLayer?.cells["2,2"]).toBeDefined();
    expect(lockedLayer?.cells["0,0"]).toBeUndefined();
  });

  it("survives a file round-trip", () => {
    const resized = resizeDocument(doc, 9, 7, "center");
    expect(deserialize(serialize(resized)).doc).toEqual(resized);
  });
});

describe("shiftAll", () => {
  it("moves every layer's contents", () => {
    // Shifting right by 2 in a 6-wide grid pushes the last two columns off, so
    // each row keeps four characters.
    expect(toText(shiftAll(doc, 1, 2))).toBe("\n  aaaa\n  bbbb\n  cccc");
  });

  it("keeps the grid size", () => {
    const shifted = shiftAll(doc, 1, 1);
    expect(shifted.cols).toBe(6);
    expect(shifted.rows).toBe(4);
  });

  it("drops cells pushed off the grid, so shifting back does not restore them", () => {
    const right = shiftAll(doc, 0, 4);
    expect(toText(right)).toBe("    aa\n    bb\n    cc\n    dd");
    expect(toText(shiftAll(right, 0, -4))).toBe("aa\nbb\ncc\ndd");
  });

  it("handles negative deltas", () => {
    // Row 0 and columns 0–1 fall off; the grid is still 4 rows, so the last is
    // empty.
    expect(toText(shiftAll(doc, -1, -2))).toBe("bbbb\ncccc\ndddd\n");
  });

  it("returns the same document for a zero delta", () => {
    expect(shiftAll(doc, 0, 0)).toBe(doc);
  });

  it("moves locked layers too", () => {
    const locked: TuiDocument = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    expect(toText(shiftAll(locked, 1, 0))).toBe("\naaaaaa\nbbbbbb\ncccccc");
  });
});

describe("cropToRect", () => {
  it("crops to the rect and moves contents to the origin", () => {
    const cropped = cropToRect(doc, { top: 1, left: 2, rows: 2, cols: 3 });
    expect(cropped.cols).toBe(3);
    expect(cropped.rows).toBe(2);
    expect(toText(cropped)).toBe("bbb\nccc");
  });

  it("is exactly shiftAll followed by resizeDocument", () => {
    // The equivalence the centre-offset rounding is pinned for.
    for (const rect of [
      { top: 0, left: 0, rows: 2, cols: 3 },
      { top: 1, left: 2, rows: 2, cols: 3 },
      { top: 2, left: 1, rows: 2, cols: 4 },
      { top: 3, left: 5, rows: 1, cols: 1 },
      { top: 0, left: 0, rows: 4, cols: 6 },
    ]) {
      const viaCrop = cropToRect(doc, rect);
      const viaSteps = resizeDocument(
        shiftAll(doc, -rect.top, -rect.left),
        rect.cols,
        rect.rows,
        "top-left",
      );
      expect(viaCrop, JSON.stringify(rect)).toEqual(viaSteps);
    }
  });

  it("holds the equivalence for a multi-layer document", () => {
    let two = addLayer(doc, { idGen: sequentialIdGen("t") });
    two = {
      ...two,
      layers: two.layers.map((l) =>
        l.id === "t1" ? { ...l, cells: { "3,5": { char: "Z", ...STYLE } } } : l,
      ),
    };
    const rect = { top: 1, left: 1, rows: 3, cols: 4 };
    expect(cropToRect(two, rect)).toEqual(
      resizeDocument(shiftAll(two, -rect.top, -rect.left), rect.cols, rect.rows, "top-left"),
    );
  });

  it("accepts a rect extending past the document, padding with emptiness", () => {
    const cropped = cropToRect(doc, { top: 2, left: 4, rows: 4, cols: 4 });
    expect(cropped.cols).toBe(4);
    expect(cropped.rows).toBe(4);
    expect(toText(cropped)).toBe("cc\ndd\n\n");
  });

  it("yields an empty document for a rect entirely outside", () => {
    // Cropping to nothing is legitimate, if unhelpful — better than throwing.
    const cropped = cropToRect(doc, { top: 50, left: 50, rows: 2, cols: 2 });
    expect(painted(cropped)).toBe(0);
    expect(cropped.cols).toBe(2);
  });

  it("rejects a non-positive size", () => {
    expect(() => cropToRect(doc, { top: 0, left: 0, rows: 0, cols: 2 })).toThrow(
      /rect.rows must be a positive integer/u,
    );
    expect(() => cropToRect(doc, { top: 0, left: 0, rows: 2, cols: -1 })).toThrow(
      /rect.cols must be a positive integer/u,
    );
    expect(() =>
      cropToRect(doc, {
        top: 0,
        left: 0,
        rows: 1,
        cols: RESOURCE_LIMITS.documentCols + 1,
      }),
    ).toThrow(/rect.cols exceeds/u);
  });

  it("reports how many cells a crop would discard", () => {
    expect(cellsLostOnCrop(doc, { top: 0, left: 0, rows: 4, cols: 6 })).toBe(0);
    expect(cellsLostOnCrop(doc, { top: 1, left: 2, rows: 2, cols: 3 })).toBe(24 - 6);
    expect(cellsLostOnCrop(doc, { top: 50, left: 50, rows: 2, cols: 2 })).toBe(24);
  });

  it("preserves the palette and active layer", () => {
    const rich: TuiDocument = {
      ...doc,
      palette: [{ id: "p1", name: "accent", color: { kind: "ansi16", index: 2 } }],
    };
    const cropped = cropToRect(rich, { top: 1, left: 1, rows: 2, cols: 2 });
    expect(cropped.palette).toEqual(rich.palette);
    expect(cropped.activeLayerId).toBe(rich.activeLayerId);
  });
});

describe("malformed input", () => {
  it("drops unparseable cell keys rather than crashing", () => {
    const dirty: TuiDocument = {
      ...doc,
      layers: doc.layers.map((l) => ({
        ...l,
        cells: { ...l.cells, garbage: { char: "!", ...STYLE } },
      })),
    };
    for (const op of [
      () => resizeDocument(dirty, 8, 6),
      () => shiftAll(dirty, 1, 1),
      () => cropToRect(dirty, { top: 0, left: 0, rows: 2, cols: 2 }),
    ]) {
      expect(op).not.toThrow();
      expect(toText(op())).not.toContain("!");
    }
  });
});

describe("scale", () => {
  it("resizes a fully painted large document promptly", () => {
    const big = createDocument(300, 100, { idGen: ids() });
    const filled = parseText(Array.from({ length: 100 }, () => "▒".repeat(300)).join("\n"), {
      idGen: ids(),
    }).doc;
    expect(painted(filled)).toBe(30_000);
    const start = performance.now();
    const resized = resizeDocument(filled, 320, 120, "center");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(painted(resized)).toBe(30_000);
    void big;
  });
});
