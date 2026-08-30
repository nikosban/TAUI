/**
 * End-to-end gesture tests through the real stores.
 *
 * This is the G2 acceptance criterion in headless form: draw two overlapping
 * boxes, assert the junction merges *in the drag preview before release*, and
 * assert one undo removes the whole box. Only the pointer events are synthesised.
 */

import { createDocument, sequentialIdGen, type TuiDocument, toText } from "@tui-designer/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { CellMetrics, GridSize, Viewport } from "../src/canvas/metrics.js";
import {
  createGestureController,
  type GestureController,
  type PointerEventLike,
} from "../src/gestures/controller.js";
import { NO_MODS } from "../src/gestures/gesture.js";
import { createDocumentStore, type DocumentState } from "../src/stores/document-store.js";
import { DEFAULT_BRUSH, useToolStore } from "../src/stores/tool-store.js";

const M: CellMetrics = {
  cellW: 8,
  cellH: 16,
  dpr: 1,
  baselineY: 12,
  font: { family: "Menlo", sizePx: 14, lineHeightFactor: 1.2 },
};

const DOC_COLS = 24;
const DOC_ROWS = 10;

let documentStore: ReturnType<typeof createDocumentStore>;
let controller: GestureController;
let scratch: TuiDocument | null;
let dragRect: unknown;
let clock: number;

/** Pointer event at a cell's top-left corner plus a nudge, so it lands inside. */
function pointerAt(
  row: number,
  col: number,
  over: Partial<PointerEventLike> = {},
): PointerEventLike {
  return {
    x: col * M.cellW + 1,
    y: row * M.cellH + 1,
    button: 0,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...over,
  };
}

/** What the canvas would render right now: scratch if present, else the present. */
const rendered = (): TuiDocument => scratch ?? documentStore.getState().history.present;

beforeEach(() => {
  documentStore = createDocumentStore(
    createDocument(DOC_COLS, DOC_ROWS, { idGen: sequentialIdGen() }),
  );
  scratch = null;
  dragRect = null;
  clock = 0;
  useToolStore.setState({
    activeTool: "box",
    brush: { ...DEFAULT_BRUSH, char: "#" },
    lineStyle: "light",
    selection: null,
    clipboard: null,
    lockFlashAt: null,
  });

  const viewport: Viewport = {
    scrollX: 0,
    scrollY: 0,
    widthPx: DOC_COLS * M.cellW,
    heightPx: DOC_ROWS * M.cellH,
    zoom: 1,
  };
  const size: GridSize = { cols: DOC_COLS, rows: DOC_ROWS };

  controller = createGestureController({
    documentStore,
    toolStore: useToolStore,
    geometry: () => ({ metrics: M, viewport, size }),
    setScratch: (doc) => {
      scratch = doc;
    },
    setDragRect: (rect) => {
      dragRect = rect;
    },
    // The text tool's caret is exercised in test/text.test.ts; the drawing tools
    // never set it.
    setCaret: () => {},
    now: () => ++clock,
  });
});

/** Drags from one cell to another, invoking the intermediate move. */
function drag(
  from: [number, number],
  to: [number, number],
  over: Partial<PointerEventLike> = {},
): void {
  controller.onPointerDown(pointerAt(from[0], from[1], over));
  controller.onPointerMove(pointerAt(to[0], to[1], over));
  controller.onPointerUp(pointerAt(to[0], to[1], over));
}

describe("the G2 acceptance criterion", () => {
  it("merges the junction in the drag preview, before release", () => {
    // First box, committed.
    drag([0, 0], [3, 5]);
    expect(toText(documentStore.getState().history.present)).toContain("┌────┐");

    // Second box: press and move, but do NOT release.
    controller.onPointerDown(pointerAt(0, 5));
    controller.onPointerMove(pointerAt(3, 10));

    // The preview must already show merged T-junctions — this is the whole point
    // of previewing from a scratch document rather than approximating.
    const preview = toText(rendered());
    expect(preview.split("\n")[0]).toBe("┌────┬────┐");
    expect(preview.split("\n")[3]).toBe("└────┴────┘");

    // And it must not have been committed yet.
    expect(documentStore.getState().history.past).toHaveLength(1);
    expect(toText(documentStore.getState().history.present)).not.toContain("┬");

    // Release commits exactly what was previewed.
    controller.onPointerUp(pointerAt(3, 10));
    expect(toText(documentStore.getState().history.present)).toBe(toText(rendered()));
    expect(documentStore.getState().history.past).toHaveLength(2);
  });

  it("undoes the whole box with a single undo", () => {
    drag([0, 0], [3, 5]);
    drag([0, 5], [3, 10]);
    expect(toText(documentStore.getState().history.present).split("\n")[0]).toBe("┌────┬────┐");

    documentStore.getState().undo();
    // One undo removes the entire second box, not one cell of it.
    expect(toText(documentStore.getState().history.present).split("\n")[0]).toBe("┌────┐");

    documentStore.getState().undo();
    expect(toText(documentStore.getState().history.present).trim()).toBe("");
    expect(documentStore.getState().canUndo()).toBe(false);
  });

  it("adds exactly one history entry per drag, however many moves it contains", () => {
    controller.onPointerDown(pointerAt(1, 1));
    for (let col = 2; col < 12; col++) controller.onPointerMove(pointerAt(4, col));
    controller.onPointerUp(pointerAt(4, 11));
    expect(documentStore.getState().history.past).toHaveLength(1);
  });
});

describe("preview lifecycle", () => {
  it("clears the scratch on commit", () => {
    drag([0, 0], [2, 4]);
    expect(scratch).toBeNull();
  });

  it("discards the scratch on cancel, leaving the document untouched", () => {
    const before = toText(documentStore.getState().history.present);
    controller.onPointerDown(pointerAt(0, 0));
    controller.onPointerMove(pointerAt(4, 8));
    expect(toText(rendered())).not.toBe(before); // preview is showing

    controller.cancel();
    expect(scratch).toBeNull();
    expect(toText(documentStore.getState().history.present)).toBe(before);
    expect(documentStore.getState().canUndo()).toBe(false);
  });

  it("settles a document replacement by cancelling its pointer preview", () => {
    const before = documentStore.getState().history.present;
    controller.onPointerDown(pointerAt(0, 0));
    controller.onPointerMove(pointerAt(4, 8));
    expect(scratch).not.toBeNull();

    controller.settleDocumentReplacement();

    expect(scratch).toBeNull();
    expect(dragRect).toBeNull();
    expect(controller.isActive()).toBe(false);
    expect(documentStore.getState().history.present).toBe(before);
  });

  it("keeps the preview derived from the committed present, not the last preview", () => {
    // Sweeping out and back must leave the small box, not a compound of both.
    controller.onPointerDown(pointerAt(0, 0));
    controller.onPointerMove(pointerAt(6, 20));
    controller.onPointerMove(pointerAt(2, 4));
    controller.onPointerUp(pointerAt(2, 4));
    const text = toText(documentStore.getState().history.present);
    expect(text.split("\n")[0]).toBe("┌───┐");
    expect(text).not.toContain("─────");
  });
});

describe("tools", () => {
  it("pencil paints a continuous stroke even when the pointer jumps", () => {
    useToolStore.getState().setTool("pencil");
    controller.onPointerDown(pointerAt(2, 0));
    controller.onPointerMove(pointerAt(2, 9)); // one big jump
    controller.onPointerUp(pointerAt(2, 9));
    // Interpolation fills the gap, so this is a line rather than two dots.
    expect(toText(documentStore.getState().history.present).split("\n")[2]).toBe("##########");
  });

  it("pencil with Shift constrains the stroke to one axis", () => {
    useToolStore.getState().setTool("pencil");
    drag([3, 1], [6, 8], { shiftKey: true });
    const lines = toText(documentStore.getState().history.present).split("\n");
    expect(lines[3]).toBe(" ########");
    expect(lines[6] ?? "").toBe("");
  });

  it("line snaps to the dominant axis", () => {
    useToolStore.getState().setTool("line");
    drag([2, 1], [4, 9]); // dCol 8 > dRow 2, so horizontal
    const lines = toText(documentStore.getState().history.present).split("\n");
    expect(lines[2]).toBe(" ╶───────╴");
    expect(lines[4] ?? "").toBe("");
  });

  it("Alt suppresses merging for the gesture", () => {
    drag([0, 0], [3, 5]);
    drag([0, 5], [3, 10], { altKey: true });
    // Column 5 is overwritten blindly, so no T-junction forms.
    expect(toText(documentStore.getState().history.present).split("\n")[0]).toBe("┌────┌────┐");
  });

  it("select drags a marquee without committing anything", () => {
    useToolStore.getState().setTool("select");
    drag([1, 2], [4, 8]);
    expect(documentStore.getState().canUndo()).toBe(false);
    expect(useToolStore.getState().selection).toEqual({ top: 1, left: 2, rows: 4, cols: 7 });
    expect(dragRect).toBeNull(); // cleared on release
  });

  it("select moves the region when dragged from inside the selection", () => {
    useToolStore.getState().setTool("pencil");
    drag([1, 1], [1, 3]);
    useToolStore.getState().setTool("select");
    drag([1, 1], [1, 3]); // marquee over the painted cells
    expect(useToolStore.getState().selection).toEqual({ top: 1, left: 1, rows: 1, cols: 3 });

    drag([1, 2], [3, 2]); // grab inside, drag down two rows
    const lines = toText(documentStore.getState().history.present).split("\n");
    expect(lines[1] ?? "").toBe("");
    expect(lines[3]).toBe(" ###");
    // The selection follows the region, so a second drag works.
    expect(useToolStore.getState().selection).toEqual({ top: 3, left: 1, rows: 1, cols: 3 });
  });

  it("Alt+drag inside a selection duplicates instead of moving", () => {
    useToolStore.getState().setTool("pencil");
    drag([1, 1], [1, 3]);
    useToolStore.getState().setTool("select");
    drag([1, 1], [1, 3]);
    drag([1, 2], [4, 2], { altKey: true });
    const lines = toText(documentStore.getState().history.present).split("\n");
    expect(lines[1], "original must survive").toBe(" ###");
    expect(lines[4], "copy must land").toBe(" ###");
  });
});

describe("right-click eyedrop", () => {
  it("picks the cell under the cursor into the brush, from any tool", () => {
    useToolStore.getState().setTool("pencil");
    useToolStore.getState().setBrush({ char: "X", fg: { kind: "ansi16", index: 5 } });
    drag([2, 2], [2, 2]);

    useToolStore.getState().setBrush({ char: "?", fg: { kind: "default" } });
    useToolStore.getState().setTool("box");
    controller.onPointerDown(pointerAt(2, 2, { button: 2 }));

    expect(useToolStore.getState().brush.char).toBe("X");
    expect(useToolStore.getState().brush.fg).toEqual({ kind: "ansi16", index: 5 });
  });

  it("leaves the brush alone over an empty cell, and starts no gesture", () => {
    useToolStore.getState().setBrush({ char: "@" });
    controller.onPointerDown(pointerAt(5, 5, { button: 2 }));
    expect(useToolStore.getState().brush.char).toBe("@");
    expect(controller.isActive()).toBe(false);
  });
});

describe("the eyedropper tool", () => {
  /** Paints `char` at (1,1) on a second layer that is *not* the active one. */
  function paintOnOtherLayer(char: string, opts: { visible?: boolean } = {}): void {
    const base = documentStore.getState().history.present;
    const other = {
      id: "other",
      name: "other",
      visible: opts.visible ?? true,
      locked: false,
      cells: { "1,1": { char, fg: { kind: "ansi16" as const, index: 3 }, bg: DEFAULT_BRUSH.bg } },
    };
    // Appended last, so it is the topmost layer. The active layer stays the first.
    documentStore.getState().load({ ...base, layers: [...base.layers, other] }, null);
  }

  it("picks the cell under a left click into the brush", () => {
    useToolStore.getState().setTool("pencil");
    useToolStore.getState().setBrush({ char: "Q", fg: { kind: "ansi16", index: 2 } });
    drag([3, 3], [3, 3]);

    useToolStore.getState().setTool("eyedropper");
    useToolStore.getState().setBrush({ char: "?", fg: { kind: "default" } });
    controller.onPointerDown(pointerAt(3, 3));

    expect(useToolStore.getState().brush.char).toBe("Q");
    expect(useToolStore.getState().brush.fg).toEqual({ kind: "ansi16", index: 2 });
  });

  it("samples the topmost visible layer, not the active one", () => {
    // The bug this guards: reading only the active layer means clicking content
    // you can plainly see does nothing, with no way to tell which layer it is on.
    paintOnOtherLayer("Z");
    useToolStore.getState().setTool("eyedropper");
    useToolStore.getState().setBrush({ char: "?" });
    controller.onPointerDown(pointerAt(1, 1));

    expect(useToolStore.getState().brush.char).toBe("Z");
    expect(useToolStore.getState().brush.fg).toEqual({ kind: "ansi16", index: 3 });
  });

  it("ignores a hidden layer, sampling only what is on screen", () => {
    paintOnOtherLayer("Z", { visible: false });
    useToolStore.getState().setTool("eyedropper");
    useToolStore.getState().setBrush({ char: "?" });
    controller.onPointerDown(pointerAt(1, 1));
    expect(useToolStore.getState().brush.char).toBe("?");
  });

  it("samples from a locked layer, because reading is not editing", () => {
    useToolStore.getState().setTool("pencil");
    useToolStore.getState().setBrush({ char: "K" });
    drag([4, 4], [4, 4]);

    const painted = documentStore.getState().history.present;
    documentStore
      .getState()
      .load({ ...painted, layers: painted.layers.map((l) => ({ ...l, locked: true })) }, null);

    useToolStore.getState().setTool("eyedropper");
    useToolStore.getState().setBrush({ char: "?" });
    controller.onPointerDown(pointerAt(4, 4));

    expect(useToolStore.getState().brush.char).toBe("K");
    expect(useToolStore.getState().lockFlashAt).toBeNull();
  });

  it("starts no gesture and writes nothing", () => {
    useToolStore.getState().setTool("eyedropper");
    const before = documentStore.getState().history.present;
    controller.onPointerDown(pointerAt(2, 2));
    controller.onPointerMove(pointerAt(6, 6));
    controller.onPointerUp(pointerAt(6, 6));

    expect(documentStore.getState().history.present).toBe(before);
    expect(documentStore.getState().history.past).toHaveLength(0);
    expect(controller.isActive()).toBe(false);
  });
});

describe("the fill tool", () => {
  it("floods the region under the pointer with the brush background", () => {
    useToolStore.getState().setTool("box");
    drag([0, 0], [3, 5]);
    useToolStore.getState().setTool("fill");
    useToolStore.getState().setBrush({ bg: { kind: "ansi16", index: 2 } });

    controller.onPointerDown(pointerAt(1, 1));
    // Characters are untouched — only the background changed.
    expect(toText(documentStore.getState().history.present).split("\n")[0]).toBe("┌────┐");
    const cells = documentStore.getState().history.present.layers[0]?.cells ?? {};
    expect(cells["1,1"]).toEqual({
      char: " ",
      fg: { kind: "default" },
      bg: { kind: "ansi16", index: 2 },
    });
  });

  it("fills with the whole brush cell when Shift is held", () => {
    useToolStore.getState().setTool("box");
    drag([0, 0], [3, 5]);
    useToolStore.getState().setTool("fill");
    useToolStore.getState().setBrush({ char: "▒" });

    controller.onPointerDown(pointerAt(1, 1, { shiftKey: true }));
    expect(toText(documentStore.getState().history.present).split("\n")[1]).toBe("│▒▒▒▒│");
  });

  it("is one history entry, and does nothing on move or up", () => {
    useToolStore.getState().setTool("fill");
    useToolStore.getState().setBrush({ bg: { kind: "ansi16", index: 3 } });
    controller.onPointerDown(pointerAt(2, 2));
    controller.onPointerMove(pointerAt(3, 3));
    controller.onPointerUp(pointerAt(3, 3));
    expect(documentStore.getState().history.past).toHaveLength(1);
  });

  it("adds no history entry when the brush background is the default", () => {
    // The reported bug: clicking Fill with an untouched brush appeared to do
    // nothing *and* consumed an undo step. Recolouring default-over-transparent
    // now changes nothing at all, so there is no entry to undo.
    useToolStore.getState().setTool("fill");
    expect(useToolStore.getState().brush.bg).toEqual({ kind: "default" });
    controller.onPointerDown(pointerAt(2, 2));
    expect(documentStore.getState().canUndo()).toBe(false);
    expect(documentStore.getState().revision).toBe(0);
  });

  it("flashes the lock instead of filling a locked layer", () => {
    const base = documentStore.getState().history.present;
    documentStore
      .getState()
      .load({ ...base, layers: base.layers.map((l) => ({ ...l, locked: true })) }, null);
    useToolStore.getState().setTool("fill");
    controller.onPointerDown(pointerAt(1, 1));
    expect(documentStore.getState().canUndo()).toBe(false);
    expect(useToolStore.getState().lockFlashAt).not.toBeNull();
  });
});

describe("locked layers", () => {
  it("flashes the lock instead of silently doing nothing", () => {
    const base = documentStore.getState().history.present;
    const locked: TuiDocument = {
      ...base,
      layers: base.layers.map((l) => ({ ...l, locked: true })),
    };
    documentStore.getState().load(locked, null);

    drag([0, 0], [3, 5]);
    expect(documentStore.getState().canUndo()).toBe(false);
    expect(useToolStore.getState().lockFlashAt).not.toBeNull();
  });
});

describe("hover and pointer bookkeeping", () => {
  it("reports the hovered cell, and null in the void", () => {
    controller.onPointerMove(pointerAt(3, 7));
    expect(controller.hoverCell()).toEqual({ row: 3, col: 7 });
    controller.onPointerMove({ ...pointerAt(0, 0), x: -20, y: -20 });
    expect(controller.hoverCell()).toBeNull();
  });

  it("clamps a drag that leaves the canvas rather than cancelling it", () => {
    controller.onPointerDown(pointerAt(1, 1));
    controller.onPointerMove({ ...pointerAt(0, 0), x: 99_999, y: 99_999 });
    controller.onPointerUp({ ...pointerAt(0, 0), x: 99_999, y: 99_999 });
    // Clamped to the last cell, so the box spans (1,1)..(9,23) — 23 columns wide,
    // which is a corner, 21 dashes, and a corner.
    const lines = toText(documentStore.getState().history.present).split("\n");
    expect(lines[1]).toBe(` ┌${"─".repeat(DOC_COLS - 3)}┐`);
    expect(lines[DOC_ROWS - 1]).toBe(` └${"─".repeat(DOC_COLS - 3)}┘`);
  });

  it("ignores a move or up with no gesture in progress", () => {
    controller.onPointerMove(pointerAt(2, 2));
    controller.onPointerUp(pointerAt(2, 2));
    expect(documentStore.getState().canUndo()).toBe(false);
    expect(scratch).toBeNull();
  });
});

describe("keyboard-driven edits", () => {
  it("Delete clears the selection as one undoable step", () => {
    useToolStore.getState().setTool("pencil");
    drag([2, 2], [2, 6]);
    useToolStore.getState().setSelection({ top: 2, left: 3, rows: 1, cols: 2 });

    // Stroke covers cols 2–6; clearing cols 3–4 leaves col 2, a two-cell hole,
    // then cols 5–6.
    controller.onKey("Delete", NO_MODS);
    expect(toText(documentStore.getState().history.present).split("\n")[2]).toBe("  #  ##");

    documentStore.getState().undo();
    expect(toText(documentStore.getState().history.present).split("\n")[2]).toBe("  #####");
  });

  it("Delete does nothing without a selection", () => {
    controller.onKey("Delete", NO_MODS);
    expect(documentStore.getState().canUndo()).toBe(false);
  });
});

describe("store hygiene", () => {
  it("marks the document dirty on commit and clean after markSaved", () => {
    drag([0, 0], [2, 3]);
    expect(documentStore.getState().dirty).toBe(true);
    documentStore
      .getState()
      .markSaved(
        { key: "k", label: "k", display: "k" },
        documentStore.getState().revision,
        documentStore.getState().generation,
      );
    expect(documentStore.getState().dirty).toBe(false);
  });

  it("does not mark a newer revision clean when an older save completes", () => {
    drag([0, 0], [2, 3]);
    const writtenRevision = documentStore.getState().revision;
    drag([4, 4], [5, 5]);
    const handle = { key: "k", label: "k", display: "k" };

    documentStore
      .getState()
      .markSaved(handle, writtenRevision, documentStore.getState().generation);
    expect(documentStore.getState().handle).toEqual(handle);
    expect(documentStore.getState().dirty).toBe(true);

    documentStore
      .getState()
      .markSaved(handle, documentStore.getState().revision, documentStore.getState().generation);
    expect(documentStore.getState().dirty).toBe(false);
  });

  it("ignores a save acknowledgement from a replaced document generation", () => {
    drag([0, 0], [2, 3]);
    const savedRevision = documentStore.getState().revision;
    const savedGeneration = documentStore.getState().generation;
    const replacementHandle = { key: "replacement", label: "replacement", display: "replacement" };
    documentStore
      .getState()
      .load(createDocument(DOC_COLS, DOC_ROWS, { idGen: sequentialIdGen() }), replacementHandle);

    expect(
      documentStore
        .getState()
        .markSaved(
          { key: "stale", label: "stale", display: "stale" },
          savedRevision,
          savedGeneration,
        ),
    ).toBe(false);
    expect(documentStore.getState().handle).toEqual(replacementHandle);
    expect(documentStore.getState().dirty).toBe(false);
  });

  it("bumps the revision once per commit", () => {
    const before = documentStore.getState().revision;
    drag([0, 0], [2, 3]);
    expect(documentStore.getState().revision).toBe(before + 1);
  });

  it("does not bump the revision for a gesture that changed nothing", () => {
    const state: DocumentState = documentStore.getState();
    const before = state.revision;
    useToolStore.getState().setTool("box");
    // A 1x1 box has no border to draw, so the op is a no-op.
    drag([2, 2], [2, 2]);
    expect(documentStore.getState().revision).toBe(before);
    expect(documentStore.getState().canUndo()).toBe(false);
  });
});
