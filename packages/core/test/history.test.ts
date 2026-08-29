import { beforeEach, describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  createHistory,
  type History,
  MAX_HISTORY,
  push,
  redo,
  replacePresent,
  resetHistory,
  undo,
} from "../src/history/history.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { drawText, fillRect, setCell } from "../src/ops/draw.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

let doc: TuiDocument;
let id: string;
let h: History;

beforeEach(() => {
  doc = createDocument(6, 2, { idGen: sequentialIdGen() });
  id = doc.activeLayerId;
  h = createHistory(doc);
});

/** Writes `char` at column `col` and pushes the result. */
const step = (history: History, col: number, char: string): History =>
  push(history, setCell(history.present, id, 0, col, { char, ...STYLE }));

describe("createHistory", () => {
  it("starts with nothing to undo or redo", () => {
    expect(h.past).toEqual([]);
    expect(h.future).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});

describe("push", () => {
  it("advances the present and records the old one", () => {
    const next = step(h, 0, "a");
    expect(toText(next.present)).toBe("a\n");
    expect(next.past).toEqual([doc]);
    expect(canUndo(next)).toBe(true);
  });

  it("returns the same history when the document did not change", () => {
    // The ops layer guarantees referential equality for no-ops, so an empty
    // gesture cannot pollute the stack even if the GUI pushes optimistically.
    expect(push(h, doc)).toBe(h);
    const locked: TuiDocument = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    const lockedHistory = createHistory(locked);
    const attempted = fillRect(
      locked,
      id,
      { top: 0, left: 0, rows: 1, cols: 1 },
      {
        char: "x",
        ...STYLE,
      },
    );
    expect(push(lockedHistory, attempted)).toBe(lockedHistory);
  });

  it("clears the redo branch", () => {
    let next = step(h, 0, "a");
    next = step(next, 1, "b");
    next = undo(next);
    expect(canRedo(next)).toBe(true);
    next = step(next, 2, "c");
    expect(next.future).toEqual([]);
    expect(canRedo(next)).toBe(false);
  });

  it("caps the past at MAX_HISTORY, dropping the oldest entries", () => {
    let next = h;
    for (let i = 0; i < MAX_HISTORY + 50; i++) {
      next = push(next, drawText(next.present, id, 0, 0, String(i % 10), STYLE));
    }
    expect(next.past).toHaveLength(MAX_HISTORY);
    // Recent history is what survives: the oldest retained entry must not be the
    // original empty document.
    expect(next.past[0]).not.toBe(doc);
  });

  it("keeps exactly MAX_HISTORY reachable undo steps at the cap", () => {
    let next = h;
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      next = push(next, drawText(next.present, id, 0, 0, String(i % 10), STYLE));
    }
    let steps = 0;
    while (canUndo(next)) {
      next = undo(next);
      steps++;
    }
    expect(steps).toBe(MAX_HISTORY);
  });
});

describe("undo and redo", () => {
  it("restores the exact previous document", () => {
    const next = step(h, 0, "a");
    const back = undo(next);
    expect(back.present).toBe(doc); // identity, not just equality
    expect(toText(back.present)).toBe("\n");
  });

  it("round-trips through several steps", () => {
    let next = step(h, 0, "a");
    next = step(next, 1, "b");
    next = step(next, 2, "c");
    expect(toText(next.present)).toBe("abc\n");

    next = undo(next);
    expect(toText(next.present)).toBe("ab\n");
    next = undo(next);
    expect(toText(next.present)).toBe("a\n");
    next = redo(next);
    expect(toText(next.present)).toBe("ab\n");
    next = redo(next);
    expect(toText(next.present)).toBe("abc\n");
    expect(canRedo(next)).toBe(false);
  });

  it("undoing everything returns the original document", () => {
    let next = h;
    for (const [i, char] of ["a", "b", "c", "d"].entries()) next = step(next, i, char);
    while (canUndo(next)) next = undo(next);
    expect(next.present).toBe(doc);
    expect(next.past).toEqual([]);
  });

  it("is a no-op at the ends of the stack", () => {
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("does not lose the redo branch when undoing repeatedly", () => {
    let next = step(h, 0, "a");
    next = step(next, 1, "b");
    next = undo(undo(next));
    expect(next.future).toHaveLength(2);
    next = redo(redo(next));
    expect(toText(next.present)).toBe("ab\n");
  });
});

describe("replacePresent", () => {
  it("swaps the present without adding an undo entry", () => {
    // The drag-preview path: render a scratch doc, commit only on pointer-up.
    const committed = step(h, 0, "a");
    const scratch = setCell(committed.present, id, 0, 3, { char: "?", ...STYLE });
    const previewing = replacePresent(committed, scratch);
    expect(previewing.past).toBe(committed.past);
    expect(toText(previewing.present)).toBe("a  ?\n");
    // Undo from a preview state jumps past it, to the last committed document.
    expect(toText(undo(previewing).present)).toBe("\n");
  });

  it("is a no-op for an unchanged document", () => {
    expect(replacePresent(h, doc)).toBe(h);
  });
});

describe("resetHistory", () => {
  it("drops undo and redo state but keeps the document", () => {
    let next = step(h, 0, "a");
    next = step(next, 1, "b");
    next = undo(next);
    const reset = resetHistory(next);
    expect(reset.present).toBe(next.present);
    expect(canUndo(reset)).toBe(false);
    expect(canRedo(reset)).toBe(false);
  });

  it("is a no-op when there is nothing to drop", () => {
    expect(resetHistory(h)).toBe(h);
  });
});

describe("snapshot cost", () => {
  it("shares untouched layers across history entries", () => {
    // This is what makes whole-document snapshots affordable: consecutive entries
    // share every layer the edit did not touch.
    const twoLayer: TuiDocument = {
      ...doc,
      layers: [...doc.layers, { id: "top", name: "top", visible: true, locked: false, cells: {} }],
    };
    const history = createHistory(twoLayer);
    const next = push(history, setCell(twoLayer, "top", 0, 0, { char: "x", ...STYLE }));
    expect(next.present.layers[0]).toBe(twoLayer.layers[0]);
    expect(next.past[0]).toBe(twoLayer);
  });
});
