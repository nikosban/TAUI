/**
 * Primitive drawing operations.
 *
 * All ops are no-ops returning the *same* document if the layer is missing,
 * locked, or the coordinates lie fully out of bounds. Partial clipping is silent.
 */

import { assertNarrowChar, type Cell, type CellStyle, splitGraphemes } from "../model/cell.js";
import { inBounds, type Rect, rectCells, type TuiDocument } from "../model/document.js";
import { withLayerDraft } from "../model/draft.js";

export function setCell(
  doc: TuiDocument,
  layerId: string,
  row: number,
  col: number,
  cell: Cell,
): TuiDocument {
  assertNarrowChar(cell.char);
  if (!inBounds(doc, row, col)) return doc;
  return withLayerDraft(doc, layerId, (draft) => {
    draft.set(row, col, cell);
  });
}

/**
 * Writes `text` starting at `(row, col)`. No wrapping — clips at the grid edge.
 *
 * Validation happens up front for the whole string, so a bad character rejects
 * the entire call rather than leaving a half-written row.
 */
export function drawText(
  doc: TuiDocument,
  layerId: string,
  row: number,
  col: number,
  text: string,
  style: CellStyle,
): TuiDocument {
  const chars = splitGraphemes(text);
  for (const char of chars) assertNarrowChar(char);
  if (chars.length === 0) return doc;
  return withLayerDraft(doc, layerId, (draft) => {
    for (const [i, char] of chars.entries()) {
      const target = col + i;
      if (!inBounds(doc, row, target)) continue;
      draft.set(row, target, { ...style, char });
    }
  });
}

export function fillRect(doc: TuiDocument, layerId: string, rect: Rect, cell: Cell): TuiDocument {
  assertNarrowChar(cell.char);
  return withLayerDraft(doc, layerId, (draft) => {
    for (const { row, col } of rectCells(doc, rect)) draft.set(row, col, cell);
  });
}

/** Deletes keys, making the region transparent rather than painting spaces. */
export function clearRect(doc: TuiDocument, layerId: string, rect: Rect): TuiDocument {
  return withLayerDraft(doc, layerId, (draft) => {
    for (const { row, col } of rectCells(doc, rect)) draft.delete(row, col);
  });
}
