import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR } from "../src/model/color.js";
import {
  cellAt,
  createDocument,
  sequentialIdGen,
  type TuiDocument,
} from "../src/model/document.js";
import { drawText, setCell } from "../src/ops/draw.js";
import { composite } from "../src/render/composite.js";
import { gridToText, toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

/** Two stacked layers over a 6x3 grid. */
function twoLayerDoc(): { doc: TuiDocument; bottom: string; top: string } {
  const base = createDocument(6, 3, { idGen: sequentialIdGen() });
  const doc: TuiDocument = {
    ...base,
    layers: [...base.layers, { id: "top", name: "top", visible: true, locked: false, cells: {} }],
  };
  return { doc, bottom: base.activeLayerId, top: "top" };
}

describe("composite", () => {
  it("fills uncovered cells with a default space carrying no style flags", () => {
    const doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    expect(composite(doc)[0]?.[0]).toEqual({
      char: " ",
      fg: DEFAULT_COLOR,
      bg: DEFAULT_COLOR,
    });
  });

  it("lets the top layer win where it is opaque", () => {
    const { doc, bottom, top } = twoLayerDoc();
    let next = drawText(doc, bottom, 0, 0, "bottom", STYLE);
    next = drawText(next, top, 0, 0, "TOP", STYLE);
    expect(toText(next)).toBe("TOPtom\n\n");
  });

  it("reveals the layer below through transparent cells", () => {
    const { doc, bottom, top } = twoLayerDoc();
    let next = drawText(doc, bottom, 1, 0, "abcdef", STYLE);
    // Write only at columns 1 and 4; everything else on `top` stays transparent.
    next = setCell(next, top, 1, 1, { char: "X", ...STYLE });
    next = setCell(next, top, 1, 4, { char: "Y", ...STYLE });
    expect(toText(next)).toBe("\naXcdYf\n");
  });

  it("skips invisible layers entirely", () => {
    const { doc, bottom, top } = twoLayerDoc();
    let next = drawText(doc, bottom, 0, 0, "below", STYLE);
    next = drawText(next, top, 0, 0, "ABOVE", STYLE);
    const hidden: TuiDocument = {
      ...next,
      layers: next.layers.map((l) => (l.id === top ? { ...l, visible: false } : l)),
    };
    expect(toText(hidden)).toBe("below\n\n");
  });

  it("resolves palette references to raw colors", () => {
    const base = createDocument(1, 1, { idGen: sequentialIdGen() });
    const doc: TuiDocument = {
      ...base,
      palette: [{ id: "p1", name: "accent", color: { kind: "ansi256", index: 42 } }],
    };
    const next = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "p1" },
      bg: DEFAULT_COLOR,
    });
    expect(composite(next)[0]?.[0]?.fg).toEqual({ kind: "ansi256", index: 42 });
  });

  it("resolves a dangling reference to the terminal default rather than throwing", () => {
    const doc = createDocument(1, 1, { idGen: sequentialIdGen() });
    const next = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "missing" },
      bg: DEFAULT_COLOR,
    });
    expect(() => composite(next)).not.toThrow();
    expect(composite(next)[0]?.[0]?.fg).toEqual(DEFAULT_COLOR);
  });

  it("honours excludeHandoff only when asked", () => {
    const { doc, bottom, top } = twoLayerDoc();
    let next = drawText(doc, bottom, 0, 0, "base", STYLE);
    next = drawText(next, top, 0, 0, "DECO", STYLE);
    next = {
      ...next,
      layers: next.layers.map((l) => (l.id === top ? { ...l, excludeFromHandoff: true } : l)),
    };
    expect(gridToText(composite(next))).toBe("DECO\n\n");
    expect(gridToText(composite(next, { excludeHandoff: true }))).toBe("base\n\n");
  });

  it("ignores out-of-bounds keys from a hand-edited file", () => {
    const base = createDocument(2, 1, { idGen: sequentialIdGen() });
    const doc: TuiDocument = {
      ...base,
      layers: [
        {
          ...base.layers[0]!,
          cells: {
            "0,0": { char: "a", ...STYLE },
            "9,9": { char: "b", ...STYLE },
            "0,-1": { char: "c", ...STYLE },
            garbage: { char: "d", ...STYLE },
          },
        },
      ],
    };
    expect(() => composite(doc)).not.toThrow();
    expect(toText(doc)).toBe("a");
  });

  it("preserves each style flag only when present", () => {
    const flags = ["bold", "italic", "underline", "inverse"] as const;
    const doc = createDocument(flags.length + 1, 1, { idGen: sequentialIdGen() });
    let next = doc;
    // One cell per flag, each carrying exactly that flag, plus one bare cell.
    for (const [i, flag] of flags.entries()) {
      next = setCell(next, doc.activeLayerId, 0, i, { char: "x", ...STYLE, [flag]: true });
    }
    next = setCell(next, doc.activeLayerId, 0, flags.length, { char: "-", ...STYLE });

    const grid = composite(next);
    for (const [i, flag] of flags.entries()) {
      const cell = grid[0]?.[i];
      expect(cell, flag).toHaveProperty(flag, true);
      // Only the one flag is set; the others stay absent rather than becoming false.
      for (const other of flags.filter((f) => f !== flag)) {
        expect(cell, `${flag} cell should not carry ${other}`).not.toHaveProperty(other);
      }
    }
    const bare = grid[0]?.[flags.length];
    for (const flag of flags) expect(bare).not.toHaveProperty(flag);
  });

  it("carries an explicitly-false flag through rather than dropping it", () => {
    const doc = createDocument(1, 1, { idGen: sequentialIdGen() });
    const next = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", ...STYLE, bold: false });
    expect(composite(next)[0]?.[0]).toHaveProperty("bold", false);
  });
});

describe("public render-grid resource boundary", () => {
  it("rejects unsafe cells and ragged grids", () => {
    const safe = { char: "x", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
    expect(() => gridToText([[{ ...safe, char: "\x1b" }]])).toThrow(/control/u);
    expect(() => gridToText([[safe], [safe, safe]])).toThrow(/not 1 cells wide/u);
  });
});

describe("toText", () => {
  it("emits one line per row, trimming trailing whitespace by default", () => {
    const doc = createDocument(8, 3, { idGen: sequentialIdGen() });
    const next = drawText(doc, doc.activeLayerId, 1, 2, "hi", STYLE);
    // Row 0 and row 2 are empty; row 1 has no trailing padding.
    expect(toText(next)).toBe("\n  hi\n");
  });

  it("pads to the full grid width when trimming is disabled", () => {
    const doc = createDocument(5, 2, { idGen: sequentialIdGen() });
    const next = drawText(doc, doc.activeLayerId, 0, 0, "ab", STYLE);
    expect(toText(next, { trimTrailingWhitespace: false })).toBe("ab   \n     ");
  });

  it("supports CRLF and a trailing newline", () => {
    const doc = createDocument(2, 2, { idGen: sequentialIdGen() });
    const next = drawText(doc, doc.activeLayerId, 0, 0, "ab", STYLE);
    expect(toText(next, { lineEnding: "\r\n", trailingNewline: true })).toBe("ab\r\n\r\n");
  });

  it("always emits exactly `rows` lines", () => {
    const doc = createDocument(3, 4, { idGen: sequentialIdGen() });
    expect(toText(doc).split("\n")).toHaveLength(4);
  });
});

describe("cellAt", () => {
  const paletteDoc = (): TuiDocument => {
    const { doc, bottom, top } = twoLayerDoc();
    return {
      ...doc,
      palette: [{ id: "p1", name: "brand", color: { kind: "ansi16", index: 5 } }],
      layers: doc.layers.map((l) =>
        l.id === bottom
          ? { ...l, cells: { "0,0": { char: "b", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } } }
          : l.id === top
            ? {
                ...l,
                cells: {
                  "0,1": { char: "t", fg: { kind: "palette", id: "p1" }, bg: DEFAULT_COLOR },
                },
              }
            : l,
      ),
    };
  };

  it("returns the topmost visible layer's cell", () => {
    const { doc, bottom, top } = twoLayerDoc();
    let d = setCell(doc, bottom, 0, 0, { char: "b", ...STYLE });
    d = setCell(d, top, 0, 0, { char: "t", ...STYLE });
    expect(cellAt(d, 0, 0)?.char).toBe("t");
  });

  it("falls through a hidden layer to the one beneath", () => {
    // The eyedropper must sample what is *seen*, not what is topmost in the stack.
    const { doc, bottom, top } = twoLayerDoc();
    let d = setCell(doc, bottom, 0, 0, { char: "b", ...STYLE });
    d = setCell(d, top, 0, 0, { char: "t", ...STYLE });
    d = { ...d, layers: d.layers.map((l) => (l.id === top ? { ...l, visible: false } : l)) };
    expect(cellAt(d, 0, 0)?.char).toBe("b");
  });

  it("falls through a transparent cell on the top layer", () => {
    const { doc, bottom, top } = twoLayerDoc();
    let d = setCell(doc, bottom, 0, 0, { char: "b", ...STYLE });
    // The top layer is present and visible but has painted elsewhere.
    d = setCell(d, top, 0, 5, { char: "t", ...STYLE });
    expect(cellAt(d, 0, 0)?.char).toBe("b");
  });

  it("returns undefined where no visible layer has painted", () => {
    const { doc } = twoLayerDoc();
    expect(cellAt(doc, 1, 1)).toBeUndefined();
  });

  it("returns undefined out of bounds rather than throwing", () => {
    const { doc } = twoLayerDoc();
    for (const [row, col] of [
      [-1, 0],
      [0, -1],
      [3, 0],
      [0, 6],
    ]) {
      expect(cellAt(doc, row as number, col as number)).toBeUndefined();
    }
  });

  it("preserves a palette reference rather than baking the colour", () => {
    // The reason this returns Cell and not ResolvedCell: an eyedropper that broke
    // the palette link would make later palette edits skip the sampled cell.
    const cell = cellAt(paletteDoc(), 0, 1);
    expect(cell?.fg).toEqual({ kind: "palette", id: "p1" });
    // composite, by contrast, resolves it — which is correct for renderers.
    expect(composite(paletteDoc())[0]?.[1]?.fg).toEqual({ kind: "ansi16", index: 5 });
  });

  it("agrees with composite on every cell of a multi-layer document", () => {
    // The two must not drift: cellAt is a reverse scan, composite a bottom-up
    // overwrite, and only one of them is exercised by the renderer.
    const { doc, bottom, top } = twoLayerDoc();
    let d = drawText(doc, bottom, 0, 0, "bottom", STYLE);
    d = drawText(d, top, 0, 2, "TOP", STYLE);
    d = drawText(d, top, 2, 0, "x", STYLE);
    const grid = composite(d);
    for (let row = 0; row < d.rows; row++) {
      for (let col = 0; col < d.cols; col++) {
        const seen = cellAt(d, row, col);
        // Uncovered cells composite to a space; cellAt reports undefined.
        expect(grid[row]?.[col]?.char).toBe(seen?.char ?? " ");
      }
    }
  });
});
