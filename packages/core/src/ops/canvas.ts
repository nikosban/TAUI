/**
 * Document-geometry operations: resize, crop, shift.
 *
 * All three remap every layer's sparse keys, and all three are **destructive** —
 * cells falling outside the new bounds are dropped, not clamped. The GUI must warn
 * before shrinking.
 *
 * Locked layers are remapped like any other: the lock protects against edits, not
 * against the document changing shape underneath. See `remapAllLayers`.
 */

import { clipRect, type Rect, type TuiDocument } from "../model/document.js";
import { remapAllLayers } from "../model/draft.js";
import { assertDocumentDimensions, ResourceLimitError } from "../model/resource-policy.js";

export type ResizeAnchor = "top-left" | "center";

/**
 * The offset applied to existing content for a given anchor.
 *
 * The centre rounding is **pinned to `Math.floor(delta / 2)`** and must not be
 * changed: the required `cropToRect ≡ shiftAll + resizeDocument` equivalence holds
 * for exactly one rounding choice, and this is it. Growing 80→81 columns therefore
 * shifts content by 0, not 1.
 */
export function resizeOffset(
  from: { cols: number; rows: number },
  to: { cols: number; rows: number },
  anchor: ResizeAnchor,
): { dRow: number; dCol: number } {
  if (anchor === "top-left") return { dRow: 0, dCol: 0 };
  return {
    dRow: Math.floor((to.rows - from.rows) / 2),
    dCol: Math.floor((to.cols - from.cols) / 2),
  };
}

/**
 * Changes the grid size, keeping content anchored.
 *
 * Growing loses nothing. Shrinking drops every cell outside the new bounds.
 * `palette` and `activeLayerId` are preserved.
 */
export function resizeDocument(
  doc: TuiDocument,
  cols: number,
  rows: number,
  anchor: ResizeAnchor = "top-left",
): TuiDocument {
  assertDocumentDimensions(cols, rows);
  if (cols === doc.cols && rows === doc.rows) return doc;

  const { dRow, dCol } = resizeOffset(doc, { cols, rows }, anchor);
  const moved = remapAllLayers(doc, ({ row, col }) => {
    const to = { row: row + dRow, col: col + dCol };
    if (to.row < 0 || to.col < 0 || to.row >= rows || to.col >= cols) return null;
    return to;
  });
  return { ...moved, cols, rows };
}

/**
 * Moves every layer's contents by a delta, keeping the grid size.
 *
 * Cells pushed outside the grid are dropped — shifting right then left does not
 * restore them.
 */
export function shiftAll(doc: TuiDocument, dRow: number, dCol: number): TuiDocument {
  if (dRow === 0 && dCol === 0) return doc;
  return remapAllLayers(doc, ({ row, col }) => {
    const to = { row: row + dRow, col: col + dCol };
    if (to.row < 0 || to.col < 0 || to.row >= doc.rows || to.col >= doc.cols) return null;
    return to;
  });
}

/**
 * Crops to `rect`: the new grid is the rect's size and its contents move to (0,0).
 *
 * Exactly equivalent to `shiftAll(-rect.top, -rect.left)` followed by
 * `resizeDocument(rect.cols, rect.rows, "top-left")` — asserted in
 * `test/canvas.test.ts`, and the reason the centre rounding above is pinned.
 *
 * A rect lying entirely outside the document yields an empty document of the
 * requested size rather than throwing: cropping to nothing is a legitimate, if
 * unhelpful, request.
 */
export function cropToRect(doc: TuiDocument, rect: Rect): TuiDocument {
  try {
    assertDocumentDimensions(rect.cols, rect.rows);
  } catch (error) {
    const message = (error as Error).message
      .replace(/^cols/u, "rect.cols")
      .replace(/^rows/u, "rect.rows");
    throw new (error instanceof ResourceLimitError ? ResourceLimitError : RangeError)(message);
  }

  const moved = remapAllLayers(doc, ({ row, col }) => {
    const to = { row: row - rect.top, col: col - rect.left };
    if (to.row < 0 || to.col < 0 || to.row >= rect.rows || to.col >= rect.cols) return null;
    return to;
  });
  return { ...moved, cols: rect.cols, rows: rect.rows };
}

/**
 * How many painted cells a resize would discard.
 *
 * The GUI calls this to warn *before* shrinking, since the loss is not undoable
 * except through history. Counts each layer separately, so a cell covered on two
 * layers counts twice — that is what the user is actually losing.
 */
export function cellsLostOnResize(
  doc: TuiDocument,
  cols: number,
  rows: number,
  anchor: ResizeAnchor = "top-left",
): number {
  const { dRow, dCol } = resizeOffset(doc, { cols, rows }, anchor);
  let lost = 0;
  for (const layer of doc.layers) {
    for (const key of Object.keys(layer.cells)) {
      const comma = key.indexOf(",");
      const row = Number(key.slice(0, comma)) + dRow;
      const col = Number(key.slice(comma + 1)) + dCol;
      if (row < 0 || col < 0 || row >= rows || col >= cols) lost++;
    }
  }
  return lost;
}

/** How many painted cells a crop would discard. */
export function cellsLostOnCrop(doc: TuiDocument, rect: Rect): number {
  const clipped = clipRect(doc, rect);
  let total = 0;
  let kept = 0;
  for (const layer of doc.layers) {
    for (const key of Object.keys(layer.cells)) {
      total++;
      if (clipped === null) continue;
      const comma = key.indexOf(",");
      const row = Number(key.slice(0, comma));
      const col = Number(key.slice(comma + 1));
      if (
        row >= clipped.top &&
        row < clipped.top + clipped.rows &&
        col >= clipped.left &&
        col < clipped.left + clipped.cols
      ) {
        kept++;
      }
    }
  }
  return total - kept;
}
