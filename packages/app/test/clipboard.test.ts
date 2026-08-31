/**
 * Clipboard: copy, cut, and the floating paste placement.
 *
 * Mostly driven through the controller rather than the bare reducer, because the
 * interesting failures here are wiring — a `set-clipboard` effect that reaches no
 * store, or a paste that commits per pointer-move — and those are invisible to a
 * pure-reducer test.
 */

import {
  createDocument,
  drawText,
  sequentialIdGen,
  type TuiDocument,
  toText,
} from "@tui-designer/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { CellMetrics, CellPos, GridSize, Viewport } from "../src/canvas/metrics.js";
import {
  createGestureController,
  type GestureController,
  type PointerEventLike,
} from "../src/gestures/controller.js";
import { type GestureContext, NO_MODS, reduceGesture } from "../src/gestures/gesture.js";
import { createDocumentStore } from "../src/stores/document-store.js";
import { DEFAULT_BRUSH, useToolStore } from "../src/stores/tool-store.js";

const M: CellMetrics = {
  cellW: 8,
  cellH: 16,
  dpr: 1,
  baselineY: 12,
  font: { family: "Menlo", sizePx: 14, lineHeightFactor: 1.2 },
};
const COLS = 20;
const ROWS = 6;
const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;

let documentStore: ReturnType<typeof createDocumentStore>;
let controller: GestureController;
let scratch: TuiDocument | null;
let dragRect: unknown;

const pointerAt = (row: number, col: number, over: Partial<PointerEventLike> = {}) => ({
  x: col * M.cellW + 1,
  y: row * M.cellH + 1,
  button: 0,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...over,
});

const rendered = (): TuiDocument => scratch ?? documentStore.getState().history.present;
const line = (n: number, doc = documentStore.getState().history.present): string =>
  toText(doc).split("\n")[n] ?? "";
const past = (): number => documentStore.getState().history.past.length;

/** Seeds "AB" at row 1, cols 2-3 — the thing every test copies. */
function seed(): void {
  const base = documentStore.getState().history.present;
  documentStore.getState().load(drawText(base, base.activeLayerId, 1, 2, "AB", STYLE), null);
}

function lockLayers(): void {
  const d = documentStore.getState().history.present;
  documentStore
    .getState()
    .load({ ...d, layers: d.layers.map((l) => ({ ...l, locked: true })) }, null);
}

beforeEach(() => {
  documentStore = createDocumentStore(createDocument(COLS, ROWS, { idGen: sequentialIdGen() }));
  scratch = null;
  dragRect = null;
  useToolStore.setState({
    activeTool: "select",
    brush: { ...DEFAULT_BRUSH, char: "#" },
    lineStyle: "light",
    selection: null,
    clipboard: null,
    lockFlashAt: null,
  });

  const viewport: Viewport = {
    scrollX: 0,
    scrollY: 0,
    widthPx: COLS * M.cellW,
    heightPx: ROWS * M.cellH,
    zoom: 1,
  };
  controller = createGestureController({
    documentStore,
    toolStore: useToolStore,
    geometry: () => ({ metrics: M, viewport, size: { cols: COLS, rows: ROWS } as GridSize }),
    setScratch: (next) => {
      scratch = next;
    },
    setDragRect: (rect) => {
      dragRect = rect;
    },
    setCaret: () => {},
    now: () => 1000,
  });
});

describe("copy", () => {
  it("does nothing without a selection", () => {
    controller.clipboard("copy");
    expect(useToolStore.getState().clipboard).toBeNull();
  });

  it("captures the selected region", () => {
    seed();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("copy");

    const clip = useToolStore.getState().clipboard;
    expect(clip).not.toBeNull();
    expect(clip?.rows).toBe(1);
    expect(clip?.cols).toBe(2);
    // Keys are relative to the clipboard's own origin, not the document's.
    expect(Object.keys(clip?.cells ?? {}).sort()).toEqual(["0,0", "0,1"]);
  });

  it("adds no history entry and changes no cell", () => {
    seed();
    const before = documentStore.getState().history.present;
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("copy");
    expect(documentStore.getState().history.present).toBe(before);
    expect(past()).toBe(0);
  });

  it("is allowed on a locked layer, because reading is not editing", () => {
    seed();
    lockLayers();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("copy");
    expect(useToolStore.getState().clipboard?.cells["0,0"]?.char).toBe("A");
    expect(useToolStore.getState().lockFlashAt).toBeNull();
  });
});

describe("cut", () => {
  it("clears the region and fills the clipboard in one history entry", () => {
    seed();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("cut");

    expect(line(1)).toBe("");
    expect(useToolStore.getState().clipboard?.cols).toBe(2);
    expect(past()).toBe(1);
  });

  it("does nothing without a selection", () => {
    seed();
    controller.clipboard("cut");
    expect(line(1)).toBe("  AB");
    expect(past()).toBe(0);
  });

  it("refuses on a locked layer and flashes instead", () => {
    seed();
    lockLayers();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("cut");

    expect(line(1)).toBe("  AB");
    expect(useToolStore.getState().clipboard).toBeNull();
    expect(useToolStore.getState().lockFlashAt).not.toBeNull();
  });
});

describe("paste placement", () => {
  /** Copies "AB" and moves the pointer to (4,10), leaving a paste armed there. */
  function armedAt(row: number, col: number): void {
    seed();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("copy");
    controller.onPointerMove(pointerAt(row, col));
    controller.clipboard("paste");
  }

  it("does nothing when the clipboard is empty", () => {
    controller.clipboard("paste");
    expect(scratch).toBeNull();
    expect(dragRect).toBeNull();
  });

  it("does nothing when the clipboard holds no cells", () => {
    // Copying a region of untouched cells yields an extent but no cells; arming a
    // placement for it would capture the pointer with nothing to show.
    useToolStore.getState().setSelection({ top: 4, left: 4, rows: 2, cols: 2 });
    controller.clipboard("copy");
    expect(useToolStore.getState().clipboard).not.toBeNull();
    controller.clipboard("paste");
    expect(scratch).toBeNull();
  });

  it("previews under the pointer without committing", () => {
    armedAt(4, 10);
    expect(line(4, rendered())).toBe("          AB");
    expect(dragRect).toEqual({ top: 4, left: 10, rows: 1, cols: 2 });
    // Still a preview: nothing in history, and the stored document is untouched.
    expect(past()).toBe(0);
    expect(line(4)).toBe("");
  });

  it("follows the pointer, previewing only the latest position", () => {
    armedAt(4, 10);
    controller.onPointerMove(pointerAt(2, 6));
    expect(line(2, rendered())).toBe("      AB");
    // The earlier preview position is gone rather than accumulated.
    expect(line(4, rendered())).toBe("");
    expect(past()).toBe(0);
  });

  it("drops on press as one history entry, and selects what landed", () => {
    armedAt(4, 10);
    controller.onPointerDown(pointerAt(4, 10));

    expect(line(4)).toBe("          AB");
    expect(past()).toBe(1);
    expect(useToolStore.getState().selection).toEqual({ top: 4, left: 10, rows: 1, cols: 2 });
    expect(scratch).toBeNull();

    // One undo removes the whole paste.
    documentStore.getState().undo();
    expect(line(4)).toBe("");
  });

  it("is inert on the release that follows the press", () => {
    armedAt(4, 10);
    controller.onPointerDown(pointerAt(4, 10));
    controller.onPointerUp(pointerAt(4, 10));
    // The press committed and returned to idle, so the release must not commit a
    // second time.
    expect(past()).toBe(1);
  });

  it("stays armed through a release left over from before the paste", () => {
    // Reachable sequence: press (starting a marquee), then ⌘V while the button is
    // still held, then release. The stray release must not drop the block —
    // nothing has aimed it yet.
    seed();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("copy");
    controller.onPointerDown(pointerAt(4, 10));
    controller.clipboard("paste");
    controller.onPointerUp(pointerAt(4, 10));

    expect(past()).toBe(0);
    expect(controller.isActive()).toBe(true);
    // Still placeable: a real press afterwards drops it.
    controller.onPointerDown(pointerAt(3, 3));
    expect(line(3)).toBe("   AB");
    expect(past()).toBe(1);
  });

  it("abandons on Esc, writing nothing", () => {
    armedAt(4, 10);
    controller.cancel();

    expect(scratch).toBeNull();
    expect(dragRect).toBeNull();
    expect(line(4)).toBe("");
    expect(past()).toBe(0);
  });

  it("undo cancels an armed paste before undoing the previous edit", () => {
    seed();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("cut");
    expect(line(1)).toBe("");
    controller.onPointerMove(pointerAt(4, 10));
    controller.clipboard("paste");
    expect(controller.isActive()).toBe(true);
    expect(scratch).not.toBeNull();

    controller.history("undo");

    expect(controller.isActive()).toBe(false);
    expect(scratch).toBeNull();
    expect(dragRect).toBeNull();
    expect(line(1)).toBe("  AB");
    expect(line(4)).toBe("");
  });

  it("refuses on a locked layer", () => {
    seed();
    useToolStore.getState().setSelection({ top: 1, left: 2, rows: 1, cols: 2 });
    controller.clipboard("copy");
    lockLayers();
    controller.clipboard("paste");

    expect(scratch).toBeNull();
    expect(useToolStore.getState().lockFlashAt).not.toBeNull();
  });

  it("owns the pointer whatever the active tool", () => {
    // ⌘V arms a paste from any tool, so the placement must not be routed into the
    // active tool's reducer — with Pencil active, a press would otherwise paint.
    armedAt(4, 10);
    useToolStore.getState().setTool("pencil");
    controller.onPointerMove(pointerAt(3, 3));
    expect(line(3, rendered())).toBe("   AB");

    controller.onPointerDown(pointerAt(3, 3));
    expect(line(3)).toBe("   AB");
    // A pencil stroke would have written the brush "#" instead.
    expect(line(3)).not.toContain("#");
  });

  it("survives a round trip: the pasted block matches the copied one", () => {
    armedAt(4, 10);
    controller.onPointerDown(pointerAt(4, 10));
    const doc = documentStore.getState().history.present;
    expect(line(1, doc)).toBe("  AB");
    expect(line(4, doc)).toBe("          AB");
  });
});

describe("paste anchor fallbacks", () => {
  const context = (over: Partial<GestureContext> = {}): GestureContext => {
    const base = drawText(
      createDocument(COLS, ROWS, { idGen: sequentialIdGen() }),
      "layer-1",
      1,
      2,
      "AB",
      STYLE,
    );
    return {
      base,
      layerId: base.activeLayerId,
      brush: DEFAULT_BRUSH,
      lineStyle: "light",
      selection: null,
      clipboard: { rows: 1, cols: 2, cells: { "0,0": { char: "A", ...STYLE } } },
      hover: null,
      ...over,
    };
  };

  const anchorOf = (ctx: GestureContext): CellPos | undefined => {
    const step = reduceGesture(
      "select",
      { kind: "idle" },
      { t: "clipboard", action: "paste" },
      ctx,
    );
    return step.state.kind === "paste" ? step.state.at : undefined;
  };

  it("prefers the cell under the pointer", () => {
    expect(anchorOf(context({ hover: { row: 3, col: 7 } }))).toEqual({ row: 3, col: 7 });
  });

  it("falls back to the selection's corner when the pointer is off-canvas", () => {
    const ctx = context({ hover: null, selection: { top: 2, left: 5, rows: 1, cols: 1 } });
    expect(anchorOf(ctx)).toEqual({ row: 2, col: 5 });
  });

  it("falls back to the origin when there is neither", () => {
    expect(anchorOf(context())).toEqual({ row: 0, col: 0 });
  });

  it("keeps the pointer's cell over the selection's, so a re-paste can be aimed", () => {
    const ctx = context({
      hover: { row: 4, col: 1 },
      selection: { top: 2, left: 5, rows: 1, cols: 1 },
    });
    expect(anchorOf(ctx)).toEqual({ row: 4, col: 1 });
  });
});

describe("copy/paste keeps the reducer's commit discipline", () => {
  it("emits no commit on a paste move, only on the press", () => {
    const base = createDocument(COLS, ROWS, { idGen: sequentialIdGen() });
    const ctx: GestureContext = {
      base,
      layerId: base.activeLayerId,
      brush: DEFAULT_BRUSH,
      lineStyle: "light",
      selection: null,
      clipboard: { rows: 1, cols: 1, cells: { "0,0": { char: "Z", ...STYLE } } },
      hover: { row: 1, col: 1 },
    };
    const armed = reduceGesture(
      "select",
      { kind: "idle" },
      { t: "clipboard", action: "paste" },
      ctx,
    );
    const moved = reduceGesture(
      "select",
      armed.state,
      { t: "move", cell: { row: 2, col: 2 }, mods: NO_MODS },
      ctx,
    );
    expect(moved.effects.some((e) => e.t === "commit")).toBe(false);

    const dropped = reduceGesture(
      "select",
      moved.state,
      { t: "down", cell: { row: 2, col: 2 }, mods: NO_MODS, button: 0 },
      ctx,
    );
    expect(dropped.effects.filter((e) => e.t === "commit")).toHaveLength(1);
    expect(dropped.state.kind).toBe("idle");
  });
});
