import { beforeEach, describe, expect, it } from "vitest";
import { InvalidCharError } from "../src/model/cell.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import {
  createDocument,
  findLayer,
  sequentialIdGen,
  type TuiDocument,
} from "../src/model/document.js";
import { clearRect, drawText, fillRect, setCell } from "../src/ops/draw.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const cell = (char: string) => ({ char, ...STYLE });

let doc: TuiDocument;
let layerId: string;

beforeEach(() => {
  doc = createDocument(6, 3, { idGen: sequentialIdGen() });
  layerId = doc.activeLayerId;
});

describe("setCell", () => {
  it("writes a single cell", () => {
    const next = setCell(doc, layerId, 1, 2, cell("X"));
    expect(toText(next)).toBe("\n  X\n");
  });

  it("rejects a wide character", () => {
    expect(() => setCell(doc, layerId, 0, 0, cell("你"))).toThrow(InvalidCharError);
  });
});

describe("drawText", () => {
  it("writes without wrapping and clips at the right edge", () => {
    const next = drawText(doc, layerId, 0, 3, "hello", STYLE);
    expect(toText(next)).toBe("   hel\n\n");
  });

  it("stores a combining grapheme in one cell", () => {
    const next = drawText(doc, layerId, 0, 0, "éx", STYLE);
    expect(next.layers[0]?.cells["0,0"]?.char).toBe("é");
    expect(next.layers[0]?.cells["0,1"]?.char).toBe("x");
  });

  it("clips negative columns, keeping the visible remainder aligned", () => {
    const next = drawText(doc, layerId, 0, -2, "abcdef", STYLE);
    expect(toText(next)).toBe("cdef\n\n");
  });

  it("is a no-op for empty text", () => {
    expect(drawText(doc, layerId, 0, 0, "", STYLE)).toBe(doc);
  });

  it("is a no-op entirely off-grid", () => {
    expect(drawText(doc, layerId, 99, 0, "hi", STYLE)).toBe(doc);
  });

  it("rejects the whole call if any character is invalid, writing nothing", () => {
    // Validate-then-write, so a bad char never leaves a half-written row.
    expect(() => drawText(doc, layerId, 0, 0, "ab你cd", STYLE)).toThrow(InvalidCharError);
  });
});

describe("fillRect and clearRect", () => {
  it("fills a clipped rect", () => {
    const next = fillRect(doc, layerId, { top: 1, left: 4, rows: 5, cols: 5 }, cell("#"));
    expect(toText(next)).toBe("\n    ##\n    ##");
  });

  it("clears to transparent rather than painting spaces", () => {
    const filled = fillRect(doc, layerId, { top: 0, left: 0, rows: 3, cols: 6 }, cell("#"));
    const cleared = clearRect(filled, layerId, { top: 1, left: 1, rows: 1, cols: 4 });
    expect(toText(cleared)).toBe("######\n#    #\n######");
    // Transparent means the key is gone, not that a space was written.
    const layer = findLayer(cleared, layerId);
    expect(layer?.cells["1,1"]).toBeUndefined();
  });

  it("is a no-op for a rect entirely outside the grid", () => {
    expect(fillRect(doc, layerId, { top: 9, left: 9, rows: 2, cols: 2 }, cell("#"))).toBe(doc);
    expect(clearRect(doc, layerId, { top: -5, left: 0, rows: 2, cols: 2 })).toBe(doc);
  });

  it("is a no-op when clearing an already-transparent region", () => {
    expect(clearRect(doc, layerId, { top: 0, left: 0, rows: 3, cols: 6 })).toBe(doc);
  });
});

describe("the immutability contract", () => {
  it("returns the same object when the layer is locked", () => {
    const locked: TuiDocument = {
      ...doc,
      layers: doc.layers.map((l) => ({ ...l, locked: true })),
    };
    expect(setCell(locked, layerId, 0, 0, cell("X"))).toBe(locked);
    expect(fillRect(locked, layerId, { top: 0, left: 0, rows: 1, cols: 1 }, cell("X"))).toBe(
      locked,
    );
  });

  it("returns the same object for an unknown layer", () => {
    expect(setCell(doc, "nope", 0, 0, cell("X"))).toBe(doc);
  });

  it("returns the same object when coordinates are out of bounds", () => {
    expect(setCell(doc, layerId, -1, 0, cell("X"))).toBe(doc);
    expect(setCell(doc, layerId, 0, 99, cell("X"))).toBe(doc);
  });

  it("never mutates the input document", () => {
    const before = JSON.stringify(doc);
    setCell(doc, layerId, 0, 0, cell("X"));
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("shares untouched layers by reference", () => {
    const twoLayer: TuiDocument = {
      ...doc,
      layers: [...doc.layers, { id: "top", name: "Top", visible: true, locked: false, cells: {} }],
    };
    const next = setCell(twoLayer, "top", 0, 0, cell("X"));
    expect(next).not.toBe(twoLayer);
    expect(next.layers[0]).toBe(twoLayer.layers[0]); // untouched layer is ===
    expect(next.layers[1]).not.toBe(twoLayer.layers[1]);
  });

  it("copies each layer's cell map exactly once per op", () => {
    // Guards against the O(n^2) regression: a naive {...cells} per cell would make
    // this fill quadratic. 40k cells completes well under a second when correct.
    const big = createDocument(400, 100, { idGen: sequentialIdGen() });
    const start = performance.now();
    const filled = fillRect(
      big,
      big.activeLayerId,
      { top: 0, left: 0, rows: 100, cols: 400 },
      cell("#"),
    );
    const elapsed = performance.now() - start;
    expect(Object.keys(findLayer(filled, big.activeLayerId)?.cells ?? {})).toHaveLength(40_000);
    expect(elapsed).toBeLessThan(2000);
  });
});
