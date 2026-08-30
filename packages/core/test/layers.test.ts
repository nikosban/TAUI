import { beforeEach, describe, expect, it } from "vitest";
import { deserialize, serialize } from "../src/io/file.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import {
  createDocument,
  findLayer,
  sequentialIdGen,
  type TuiDocument,
} from "../src/model/document.js";
import { RESOURCE_LIMITS } from "../src/model/resource-policy.js";
import { drawText } from "../src/ops/draw.js";
import {
  addLayer,
  duplicateLayer,
  mergeDown,
  moveLayer,
  removeLayer,
  renameLayer,
  setActiveLayer,
  setExcludeFromHandoff,
  setLayerLocked,
  setLayerVisible,
} from "../src/ops/layers.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const ids = () => sequentialIdGen();
const names = (doc: TuiDocument) => doc.layers.map((l) => l.name);

let doc: TuiDocument;
let base: string;

beforeEach(() => {
  doc = createDocument(8, 3, { idGen: ids() });
  base = doc.activeLayerId;
});

describe("addLayer", () => {
  it("enforces the shared layer budget", () => {
    const full: TuiDocument = {
      ...doc,
      layers: Array.from({ length: RESOURCE_LIMITS.layers }, (_, index) => ({
        ...doc.layers[0]!,
        id: `l${index}`,
      })),
    };
    expect(() => addLayer(full)).toThrow(/layers cannot exceed/u);
  });
  it("appends on top and activates the new layer", () => {
    const next = addLayer(doc, { idGen: sequentialIdGen("n"), name: "Overlay" });
    expect(names(next)).toEqual(["Layer 1", "Overlay"]);
    expect(next.activeLayerId).toBe("n1");
  });

  it("can insert at a specific index and leave the active layer alone", () => {
    const next = addLayer(doc, { idGen: sequentialIdGen("n"), index: 0, activate: false });
    expect(next.layers[0]?.id).toBe("n1");
    expect(next.activeLayerId).toBe(base);
  });

  it("clamps an out-of-range index", () => {
    const low = addLayer(doc, { idGen: sequentialIdGen("a"), index: -5 });
    expect(low.layers[0]?.id).toBe("a1");
    const high = addLayer(doc, { idGen: sequentialIdGen("b"), index: 99 });
    expect(high.layers[high.layers.length - 1]?.id).toBe("b1");
  });

  it("works with no options at all, generating a real id and a default name", () => {
    const next = addLayer(doc);
    expect(next.layers).toHaveLength(2);
    expect(next.layers[1]?.name).toBe("Layer 2");
    // Falls back to crypto.randomUUID rather than a test counter.
    expect(next.layers[1]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(next.activeLayerId).toBe(next.layers[1]?.id);
  });

  it("creates a layer with no cells and no optional flags", () => {
    const next = addLayer(doc, { idGen: sequentialIdGen("n") });
    expect(next.layers[1]?.cells).toEqual({});
    expect(serialize(next)).not.toContain("excludeFromHandoff");
  });
});

describe("duplicateLayer", () => {
  beforeEach(() => {
    doc = drawText(doc, base, 0, 0, "hi", STYLE);
  });

  it("inserts the copy directly above the original", () => {
    const next = duplicateLayer(doc, base, { idGen: sequentialIdGen("c") });
    expect(names(next)).toEqual(["Layer 1", "Layer 1 copy"]);
    expect(next.layers[1]?.id).toBe("c1");
    expect(next.activeLayerId).toBe("c1");
  });

  it("copies the cell content", () => {
    const next = duplicateLayer(doc, base, { idGen: sequentialIdGen("c") });
    expect(next.layers[1]?.cells).toEqual(doc.layers[0]?.cells);
  });

  it("shares the cell map by reference until the copy is edited", () => {
    // Layers are immutable, so an unedited duplicate costs nothing.
    const next = duplicateLayer(doc, base, { idGen: sequentialIdGen("c") });
    expect(next.layers[1]?.cells).toBe(doc.layers[0]?.cells);
    // Editing the copy must not disturb the original.
    const edited = drawText(next, "c1", 1, 0, "yo", STYLE);
    expect(findLayer(edited, base)?.cells).toEqual(doc.layers[0]?.cells);
    expect(Object.keys(findLayer(edited, "c1")?.cells ?? {})).toHaveLength(4);
  });

  it("works with no options, generating a real id", () => {
    const next = duplicateLayer(doc, base);
    expect(next.layers).toHaveLength(2);
    expect(next.layers[1]?.name).toBe("Layer 1 copy");
    expect(next.layers[1]?.id).not.toBe(base);
    expect(next.activeLayerId).toBe(next.layers[1]?.id);
  });

  it("can leave the active layer alone and take an explicit name", () => {
    const next = duplicateLayer(doc, base, {
      idGen: sequentialIdGen("c"),
      name: "Backup",
      activate: false,
    });
    expect(next.layers[1]?.name).toBe("Backup");
    expect(next.activeLayerId).toBe(base);
  });

  it("is a no-op for an unknown layer", () => {
    expect(duplicateLayer(doc, "nope")).toBe(doc);
  });

  it("enforces layer, id, and name budgets", () => {
    const full: TuiDocument = {
      ...doc,
      layers: Array.from({ length: RESOURCE_LIMITS.layers }, (_, index) => ({
        ...doc.layers[0]!,
        id: index === 0 ? base : `l${index}`,
      })),
    };
    expect(() => duplicateLayer(full, base)).toThrow(/layers cannot exceed/u);
    expect(() => duplicateLayer(doc, base, { idGen: () => "i".repeat(257) })).toThrow(
      /id exceeds/u,
    );
    expect(() => duplicateLayer(doc, base, { name: "n".repeat(1025) })).toThrow(/name exceeds/u);
  });
});

describe("removeLayer", () => {
  it("refuses to delete the only layer", () => {
    // A document with no layers has no valid activeLayerId and nothing to draw on.
    expect(removeLayer(doc, base)).toBe(doc);
    expect(doc.layers).toHaveLength(1);
  });

  it("deletes a layer and keeps the rest by reference", () => {
    const three = addLayer(addLayer(doc, { idGen: sequentialIdGen("b") }), {
      idGen: sequentialIdGen("c"),
    });
    const next = removeLayer(three, "b1");
    expect(next.layers.map((l) => l.id)).toEqual([base, "c1"]);
    expect(next.layers[0]).toBe(three.layers[0]);
  });

  it("moves the active layer down when the active one is deleted", () => {
    const two = addLayer(doc, { idGen: sequentialIdGen("b") }); // active = b1, index 1
    const next = removeLayer(two, "b1");
    expect(next.activeLayerId).toBe(base);
  });

  it("moves the active layer up when the bottom layer is deleted", () => {
    let two = addLayer(doc, { idGen: sequentialIdGen("b"), activate: false });
    two = setActiveLayer(two, base); // active = the bottom layer
    const next = removeLayer(two, base);
    expect(next.layers.map((l) => l.id)).toEqual(["b1"]);
    expect(next.activeLayerId).toBe("b1");
  });

  it("leaves the active layer alone when deleting a different one", () => {
    const two = addLayer(doc, { idGen: sequentialIdGen("b") });
    expect(removeLayer(two, base).activeLayerId).toBe("b1");
  });

  it("is a no-op for an unknown layer", () => {
    const two = addLayer(doc, { idGen: sequentialIdGen("b") });
    expect(removeLayer(two, "nope")).toBe(two);
  });
});

describe("moveLayer", () => {
  let three: TuiDocument;

  beforeEach(() => {
    three = addLayer(addLayer(doc, { idGen: sequentialIdGen("b") }), {
      idGen: sequentialIdGen("c"),
    });
    // order: [base, b1, c1]
  });

  it("moves a layer to the given index", () => {
    expect(moveLayer(three, "c1", 0).layers.map((l) => l.id)).toEqual(["c1", base, "b1"]);
    expect(moveLayer(three, base, 2).layers.map((l) => l.id)).toEqual(["b1", "c1", base]);
    expect(moveLayer(three, base, 1).layers.map((l) => l.id)).toEqual(["b1", base, "c1"]);
  });

  it("clamps the target index", () => {
    expect(moveLayer(three, base, 99).layers.map((l) => l.id)).toEqual(["b1", "c1", base]);
    expect(moveLayer(three, "c1", -3).layers.map((l) => l.id)).toEqual(["c1", base, "b1"]);
  });

  it("is a no-op when the order would not change, or the layer is unknown", () => {
    expect(moveLayer(three, base, 0)).toBe(three);
    expect(moveLayer(three, "nope", 0)).toBe(three);
  });

  it("does not change which layer is active", () => {
    expect(moveLayer(three, "c1", 0).activeLayerId).toBe(three.activeLayerId);
  });

  it("changes compositing order", () => {
    let d = drawText(three, base, 0, 0, "AAAA", STYLE);
    d = drawText(d, "c1", 0, 0, "bb", STYLE);
    expect(toText(d)).toBe("bbAA\n\n");
    expect(toText(moveLayer(d, "c1", 0))).toBe("AAAA\n\n");
  });
});

describe("flag setters", () => {
  it("rename, visible, and locked each return the same doc when unchanged", () => {
    expect(renameLayer(doc, base, "Layer 1")).toBe(doc);
    expect(setLayerVisible(doc, base, true)).toBe(doc);
    expect(setLayerLocked(doc, base, false)).toBe(doc);
  });

  it("applies changes", () => {
    expect(renameLayer(doc, base, "Sidebar").layers[0]?.name).toBe("Sidebar");
    expect(setLayerVisible(doc, base, false).layers[0]?.visible).toBe(false);
    expect(setLayerLocked(doc, base, true).layers[0]?.locked).toBe(true);
  });

  it("is a no-op for an unknown layer", () => {
    expect(renameLayer(doc, "nope", "x")).toBe(doc);
    expect(setLayerVisible(doc, "nope", false)).toBe(doc);
    expect(setLayerLocked(doc, "nope", true)).toBe(doc);
    expect(setExcludeFromHandoff(doc, "nope", true)).toBe(doc);
  });
});

describe("setExcludeFromHandoff", () => {
  it("sets the flag and clears it by deleting the property", () => {
    const on = setExcludeFromHandoff(doc, base, true);
    expect(on.layers[0]?.excludeFromHandoff).toBe(true);
    expect(serialize(on)).toContain("excludeFromHandoff");

    const off = setExcludeFromHandoff(on, base, false);
    expect(off.layers[0]).not.toHaveProperty("excludeFromHandoff");
    // Toggling on then off must be byte-identical to never having touched it:
    // absent optional flags stay absent.
    expect(serialize(off)).toBe(serialize(doc));
  });

  it("is a no-op when already in the requested state", () => {
    expect(setExcludeFromHandoff(doc, base, false)).toBe(doc);
    const on = setExcludeFromHandoff(doc, base, true);
    expect(setExcludeFromHandoff(on, base, true)).toBe(on);
  });
});

describe("setActiveLayer", () => {
  it("switches to an existing layer", () => {
    const two = addLayer(doc, { idGen: sequentialIdGen("b"), activate: false });
    expect(setActiveLayer(two, "b1").activeLayerId).toBe("b1");
  });

  it("is a no-op for an unknown layer or the current one", () => {
    expect(setActiveLayer(doc, "nope")).toBe(doc);
    expect(setActiveLayer(doc, base)).toBe(doc);
  });
});

describe("mergeDown", () => {
  let two: TuiDocument;

  beforeEach(() => {
    two = addLayer(doc, { idGen: sequentialIdGen("b"), name: "Top" });
    two = drawText(two, base, 0, 0, "aaaa", STYLE);
    two = drawText(two, "b1", 0, 1, "BB", STYLE);
  });

  it("lets the upper layer win where both are painted", () => {
    const merged = mergeDown(two, "b1");
    expect(merged.layers).toHaveLength(1);
    expect(toText(merged)).toBe("aBBa\n\n");
  });

  it("keeps the lower layer's identity, name, and flags", () => {
    // So activeLayerId and any handoff exclusion survive the merge.
    const flagged = setExcludeFromHandoff(two, base, true);
    const merged = mergeDown(flagged, "b1");
    expect(merged.layers[0]?.id).toBe(base);
    expect(merged.layers[0]?.name).toBe("Layer 1");
    expect(merged.layers[0]?.excludeFromHandoff).toBe(true);
  });

  it("reassigns the active layer when the merged-away layer was active", () => {
    expect(two.activeLayerId).toBe("b1");
    expect(mergeDown(two, "b1").activeLayerId).toBe(base);
  });

  it("is a no-op on the bottom layer and for an unknown layer", () => {
    expect(mergeDown(two, base)).toBe(two);
    expect(mergeDown(two, "nope")).toBe(two);
  });

  it("is a no-op when either layer is locked", () => {
    const lockedUpper = setLayerLocked(two, "b1", true);
    expect(mergeDown(lockedUpper, "b1")).toBe(lockedUpper);
    const lockedLower = setLayerLocked(two, base, true);
    expect(mergeDown(lockedLower, "b1")).toBe(lockedLower);
  });

  it("merges hidden content, making it visible — the documented behavior", () => {
    // A layer's cells are its content; `visible` is a view flag. The GUI is
    // expected to confirm before merging a hidden layer.
    const hidden = setLayerVisible(two, "b1", false);
    expect(toText(hidden)).toBe("aaaa\n\n");
    expect(toText(mergeDown(hidden, "b1"))).toBe("aBBa\n\n");
  });

  it("only touches the two merged layers", () => {
    const three = addLayer(two, { idGen: sequentialIdGen("c"), name: "Extra" });
    const merged = mergeDown(three, "b1");
    expect(merged.layers.map((l) => l.name)).toEqual(["Layer 1", "Extra"]);
    expect(merged.layers[1]).toBe(three.layers[2]);
  });
});

describe("document invariants", () => {
  it("always keeps at least one layer through any sequence of removals", () => {
    let d = addLayer(addLayer(doc, { idGen: sequentialIdGen("b") }), {
      idGen: sequentialIdGen("c"),
    });
    for (const id of [...d.layers.map((l) => l.id)]) d = removeLayer(d, id);
    expect(d.layers.length).toBeGreaterThanOrEqual(1);
  });

  it("always keeps activeLayerId pointing at a real layer", () => {
    let d = addLayer(addLayer(doc, { idGen: sequentialIdGen("b") }), {
      idGen: sequentialIdGen("c"),
    });
    const check = (label: string) =>
      expect(
        d.layers.some((l) => l.id === d.activeLayerId),
        `${label}: activeLayerId ${d.activeLayerId} is dangling`,
      ).toBe(true);

    check("initial");
    d = removeLayer(d, d.activeLayerId);
    check("after removing active");
    d = mergeDown(d, d.layers[d.layers.length - 1]?.id ?? "");
    check("after merge");
    d = moveLayer(d, d.activeLayerId, 0);
    check("after move");
  });

  it("survives a file round-trip after structural edits", () => {
    let d = addLayer(doc, { idGen: sequentialIdGen("b"), name: "Top" });
    d = setExcludeFromHandoff(d, "b1", true);
    d = setLayerLocked(d, base, true);
    d = renameLayer(d, base, "Background");
    expect(deserialize(serialize(d)).doc).toEqual(d);
  });
});
