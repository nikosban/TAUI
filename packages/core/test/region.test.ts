import { beforeEach, describe, expect, it } from "vitest";
import { parseText } from "../src/io/text-import.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { findLayer, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { drawText } from "../src/ops/draw.js";
import {
  copyRegion,
  cutRegion,
  EMPTY_CLIPBOARD,
  moveRegion,
  pasteRegion,
} from "../src/ops/region.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

let doc: TuiDocument;
let id: string;

beforeEach(() => {
  // abcde
  // fghij
  // klmno
  // pqrst
  doc = parseText("abcde\nfghij\nklmno\npqrst", { idGen: sequentialIdGen() }).doc;
  id = doc.activeLayerId;
});

describe("copyRegion", () => {
  it("rebases keys onto the clipboard origin", () => {
    const clip = copyRegion(doc, id, { top: 1, left: 1, rows: 2, cols: 3 });
    expect(clip.rows).toBe(2);
    expect(clip.cols).toBe(3);
    // "ghi" / "lmn" become (0,0)..(1,2) — relative, not absolute.
    expect(Object.keys(clip.cells).sort()).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"]);
    expect(clip.cells["0,0"]?.char).toBe("g");
    expect(clip.cells["1,2"]?.char).toBe("n");
  });

  it("does not record transparent cells", () => {
    const sparse = parseText("a c", { idGen: sequentialIdGen() }).doc;
    const clip = copyRegion(sparse, sparse.activeLayerId, { top: 0, left: 0, rows: 1, cols: 3 });
    expect(Object.keys(clip.cells)).toEqual(["0,0", "0,2"]);
  });

  it("keeps the requested extent when the rect hangs off the grid", () => {
    // Extent stays 4 wide so relative positions survive the paste.
    const clip = copyRegion(doc, id, { top: 0, left: 3, rows: 1, cols: 4 });
    expect(clip.cols).toBe(4);
    expect(Object.keys(clip.cells).sort()).toEqual(["0,0", "0,1"]);
    expect(clip.cells["0,0"]?.char).toBe("d");
  });

  it("returns an empty clipboard for an unknown layer or off-grid rect", () => {
    expect(copyRegion(doc, "nope", { top: 0, left: 0, rows: 1, cols: 1 })).toBe(EMPTY_CLIPBOARD);
    expect(copyRegion(doc, id, { top: 50, left: 0, rows: 1, cols: 1 })).toBe(EMPTY_CLIPBOARD);
  });
});

describe("cutRegion", () => {
  it("returns the clipboard and clears the source", () => {
    const [next, clip] = cutRegion(doc, id, { top: 1, left: 1, rows: 2, cols: 3 });
    expect(clip.cells["0,0"]?.char).toBe("g");
    expect(toText(next)).toBe("abcde\nf   j\nk   o\npqrst");
    // Cleared means transparent, not a painted space.
    expect(findLayer(next, id)?.cells["1,1"]).toBeUndefined();
  });

  it("is a no-op on the document for an off-grid rect", () => {
    const [next, clip] = cutRegion(doc, id, { top: 50, left: 0, rows: 2, cols: 2 });
    expect(next).toBe(doc);
    expect(clip).toBe(EMPTY_CLIPBOARD);
  });

  it("leaves the document untouched when the layer is locked", () => {
    const locked: TuiDocument = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    const [next] = cutRegion(locked, id, { top: 0, left: 0, rows: 2, cols: 2 });
    expect(next).toBe(locked);
  });
});

describe("pasteRegion", () => {
  it("places the clipboard origin at the target cell", () => {
    const clip = copyRegion(doc, id, { top: 0, left: 0, rows: 2, cols: 2 });
    const next = pasteRegion(doc, id, { row: 2, col: 3 }, clip);
    expect(toText(next)).toBe("abcde\nfghij\nklmab\npqrfg");
  });

  it("leaves cells under transparent clipboard cells intact", () => {
    // Clipboard from "a c" has a hole at column 1.
    const source = parseText("a c", { idGen: sequentialIdGen() }).doc;
    const clip = copyRegion(source, source.activeLayerId, { top: 0, left: 0, rows: 1, cols: 3 });
    const next = pasteRegion(doc, id, { row: 0, col: 0 }, clip);
    // Pasting "a c" over "abcde": 'a' and 'c' overwrite identically, and 'b'
    // survives beneath the hole — so row 0 is unchanged.
    expect(toText(next).split("\n")[0]).toBe("abcde");
    // Over "fghij" the effect is visible: cols 0 and 2 are replaced, col 1 ('g')
    // shows through the clipboard's transparent cell.
    const next2 = pasteRegion(doc, id, { row: 1, col: 0 }, clip);
    expect(toText(next2).split("\n")[1]).toBe("agcij");
  });

  it("clips cells that land off-grid", () => {
    const clip = copyRegion(doc, id, { top: 0, left: 0, rows: 2, cols: 3 });
    const next = pasteRegion(doc, id, { row: 3, col: 3 }, clip);
    expect(toText(next)).toBe("abcde\nfghij\nklmno\npqrab");
  });

  it("is a no-op for an empty clipboard", () => {
    expect(pasteRegion(doc, id, { row: 0, col: 0 }, EMPTY_CLIPBOARD)).toBe(doc);
  });

  it("is a no-op when everything lands off-grid", () => {
    const clip = copyRegion(doc, id, { top: 0, left: 0, rows: 1, cols: 2 });
    expect(pasteRegion(doc, id, { row: 90, col: 90 }, clip)).toBe(doc);
  });

  it("skips malformed keys in a hand-built or deserialized clipboard", () => {
    // A Clipboard is plain data and may arrive from a persisted session, so bad
    // keys must be ignored rather than crashing the paste.
    const clip = {
      rows: 1,
      cols: 2,
      cells: {
        "0,0": { char: "Z", ...STYLE },
        garbage: { char: "!", ...STYLE },
        "": { char: "?", ...STYLE },
      },
    };
    const next = pasteRegion(doc, id, { row: 0, col: 0 }, clip);
    expect(toText(next).split("\n")[0]).toBe("Zbcde");
    expect(toText(next)).not.toContain("!");
    expect(toText(next)).not.toContain("?");
  });
});

describe("moveRegion", () => {
  it("moves a region and clears the source", () => {
    const next = moveRegion(doc, id, { top: 0, left: 0, rows: 1, cols: 3 }, 2, 1);
    expect(toText(next)).toBe("   de\nfghij\nkabco\npqrst");
  });

  it("handles an overlapping source and destination without corruption", () => {
    // Shift right by 1: destination overlaps the source everywhere but the edge.
    const next = moveRegion(doc, id, { top: 0, left: 0, rows: 1, cols: 4 }, 0, 1);
    expect(toText(next)).toBe(" abcd\nfghij\nklmno\npqrst");
  });

  it("handles a negative delta", () => {
    const next = moveRegion(doc, id, { top: 1, left: 1, rows: 1, cols: 3 }, -1, -1);
    expect(toText(next)).toBe("ghide\nf   j\nklmno\npqrst");
  });

  it("drops cells moved off-grid", () => {
    const next = moveRegion(doc, id, { top: 0, left: 0, rows: 1, cols: 3 }, 0, 3);
    // "abc" -> columns 3,4,5; column 5 does not exist.
    expect(toText(next)).toBe("   ab\nfghij\nklmno\npqrst");
  });

  it("is a no-op for a zero delta", () => {
    expect(moveRegion(doc, id, { top: 0, left: 0, rows: 2, cols: 2 }, 0, 0)).toBe(doc);
  });

  it("is a no-op for an off-grid rect and for a locked layer", () => {
    expect(moveRegion(doc, id, { top: 50, left: 0, rows: 2, cols: 2 }, 1, 1)).toBe(doc);
    const locked: TuiDocument = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    expect(moveRegion(locked, id, { top: 0, left: 0, rows: 2, cols: 2 }, 1, 1)).toBe(locked);
  });

  it("skips malformed keys when the source layer holds a bad key", () => {
    const dirty: TuiDocument = {
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === id ? { ...l, cells: { ...l.cells, garbage: { char: "!", ...STYLE } } } : l,
      ),
    };
    const next = moveRegion(dirty, id, { top: 0, left: 0, rows: 1, cols: 3 }, 2, 1);
    expect(toText(next)).toBe("   de\nfghij\nkabco\npqrst");
  });
});

describe("round-trip properties", () => {
  it("cut then paste at the same place restores the document", () => {
    const rect = { top: 1, left: 1, rows: 2, cols: 3 };
    const [cutDoc, clip] = cutRegion(doc, id, rect);
    const restored = pasteRegion(cutDoc, id, { row: rect.top, col: rect.left }, clip);
    expect(toText(restored)).toBe(toText(doc));
  });

  it("moving into empty space and back restores the document", () => {
    // Round-tripping only holds when the destination was empty — move overwrites.
    const sparse = parseText("abc", { idGen: sequentialIdGen(), cols: 8, rows: 4 }).doc;
    const sid = sparse.activeLayerId;
    const rect = { top: 0, left: 0, rows: 1, cols: 3 };
    const moved = moveRegion(sparse, sid, rect, 2, 1);
    expect(toText(moved)).toBe("\n\n abc\n");
    const back = moveRegion(moved, sid, { ...rect, top: 2, left: 1 }, -2, -1);
    expect(toText(back)).toBe(toText(sparse));
  });

  it("is destructive at the destination — move is not reversible in general", () => {
    // Documents the real semantic: 'lmn' is gone, not displaced. The GUI relies
    // on undo (a document snapshot) rather than an inverse move.
    const rect = { top: 0, left: 0, rows: 1, cols: 3 };
    const moved = moveRegion(doc, id, rect, 2, 1);
    expect(toText(moved)).toBe("   de\nfghij\nkabco\npqrst");
    const back = moveRegion(moved, id, { ...rect, top: 2, left: 1 }, -2, -1);
    expect(toText(back)).toBe("abcde\nfghij\nk   o\npqrst");
  });

  it("preserves cell styling through a copy/paste cycle", () => {
    const styled = drawText(doc, id, 0, 0, "XY", {
      fg: { kind: "ansi256", index: 42 },
      bg: DEFAULT_COLOR,
      bold: true,
    });
    const clip = copyRegion(styled, id, { top: 0, left: 0, rows: 1, cols: 2 });
    const pasted = pasteRegion(doc, id, { row: 3, col: 3 }, clip);
    const cell = findLayer(pasted, id)?.cells["3,3"];
    expect(cell).toEqual({
      char: "X",
      fg: { kind: "ansi256", index: 42 },
      bg: DEFAULT_COLOR,
      bold: true,
    });
  });
});
