import { beforeEach, describe, expect, it } from "vitest";
import { parseText } from "../src/io/text-import.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import {
  createDocument,
  findLayer,
  sequentialIdGen,
  type TuiDocument,
} from "../src/model/document.js";
import { drawBox } from "../src/ops/box.js";
import { drawText, fillRect, setCell } from "../src/ops/draw.js";
import { floodFill } from "../src/ops/fill.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const RED = { kind: "ansi16", index: 1 } as const;
const BLUE = { kind: "ansi16", index: 4 } as const;

let doc: TuiDocument;
let id: string;

beforeEach(() => {
  doc = createDocument(10, 6, { idGen: sequentialIdGen() });
  id = doc.activeLayerId;
});

/** Positions whose background is `color`, for asserting fill extent. */
function bgCells(d: TuiDocument, layerId: string, index: number): string[] {
  const layer = findLayer(d, layerId);
  return Object.entries(layer?.cells ?? {})
    .filter(([, cell]) => cell.bg.kind === "ansi16" && cell.bg.index === index)
    .map(([key]) => key)
    .sort();
}

describe("region membership", () => {
  it("fills contiguous whitespace inside a box, stopping at the border", () => {
    // The common case, and the reason transparent reads as space+default: a fill
    // must cross cells that were never painted.
    const boxed = drawBox(doc, id, { top: 0, left: 0, rows: 4, cols: 6 }, "light", true, STYLE);
    const filled = floodFill(boxed, id, 1, 1, { bg: RED });

    // The 4x2 interior only.
    expect(bgCells(filled, id, 1)).toEqual([
      "1,1",
      "1,2",
      "1,3",
      "1,4",
      "2,1",
      "2,2",
      "2,3",
      "2,4",
    ]);
    // The border characters are untouched.
    expect(toText(filled).split("\n")[0]).toBe("┌────┐");
  });

  it("escapes through a gap in the border", () => {
    let boxed = drawBox(doc, id, { top: 0, left: 0, rows: 4, cols: 6 }, "light", true, STYLE);
    // Punch the *right* wall — the left wall sits on the document edge, so a hole
    // there has nowhere to leak to.
    boxed = setCell(boxed, id, 1, 5, { char: " ", ...STYLE });
    const filled = floodFill(boxed, id, 1, 1, { bg: RED });
    // 60 cells, less the 15 border characters still standing.
    expect(bgCells(filled, id, 1)).toHaveLength(45);
  });

  it("treats a transparent cell and a painted space as the same region", () => {
    // Without this equivalence a fill would stop dead at the boundary between
    // "never painted" and "painted with a space".
    const withSpace = setCell(doc, id, 0, 5, { char: " ", ...STYLE });
    const filled = floodFill(withSpace, id, 0, 0, { bg: RED });
    expect(bgCells(filled, id, 1)).toHaveLength(60);
  });

  it("is bounded by a differing character", () => {
    const d = parseText("###\n#.#\n###", { idGen: sequentialIdGen(), paintSpaces: true }).doc;
    const filled = floodFill(d, d.activeLayerId, 1, 1, { bg: RED });
    expect(bgCells(filled, d.activeLayerId, 1)).toEqual(["1,1"]);
  });

  it("is bounded by a differing background, even with the same character", () => {
    let d = fillRect(doc, id, { top: 0, left: 0, rows: 6, cols: 10 }, { char: " ", ...STYLE });
    d = fillRect(
      d,
      id,
      { top: 0, left: 5, rows: 6, cols: 5 },
      {
        char: " ",
        fg: DEFAULT_COLOR,
        bg: BLUE,
      },
    );
    const filled = floodFill(d, id, 0, 0, { bg: RED });
    // Only the default-background half.
    expect(bgCells(filled, id, 1)).toHaveLength(30);
  });

  it("is four-connected, not eight — diagonals do not leak", () => {
    // A diagonal wall must hold.
    const art = [
      "#.........",
      ".#........",
      "..#.......",
      "...#......",
      "....#.....",
      ".....#....",
    ];
    const d = parseText(art.join("\n"), { idGen: sequentialIdGen(), paintSpaces: true }).doc;
    const filled = floodFill(d, d.activeLayerId, 0, 1, { bg: RED });
    // Filling above the diagonal must not reach below it.
    const keys = bgCells(filled, d.activeLayerId, 1);
    expect(keys).toContain("0,1");
    expect(keys).not.toContain("5,0");
  });
});

describe("fill targets", () => {
  it("{ bg } recolours the background, keeping the character and foreground", () => {
    const d = drawText(doc, id, 0, 0, "abc", { fg: BLUE, bg: DEFAULT_COLOR });
    const filled = floodFill(d, id, 0, 0, { bg: RED });
    const cell = findLayer(filled, id)?.cells["0,0"];
    expect(cell).toEqual({ char: "a", fg: BLUE, bg: RED });
  });

  it("{ bg } turns transparent cells into explicit spaces", () => {
    const filled = floodFill(doc, id, 2, 2, { bg: RED });
    expect(findLayer(filled, id)?.cells["2,2"]).toEqual({
      char: " ",
      fg: DEFAULT_COLOR,
      bg: RED,
    });
  });

  it("{ fg } recolours glyphs but leaves transparent cells alone", () => {
    // Colouring the foreground of nothing would create an invisible cell.
    const d = drawText(doc, id, 0, 0, "ab", STYLE);
    const filled = floodFill(d, id, 0, 5, { fg: RED });
    expect(findLayer(filled, id)?.cells["0,5"]).toBeUndefined();

    // On a region that does have glyphs, it applies.
    const painted = fillRect(
      doc,
      id,
      { top: 0, left: 0, rows: 2, cols: 3 },
      {
        char: "x",
        ...STYLE,
      },
    );
    const recoloured = floodFill(painted, id, 0, 0, { fg: RED });
    expect(findLayer(recoloured, id)?.cells["0,0"]?.fg).toEqual(RED);
  });

  it("{ cell } replaces the cell wholesale", () => {
    const d = drawBox(doc, id, { top: 0, left: 0, rows: 4, cols: 6 }, "light", true, STYLE);
    const filled = floodFill(d, id, 1, 1, { cell: { char: "▒", fg: BLUE, bg: RED } });
    expect(toText(filled).split("\n")[1]).toBe("│▒▒▒▒│");
    expect(findLayer(filled, id)?.cells["1,1"]).toEqual({ char: "▒", fg: BLUE, bg: RED });
  });

  it("distinguishes every colour kind when deciding region membership", () => {
    // colorEquals covers default / ansi16 / ansi256 / rgb; a fill must not bleed
    // between two visually distinct backgrounds of different kinds.
    const kinds = [
      DEFAULT_COLOR,
      { kind: "ansi16", index: 1 },
      { kind: "ansi256", index: 200 },
      { kind: "rgb", r: 10, g: 20, b: 30 },
    ] as const;
    let d = createDocument(kinds.length, 1, { idGen: sequentialIdGen() });
    const layerId = d.activeLayerId;
    for (const [i, bg] of kinds.entries()) {
      d = setCell(d, layerId, 0, i, { char: " ", fg: DEFAULT_COLOR, bg });
    }
    // Seeded on the rgb cell, the fill must claim that cell alone.
    const filled = floodFill(d, layerId, 0, 3, { cell: { char: "#", ...STYLE } });
    expect(toText(filled)).toBe("   #");
  });

  it("does not bleed between two different rgb backgrounds", () => {
    let d = createDocument(3, 1, { idGen: sequentialIdGen() });
    const layerId = d.activeLayerId;
    d = setCell(d, layerId, 0, 0, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "rgb", r: 1, g: 2, b: 3 },
    });
    d = setCell(d, layerId, 0, 1, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "rgb", r: 1, g: 2, b: 3 },
    });
    d = setCell(d, layerId, 0, 2, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "rgb", r: 9, g: 2, b: 3 },
    });
    const filled = floodFill(d, layerId, 0, 0, { cell: { char: "#", ...STYLE } });
    expect(toText(filled)).toBe("##");
  });

  it("does not bleed between two different ansi256 backgrounds", () => {
    let d = createDocument(3, 1, { idGen: sequentialIdGen() });
    const layerId = d.activeLayerId;
    d = setCell(d, layerId, 0, 0, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi256", index: 24 },
    });
    d = setCell(d, layerId, 0, 1, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "ansi256", index: 25 },
    });
    const filled = floodFill(d, layerId, 0, 0, { cell: { char: "#", ...STYLE } });
    expect(toText(filled)).toBe("#");
  });

  it("resolves palette references when comparing backgrounds", () => {
    // A palette-referenced red and a literal red are the same region.
    const withPalette: TuiDocument = {
      ...doc,
      palette: [{ id: "p1", name: "accent", color: RED }],
    };
    let d = setCell(withPalette, id, 0, 0, { char: " ", fg: DEFAULT_COLOR, bg: RED });
    d = setCell(d, id, 0, 1, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "palette", id: "p1" },
    });
    const filled = floodFill(d, id, 0, 0, { bg: BLUE });
    expect(bgCells(filled, id, 4)).toEqual(["0,0", "0,1"]);
  });
});

describe("the immutability contract", () => {
  it("returns the same document for an out-of-bounds seed", () => {
    expect(floodFill(doc, id, -1, 0, { bg: RED })).toBe(doc);
    expect(floodFill(doc, id, 0, 99, { bg: RED })).toBe(doc);
  });

  it("returns the same document for an unknown layer", () => {
    expect(floodFill(doc, "nope", 0, 0, { bg: RED })).toBe(doc);
  });

  it("returns the same document when the layer is locked", () => {
    const locked: TuiDocument = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    expect(floodFill(locked, id, 0, 0, { bg: RED })).toBe(locked);
  });

  it("returns the same document when nothing would change", () => {
    // Filling a { fg } over an entirely transparent region writes nothing.
    expect(floodFill(doc, id, 0, 0, { fg: RED })).toBe(doc);
  });

  it("is a no-op when the fill colour already matches", () => {
    // The bug behind "I click Fill and nothing happens": recolouring
    // default-over-default used to dirty the draft and push an empty undo entry.
    const already = fillRect(
      doc,
      id,
      { top: 0, left: 0, rows: 6, cols: 10 },
      {
        char: " ",
        fg: DEFAULT_COLOR,
        bg: RED,
      },
    );
    expect(floodFill(already, id, 0, 0, { bg: RED })).toBe(already);
  });

  it("is a no-op when filling default background over transparent cells", () => {
    // Exactly what a click with the untouched default brush does.
    expect(floodFill(doc, id, 3, 3, { bg: DEFAULT_COLOR })).toBe(doc);
  });

  it("is a no-op when { cell } matches what is already there", () => {
    const cell = { char: "▒", fg: RED, bg: BLUE };
    const painted = fillRect(doc, id, { top: 0, left: 0, rows: 6, cols: 10 }, cell);
    expect(floodFill(painted, id, 0, 0, { cell })).toBe(painted);
  });

  it("still fills where at least one cell differs", () => {
    // A partially-filled region must complete, not be mistaken for a no-op.
    let d = fillRect(
      doc,
      id,
      { top: 0, left: 0, rows: 6, cols: 10 },
      {
        char: " ",
        fg: DEFAULT_COLOR,
        bg: DEFAULT_COLOR,
      },
    );
    d = setCell(d, id, 0, 0, { char: " ", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR });
    const filled = floodFill(d, id, 0, 0, { bg: RED });
    expect(bgCells(filled, id, 1)).toHaveLength(60);
  });

  it("never mutates the input", () => {
    const before = JSON.stringify(doc);
    floodFill(doc, id, 0, 0, { bg: RED });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("only touches the target layer", () => {
    const twoLayer: TuiDocument = {
      ...doc,
      layers: [...doc.layers, { id: "top", name: "top", visible: true, locked: false, cells: {} }],
    };
    const filled = floodFill(twoLayer, "top", 0, 0, { bg: RED });
    expect(filled.layers[0]).toBe(twoLayer.layers[0]);
  });
});

describe("scale", () => {
  it("fills a large grid iteratively, without blowing the stack", () => {
    // The whole reason for the explicit stack: a recursive flood over 30k cells
    // exceeds the call-stack depth.
    const big = createDocument(300, 100, { idGen: sequentialIdGen() });
    const start = performance.now();
    const filled = floodFill(big, big.activeLayerId, 50, 150, { bg: RED });
    const elapsed = performance.now() - start;

    expect(Object.keys(findLayer(filled, big.activeLayerId)?.cells ?? {})).toHaveLength(30_000);
    expect(elapsed).toBeLessThan(3000);
  });

  it("visits each cell once", () => {
    // A missing `seen` check would revisit cells exponentially.
    const big = createDocument(120, 60, { idGen: sequentialIdGen() });
    const start = performance.now();
    floodFill(big, big.activeLayerId, 0, 0, { bg: RED });
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
