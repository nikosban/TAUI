/**
 * The layers panel's pure model.
 *
 * The reorder tests are worked examples rather than assertions about the formula:
 * the display/array inversion is the one place a plausible-looking index silently
 * reorders a document, so each case states the expected *order*, not the index.
 */

import {
  addLayer,
  createDocument,
  drawText,
  type Layer,
  moveLayer,
  renameLayer,
  sequentialIdGen,
  setLayerVisible,
  type TuiDocument,
} from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import {
  activeLayerNotice,
  arrayIndexFromDisplay,
  canDelete,
  canMergeDown,
  cycleActiveId,
  deleteConfirm,
  layerRows,
  mergeDownConfirm,
  paintedCount,
  reorderTargetIndex,
} from "../src/layers/panel-model.js";

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;

/** A document whose layers are named bottom-up: A (bottom), B, C (top). */
function threeLayers(): TuiDocument {
  let doc = createDocument(10, 4, { idGen: sequentialIdGen() });
  doc = renameLayer(doc, doc.activeLayerId, "A");
  doc = addLayer(doc, { name: "B", idGen: () => "layer-B" });
  doc = addLayer(doc, { name: "C", idGen: () => "layer-C" });
  return doc;
}

const names = (doc: TuiDocument): string[] => doc.layers.map((l) => l.name);
const displayNames = (doc: TuiDocument): string[] => layerRows(doc).map((r) => r.layer.name);
const idOf = (doc: TuiDocument, name: string): string =>
  doc.layers.find((l) => l.name === name)?.id ?? "missing";
const layerNamed = (doc: TuiDocument, name: string): Layer =>
  doc.layers.find((l) => l.name === name) as Layer;

describe("display order", () => {
  it("lists layers top-first, the reverse of the composite order", () => {
    const doc = threeLayers();
    // Bottom-up in the model...
    expect(names(doc)).toEqual(["A", "B", "C"]);
    // ...top-first in the panel.
    expect(displayNames(doc)).toEqual(["C", "B", "A"]);
  });

  it("reports both indices, and marks the bottom layer", () => {
    const rows = layerRows(threeLayers());
    expect(rows.map((r) => [r.layer.name, r.displayIndex, r.arrayIndex, r.isBottom])).toEqual([
      ["C", 0, 2, false],
      ["B", 1, 1, false],
      ["A", 2, 0, true],
    ]);
  });

  it("marks exactly one row active", () => {
    const rows = layerRows(threeLayers());
    expect(rows.filter((r) => r.isActive)).toHaveLength(1);
    // addLayer makes the new layer active, and it is on top.
    expect(rows.find((r) => r.isActive)?.layer.name).toBe("C");
  });

  it("is its own inverse", () => {
    for (const count of [1, 2, 5, 9]) {
      for (let i = 0; i < count; i++) {
        expect(arrayIndexFromDisplay(arrayIndexFromDisplay(i, count), count)).toBe(i);
      }
    }
  });

  it("handles a single-layer document", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    const rows = layerRows(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isBottom).toBe(true);
    expect(rows[0]?.displayIndex).toBe(0);
  });
});

describe("reorder", () => {
  /** Applies a panel drag and returns the resulting panel order. */
  const dragTo = (doc: TuiDocument, name: string, toDisplay: number): string[] =>
    displayNames(moveLayer(doc, idOf(doc, name), reorderTargetIndex(toDisplay, doc.layers.length)));

  it("drags the top layer to the bottom of the panel", () => {
    expect(dragTo(threeLayers(), "C", 2)).toEqual(["B", "A", "C"]);
  });

  it("drags the bottom layer to the top of the panel", () => {
    expect(dragTo(threeLayers(), "A", 0)).toEqual(["A", "C", "B"]);
  });

  it("drags the middle layer up one", () => {
    expect(dragTo(threeLayers(), "B", 0)).toEqual(["B", "C", "A"]);
  });

  it("drags the middle layer down one", () => {
    expect(dragTo(threeLayers(), "B", 2)).toEqual(["C", "A", "B"]);
  });

  it("is a no-op when dropped where it started", () => {
    const doc = threeLayers();
    const target = reorderTargetIndex(1, 3);
    // Referential equality: moveLayer short-circuits an order-preserving move.
    expect(moveLayer(doc, idOf(doc, "B"), target)).toBe(doc);
  });

  it("actually changes what composites on top", () => {
    // The inversion's real consequence: whoever is display-index 0 wins a cell.
    let doc = threeLayers();
    doc = drawText(doc, idOf(doc, "A"), 0, 0, "a", STYLE);
    doc = drawText(doc, idOf(doc, "C"), 0, 0, "c", STYLE);

    const topWins = (d: TuiDocument) =>
      d.layers.reduce<string>((acc, l) => l.cells["0,0"]?.char ?? acc, "");
    expect(topWins(doc)).toBe("c");

    // Send C to the bottom of the panel; A should now win.
    const moved = moveLayer(doc, idOf(doc, "C"), reorderTargetIndex(2, 3));
    expect(topWins(moved)).toBe("a");
  });
});

describe("cycleActiveId", () => {
  it("moves up the panel and wraps at the top", () => {
    const doc = threeLayers(); // active is C, display index 0
    const up1 = cycleActiveId(doc, -1);
    // Wraps from the top row to the bottom row.
    expect(doc.layers.find((l) => l.id === up1)?.name).toBe("A");
  });

  it("moves down the panel", () => {
    const doc = threeLayers();
    expect(doc.layers.find((l) => l.id === cycleActiveId(doc, 1))?.name).toBe("B");
  });

  it("returns to where it started after a full cycle", () => {
    let doc = threeLayers();
    const start = doc.activeLayerId;
    for (let i = 0; i < 3; i++) {
      doc = { ...doc, activeLayerId: cycleActiveId(doc, 1) };
    }
    expect(doc.activeLayerId).toBe(start);
  });

  it("is a no-op cycle on a single-layer document", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    expect(cycleActiveId(doc, 1)).toBe(doc.activeLayerId);
    expect(cycleActiveId(doc, -1)).toBe(doc.activeLayerId);
  });

  it("stays total when activeLayerId names no layer", () => {
    // deserialize repairs this, but the shortcut must not depend on that.
    const doc = { ...threeLayers(), activeLayerId: "gone" };
    expect(doc.layers.some((l) => l.id === cycleActiveId(doc, 1))).toBe(true);
  });
});

describe("merge-down guards", () => {
  it("refuses the bottom layer, which has nothing beneath it", () => {
    const doc = threeLayers();
    expect(canMergeDown(doc, idOf(doc, "A"))).toBe(false);
    expect(canMergeDown(doc, idOf(doc, "B"))).toBe(true);
  });

  it("warns that merging a hidden layer makes its content appear", () => {
    // The one surprising outcome: mergeDown ignores `visible` by design.
    let doc = threeLayers();
    doc = setLayerVisible(doc, idOf(doc, "B"), false);
    expect(mergeDownConfirm(doc, idOf(doc, "B"))).toContain("will become visible");
  });

  it("asks nothing when the layer is visible", () => {
    const doc = threeLayers();
    expect(mergeDownConfirm(doc, idOf(doc, "B"))).toBeNull();
  });

  it("asks nothing when the merge cannot happen anyway", () => {
    let doc = threeLayers();
    doc = setLayerVisible(doc, idOf(doc, "A"), false);
    expect(mergeDownConfirm(doc, idOf(doc, "A"))).toBeNull();
  });

  it("asks nothing for a layer that does not exist", () => {
    expect(mergeDownConfirm(threeLayers(), "nope")).toBeNull();
  });
});

describe("delete guards", () => {
  it("refuses when only one layer remains", () => {
    expect(canDelete(createDocument(4, 2, { idGen: sequentialIdGen() }))).toBe(false);
    expect(canDelete(threeLayers())).toBe(true);
  });

  it("counts the cells at stake, singular and plural", () => {
    let doc = threeLayers();
    doc = drawText(doc, idOf(doc, "B"), 0, 0, "x", STYLE);
    expect(deleteConfirm(doc, idOf(doc, "B"))).toContain("1 painted cell?");

    doc = drawText(doc, idOf(doc, "B"), 1, 0, "yz", STYLE);
    expect(deleteConfirm(doc, idOf(doc, "B"))).toContain("3 painted cells?");
  });

  it("asks nothing for an empty layer", () => {
    const doc = threeLayers();
    expect(deleteConfirm(doc, idOf(doc, "B"))).toBeNull();
    expect(paintedCount(layerNamed(doc, "B"))).toBe(0);
  });

  it("asks nothing for a layer that does not exist", () => {
    expect(deleteConfirm(threeLayers(), "nope")).toBeNull();
  });
});

describe("activeLayerNotice", () => {
  it("warns when the active layer is hidden, because edits leave no trace", () => {
    let doc = threeLayers();
    doc = setLayerVisible(doc, doc.activeLayerId, false);
    expect(activeLayerNotice(doc)).toContain("hidden");
  });

  it("warns when the active layer is locked", () => {
    const doc = threeLayers();
    const locked = {
      ...doc,
      layers: doc.layers.map((l) => (l.id === doc.activeLayerId ? { ...l, locked: true } : l)),
    };
    expect(activeLayerNotice(locked)).toContain("locked");
  });

  it("prefers the hidden warning, since an invisible edit is the more confusing one", () => {
    const doc = threeLayers();
    const both = {
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === doc.activeLayerId ? { ...l, locked: true, visible: false } : l,
      ),
    };
    expect(activeLayerNotice(both)).toContain("hidden");
  });

  it("says nothing about a normal layer", () => {
    expect(activeLayerNotice(threeLayers())).toBeNull();
  });

  it("says nothing when activeLayerId names no layer", () => {
    expect(activeLayerNotice({ ...threeLayers(), activeLayerId: "gone" })).toBeNull();
  });
});
