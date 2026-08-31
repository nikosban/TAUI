/**
 * Wires the pure reducer to the stores. The one impure part of the gesture path.
 *
 * `applyEffects` is the only switch that touches stores, and its `commit` branch
 * is the only route into history — which, with `GestureEffect` having no
 * push-history variant and `commit` demanding a `CommittedDoc`, is what makes
 * "one gesture = one history entry" structural.
 */

import { cellAt, type Rect, type TuiDocument } from "@tui-designer/core";
import type { CellMetrics, CellPos, GridSize, Viewport } from "../canvas/metrics.js";
import { cellFromPoint, cellFromPointClamped } from "../canvas/metrics.js";
import type { DocumentState } from "../stores/document-store.js";
import type { ToolState } from "../stores/tool-store.js";
import { sealCommit } from "./commit.js";
import {
  type GestureContext,
  type GestureEffect,
  type GestureEvent,
  type GestureState,
  IDLE,
  type Modifiers,
  reduceGesture,
} from "./gesture.js";
import {
  type BurstState,
  burstDoc,
  burstOpen,
  type FlushReason,
  reduceBurst,
} from "./typing-burst.js";

export interface ControllerDeps {
  readonly documentStore: { getState(): DocumentState };
  readonly toolStore: { getState(): ToolState };
  /** Current canvas geometry. Read fresh on every event. */
  readonly geometry: () => { metrics: CellMetrics; viewport: Viewport; size: GridSize };
  /** Scratch document to render instead of `present`, or null. */
  readonly setScratch: (doc: DocumentState["history"]["present"] | null) => void;
  /** In-progress rubber band with no scratch of its own (the marquee). */
  readonly setDragRect: (rect: Rect | null) => void;
  /** Where to draw the inverse-video text caret, or null. */
  readonly setCaret: (caret: CellPos | null) => void;
  readonly now: () => number;
}

export interface GestureController {
  onPointerDown(e: PointerEventLike): void;
  onPointerMove(e: PointerEventLike): void;
  onPointerUp(e: PointerEventLike): void;
  onKey(key: string, mods: Modifiers): void;
  /** Shared undo/redo command used by both shortcuts and visible controls. */
  history(action: "undo" | "redo"): void;
  cancel(): void;
  /**
   * Settles every document-relative interaction immediately before another
   * document is adopted. Typing is flushed rather than silently discarded;
   * pointer previews are cancelled rather than committed.
   */
  settleDocumentReplacement(): void;
  /**
   * Ends any open typing burst, turning it into one history entry.
   *
   * Must be called before undo, before save, and on tool change — otherwise the
   * uncommitted keystrokes are lost and the undo removes the wrong entry.
   */
  flushTyping(reason: FlushReason): void;
  /** Periodic poll that detects the idle timeout. Cheap when no burst is open. */
  tick(): void;
  isTyping(): boolean;
  /**
   * Leaves text-edit mode, returning the rect of what the last burst wrote.
   *
   * Distinct from {@link cancel} because Esc and a focus loss want different
   * things: Esc is the user deliberately stepping out to act on the text they
   * just typed, so the caller selects the returned rect and switches to the
   * Select tool — Figma's behaviour, where leaving text edit leaves the object
   * selected under the move tool. A blur must not reshape the selection, so it
   * still goes through `cancel`.
   *
   * The rect spans the whole editing session — from the click that placed the
   * caret to Esc — so a label typed across two rows with an Enter selects as one
   * block. Returns null when the session wrote nothing.
   */
  endTextEditing(): Rect | null;
  /**
   * Copy, cut, or paste.
   *
   * Copy and cut act on the current selection and do nothing without one. Paste
   * does not write immediately: it arms a placement gesture in which the block
   * follows the pointer, so a press drops it and Esc abandons it. That keeps the
   * paste one history entry and lets it be aimed, which matters on a grid where
   * being one cell off is obvious.
   */
  clipboard(action: "copy" | "cut" | "paste"): void;
  /**
   * Commits a discrete, non-gesture document edit as one history entry —
   * resize, crop, and (from G4) palette deletion.
   *
   * These are legitimate single-step edits that are not *gestures*, so they need a
   * way in. Routing them through the controller rather than letting callers reach
   * for `sealCommit` keeps the brand confined to `gestures/` and keeps `push` to
   * one call site. Any open typing burst is flushed first, so the resize lands
   * after the characters typed rather than swallowing them.
   */
  commitEdit(doc: TuiDocument): void;
  /** The cell under the pointer, for the status bar. Null in the void. */
  hoverCell(): CellPos | null;
  isActive(): boolean;
}

/**
 * The subset of PointerEvent the controller needs.
 *
 * `x`/`y` are **canvas-relative CSS pixels**, which the caller computes as
 * `clientX - canvasRect.left`. Deliberately not `offsetX`/`offsetY`: those are
 * relative to the target's *padding box*, so they would silently shift if the
 * canvas ever gained a border or padding, and they are unreliable on
 * programmatically dispatched events.
 */
export interface PointerEventLike {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** Grows a rect to include a cell. Either side may be absent. */
function unionRect(rect: Rect | null, pos: CellPos | null): Rect | null {
  if (pos === null) return rect;
  if (rect === null) return { top: pos.row, left: pos.col, rows: 1, cols: 1 };
  const top = Math.min(rect.top, pos.row);
  const left = Math.min(rect.left, pos.col);
  const bottom = Math.max(rect.top + rect.rows - 1, pos.row);
  const right = Math.max(rect.left + rect.cols - 1, pos.col);
  return { top, left, rows: bottom - top + 1, cols: right - left + 1 };
}

const modsOf = (e: PointerEventLike): Modifiers => ({
  shift: e.shiftKey,
  alt: e.altKey,
  meta: e.metaKey,
  ctrl: e.ctrlKey,
});

export function createGestureController(deps: ControllerDeps): GestureController {
  let state: GestureState = IDLE;
  let hover: CellPos | null = null;
  let burst: BurstState | null = null;
  /**
   * Everything the current text-editing session has written, or null.
   *
   * Deliberately wider than the typing burst. A burst ends at the first Enter or
   * arrow key, but the *session* runs from caret placement to Esc — and "select
   * what I just typed" means the whole label, including the rows after an Enter.
   * Tracking it here rather than in the burst is what makes Esc's selection
   * survive the mid-label flushes.
   */
  let textSession: Rect | null = null;

  const contextNow = (): GestureContext => {
    const doc = deps.documentStore.getState();
    const tools = deps.toolStore.getState();
    return {
      /**
       * The document this gesture builds on.
       *
       * For a drag this is always the committed present — invariant 2, which is
       * what makes previews non-cumulative. For an open typing burst it is the
       * burst's working copy, because there the *burst* is the gesture: each
       * keystroke must build on the previous one rather than on `present`.
       */
      base: burstDoc(burst, doc.history.present),
      layerId: doc.history.present.activeLayerId,
      brush: tools.brush,
      lineStyle: tools.lineStyle,
      selection: tools.selection,
      clipboard: tools.clipboard,
      hover,
    };
  };

  function applyEffects(effects: readonly GestureEffect[]): void {
    for (const effect of effects) {
      switch (effect.t) {
        case "scratch":
          deps.setScratch(effect.doc);
          break;

        case "commit":
          // The single push call site in the application.
          deps.documentStore.getState().commit(effect.doc);
          deps.setScratch(null);
          deps.setDragRect(null);
          break;

        case "revert":
          deps.setScratch(null);
          break;

        case "set-selection":
          deps.toolStore.getState().setSelection(effect.rect);
          break;

        case "set-clipboard":
          deps.toolStore.getState().setClipboard(effect.clip);
          break;

        case "drag-rect":
          deps.setDragRect(effect.rect);
          break;

        case "set-brush-from-cell": {
          // Samples the topmost *visible* layer, not the active one. An eyedropper
          // that only read the active layer would do nothing when you click the
          // content you can plainly see, because it lives on another layer — and
          // the user has no way to tell which layer that is.
          const doc = deps.documentStore.getState().history.present;
          const cell = cellAt(doc, effect.cell.row, effect.cell.col);
          if (cell !== undefined) {
            const { char, ...style } = cell;
            deps.toolStore.getState().setBrush({ char, ...style });
          }
          break;
        }

        case "flash-lock":
          deps.toolStore.getState().flashLock(deps.now());
          break;

        case "set-caret":
          deps.setCaret(effect.caret);
          break;

        case "typed": {
          textSession = unionRect(textSession, effect.wrote);
          // Fold the edit into the burst, then flush if the key demanded it.
          const step = reduceBurst(burst, {
            t: "keystroke",
            doc: effect.doc,
            caretOrigin: effect.caret,
            at: deps.now(),
          });
          burst = step.state;
          if (step.out.t === "open") deps.setScratch(step.out.working);
          if (effect.flush) flushTyping("enter");
          break;
        }
      }
    }
  }

  function flushTyping(reason: FlushReason): void {
    const step = reduceBurst(burst, { t: "flush", reason });
    burst = step.state;
    if (step.out.t === "flush") {
      deps.documentStore.getState().commit(step.out.commit);
      deps.setScratch(null);
    }
  }

  function dispatch(event: GestureEvent): void {
    const tool = deps.toolStore.getState().activeTool;
    const step = reduceGesture(tool, state, event, contextNow());
    state = step.state;
    applyEffects(step.effects);
  }

  function runHistoryCommand(action: "undo" | "redo"): void {
    // A typing burst is a real edit, so land it first. Undo then removes that
    // burst; redo intentionally sees the redo branch cleared by the new edit.
    flushTyping("undo-requested");

    // Pointer previews and floating paste placement are transient. They must not
    // become history merely because undo/redo was invoked while the pointer was
    // captured.
    if (state.kind !== "idle") dispatch({ t: "cancel" });
    textSession = null;
    deps.setScratch(null);
    deps.setDragRect(null);
    deps.setCaret(null);

    const documents = deps.documentStore.getState();
    if (action === "undo") documents.undo();
    else documents.redo();
  }

  /** Clamped: dragging off-canvas must extend the gesture, not cancel it. */
  function cellOf(e: PointerEventLike): CellPos {
    const { metrics, viewport, size } = deps.geometry();
    return cellFromPointClamped(e.x, e.y, metrics, viewport, size);
  }

  return {
    onPointerDown(e) {
      const button = e.button === 2 ? 2 : 0;
      // Clicking to reposition the caret starts a new text session, so Esc selects
      // the label being typed rather than every label since the tool was picked.
      // Keyboard-driven caret moves (Enter, arrows) deliberately do not reset it:
      // a label spanning two rows via Enter is one label.
      if (button === 0 && deps.toolStore.getState().activeTool === "text") {
        textSession = null;
      }
      dispatch({ t: "down", cell: cellOf(e), mods: modsOf(e), button });
    },

    onPointerMove(e) {
      const { metrics, viewport, size } = deps.geometry();
      // Hover uses the unclamped mapping so the status bar shows nothing in the void.
      hover = cellFromPoint(e.x, e.y, metrics, viewport, size);
      if (state.kind === "idle") return;
      dispatch({ t: "move", cell: cellOf(e), mods: modsOf(e) });
    },

    onPointerUp(e) {
      if (state.kind === "idle") return;
      dispatch({ t: "up", cell: cellOf(e), mods: modsOf(e) });
    },

    onKey(key, mods) {
      dispatch({ t: "key", key, mods });
    },

    history(action) {
      runHistoryCommand(action);
    },

    cancel() {
      dispatch({ t: "cancel" });
      // Characters already typed are real edits, so they are committed rather
      // than discarded; cancelling only dismisses the caret.
      flushTyping("blur");
      textSession = null;
      deps.setCaret(null);
    },

    settleDocumentReplacement() {
      dispatch({ t: "cancel" });
      flushTyping("document-replacement");
      // Be explicit even when the reducer had no effect (for example an idle text
      // burst): no preview from the old document may survive the load boundary.
      state = IDLE;
      textSession = null;
      hover = null;
      deps.setScratch(null);
      deps.setDragRect(null);
      deps.setCaret(null);
    },

    clipboard(action) {
      dispatch({ t: "clipboard", action });
    },

    endTextEditing() {
      dispatch({ t: "cancel" });
      flushTyping("blur");
      const typed = textSession;
      textSession = null;
      deps.setCaret(null);
      return typed;
    },

    flushTyping,

    tick() {
      if (!burstOpen(burst)) return;
      const step = reduceBurst(burst, { t: "tick", at: deps.now() });
      burst = step.state;
      if (step.out.t === "flush") {
        deps.documentStore.getState().commit(step.out.commit);
        deps.setScratch(null);
      }
    },

    isTyping() {
      return burstOpen(burst);
    },

    commitEdit(doc) {
      flushTyping("tool-change");
      deps.documentStore.getState().commit(sealCommit(doc));
      deps.setScratch(null);
    },

    hoverCell() {
      return hover;
    },

    isActive() {
      return state.kind !== "idle";
    },
  };
}
