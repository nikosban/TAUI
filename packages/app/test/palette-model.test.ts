/**
 * The palette editor's pure model.
 *
 * These messages exist to make two surprising engine behaviours legible: delete
 * preserves the design, and delete reaches locked layers. Asserting the wording
 * is asserting that the surprise gets explained.
 */

import {
  addPaletteEntry,
  type Color,
  createDocument,
  drawText,
  sequentialIdGen,
  setCell,
  type TuiDocument,
} from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import {
  colorModeIsLossy,
  colorModeNotice,
  danglingNotice,
  deleteNotice,
  nameProblem,
  paletteRows,
} from "../src/palette/palette-model.js";

const RED: Color = { kind: "ansi16", index: 1 };
const BLUE: Color = { kind: "ansi16", index: 4 };
const DEFAULT = { kind: "default" } as const;
const NO_BRUSH = { fg: DEFAULT, bg: DEFAULT };

/** One entry "brand" (red), referenced by three cells on the active layer. */
function branded(): TuiDocument {
  let doc = createDocument(10, 3, { idGen: sequentialIdGen() });
  doc = addPaletteEntry(doc, "brand", RED, { idGen: () => "p1" });
  doc = drawText(doc, doc.activeLayerId, 0, 0, "abc", {
    fg: { kind: "palette", id: "p1" },
    bg: DEFAULT,
  });
  return doc;
}

describe("paletteRows", () => {
  it("joins each entry with its usage, in palette order", () => {
    let doc = branded();
    doc = addPaletteEntry(doc, "unused", BLUE, { idGen: () => "p2" });
    const rows = paletteRows(doc, NO_BRUSH);
    expect(rows.map((r) => [r.entry.name, r.usage.cells])).toEqual([
      ["brand", 3],
      ["unused", 0],
    ]);
  });

  it("keeps palette order rather than sorting by usage", () => {
    // The list is something the user arranges; re-sorting under them as usage
    // changes would make it unnavigable.
    let doc = createDocument(6, 1, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "rare", RED, { idGen: () => "pa" });
    doc = addPaletteEntry(doc, "common", BLUE, { idGen: () => "pb" });
    doc = drawText(doc, doc.activeLayerId, 0, 0, "xxxx", {
      fg: { kind: "palette", id: "pb" },
      bg: DEFAULT,
    });
    expect(paletteRows(doc, NO_BRUSH).map((r) => r.entry.name)).toEqual(["rare", "common"]);
  });

  it("marks which entry the brush is holding, per channel", () => {
    const doc = branded();
    const rows = paletteRows(doc, { fg: { kind: "palette", id: "p1" }, bg: DEFAULT });
    expect([rows[0]?.inBrushFg, rows[0]?.inBrushBg]).toEqual([true, false]);

    const bgRows = paletteRows(doc, { fg: DEFAULT, bg: { kind: "palette", id: "p1" } });
    expect([bgRows[0]?.inBrushFg, bgRows[0]?.inBrushBg]).toEqual([false, true]);
  });

  it("does not mark an entry when the brush holds a raw colour of the same value", () => {
    // A raw red is not the same thing as a reference to the red entry: editing the
    // entry would not move the raw one.
    const rows = paletteRows(branded(), { fg: RED, bg: DEFAULT });
    expect(rows[0]?.inBrushFg).toBe(false);
  });

  it("is empty for a document with no palette", () => {
    expect(paletteRows(createDocument(4, 2, { idGen: sequentialIdGen() }), NO_BRUSH)).toEqual([]);
  });
});

describe("deleteNotice", () => {
  it("says plainly that nothing changes visually", () => {
    // The surprise worth explaining: delete bakes each reference to the colour it
    // was showing, so the design survives. A scary confirmation would cause
    // hesitation over a safe action.
    const notice = deleteNotice(branded(), "p1");
    expect(notice).toContain("3 cells");
    expect(notice).toContain("nothing changes visually");
  });

  it("singularises a single cell", () => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "one", RED, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "p1" },
      bg: DEFAULT,
    });
    expect(deleteNotice(doc, "p1")).toContain("1 cell use");
  });

  it("says an unused entry changes nothing at all", () => {
    let doc = branded();
    doc = addPaletteEntry(doc, "spare", BLUE, { idGen: () => "p2" });
    expect(deleteNotice(doc, "p2")).toContain("is unused");
  });

  it("calls out a locked layer, which delete reaches anyway", () => {
    // The engine's one exception to `locked`. A user who locked a layer to protect
    // it deserves to know this reaches it.
    const base = branded();
    const locked = { ...base, layers: base.layers.map((l) => ({ ...l, locked: true })) };
    expect(deleteNotice(locked, "p1")).toContain("including a locked layer");
  });

  it("does not mention locking when no locked layer is involved", () => {
    expect(deleteNotice(branded(), "p1")).not.toContain("locked");
  });

  it("says nothing about an entry that does not exist", () => {
    expect(deleteNotice(branded(), "gone")).toBeNull();
  });
});

describe("nameProblem", () => {
  it("requires a name", () => {
    expect(nameProblem(branded(), "   ")).toBe("A name is required.");
  });

  it("rejects a duplicate, because names become token keys", () => {
    expect(nameProblem(branded(), "brand")).toContain("already used");
  });

  it("trims before comparing, so trailing space is not a loophole", () => {
    expect(nameProblem(branded(), "  brand  ")).toContain("already used");
  });

  it("allows a free name", () => {
    expect(nameProblem(branded(), "accent")).toBeNull();
  });

  it("lets an entry keep its own name during a rename", () => {
    expect(nameProblem(branded(), "brand", "p1")).toBeNull();
  });
});

describe("colorModeNotice", () => {
  const rgbDoc = (): TuiDocument => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "a",
      fg: { kind: "rgb", r: 200, g: 10, b: 10 },
      bg: DEFAULT,
    });
    return doc;
  };

  it("says nothing when the mode is unchanged", () => {
    expect(colorModeNotice(rgbDoc(), "rgb")).toBeNull();
  });

  it("reassures when the target mode loses nothing", () => {
    // Widening: worth saying explicitly, so the user is not left guessing.
    let doc = createDocument(4, 1, { colorMode: "ansi16", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", fg: RED, bg: BLUE });
    expect(colorModeNotice(doc, "rgb")).toContain("Nothing will change");
  });

  it("counts the cell colours that will be approximated", () => {
    expect(colorModeNotice(rgbDoc(), "ansi16")).toContain("1 cell colour");
  });

  it("counts palette entries separately from cells", () => {
    // One entry standing in for a thousand cells is a very different sentence.
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "rich", { kind: "rgb", r: 9, g: 9, b: 200 }, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "p1" },
      bg: DEFAULT,
    });
    const notice = colorModeNotice(doc, "ansi16");
    expect(notice).toContain("1 palette entry");
    // The referencing cell is not counted as a cell colour.
    expect(notice).not.toContain("cell colour");
  });

  it("pluralises entries", () => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "a", { kind: "rgb", r: 1, g: 2, b: 3 }, { idGen: () => "p1" });
    doc = addPaletteEntry(doc, "b", { kind: "rgb", r: 4, g: 5, b: 6 }, { idGen: () => "p2" });
    expect(colorModeNotice(doc, "ansi16")).toContain("2 palette entries");
  });

  it("pluralises cell colours", () => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "a",
      fg: { kind: "rgb", r: 200, g: 10, b: 10 },
      bg: { kind: "rgb", r: 10, g: 200, b: 10 },
    });
    expect(colorModeNotice(doc, "ansi16")).toContain("2 cell colours");
  });

  it("joins both counts when both apply", () => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "a", { kind: "rgb", r: 1, g: 2, b: 3 }, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "rgb", r: 7, g: 8, b: 9 },
      bg: DEFAULT,
    });
    const notice = colorModeNotice(doc, "ansi16");
    expect(notice).toContain("1 cell colour and 1 palette entry");
    expect(notice).toContain("Undo is the only way back");
  });
});

describe("colorModeIsLossy", () => {
  it("is false for the current mode and for a widening change", () => {
    let doc = createDocument(4, 1, { colorMode: "ansi16", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", fg: RED, bg: DEFAULT });
    expect(colorModeIsLossy(doc, "ansi16")).toBe(false);
    expect(colorModeIsLossy(doc, "rgb")).toBe(false);
  });

  it("is true when a cell colour would be approximated", () => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "a",
      fg: { kind: "rgb", r: 200, g: 10, b: 10 },
      bg: DEFAULT,
    });
    expect(colorModeIsLossy(doc, "ansi16")).toBe(true);
  });

  it("is true when only a palette entry would be approximated", () => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "rich", { kind: "rgb", r: 9, g: 9, b: 200 }, { idGen: () => "p1" });
    expect(colorModeIsLossy(doc, "ansi16")).toBe(true);
  });

  it("agrees with the notice about whether anything is lost", () => {
    // The predicate exists so callers need not parse the message; the two must
    // never disagree.
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "a",
      fg: { kind: "rgb", r: 200, g: 10, b: 10 },
      bg: DEFAULT,
    });
    for (const mode of ["ansi16", "ansi256", "rgb"] as const) {
      const lossy = colorModeIsLossy(doc, mode);
      const notice = colorModeNotice(doc, mode);
      expect(lossy, mode).toBe(notice?.includes("approximated") === true);
    }
  });
});

describe("danglingNotice", () => {
  const dangling = (count: 1 | 2): TuiDocument => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "gone" },
      bg: count === 2 ? { kind: "palette", id: "gone" } : DEFAULT,
    });
    return doc;
  };

  it("says nothing when every reference resolves", () => {
    expect(danglingNotice(branded())).toBeNull();
  });

  it("offers a repair, counting the broken references", () => {
    expect(danglingNotice(dangling(1))).toContain("1 reference point");
    expect(danglingNotice(dangling(2))).toContain("2 references point");
  });

  it("says the colour is lost, unlike deleting an entry", () => {
    // The entry is already gone, so what the cell was showing is unrecoverable —
    // the opposite of deleteNotice's reassurance.
    expect(danglingNotice(dangling(1))).toContain("terminal default");
  });
});
