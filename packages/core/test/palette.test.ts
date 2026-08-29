/**
 * Palette operations.
 *
 * The load-bearing assertions here are the *negative* ones: rename and recolour
 * must touch no cells, checked by referential equality on `doc.layers`. That is
 * the entire reason cells store a `ColorRef` rather than a `Color`, and it is
 * invisible to any test that only compares rendered output.
 */

import { describe, expect, it } from "vitest";
import { type Color, DEFAULT_COLOR, resolveColor } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { colorModeLoss, convertColorMode } from "../src/ops/color-mode.js";
import { drawText, setCell } from "../src/ops/draw.js";
import {
  addPaletteEntry,
  bakeDanglingRefs,
  danglingRefs,
  findPaletteEntry,
  paletteNameConflict,
  paletteUsage,
  removePaletteEntry,
  renamePaletteEntry,
  setPaletteColor,
} from "../src/ops/palette.js";

const RED: Color = { kind: "ansi16", index: 1 };
const BLUE: Color = { kind: "ansi16", index: 4 };
const ORANGE: Color = { kind: "ansi256", index: 208 };

/** A document with one palette entry "brand" (red) referenced by three cells. */
function branded(): { doc: TuiDocument; brandId: string } {
  let doc = createDocument(10, 3, { idGen: sequentialIdGen() });
  doc = addPaletteEntry(doc, "brand", RED, { idGen: () => "p-brand" });
  doc = drawText(doc, doc.activeLayerId, 0, 0, "abc", {
    fg: { kind: "palette", id: "p-brand" },
    bg: DEFAULT_COLOR,
  });
  return { doc, brandId: "p-brand" };
}

const cellOf = (doc: TuiDocument, key: string) => doc.layers[0]?.cells[key];

describe("addPaletteEntry", () => {
  it("appends an entry with the generated id", () => {
    const doc = addPaletteEntry(createDocument(4, 2, { idGen: sequentialIdGen() }), "bg", BLUE, {
      idGen: () => "p1",
    });
    expect(doc.palette).toEqual([{ id: "p1", name: "bg", color: BLUE }]);
  });

  it("mints a real id when none is injected", () => {
    const doc = addPaletteEntry(createDocument(4, 2, { idGen: sequentialIdGen() }), "bg", BLUE);
    expect(doc.palette[0]?.id).toMatch(/[0-9a-f-]{36}/u);
  });

  it("touches no cells", () => {
    const base = branded().doc;
    const next = addPaletteEntry(base, "second", BLUE, { idGen: () => "p2" });
    expect(next.layers).toBe(base.layers);
  });

  it("rejects an out-of-range colour rather than storing it", () => {
    // The GUI prevents this; reaching it is a programming error, so it fails loudly
    // like setCell does for a wide character.
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    expect(() => addPaletteEntry(doc, "bad", { kind: "ansi16", index: 99 })).toThrow(
      /index must be 0-15/u,
    );
    expect(() => addPaletteEntry(doc, "bad", { kind: "rgb", r: 300, g: 0, b: 0 })).toThrow(
      /r\/g\/b must each be 0-255/u,
    );
  });
});

describe("renamePaletteEntry", () => {
  it("renames without touching a single cell", () => {
    // The payoff of ColorRef: restyling is a palette-array edit, not a document pass.
    const { doc, brandId } = branded();
    const next = renamePaletteEntry(doc, brandId, "accent");
    expect(findPaletteEntry(next, brandId)?.name).toBe("accent");
    expect(next.layers).toBe(doc.layers);
  });

  it("leaves the other entries untouched", () => {
    let doc = branded().doc;
    doc = addPaletteEntry(doc, "other", BLUE, { idGen: () => "p2" });
    const next = renamePaletteEntry(doc, "p-brand", "accent");
    // The sibling entry must be the same object, not a rebuilt copy.
    expect(next.palette[1]).toBe(doc.palette[1]);
  });

  it("is a no-op for an unchanged name", () => {
    const { doc, brandId } = branded();
    expect(renamePaletteEntry(doc, brandId, "brand")).toBe(doc);
  });

  it("is a no-op for a missing entry", () => {
    const { doc } = branded();
    expect(renamePaletteEntry(doc, "nope", "x")).toBe(doc);
  });
});

describe("setPaletteColor", () => {
  it("recolours every referencing cell without touching any of them", () => {
    const { doc, brandId } = branded();
    const next = setPaletteColor(doc, brandId, BLUE);

    expect(next.layers).toBe(doc.layers);
    // Yet what the cells resolve to has changed — that is the whole point.
    const fg = cellOf(next, "0,0")?.fg;
    expect(fg).toEqual({ kind: "palette", id: brandId });
    expect(resolveColor(next, fg as never)).toEqual(BLUE);
  });

  it("leaves the other entries untouched", () => {
    let doc = branded().doc;
    doc = addPaletteEntry(doc, "other", BLUE, { idGen: () => "p2" });
    const next = setPaletteColor(doc, "p-brand", ORANGE);
    expect(next.palette[1]).toBe(doc.palette[1]);
    expect(next.palette[0]?.color).toEqual(ORANGE);
  });

  it("is a no-op for the same colour", () => {
    const { doc, brandId } = branded();
    expect(setPaletteColor(doc, brandId, RED)).toBe(doc);
  });

  it("is a no-op for a missing entry", () => {
    const { doc } = branded();
    expect(setPaletteColor(doc, "nope", BLUE)).toBe(doc);
  });

  it("rejects an out-of-range colour", () => {
    const { doc, brandId } = branded();
    expect(() => setPaletteColor(doc, brandId, { kind: "ansi256", index: 999 })).toThrow(
      /index must be 0-255/u,
    );
  });
});

describe("removePaletteEntry", () => {
  it("bakes references into the colour they were showing, not the default", () => {
    // Deleting a swatch must not change the design. Baking to `default` would
    // silently wipe colour from every cell that used it.
    const { doc, brandId } = branded();
    const next = removePaletteEntry(doc, brandId);

    expect(next.palette).toEqual([]);
    expect(cellOf(next, "0,0")?.fg).toEqual(RED);
    expect(cellOf(next, "0,2")?.fg).toEqual(RED);
  });

  it("bakes a background reference too", () => {
    let doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "bg", BLUE, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "p1" },
      bg: { kind: "palette", id: "p1" },
    });
    const next = removePaletteEntry(doc, "p1");
    expect(cellOf(next, "0,0")).toEqual({ char: "x", fg: BLUE, bg: BLUE });
  });

  it("bakes a background-only reference, leaving the foreground alone", () => {
    // The asymmetric case: a coloured bar whose text keeps the terminal default.
    let doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "bar", BLUE, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: " ",
      fg: DEFAULT_COLOR,
      bg: { kind: "palette", id: "p1" },
    });
    const next = removePaletteEntry(doc, "p1");
    expect(cellOf(next, "0,0")).toEqual({ char: " ", fg: DEFAULT_COLOR, bg: BLUE });
  });

  it("bakes references on a LOCKED layer too", () => {
    // The one mutation that ignores `locked`. Skipping locked layers would leave
    // them holding a ref to an entry that no longer exists, and then every reader
    // has to defend against a dangling ref forever.
    const { doc, brandId } = branded();
    const locked = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    const next = removePaletteEntry(locked, brandId);

    expect(next.palette).toEqual([]);
    expect(cellOf(next, "0,0")?.fg).toEqual(RED);
    // The lock itself survives; only the reference was rewritten.
    expect(next.layers[0]?.locked).toBe(true);
  });

  it("leaves cells referencing other entries alone", () => {
    let doc = createDocument(6, 2, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "a", RED, { idGen: () => "pa" });
    doc = addPaletteEntry(doc, "b", BLUE, { idGen: () => "pb" });
    doc = drawText(doc, doc.activeLayerId, 0, 0, "x", {
      fg: { kind: "palette", id: "pa" },
      bg: DEFAULT_COLOR,
    });
    doc = drawText(doc, doc.activeLayerId, 0, 1, "y", {
      fg: { kind: "palette", id: "pb" },
      bg: DEFAULT_COLOR,
    });

    const next = removePaletteEntry(doc, "pa");
    expect(cellOf(next, "0,0")?.fg).toEqual(RED);
    expect(cellOf(next, "0,1")?.fg).toEqual({ kind: "palette", id: "pb" });
  });

  it("is a no-op for a missing entry", () => {
    const { doc } = branded();
    expect(removePaletteEntry(doc, "nope")).toBe(doc);
  });

  it("leaves the document referentially equal when nothing referenced the entry", () => {
    let doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "unused", BLUE, { idGen: () => "p1" });
    doc = drawText(doc, doc.activeLayerId, 0, 0, "ab", {
      fg: DEFAULT_COLOR,
      bg: DEFAULT_COLOR,
    });
    const next = removePaletteEntry(doc, "p1");
    // The palette shrank, but no cell map was rebuilt.
    expect(next.layers).toBe(doc.layers);
    expect(next.palette).toEqual([]);
  });

  it("leaves no ref resolving to nothing afterwards", () => {
    // The invariant the lock exception exists to protect.
    const { doc, brandId } = branded();
    const next = removePaletteEntry(doc, brandId);
    expect(danglingRefs(next)).toBe(0);
  });
});

describe("danglingRefs and bakeDanglingRefs", () => {
  /** A hand-edited document: refs pointing at an empty palette. */
  function dangling(): TuiDocument {
    let doc = createDocument(6, 2, { idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "gone" },
      bg: { kind: "palette", id: "gone" },
    });
    doc = setCell(doc, doc.activeLayerId, 0, 1, {
      char: "y",
      fg: { kind: "palette", id: "gone" },
      bg: DEFAULT_COLOR,
    });
    return doc;
  }

  it("counts per reference, not per cell", () => {
    // Two lost pieces of information in the first cell, one in the second.
    expect(danglingRefs(dangling())).toBe(3);
  });

  it("reports zero for a document with no palette refs at all", () => {
    const doc = drawText(createDocument(4, 2, { idGen: sequentialIdGen() }), "l1", 0, 0, "ab", {
      fg: DEFAULT_COLOR,
      bg: DEFAULT_COLOR,
    });
    expect(danglingRefs(doc)).toBe(0);
  });

  it("reports zero when every ref resolves", () => {
    expect(danglingRefs(branded().doc)).toBe(0);
  });

  it("replaces dangling refs with the default, since the colour is unrecoverable", () => {
    const next = bakeDanglingRefs(dangling());
    expect(cellOf(next, "0,0")).toEqual({ char: "x", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR });
    expect(cellOf(next, "0,1")?.fg).toEqual(DEFAULT_COLOR);
    expect(danglingRefs(next)).toBe(0);
  });

  it("repairs a background-only dangling ref, leaving the foreground alone", () => {
    let doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "q",
      fg: RED,
      bg: { kind: "palette", id: "gone" },
    });
    const next = bakeDanglingRefs(doc);
    expect(cellOf(next, "0,0")).toEqual({ char: "q", fg: RED, bg: DEFAULT_COLOR });
  });

  it("is referentially identical when nothing dangles", () => {
    const { doc } = branded();
    expect(bakeDanglingRefs(doc)).toBe(doc);
  });

  it("repairs a locked layer too", () => {
    const base = dangling();
    const locked = { ...base, layers: base.layers.map((l) => ({ ...l, locked: true })) };
    expect(danglingRefs(bakeDanglingRefs(locked))).toBe(0);
  });
});

describe("paletteUsage", () => {
  it("counts distinct cells, not references", () => {
    // A cell using the entry for both fg and bg is one cell, because "used by
    // 47 cells" is how a designer reads it.
    let doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "both", RED, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "p1" },
      bg: { kind: "palette", id: "p1" },
    });
    expect(paletteUsage(doc)[0]?.cells).toBe(1);
  });

  it("reports every entry in palette order, including unused ones", () => {
    let doc = branded().doc;
    doc = addPaletteEntry(doc, "unused", BLUE, { idGen: () => "p2" });
    const usage = paletteUsage(doc);
    expect(usage.map((u) => [u.name, u.cells])).toEqual([
      ["brand", 3],
      ["unused", 0],
    ]);
  });

  it("lists the layers involved, in document order", () => {
    let doc = createDocument(6, 2, { idGen: sequentialIdGen() });
    doc = {
      ...doc,
      layers: [...doc.layers, { id: "top", name: "top", visible: true, locked: false, cells: {} }],
    };
    doc = addPaletteEntry(doc, "p", RED, { idGen: () => "p1" });
    const ref = { fg: { kind: "palette" as const, id: "p1" }, bg: DEFAULT_COLOR };
    doc = drawText(doc, "top", 0, 0, "a", ref);
    doc = drawText(doc, doc.layers[0]?.id ?? "", 1, 0, "b", ref);

    // Bottom layer first, matching doc.layers, so the GUI need not re-sort.
    expect(paletteUsage(doc)[0]?.layerIds).toEqual([doc.layers[0]?.id, "top"]);
  });

  it("counts a hidden layer, because its cells still reference the entry", () => {
    // Deliberately unlike the inspector: usage is about the document, not about
    // what is currently on screen.
    const { doc } = branded();
    const hidden = { ...doc, layers: doc.layers.map((l) => ({ ...l, visible: false })) };
    expect(paletteUsage(hidden)[0]?.cells).toBe(3);
  });

  it("ignores a dangling ref, which belongs to no entry", () => {
    let doc = branded().doc;
    doc = setCell(doc, doc.activeLayerId, 1, 0, {
      char: "z",
      fg: { kind: "palette", id: "gone" },
      bg: DEFAULT_COLOR,
    });
    expect(paletteUsage(doc)[0]?.cells).toBe(3);
    expect(danglingRefs(doc)).toBe(1);
  });

  it("returns an empty array for an empty palette", () => {
    expect(paletteUsage(createDocument(4, 2, { idGen: sequentialIdGen() }))).toEqual([]);
  });
});

describe("paletteNameConflict", () => {
  it("finds an entry sharing the name", () => {
    const { doc, brandId } = branded();
    expect(paletteNameConflict(doc, "brand")).toBe(brandId);
  });

  it("returns null when the name is free", () => {
    expect(paletteNameConflict(branded().doc, "other")).toBeNull();
  });

  it("ignores the entry being renamed, so a no-op rename is not a conflict", () => {
    const { doc, brandId } = branded();
    expect(paletteNameConflict(doc, "brand", brandId)).toBeNull();
  });
});

describe("convertColorMode", () => {
  /** One cell per colour kind, so every conversion path is exercised. */
  function mixed(): TuiDocument {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "a",
      fg: { kind: "rgb", r: 255, g: 0, b: 0 },
      bg: DEFAULT_COLOR,
    });
    doc = setCell(doc, doc.activeLayerId, 0, 1, {
      char: "b",
      fg: ORANGE,
      bg: DEFAULT_COLOR,
    });
    doc = setCell(doc, doc.activeLayerId, 0, 2, { char: "c", fg: RED, bg: DEFAULT_COLOR });
    return doc;
  }

  it("sets the mode and quantises richer colours", () => {
    const next = convertColorMode(mixed(), "ansi16");
    expect(next.colorMode).toBe("ansi16");
    // rgb pure red and ansi256 orange both land in the 16-colour space.
    expect(cellOf(next, "0,0")?.fg).toEqual({ kind: "ansi16", index: 9 });
    expect(cellOf(next, "0,1")?.fg?.kind).toBe("ansi16");
  });

  it("leaves colours poorer than the mode alone rather than expanding them", () => {
    // ansi16 red stays ansi16 red, so it keeps honouring the user's theme.
    const next = convertColorMode(mixed(), "ansi16");
    expect(cellOf(next, "0,2")?.fg).toEqual(RED);
  });

  it("changes no cell on a widening conversion", () => {
    let doc = createDocument(4, 1, { colorMode: "ansi16", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", fg: RED, bg: BLUE });
    const next = convertColorMode(doc, "rgb");
    expect(next.layers).toBe(doc.layers);
    expect(next.colorMode).toBe("rgb");
  });

  it("downgrades the palette entry, not the cells referencing it", () => {
    // The elegance of ColorRef: one entry converted, every cell follows.
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "brand", { kind: "rgb", r: 255, g: 0, b: 0 }, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "x",
      fg: { kind: "palette", id: "p1" },
      bg: DEFAULT_COLOR,
    });

    const next = convertColorMode(doc, "ansi16");
    expect(next.layers).toBe(doc.layers);
    expect(next.palette[0]?.color).toEqual({ kind: "ansi16", index: 9 });
    expect(cellOf(next, "0,0")?.fg).toEqual({ kind: "palette", id: "p1" });
  });

  it("leaves a palette entry alone when it already fits the mode", () => {
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "fits", RED, { idGen: () => "p1" });
    doc = addPaletteEntry(doc, "rich", { kind: "rgb", r: 9, g: 9, b: 200 }, { idGen: () => "p2" });

    const next = convertColorMode(doc, "ansi16");
    // The ansi16 entry is the same object; only the rgb one was rebuilt.
    expect(next.palette[0]).toBe(doc.palette[0]);
    expect(next.palette[1]).not.toBe(doc.palette[1]);
  });

  it("converts a LOCKED layer too", () => {
    const base = mixed();
    const locked = { ...base, layers: base.layers.map((l) => ({ ...l, locked: true })) };
    const next = convertColorMode(locked, "ansi16");
    // Leaving one layer in a richer space would make the document inconsistent.
    expect(cellOf(next, "0,0")?.fg).toEqual({ kind: "ansi16", index: 9 });
  });

  it("is referentially identical when the mode already matches and nothing quantises", () => {
    let doc = createDocument(4, 1, { colorMode: "ansi16", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", fg: RED, bg: DEFAULT_COLOR });
    expect(convertColorMode(doc, "ansi16")).toBe(doc);
  });

  it("is idempotent", () => {
    const once = convertColorMode(mixed(), "ansi256");
    expect(convertColorMode(once, "ansi256")).toBe(once);
  });
});

describe("colorModeLoss", () => {
  it("counts cell colours and palette entries separately", () => {
    // One entry standing in for a thousand cells is a very different sentence.
    let doc = createDocument(4, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    doc = addPaletteEntry(doc, "p", { kind: "rgb", r: 1, g: 2, b: 3 }, { idGen: () => "p1" });
    doc = setCell(doc, doc.activeLayerId, 0, 0, {
      char: "a",
      fg: { kind: "rgb", r: 10, g: 20, b: 30 },
      bg: { kind: "rgb", r: 40, g: 50, b: 60 },
    });
    doc = setCell(doc, doc.activeLayerId, 0, 1, {
      char: "b",
      fg: { kind: "palette", id: "p1" },
      bg: DEFAULT_COLOR,
    });

    // Two cell colours quantise; the palette ref is not counted as a cell colour.
    expect(colorModeLoss(doc, "ansi16")).toEqual({ cellColors: 2, paletteEntries: 1 });
  });

  it("reports zero for a widening conversion", () => {
    let doc = createDocument(4, 1, { colorMode: "ansi16", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", fg: RED, bg: BLUE });
    expect(colorModeLoss(doc, "rgb")).toEqual({ cellColors: 0, paletteEntries: 0 });
  });

  it("reports zero when the target mode is already in use", () => {
    let doc = createDocument(4, 1, { colorMode: "ansi256", idGen: sequentialIdGen() });
    doc = setCell(doc, doc.activeLayerId, 0, 0, { char: "a", fg: ORANGE, bg: DEFAULT_COLOR });
    expect(colorModeLoss(doc, "ansi256")).toEqual({ cellColors: 0, paletteEntries: 0 });
  });

  it("agrees with what convertColorMode actually changes", () => {
    // The warning must not overstate or understate the damage.
    let doc = createDocument(6, 1, { colorMode: "rgb", idGen: sequentialIdGen() });
    for (const [i, color] of [
      { kind: "rgb", r: 200, g: 10, b: 10 },
      { kind: "ansi256", index: 33 },
      { kind: "ansi16", index: 2 },
    ].entries()) {
      doc = setCell(doc, doc.activeLayerId, 0, i, {
        char: "x",
        fg: color as Color,
        bg: DEFAULT_COLOR,
      });
    }

    const { cellColors } = colorModeLoss(doc, "ansi16");
    const next = convertColorMode(doc, "ansi16");
    let actuallyChanged = 0;
    for (let i = 0; i < 3; i++) {
      const before = cellOf(doc, `0,${i}`)?.fg;
      const after = cellOf(next, `0,${i}`)?.fg;
      if (JSON.stringify(before) !== JSON.stringify(after)) actuallyChanged++;
    }
    expect(cellColors).toBe(actuallyChanged);
  });
});
