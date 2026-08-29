/**
 * The interaction model, as one pure function.
 *
 * `reduceGesture(tool, state, event, ctx)` is total and deterministic: the same
 * inputs always produce the same step, with no clock, no randomness, and no store
 * access. That is what makes the four invariants below testable as properties
 * over generated event sequences rather than hoped for.
 *
 * ## The four invariants
 *
 * 1. **`commit` never on `move`.** Only pointer-up or a terminal key ends a
 *    gesture.
 * 2. **Every op derives from `ctx.base`**, never from a previous scratch. The
 *    whole preview is recomputed each move, which also makes `move` idempotent
 *    and is why changing a modifier mid-drag re-derives cleanly instead of
 *    leaving orphaned cells behind.
 * 3. **At most one `commit` per `down`…`up`**, and none at all for a sequence
 *    ending in `cancel`.
 * 4. **`cancel` always reverts** and returns to `idle` — covering Esc, a tool
 *    switch mid-gesture, and window blur through one path.
 *
 * `GestureEffect` deliberately has **no** "push history" variant: the only way
 * into history is a `commit` carrying a {@link CommittedDoc}, and the only
 * producer of those is `sealCommit`. A tool cannot push per mousemove.
 */

import {
  type Cell,
  type CellStyle,
  type Clipboard,
  clearRect,
  copyRegion,
  cutRegion,
  drawBox,
  drawLine,
  floodFill,
  type LineStyle,
  moveRegion,
  pasteRegion,
  type Rect,
  setCell,
  type TuiDocument,
} from "@tui-designer/core";
import type { CellPos } from "../canvas/metrics.js";
import { type CommittedDoc, sealCommit } from "./commit.js";
import { applyTextKey } from "./text.js";

export type ToolId = "pencil" | "box" | "line" | "text" | "select" | "fill" | "eyedropper";

export interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  readonly meta: boolean;
  readonly ctrl: boolean;
}

export const NO_MODS: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

/** The brush: a cell's worth of style plus the character to stamp. */
export interface BrushState extends CellStyle {
  readonly char: string;
}

const brushCell = (brush: BrushState): Cell => ({ ...brush });

/** Style only, for ops that supply their own character (box, line). */
function brushStyle(brush: BrushState): CellStyle {
  const { char: _char, ...style } = brush;
  return style;
}

/** Everything the reducer needs about the world. No stores, no DOM. */
export interface GestureContext {
  /** ALWAYS `history.present`. Never a scratch document. */
  readonly base: TuiDocument;
  readonly layerId: string;
  readonly brush: BrushState;
  readonly lineStyle: LineStyle;
  readonly selection: Rect | null;
  readonly clipboard: Clipboard | null;
  /**
   * The cell under the pointer, or null when it is off-canvas.
   *
   * Only the paste gesture reads it: ⌘V has no cell of its own, and dropping the
   * pasted block wherever the pointer already is beats a fixed corner.
   */
  readonly hover: CellPos | null;
}

export type GestureEvent =
  | { readonly t: "down"; readonly cell: CellPos; readonly mods: Modifiers; readonly button: 0 | 2 }
  | { readonly t: "move"; readonly cell: CellPos; readonly mods: Modifiers }
  | { readonly t: "up"; readonly cell: CellPos; readonly mods: Modifiers }
  /** Esc, tool switch mid-gesture, or window blur. */
  | { readonly t: "cancel" }
  /**
   * A clipboard command. Carries no cell — copy and cut act on the selection, and
   * paste anchors on `ctx.hover` — so it cannot be folded into `key`.
   */
  | { readonly t: "clipboard"; readonly action: "copy" | "cut" | "paste" }
  | { readonly t: "key"; readonly key: string; readonly mods: Modifiers };

/**
 * The pointer events a per-tool reducer can receive.
 *
 * Stated positively rather than as `Exclude<GestureEvent, …>`: every new
 * keyboard-ish event kind would otherwise have to be subtracted again in six
 * signatures, and forgetting one turns an exhaustive switch into a silent
 * fallthrough.
 */
type PointerGestureEvent = Extract<GestureEvent, { t: "down" } | { t: "move" } | { t: "up" }>;

type Axis = "h" | "v";

/** A path with at least one point, so `path[0]` needs no undefined check. */
type NonEmptyPath = readonly [CellPos, ...CellPos[]];

/** Discriminated per tool, so impossible states are unrepresentable. */
export type GestureState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pencil";
      /**
       * Raw pointer path, never empty — it always contains at least the cell the
       * press landed on. The painted cells are *derived* from it each move.
       */
      readonly path: NonEmptyPath;
      readonly axis: Axis | null;
    }
  | {
      readonly kind: "box";
      readonly anchor: CellPos;
      readonly current: CellPos;
      readonly merge: boolean;
    }
  | {
      readonly kind: "line";
      readonly anchor: CellPos;
      readonly current: CellPos;
      readonly merge: boolean;
    }
  | { readonly kind: "marquee"; readonly anchor: CellPos; readonly current: CellPos }
  | {
      /**
       * The text caret. Unlike the drag states this persists across pointer-up —
       * a click places it and typing continues until Esc or a tool change.
       */
      readonly kind: "caret";
      readonly origin: CellPos;
      readonly at: CellPos;
      readonly insertMode: boolean;
    }
  | {
      /**
       * A pasted block following the pointer until a click drops it.
       *
       * Persists across pointer-up like the caret, because it is armed by a
       * keystroke rather than a press. Deliberately *not* owned by the Select
       * tool: ⌘V arms it from any tool, so the placement gesture is routed ahead
       * of the per-tool reducers.
       */
      readonly kind: "paste";
      readonly clip: Clipboard;
      /** Where the clipboard's origin currently sits. */
      readonly at: CellPos;
    }
  | {
      readonly kind: "move-region";
      readonly rect: Rect;
      readonly grab: CellPos;
      readonly current: CellPos;
      readonly duplicate: boolean;
    };

export type GestureEffect =
  /** Preview only. Rendered instead of base; NEVER enters history. */
  | { readonly t: "scratch"; readonly doc: TuiDocument }
  /** Terminal. Pushes exactly one history entry. */
  | { readonly t: "commit"; readonly doc: CommittedDoc }
  /** Discard the scratch and repaint base. */
  | { readonly t: "revert" }
  | { readonly t: "set-selection"; readonly rect: Rect | null }
  | { readonly t: "set-clipboard"; readonly clip: Clipboard }
  | { readonly t: "set-brush-from-cell"; readonly cell: CellPos }
  /** The engine already no-ops on a locked layer; the GUI must explain why. */
  | { readonly t: "flash-lock" }
  /** An in-progress rubber band with no scratch document of its own. */
  | { readonly t: "drag-rect"; readonly rect: Rect | null }
  /**
   * A typed edit. The controller folds this into the typing burst and decides
   * when it becomes a history entry — which is why this is not a `commit`.
   */
  | {
      readonly t: "typed";
      readonly doc: TuiDocument;
      readonly caret: CellPos;
      readonly flush: boolean;
      /**
       * The cell this keypress changed, or `null` for navigation only.
       *
       * The burst accumulates these into the rect that becomes the selection
       * when Esc leaves text-edit mode.
       */
      readonly wrote: CellPos | null;
    }
  /** Where to draw the inverse-video caret block, or null to hide it. */
  | { readonly t: "set-caret"; readonly caret: CellPos | null };

export interface GestureStep {
  readonly state: GestureState;
  readonly effects: readonly GestureEffect[];
}

export const IDLE: GestureState = { kind: "idle" };

const idle = (effects: readonly GestureEffect[] = []): GestureStep => ({ state: IDLE, effects });

/** Rect spanning two corners, inclusive. */
function rectFromCorners(a: CellPos, b: CellPos): Rect {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    rows: Math.abs(a.row - b.row) + 1,
    cols: Math.abs(a.col - b.col) + 1,
  };
}

const rectContains = (rect: Rect, pos: CellPos): boolean =>
  pos.row >= rect.top &&
  pos.row < rect.top + rect.rows &&
  pos.col >= rect.left &&
  pos.col < rect.left + rect.cols;

/**
 * Snaps a drag to its dominant axis, as `drawLine` requires.
 *
 * Ties go horizontal, matching the tie-break used for a zero-delta drag.
 */
function snapToAxis(anchor: CellPos, current: CellPos): { axis: Axis; to: CellPos } {
  const dRow = Math.abs(current.row - anchor.row);
  const dCol = Math.abs(current.col - anchor.col);
  return dCol >= dRow
    ? { axis: "h", to: { row: anchor.row, col: current.col } }
    : { axis: "v", to: { row: current.row, col: anchor.col } };
}

/**
 * Fills the gap between two pointer samples.
 *
 * A fast drag reports cells several apart; without interpolation the stroke comes
 * out as dots. Bresenham over the cell grid, endpoints inclusive.
 */
function interpolate(a: CellPos, b: CellPos): CellPos[] {
  const out: CellPos[] = [];
  let row = a.row;
  let col = a.col;
  const dRow = Math.abs(b.row - a.row);
  const dCol = Math.abs(b.col - a.col);
  const stepRow = a.row < b.row ? 1 : -1;
  const stepCol = a.col < b.col ? 1 : -1;
  let err = dCol - dRow;

  for (;;) {
    out.push({ row, col });
    if (row === b.row && col === b.col) return out;
    const e2 = 2 * err;
    if (e2 > -dRow) {
      err -= dRow;
      col += stepCol;
    }
    if (e2 < dCol) {
      err += dCol;
      row += stepRow;
    }
  }
}

/**
 * The cells a pencil stroke paints, derived from the raw pointer path.
 *
 * Deriving rather than accumulating is what makes the Shift constraint behave:
 * pressing or releasing Shift mid-drag re-derives the whole stroke instead of
 * leaving cells stranded off-axis.
 */
function pencilCells(path: NonEmptyPath, axis: Axis | null): CellPos[] {
  const first = path[0];
  const constrained = path.map((pos) =>
    axis === "h"
      ? { row: first.row, col: pos.col }
      : axis === "v"
        ? { row: pos.row, col: first.col }
        : pos,
  );

  const out: CellPos[] = [];
  const seen = new Set<string>();
  let previous: CellPos | null = null;
  for (const pos of constrained) {
    const segment = previous === null ? [pos] : interpolate(previous, pos).slice(1);
    for (const cell of segment) {
      const key = `${cell.row},${cell.col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cell);
    }
    previous = pos;
  }
  return out;
}

/** The axis implied by the first movement away from the start of a path. */
function axisOf(path: NonEmptyPath): Axis | null {
  const first = path[0];
  for (const pos of path) {
    const dRow = Math.abs(pos.row - first.row);
    const dCol = Math.abs(pos.col - first.col);
    if (dRow === 0 && dCol === 0) continue;
    return dCol >= dRow ? "h" : "v";
  }
  return null;
}

/** Applies a pencil stroke to `base`. Locked layers no-op inside the engine. */
function paintPencil(ctx: GestureContext, path: NonEmptyPath, axis: Axis | null): TuiDocument {
  const cell = brushCell(ctx.brush);
  let doc = ctx.base;
  for (const pos of pencilCells(path, axis)) {
    doc = setCell(doc, ctx.layerId, pos.row, pos.col, cell);
  }
  return doc;
}

function previewBox(
  ctx: GestureContext,
  state: Extract<GestureState, { kind: "box" }>,
): TuiDocument {
  return drawBox(
    ctx.base,
    ctx.layerId,
    rectFromCorners(state.anchor, state.current),
    ctx.lineStyle,
    state.merge,
    brushStyle(ctx.brush),
  );
}

function previewLine(
  ctx: GestureContext,
  state: Extract<GestureState, { kind: "line" }>,
): TuiDocument {
  const { to } = snapToAxis(state.anchor, state.current);
  return drawLine(
    ctx.base,
    ctx.layerId,
    state.anchor,
    to,
    ctx.lineStyle,
    state.merge,
    brushStyle(ctx.brush),
  );
}

function previewMove(
  ctx: GestureContext,
  state: Extract<GestureState, { kind: "move-region" }>,
): TuiDocument {
  const dRow = state.current.row - state.grab.row;
  const dCol = state.current.col - state.grab.col;
  if (state.duplicate) {
    // Copy first, then paste at the offset, leaving the original in place.
    const clip = copyRegion(ctx.base, ctx.layerId, state.rect);
    return pasteRegion(
      ctx.base,
      ctx.layerId,
      {
        row: state.rect.top + dRow,
        col: state.rect.left + dCol,
      },
      clip,
    );
  }
  return moveRegion(ctx.base, ctx.layerId, state.rect, dRow, dCol);
}

/** Offsets a rect, for keeping the selection with a moved region. */
const offsetRect = (rect: Rect, dRow: number, dCol: number): Rect => ({
  ...rect,
  top: rect.top + dRow,
  left: rect.left + dCol,
});

/** True when the target layer is locked, so the GUI can explain the no-op. */
function isLocked(ctx: GestureContext): boolean {
  return ctx.base.layers.find((l) => l.id === ctx.layerId)?.locked === true;
}

/**
 * A commit effect, plus whatever else the gesture wants to leave behind.
 *
 * Committing an unchanged document is harmless — the store compares identity and
 * adds no entry — so no caller needs to check first.
 */
function commit(doc: TuiDocument, extra: readonly GestureEffect[] = []): GestureEffect[] {
  return [{ t: "commit", doc: sealCommit(doc) }, ...extra];
}

export function reduceGesture(
  tool: ToolId,
  state: GestureState,
  event: GestureEvent,
  ctx: GestureContext,
): GestureStep {
  // Invariant 4: one path for Esc, tool switch, and blur.
  if (event.t === "cancel") {
    if (state.kind === "idle") return idle();
    // A caret is dismissed rather than reverted: the characters already typed are
    // real edits held by the burst, and the controller flushes them.
    if (state.kind === "caret") return idle([{ t: "set-caret", caret: null }]);
    return idle([{ t: "revert" }, { t: "drag-rect", rect: null }]);
  }

  // Right-click eyedrops from any tool, per the spec, and starts no gesture.
  if (event.t === "down" && event.button === 2) {
    return { state, effects: [{ t: "set-brush-from-cell", cell: event.cell }] };
  }

  if (event.t === "clipboard") return reduceClipboard(state, event, ctx);

  if (event.t === "key") {
    // The text tool owns the keyboard when active — it must see printable keys,
    // Enter, Backspace, and the arrows before the global handlers below.
    if (tool === "text") return reduceText(state, event, ctx);
    return reduceKey(state, event, ctx);
  }

  // A pending paste owns the pointer whatever the active tool: ⌘V arms it from
  // anywhere, so the placement gesture cannot live inside one tool's reducer.
  if (state.kind === "paste") return reducePastePlacement(state, event, ctx);

  switch (tool) {
    case "pencil":
      return reducePencil(state, event, ctx);
    case "box":
    case "line":
      return reduceBoxOrLine(tool, state, event, ctx);
    case "select":
      return reduceSelect(state, event, ctx);
    case "text":
      return reduceText(state, event, ctx);
    case "fill":
      return reduceFill(state, event, ctx);
    // G3: no pointer gesture of its own; right-click already eyedrops everywhere.
    case "eyedropper":
      return event.t === "down"
        ? { state, effects: [{ t: "set-brush-from-cell", cell: event.cell }] }
        : { state, effects: [] };
  }
}

/** The rect a pasted block would occupy at its current position. */
const pasteRect = (state: Extract<GestureState, { kind: "paste" }>): Rect => ({
  top: state.at.row,
  left: state.at.col,
  rows: state.clip.rows,
  cols: state.clip.cols,
});

const previewPaste = (
  ctx: GestureContext,
  state: Extract<GestureState, { kind: "paste" }>,
): TuiDocument => pasteRegion(ctx.base, ctx.layerId, state.at, state.clip);

/**
 * Where a fresh paste first lands.
 *
 * Under the pointer normally; the selection's corner when ⌘V is pressed with the
 * pointer off-canvas; the origin when there is neither. Any of the three is
 * immediately draggable, so none of them is a dead end.
 */
function pasteAnchor(ctx: GestureContext): CellPos {
  if (ctx.hover !== null) return ctx.hover;
  if (ctx.selection !== null) return { row: ctx.selection.top, col: ctx.selection.left };
  return { row: 0, col: 0 };
}

/**
 * Copy, cut, and paste — tool-independent, like Delete.
 *
 * Copy is allowed on a locked layer: a lock forbids edits, and reading is not an
 * edit. Cut and paste are not.
 */
function reduceClipboard(
  state: GestureState,
  event: Extract<GestureEvent, { t: "clipboard" }>,
  ctx: GestureContext,
): GestureStep {
  switch (event.action) {
    case "copy":
      if (ctx.selection === null) return { state, effects: [] };
      return {
        state,
        effects: [{ t: "set-clipboard", clip: copyRegion(ctx.base, ctx.layerId, ctx.selection) }],
      };

    case "cut": {
      if (ctx.selection === null) return { state, effects: [] };
      if (isLocked(ctx)) return { state, effects: [{ t: "flash-lock" }] };
      const [doc, clip] = cutRegion(ctx.base, ctx.layerId, ctx.selection);
      return { state, effects: commit(doc, [{ t: "set-clipboard", clip }]) };
    }

    case "paste": {
      // An empty clipboard would arm a placement gesture that can paint nothing,
      // leaving the pointer captured with no way to tell why.
      if (ctx.clipboard === null || Object.keys(ctx.clipboard.cells).length === 0) {
        return { state, effects: [] };
      }
      if (isLocked(ctx)) return { state, effects: [{ t: "flash-lock" }] };
      const next: GestureState = { kind: "paste", clip: ctx.clipboard, at: pasteAnchor(ctx) };
      return {
        state: next,
        effects: [
          { t: "scratch", doc: previewPaste(ctx, next) },
          { t: "drag-rect", rect: pasteRect(next) },
        ],
      };
    }
  }
}

/**
 * Positioning a pending paste: the block tracks the pointer and a press drops it.
 *
 * The press *commits* rather than starting a drag, so the whole paste is one
 * history entry and one undo removes it.
 */
function reducePastePlacement(
  state: Extract<GestureState, { kind: "paste" }>,
  event: PointerGestureEvent,
  ctx: GestureContext,
): GestureStep {
  switch (event.t) {
    case "move": {
      const next: GestureState = { ...state, at: event.cell };
      return {
        state: next,
        effects: [
          { t: "scratch", doc: previewPaste(ctx, next) },
          { t: "drag-rect", rect: pasteRect(next) },
        ],
      };
    }
    case "down": {
      const next = { ...state, at: event.cell };
      return {
        state: IDLE,
        // Selecting what landed makes the paste immediately movable, matching
        // what Esc does when it leaves text-edit mode.
        effects: commit(previewPaste(ctx, next), [{ t: "set-selection", rect: pasteRect(next) }]),
      };
    }
    // The press already committed, so the release that follows it is inert.
    case "up":
      return { state, effects: [] };
  }
}

function reduceKey(
  state: GestureState,
  event: Extract<GestureEvent, { t: "key" }>,
  ctx: GestureContext,
): GestureStep {
  // Delete/Backspace clears the selection. Terminal: it is its own gesture.
  if ((event.key === "Delete" || event.key === "Backspace") && ctx.selection !== null) {
    if (isLocked(ctx)) return { state, effects: [{ t: "flash-lock" }] };
    return { state, effects: commit(clearRect(ctx.base, ctx.layerId, ctx.selection)) };
  }
  return { state, effects: [] };
}

function reducePencil(
  state: GestureState,
  event: PointerGestureEvent,
  ctx: GestureContext,
): GestureStep {
  switch (event.t) {
    case "down": {
      if (isLocked(ctx)) return { state: IDLE, effects: [{ t: "flash-lock" }] };
      const path: NonEmptyPath = [event.cell];
      const axis = event.mods.shift ? axisOf(path) : null;
      return {
        state: { kind: "pencil", path, axis },
        effects: [{ t: "scratch", doc: paintPencil(ctx, path, axis) }],
      };
    }
    case "move": {
      if (state.kind !== "pencil") return { state, effects: [] };
      const path: NonEmptyPath = [...state.path, event.cell];
      // Re-derive the axis each move so pressing Shift mid-drag takes effect.
      const axis = event.mods.shift ? axisOf(path) : null;
      return {
        state: { kind: "pencil", path, axis },
        effects: [{ t: "scratch", doc: paintPencil(ctx, path, axis) }],
      };
    }
    case "up": {
      if (state.kind !== "pencil") return idle();
      const path: NonEmptyPath = [...state.path, event.cell];
      const axis = event.mods.shift ? axisOf(path) : null;
      return { state: IDLE, effects: commit(paintPencil(ctx, path, axis)) };
    }
  }
}

function reduceBoxOrLine(
  tool: "box" | "line",
  state: GestureState,
  event: PointerGestureEvent,
  ctx: GestureContext,
): GestureStep {
  type BoxOrLine = Extract<GestureState, { kind: "box" } | { kind: "line" }>;
  const preview = (s: BoxOrLine): TuiDocument =>
    s.kind === "box" ? previewBox(ctx, s) : previewLine(ctx, s);

  switch (event.t) {
    case "down": {
      if (isLocked(ctx)) return { state: IDLE, effects: [{ t: "flash-lock" }] };
      // Alt inverts merge for the whole gesture, captured at press time.
      const next: BoxOrLine = {
        kind: tool,
        anchor: event.cell,
        current: event.cell,
        merge: !event.mods.alt,
      };
      return { state: next, effects: [{ t: "scratch", doc: preview(next) }] };
    }
    case "move": {
      if (state.kind !== tool) return { state, effects: [] };
      const next: BoxOrLine = { ...state, current: event.cell };
      return { state: next, effects: [{ t: "scratch", doc: preview(next) }] };
    }
    case "up": {
      if (state.kind !== tool) return idle();
      const next: BoxOrLine = { ...state, current: event.cell };
      return { state: IDLE, effects: commit(preview(next)) };
    }
  }
}

function reduceSelect(
  state: GestureState,
  event: PointerGestureEvent,
  ctx: GestureContext,
): GestureStep {
  switch (event.t) {
    case "down": {
      // Pressing inside an existing selection moves it; Alt duplicates.
      if (ctx.selection !== null && rectContains(ctx.selection, event.cell)) {
        if (isLocked(ctx)) return { state: IDLE, effects: [{ t: "flash-lock" }] };
        const next: GestureState = {
          kind: "move-region",
          rect: ctx.selection,
          grab: event.cell,
          current: event.cell,
          duplicate: event.mods.alt,
        };
        return { state: next, effects: [{ t: "scratch", doc: previewMove(ctx, next) }] };
      }
      const next: GestureState = { kind: "marquee", anchor: event.cell, current: event.cell };
      return {
        state: next,
        effects: [{ t: "drag-rect", rect: rectFromCorners(event.cell, event.cell) }],
      };
    }

    case "move": {
      if (state.kind === "marquee") {
        const next: GestureState = { ...state, current: event.cell };
        return {
          state: next,
          effects: [{ t: "drag-rect", rect: rectFromCorners(next.anchor, next.current) }],
        };
      }
      if (state.kind === "move-region") {
        const next: GestureState = { ...state, current: event.cell };
        return { state: next, effects: [{ t: "scratch", doc: previewMove(ctx, next) }] };
      }
      return { state, effects: [] };
    }

    case "up": {
      if (state.kind === "marquee") {
        // A marquee changes no cells, so it commits nothing — just a selection.
        const rect = rectFromCorners(state.anchor, event.cell);
        return {
          state: IDLE,
          effects: [
            { t: "drag-rect", rect: null },
            { t: "set-selection", rect },
          ],
        };
      }
      if (state.kind === "move-region") {
        const next = { ...state, current: event.cell };
        const dRow = next.current.row - next.grab.row;
        const dCol = next.current.col - next.grab.col;
        return {
          state: IDLE,
          effects: commit(previewMove(ctx, next), [
            // The selection follows the moved region, so a further drag works.
            { t: "set-selection", rect: offsetRect(next.rect, dRow, dCol) },
          ]),
        };
      }
      return idle();
    }
  }
}

/**
 * The text tool.
 *
 * A click places the caret; typing edits from there. The caret state deliberately
 * survives pointer-up, so this reducer looks unlike the drag tools.
 *
 * Typed edits emit a `typed` effect rather than a `commit`: the controller owns
 * the typing burst and decides when a run of keystrokes becomes one history
 * entry. That keeps the clock out of this pure function.
 */
function reduceText(
  state: GestureState,
  event: PointerGestureEvent | Extract<GestureEvent, { t: "key" }>,
  ctx: GestureContext,
): GestureStep {
  if (event.t === "down") {
    if (isLocked(ctx)) return { state: IDLE, effects: [{ t: "flash-lock" }] };
    // Placing the caret elsewhere ends the current burst, so each run of typing
    // at a given spot is its own undo step.
    const moved = state.kind === "caret" && !samePos(state.at, event.cell);
    const next: GestureState = {
      kind: "caret",
      origin: event.cell,
      at: event.cell,
      insertMode: state.kind === "caret" ? state.insertMode : false,
    };
    return {
      state: next,
      effects: moved
        ? [
            { t: "typed", doc: ctx.base, caret: event.cell, flush: true, wrote: null },
            { t: "set-caret", caret: event.cell },
          ]
        : [{ t: "set-caret", caret: event.cell }],
    };
  }

  // Dragging with the text tool does nothing; the caret is set on press.
  if (event.t === "move" || event.t === "up") return { state, effects: [] };

  if (state.kind !== "caret") return { state, effects: [] };

  if (event.key === "Insert") {
    return { state: { ...state, insertMode: !state.insertMode }, effects: [] };
  }

  if (isLocked(ctx)) return { state, effects: [{ t: "flash-lock" }] };

  const edit = applyTextKey({
    doc: ctx.base,
    layerId: ctx.layerId,
    caret: state.at,
    origin: state.origin,
    key: event.key,
    style: brushStyle(ctx.brush),
    insertMode: state.insertMode,
  });

  // Enter re-anchors the origin column so a following Enter aligns again.
  const origin = event.key === "Enter" ? { ...edit.caret } : state.origin;

  return {
    state: { kind: "caret", origin, at: edit.caret, insertMode: state.insertMode },
    effects: [
      { t: "typed", doc: edit.doc, caret: edit.caret, flush: edit.flush, wrote: edit.wrote },
      { t: "set-caret", caret: edit.caret },
    ],
  };
}

const samePos = (a: CellPos, b: CellPos): boolean => a.row === b.row && a.col === b.col;

/**
 * The fill tool.
 *
 * A click floods the region under the pointer. Shift fills with the whole brush
 * cell (character, foreground, and background); without it, only the background
 * changes — which is what you want for shading a panel without erasing its
 * contents.
 *
 * Terminal on press: there is no drag, so the commit happens immediately.
 */
function reduceFill(
  state: GestureState,
  event: PointerGestureEvent,
  ctx: GestureContext,
): GestureStep {
  if (event.t !== "down") return { state, effects: [] };
  if (isLocked(ctx)) return { state: IDLE, effects: [{ t: "flash-lock" }] };

  const target = event.mods.shift ? { cell: brushCell(ctx.brush) } : { bg: ctx.brush.bg };
  const filled = floodFill(ctx.base, ctx.layerId, event.cell.row, event.cell.col, target);
  return { state: IDLE, effects: commit(filled) };
}
