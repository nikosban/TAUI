/**
 * Text tool: editing semantics and burst coalescing.
 *
 * The burst tests need no fake timers — `reduceBurst` takes the time as a
 * parameter, so "1 second later" is just a bigger number.
 */

import { createDocument, sequentialIdGen, type TuiDocument, toText } from "@tui-designer/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { CellMetrics, CellPos, GridSize, Viewport } from "../src/canvas/metrics.js";
import {
  createGestureController,
  type GestureController,
  type PointerEventLike,
} from "../src/gestures/controller.js";
import { NO_MODS } from "../src/gestures/gesture.js";
import { applyTextKey, isPrintable } from "../src/gestures/text.js";
import { BURST_IDLE_MS, reduceBurst } from "../src/gestures/typing-burst.js";
import { createDocumentStore } from "../src/stores/document-store.js";
import { DEFAULT_BRUSH, useToolStore } from "../src/stores/tool-store.js";

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;
const doc10 = () => createDocument(10, 4, { idGen: sequentialIdGen() });

describe("isPrintable", () => {
  it("accepts single narrow characters", () => {
    for (const key of ["a", "Z", "0", " ", "─", "│", "#"]) {
      expect(isPrintable(key), key).toBe(true);
    }
  });

  it("rejects control keys and named keys", () => {
    for (const key of [
      "Enter",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "Shift",
      "F5",
      "Escape",
      "Tab",
    ]) {
      expect(isPrintable(key), key).toBe(false);
    }
  });

  it("rejects wide characters, which cannot occupy one cell", () => {
    for (const key of ["你", "🎉"]) {
      expect(isPrintable(key), key).toBe(false);
    }
  });
});

describe("applyTextKey — overwrite mode", () => {
  const base = {
    layerId: "l1",
    origin: { row: 1, col: 2 } as CellPos,
    style: STYLE,
    insertMode: false,
  };

  it("writes the character and advances the caret", () => {
    const edit = applyTextKey({ ...base, doc: doc10(), caret: { row: 1, col: 2 }, key: "A" });
    expect(toText(edit.doc).split("\n")[1]).toBe("  A");
    expect(edit.caret).toEqual({ row: 1, col: 3 });
    expect(edit.flush).toBe(false);
  });

  it("overwrites rather than inserting, since the grid has no reflow", () => {
    let doc = doc10();
    for (const [i, ch] of [..."abcd"].entries()) {
      doc = applyTextKey({ ...base, doc, caret: { row: 0, col: i }, key: ch }).doc;
    }
    const over = applyTextKey({ ...base, doc, caret: { row: 0, col: 1 }, key: "X" });
    expect(toText(over.doc).split("\n")[0]).toBe("aXcd");
  });

  it("stops at the last column instead of wrapping", () => {
    const doc = doc10();
    const edit = applyTextKey({ ...base, doc, caret: { row: 0, col: 9 }, key: "Z" });
    expect(toText(edit.doc).split("\n")[0]).toBe("         Z");
    // The character lands, but the caret does not move past the edge.
    expect(edit.caret).toEqual({ row: 0, col: 9 });
  });
});

describe("applyTextKey — insert mode", () => {
  const base = { layerId: "l1", origin: { row: 0, col: 0 } as CellPos, style: STYLE };

  const withRow = (text: string): TuiDocument => {
    let doc = doc10();
    for (const [i, ch] of [...text].entries()) {
      doc = applyTextKey({
        ...base,
        insertMode: false,
        doc,
        caret: { row: 0, col: i },
        key: ch,
      }).doc;
    }
    return doc;
  };

  it("shifts the remainder of the row right", () => {
    const doc = withRow("abcd");
    const edit = applyTextKey({
      ...base,
      insertMode: true,
      doc,
      caret: { row: 0, col: 1 },
      key: "X",
    });
    expect(toText(edit.doc).split("\n")[0]).toBe("aXbcd");
  });

  it("loses cells pushed past the last column", () => {
    // 10 columns, all full: inserting must drop the rightmost character.
    const doc = withRow("abcdefghij");
    const edit = applyTextKey({
      ...base,
      insertMode: true,
      doc,
      caret: { row: 0, col: 0 },
      key: "X",
    });
    expect(toText(edit.doc).split("\n")[0]).toBe("Xabcdefghi");
  });

  it("does not disturb other rows", () => {
    let doc = withRow("abcd");
    doc = applyTextKey({
      ...base,
      insertMode: false,
      doc,
      caret: { row: 1, col: 0 },
      key: "z",
    }).doc;
    const edit = applyTextKey({
      ...base,
      insertMode: true,
      doc,
      caret: { row: 0, col: 0 },
      key: "X",
    });
    expect(toText(edit.doc).split("\n")[1]).toBe("z");
  });

  it("leaves no stale character behind when the tail has gaps", () => {
    // Paste is sparse, so the tail must be cleared before the shifted copy lands.
    let doc = doc10();
    doc = applyTextKey({
      ...base,
      insertMode: false,
      doc,
      caret: { row: 0, col: 0 },
      key: "a",
    }).doc;
    doc = applyTextKey({
      ...base,
      insertMode: false,
      doc,
      caret: { row: 0, col: 3 },
      key: "b",
    }).doc;
    const edit = applyTextKey({
      ...base,
      insertMode: true,
      doc,
      caret: { row: 0, col: 1 },
      key: "X",
    });
    expect(toText(edit.doc).split("\n")[0]).toBe("aX  b");
  });
});

describe("applyTextKey — navigation and deletion", () => {
  const base = { layerId: "l1", style: STYLE, insertMode: false };

  it("Enter returns to the column where typing began", () => {
    // The spec's column-aligned newline: how people type stacked labels.
    const edit = applyTextKey({
      ...base,
      doc: doc10(),
      caret: { row: 1, col: 7 },
      origin: { row: 1, col: 3 },
      key: "Enter",
    });
    expect(edit.caret).toEqual({ row: 2, col: 3 });
    expect(edit.flush).toBe(true);
  });

  it("Backspace moves left and clears to transparent", () => {
    let doc = doc10();
    doc = applyTextKey({
      ...base,
      doc,
      caret: { row: 0, col: 0 },
      origin: { row: 0, col: 0 },
      key: "a",
    }).doc;
    const edit = applyTextKey({
      ...base,
      doc,
      caret: { row: 0, col: 1 },
      origin: { row: 0, col: 0 },
      key: "Backspace",
    });
    expect(toText(edit.doc).split("\n")[0]).toBe("");
    expect(edit.caret).toEqual({ row: 0, col: 0 });
    // Transparent, not a painted space.
    expect(edit.doc.layers[0]?.cells["0,0"]).toBeUndefined();
  });

  it("Backspace at column 0 does nothing", () => {
    const doc = doc10();
    const edit = applyTextKey({
      ...base,
      doc,
      caret: { row: 0, col: 0 },
      origin: { row: 0, col: 0 },
      key: "Backspace",
    });
    expect(edit.caret).toEqual({ row: 0, col: 0 });
    expect(edit.doc).toBe(doc);
  });

  it("Delete clears in place without moving", () => {
    let doc = doc10();
    doc = applyTextKey({
      ...base,
      doc,
      caret: { row: 0, col: 2 },
      origin: { row: 0, col: 0 },
      key: "q",
    }).doc;
    const edit = applyTextKey({
      ...base,
      doc,
      caret: { row: 0, col: 2 },
      origin: { row: 0, col: 0 },
      key: "Delete",
    });
    expect(toText(edit.doc).split("\n")[0]).toBe("");
    expect(edit.caret).toEqual({ row: 0, col: 2 });
  });

  it("arrow keys move the caret and clamp at the edges", () => {
    const doc = doc10();
    const move = (caret: CellPos, key: string) =>
      applyTextKey({ ...base, doc, caret, origin: caret, key }).caret;
    expect(move({ row: 1, col: 1 }, "ArrowLeft")).toEqual({ row: 1, col: 0 });
    expect(move({ row: 1, col: 1 }, "ArrowRight")).toEqual({ row: 1, col: 2 });
    expect(move({ row: 1, col: 1 }, "ArrowUp")).toEqual({ row: 0, col: 1 });
    expect(move({ row: 1, col: 1 }, "ArrowDown")).toEqual({ row: 2, col: 1 });
    // Clamped, never out of bounds.
    expect(move({ row: 0, col: 0 }, "ArrowLeft")).toEqual({ row: 0, col: 0 });
    expect(move({ row: 0, col: 0 }, "ArrowUp")).toEqual({ row: 0, col: 0 });
    expect(move({ row: 3, col: 9 }, "ArrowDown")).toEqual({ row: 3, col: 9 });
    expect(move({ row: 3, col: 9 }, "ArrowRight")).toEqual({ row: 3, col: 9 });
    expect(move({ row: 2, col: 5 }, "Home")).toEqual({ row: 2, col: 0 });
    expect(move({ row: 2, col: 5 }, "End")).toEqual({ row: 2, col: 9 });
  });

  it("navigation flushes the burst; typing does not", () => {
    const doc = doc10();
    const flushOf = (key: string) =>
      applyTextKey({ ...base, doc, caret: { row: 1, col: 1 }, origin: { row: 1, col: 1 }, key })
        .flush;
    for (const key of ["Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(flushOf(key), key).toBe(true);
    }
    for (const key of ["a", "Backspace", "Delete"]) {
      expect(flushOf(key), key).toBe(false);
    }
  });

  it("ignores an unhandled key without touching the document", () => {
    const doc = doc10();
    const edit = applyTextKey({
      ...base,
      doc,
      caret: { row: 1, col: 1 },
      origin: { row: 1, col: 1 },
      key: "F5",
    });
    expect(edit.doc).toBe(doc);
    expect(edit.caret).toEqual({ row: 1, col: 1 });
  });
});

describe("reduceBurst", () => {
  const docs = Array.from({ length: 6 }, () => doc10());
  const origin: CellPos = { row: 0, col: 0 };

  it("coalesces a run of keystrokes into one commit", () => {
    let state = null;
    let commits = 0;
    for (const [i, doc] of docs.entries()) {
      const step = reduceBurst(state, {
        t: "keystroke",
        doc,
        caretOrigin: origin,
        at: 1000 + i * 80,
      });
      state = step.state;
      if (step.out.t === "flush") commits++;
    }
    expect(commits, "no commit while the burst is open").toBe(0);

    const idle = reduceBurst(state, { t: "tick", at: 1000 + 5 * 80 + BURST_IDLE_MS });
    expect(idle.out.t).toBe("flush");
    expect(idle.state).toBeNull();
  });

  it("does not flush before the idle timeout elapses", () => {
    const opened = reduceBurst(null, {
      t: "keystroke",
      doc: docs[0]!,
      caretOrigin: origin,
      at: 1000,
    });
    const early = reduceBurst(opened.state, { t: "tick", at: 1000 + BURST_IDLE_MS - 1 });
    expect(early.out.t).toBe("none");
    expect(early.state).not.toBeNull();
  });

  it("records the document at the burst's start as the undo target", () => {
    const first = reduceBurst(null, {
      t: "keystroke",
      doc: docs[0]!,
      caretOrigin: origin,
      at: 1,
    });
    const second = reduceBurst(first.state, {
      t: "keystroke",
      doc: docs[1]!,
      caretOrigin: origin,
      at: 2,
    });
    expect(second.state?.baseAtStart).toBe(docs[0]);
    expect(second.state?.working).toBe(docs[1]);
    expect(second.state?.keyCount).toBe(2);
  });

  it("flushes on demand, for every reason", () => {
    for (const reason of ["enter", "tool-change", "blur", "undo-requested", "save"] as const) {
      const opened = reduceBurst(null, {
        t: "keystroke",
        doc: docs[0]!,
        caretOrigin: origin,
        at: 1,
      });
      const flushed = reduceBurst(opened.state, { t: "flush", reason });
      expect(flushed.out.t, reason).toBe("flush");
      if (flushed.out.t === "flush") expect(flushed.out.reason).toBe(reason);
      expect(flushed.state).toBeNull();
    }
  });

  it("is inert when no burst is open", () => {
    expect(reduceBurst(null, { t: "tick", at: 9999 }).out.t).toBe("none");
    expect(reduceBurst(null, { t: "flush", reason: "save" }).out.t).toBe("none");
  });

  it("honours a custom idle window", () => {
    const opened = reduceBurst(
      null,
      { t: "keystroke", doc: docs[0]!, caretOrigin: origin, at: 0 },
      { idleMs: 50 },
    );
    expect(reduceBurst(opened.state, { t: "tick", at: 49 }, { idleMs: 50 }).out.t).toBe("none");
    expect(reduceBurst(opened.state, { t: "tick", at: 50 }, { idleMs: 50 }).out.t).toBe("flush");
  });
});

describe("the text tool end to end", () => {
  const M: CellMetrics = {
    cellW: 8,
    cellH: 16,
    dpr: 1,
    baselineY: 12,
    font: { family: "Menlo", sizePx: 14, lineHeightFactor: 1.2 },
  };
  const COLS = 20;
  const ROWS = 6;

  let documentStore: ReturnType<typeof createDocumentStore>;
  let controller: GestureController;
  let scratch: TuiDocument | null;
  let caret: CellPos | null;
  let now: number;

  const pointerAt = (row: number, col: number): PointerEventLike => ({
    x: col * M.cellW + 1,
    y: row * M.cellH + 1,
    button: 0,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  });

  const rendered = (): TuiDocument => scratch ?? documentStore.getState().history.present;
  const type = (text: string) => {
    for (const ch of text) controller.onKey(ch, NO_MODS);
  };

  beforeEach(() => {
    documentStore = createDocumentStore(createDocument(COLS, ROWS, { idGen: sequentialIdGen() }));
    scratch = null;
    caret = null;
    now = 1000;
    useToolStore.setState({
      activeTool: "text",
      brush: { ...DEFAULT_BRUSH, char: "x" },
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
      setDragRect: () => {},
      setCaret: (next) => {
        caret = next;
      },
      now: () => now,
    });
  });

  it("places the caret on click and types a label", () => {
    controller.onPointerDown(pointerAt(1, 2));
    expect(caret).toEqual({ row: 1, col: 2 });
    type("STATUS");
    expect(toText(rendered()).split("\n")[1]).toBe("  STATUS");
    expect(caret).toEqual({ row: 1, col: 8 });
  });

  it("commits the whole label as one undo step after the idle timeout", () => {
    controller.onPointerDown(pointerAt(0, 0));
    type("hello");
    // Nothing committed yet — it is still one open burst.
    expect(documentStore.getState().canUndo()).toBe(false);

    now += BURST_IDLE_MS;
    controller.tick();
    expect(documentStore.getState().history.past).toHaveLength(1);
    expect(toText(documentStore.getState().history.present).split("\n")[0]).toBe("hello");

    documentStore.getState().undo();
    // One undo removes all five characters, not one.
    expect(toText(documentStore.getState().history.present).trim()).toBe("");
  });

  it("flushes before undo, so Cmd+Z removes the burst and not the previous entry", () => {
    // The most likely coalescing bug: without the pre-undo flush the typed
    // characters vanish and the undo removes something else.
    controller.onPointerDown(pointerAt(0, 0));
    type("first");
    controller.flushTyping("enter");
    expect(documentStore.getState().history.past).toHaveLength(1);

    type("second");
    expect(documentStore.getState().canUndo()).toBe(true);

    controller.flushTyping("undo-requested");
    expect(documentStore.getState().history.past).toHaveLength(2);
    documentStore.getState().undo();
    expect(toText(documentStore.getState().history.present).split("\n")[0]).toBe("first");
  });

  it("starts a new burst when the caret is placed elsewhere", () => {
    controller.onPointerDown(pointerAt(0, 0));
    type("aa");
    controller.onPointerDown(pointerAt(2, 0));
    type("bb");
    controller.flushTyping("blur");
    // Two separate undo steps, one per location.
    expect(documentStore.getState().history.past.length).toBeGreaterThanOrEqual(2);
  });

  it("Enter starts a new burst at the original column", () => {
    controller.onPointerDown(pointerAt(0, 3));
    type("ab");
    controller.onKey("Enter", NO_MODS);
    expect(caret).toEqual({ row: 1, col: 3 });
    type("cd");
    controller.flushTyping("blur");
    const lines = toText(documentStore.getState().history.present).split("\n");
    expect(lines[0]).toBe("   ab");
    expect(lines[1]).toBe("   cd");
  });

  it("Insert toggles insert mode", () => {
    controller.onPointerDown(pointerAt(0, 0));
    type("abcd");
    controller.onKey("Home", NO_MODS);
    controller.onKey("Insert", NO_MODS);
    type("X");
    expect(toText(rendered()).split("\n")[0]).toBe("Xabcd");
  });

  it("Esc dismisses the caret but keeps what was typed", () => {
    controller.onPointerDown(pointerAt(1, 1));
    type("kept");
    controller.cancel();
    expect(caret).toBeNull();
    expect(toText(documentStore.getState().history.present).split("\n")[1]).toBe(" kept");
    expect(documentStore.getState().history.past).toHaveLength(1);
  });

  describe("endTextEditing — the Esc that hands off to the Select tool", () => {
    it("returns the rect covering exactly the run that was typed", () => {
      controller.onPointerDown(pointerAt(2, 4));
      type("Name");
      // Four characters from column 4, so columns 4..7 — not 4..8. The trailing
      // caret sits at 8 and must not widen the selection.
      expect(controller.endTextEditing()).toEqual({ top: 2, left: 4, rows: 1, cols: 4 });
      expect(caret).toBeNull();
    });

    it("spans both rows when the run crossed an Enter", () => {
      controller.onPointerDown(pointerAt(1, 2));
      type("ab");
      controller.onKey("Enter", NO_MODS);
      type("cde");
      // Enter flushes the burst mid-label, but the *session* spans both rows —
      // "select what I just typed" has to mean the whole label.
      expect(controller.endTextEditing()).toEqual({ top: 1, left: 2, rows: 2, cols: 3 });
    });

    it("ignores pure navigation, which changes no cell", () => {
      controller.onPointerDown(pointerAt(0, 5));
      type("hi");
      controller.onKey("ArrowRight", NO_MODS);
      controller.onKey("End", NO_MODS);
      // Arrows flush the burst and write nothing, so they neither reset nor widen
      // the session.
      expect(controller.endTextEditing()).toEqual({ top: 0, left: 5, rows: 1, cols: 2 });
    });

    it("counts a Backspace's cleared cell as part of the extent", () => {
      controller.onPointerDown(pointerAt(0, 3));
      type("ab");
      controller.onKey("Backspace", NO_MODS);
      // "a" survives at column 3 and the cleared column 4 is still inside the
      // rect — the user's edit covered both.
      expect(controller.endTextEditing()).toEqual({ top: 0, left: 3, rows: 1, cols: 2 });
    });

    it("survives an idle-timeout commit, since the session outlives the burst", () => {
      controller.onPointerDown(pointerAt(0, 0));
      type("done");
      now += BURST_IDLE_MS;
      controller.tick();
      // The burst is committed and gone, but the caret is still placed — the user
      // is still editing, so Esc must still select what they wrote.
      expect(controller.endTextEditing()).toEqual({ top: 0, left: 0, rows: 1, cols: 4 });
    });

    it("starts a new session when the caret is clicked elsewhere", () => {
      controller.onPointerDown(pointerAt(0, 0));
      type("first");
      controller.onPointerDown(pointerAt(3, 6));
      type("second");
      // Only the label being typed, not a block spanning both.
      expect(controller.endTextEditing()).toEqual({ top: 3, left: 6, rows: 1, cols: 6 });
    });

    it("returns null when no text was ever typed", () => {
      controller.onPointerDown(pointerAt(1, 1));
      expect(controller.endTextEditing()).toBeNull();
    });

    it("still commits what was typed", () => {
      controller.onPointerDown(pointerAt(1, 1));
      type("kept");
      controller.endTextEditing();
      expect(toText(documentStore.getState().history.present).split("\n")[1]).toBe(" kept");
      expect(documentStore.getState().history.past).toHaveLength(1);
    });
  });

  it("leaves an open burst alone when the idle window has not elapsed", () => {
    controller.onPointerDown(pointerAt(0, 0));
    type("ab");
    now += BURST_IDLE_MS - 1;
    controller.tick();
    expect(controller.isTyping()).toBe(true);
    expect(documentStore.getState().canUndo()).toBe(false);
  });

  it("ticks harmlessly when nothing is being typed", () => {
    // The poll runs four times a second whether or not anyone is typing.
    expect(controller.isTyping()).toBe(false);
    now += BURST_IDLE_MS * 5;
    expect(() => controller.tick()).not.toThrow();
    expect(documentStore.getState().canUndo()).toBe(false);
  });

  it("refuses to type once the layer is locked mid-session", () => {
    // The caret is already placed, then the layer is locked — so this reaches the
    // guard inside the typing path rather than the one on caret placement.
    controller.onPointerDown(pointerAt(0, 0));
    type("ok");
    controller.flushTyping("blur");
    const locked = documentStore.getState().history.present;
    documentStore
      .getState()
      .load({ ...locked, layers: locked.layers.map((l) => ({ ...l, locked: true })) }, null);
    // Deliberately no further click: the caret is still placed, so this exercises
    // the guard inside the typing path rather than the one on caret placement.
    const before = toText(documentStore.getState().history.present);
    type("blocked");
    expect(toText(documentStore.getState().history.present)).toBe(before);
    expect(useToolStore.getState().lockFlashAt).not.toBeNull();
  });

  it("refuses to type on a locked layer", () => {
    const base = documentStore.getState().history.present;
    documentStore
      .getState()
      .load({ ...base, layers: base.layers.map((l) => ({ ...l, locked: true })) }, null);
    controller.onPointerDown(pointerAt(0, 0));
    type("nope");
    expect(useToolStore.getState().lockFlashAt).not.toBeNull();
    expect(toText(documentStore.getState().history.present).trim()).toBe("");
  });

  it("reports whether a burst is open", () => {
    expect(controller.isTyping()).toBe(false);
    controller.onPointerDown(pointerAt(0, 0));
    type("a");
    expect(controller.isTyping()).toBe(true);
    controller.flushTyping("blur");
    expect(controller.isTyping()).toBe(false);
  });

  it("keeps the burst open when clicking the caret's current cell", () => {
    // Typing "ab" from column 1 leaves the caret at column 3, so clicking there
    // is a no-move and must not split the undo step.
    controller.onPointerDown(pointerAt(1, 1));
    type("ab");
    expect(caret).toEqual({ row: 1, col: 3 });
    controller.onPointerDown(pointerAt(1, 3));
    type("cd");
    controller.flushTyping("blur");
    expect(documentStore.getState().history.past).toHaveLength(1);
    expect(toText(documentStore.getState().history.present).split("\n")[1]).toBe(" abcd");
  });

  it("splits the burst when the caret is placed somewhere else", () => {
    controller.onPointerDown(pointerAt(1, 1));
    type("ab");
    controller.onPointerDown(pointerAt(1, 8)); // a real move
    type("cd");
    controller.flushTyping("blur");
    expect(documentStore.getState().history.past).toHaveLength(2);
  });

  it("toggles insert mode even on a locked layer, without editing", () => {
    const base = documentStore.getState().history.present;
    documentStore
      .getState()
      .load({ ...base, layers: base.layers.map((l) => ({ ...l, locked: true })) }, null);
    controller.onPointerDown(pointerAt(0, 0));
    // Locked layers flash rather than typing; Insert is a mode change, not an edit.
    controller.onKey("Insert", NO_MODS);
    expect(documentStore.getState().canUndo()).toBe(false);
  });

  it("commitEdit flushes an open burst before landing its own entry", () => {
    // A resize mid-typing must not swallow the characters typed; the burst
    // commits first, then the resize becomes its own step.
    controller.onPointerDown(pointerAt(0, 0));
    type("kept");
    const resized = { ...documentStore.getState().present(), cols: 10 };
    controller.commitEdit(resized);
    expect(documentStore.getState().history.past).toHaveLength(2);
    expect(documentStore.getState().present().cols).toBe(10);
    // Undoing the resize leaves the typed text intact.
    documentStore.getState().undo();
    expect(toText(documentStore.getState().present()).split("\n")[0]).toBe("kept");
  });

  it("keeps typing on the burst's working document, not on the committed present", () => {
    // If each keystroke rebuilt from `present`, only the last character would
    // survive. This is the one place a gesture legitimately builds on itself.
    controller.onPointerDown(pointerAt(0, 0));
    type("abcdef");
    expect(toText(rendered()).split("\n")[0]).toBe("abcdef");
  });
});
