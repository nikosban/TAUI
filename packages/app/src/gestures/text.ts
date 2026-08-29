/**
 * Text-tool semantics. Pure transforms over a document.
 *
 * The decisions here are the spec's, written down so nobody re-invents them:
 *
 * - **Overwrite by default.** The grid has no reflow, so terminal-faithful
 *   behaviour is to replace the cell under the caret. `Insert` toggles insert
 *   mode, which shifts the remainder of *that row only* right; cells pushed past
 *   the last column are lost.
 * - **`Enter` returns to the column where typing began**, not to column 0 — that
 *   is how people actually type a stack of labels into a mockup.
 * - **`Backspace` moves left and clears to transparent**; `Delete` clears in
 *   place without moving. Neither attempts junction repair on box characters: a
 *   cleared cell is simply cleared (v1 limitation, per the core spec).
 * - **No wrap.** Typing past the last column stops.
 *
 * Insert mode is built from `copyRegion`/`pasteRegion` rather than a new core op:
 * copy the tail of the row, paste it one column right, then write into the gap.
 * The "pushed past the last column is lost" rule falls out of paste clipping.
 */

import {
  type CellStyle,
  clearRect,
  copyRegion,
  isNarrowSingle,
  pasteRegion,
  setCell,
  type TuiDocument,
} from "@tui-designer/core";
import type { CellPos } from "../canvas/metrics.js";

export interface TextEdit {
  readonly doc: TuiDocument;
  readonly caret: CellPos;
  /** True when this edit should end the current typing burst. */
  readonly flush: boolean;
  /**
   * The cell this keypress actually changed, or `null` for pure navigation.
   *
   * Reported so a typing burst can accumulate the exact extent of what was
   * written — which becomes the selection when Esc leaves edit mode. Deriving it
   * from caret positions instead would overshoot by one on the trailing caret.
   */
  readonly wrote: CellPos | null;
}

/** Keys handled by the text tool that are not printable characters. */
const CONTROL_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Insert",
  "Tab",
  "Escape",
]);

/**
 * True when the key should be written into a cell.
 *
 * A printable key is a single narrow grapheme — which also filters out `"Shift"`,
 * `"F5"`, and dead keys without needing a list of them.
 */
export function isPrintable(key: string): boolean {
  return !CONTROL_KEYS.has(key) && isNarrowSingle(key);
}

const clampCaret = (doc: TuiDocument, pos: CellPos): CellPos => ({
  row: Math.max(0, Math.min(doc.rows - 1, pos.row)),
  col: Math.max(0, Math.min(doc.cols - 1, pos.col)),
});

/**
 * Shifts a row's tail one column right, dropping whatever falls off the end.
 *
 * Precondition: `at.col` is a valid column, which holds because every caret is
 * clamped by {@link clampCaret} before reaching here — so the tail is always at
 * least one cell wide and needs no guard.
 */
function insertGap(doc: TuiDocument, layerId: string, at: CellPos): TuiDocument {
  const tailCols = doc.cols - at.col;
  const clip = copyRegion(doc, layerId, {
    top: at.row,
    left: at.col,
    rows: 1,
    cols: tailCols,
  });
  // Clear the tail first: paste is sparse, so without this any cell that was
  // transparent in the source would leave the old character behind.
  const cleared = clearRect(doc, layerId, { top: at.row, left: at.col, rows: 1, cols: tailCols });
  return pasteRegion(cleared, layerId, { row: at.row, col: at.col + 1 }, clip);
}

export interface TextKeyOptions {
  readonly doc: TuiDocument;
  readonly layerId: string;
  readonly caret: CellPos;
  /** Column typing began in, for Enter. */
  readonly origin: CellPos;
  readonly key: string;
  readonly style: CellStyle;
  readonly insertMode: boolean;
}

/**
 * Applies one keypress. Returns the new document and caret.
 *
 * Returns the document unchanged for keys that only move the caret, so the caller
 * can tell an edit from a navigation.
 */
export function applyTextKey(opts: TextKeyOptions): TextEdit {
  const { doc, layerId, caret, origin, key, style, insertMode } = opts;
  const stay = (next: CellPos, flush: boolean): TextEdit => ({
    doc,
    caret: clampCaret(doc, next),
    flush,
    wrote: null,
  });

  switch (key) {
    case "Enter":
      // Column-aligned newline: back to where typing began, one row down.
      return stay({ row: caret.row + 1, col: origin.col }, true);

    case "ArrowLeft":
      return stay({ row: caret.row, col: caret.col - 1 }, true);
    case "ArrowRight":
      return stay({ row: caret.row, col: caret.col + 1 }, true);
    case "ArrowUp":
      return stay({ row: caret.row - 1, col: caret.col }, true);
    case "ArrowDown":
      return stay({ row: caret.row + 1, col: caret.col }, true);
    case "Home":
      return stay({ row: caret.row, col: 0 }, true);
    case "End":
      return stay({ row: caret.row, col: doc.cols - 1 }, true);

    case "Backspace": {
      // Move left, then clear — so it deletes the character just typed.
      const target = clampCaret(doc, { row: caret.row, col: caret.col - 1 });
      if (caret.col === 0) return stay(caret, false);
      return {
        doc: clearRect(doc, layerId, { top: target.row, left: target.col, rows: 1, cols: 1 }),
        caret: target,
        flush: false,
        wrote: target,
      };
    }

    case "Delete":
      return {
        doc: clearRect(doc, layerId, { top: caret.row, left: caret.col, rows: 1, cols: 1 }),
        caret,
        flush: false,
        wrote: caret,
      };

    default: {
      if (!isPrintable(key)) return stay(caret, false);
      const shifted = insertMode ? insertGap(doc, layerId, caret) : doc;
      const written = setCell(shifted, layerId, caret.row, caret.col, { ...style, char: key });
      // No wrap: typing in the last column writes but the caret stays put.
      const next = caret.col + 1 >= doc.cols ? caret : { row: caret.row, col: caret.col + 1 };
      return { doc: written, caret: next, flush: false, wrote: caret };
    }
  }
}
