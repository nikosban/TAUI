/**
 * Rectangular region operations: copy, cut, paste, move.
 */

import type { Cell } from "../model/cell.js";
import { clipRect, inBounds, type Rect, type TuiDocument } from "../model/document.js";
import { withLayerDraft } from "../model/draft.js";
import { cellKey, parseCellKey } from "../model/layer.js";

/**
 * A copied region.
 *
 * Cell keys are **relative to the clipboard's own origin** (0,0), not to the
 * document they came from. That relativity is what makes paste-at-arbitrary-point
 * work, and it means `rows`/`cols` describe the clipboard's extent rather than
 * any position. Sparse, so transparent cells within the region stay transparent
 * and do not overwrite on paste.
 */
export interface Clipboard {
  readonly rows: number;
  readonly cols: number;
  readonly cells: Readonly<Record<string, Cell>>;
}

export const EMPTY_CLIPBOARD: Clipboard = { rows: 0, cols: 0, cells: {} };

/**
 * Copies a region. The clipboard's extent is the *requested* rect, clipped to the
 * document — so pasting a partially-off-grid copy preserves the relative
 * positions of the cells that existed.
 */
export function copyRegion(doc: TuiDocument, layerId: string, rect: Rect): Clipboard {
  const layer = doc.layers.find((l) => l.id === layerId);
  const clipped = clipRect(doc, rect);
  if (layer === undefined || clipped === null) return EMPTY_CLIPBOARD;

  const cells: Record<string, Cell> = {};
  for (let row = clipped.top; row < clipped.top + clipped.rows; row++) {
    for (let col = clipped.left; col < clipped.left + clipped.cols; col++) {
      const cell = layer.cells[cellKey(row, col)];
      if (cell === undefined) continue;
      // Rebase onto the clipboard's own origin.
      cells[cellKey(row - rect.top, col - rect.left)] = cell;
    }
  }
  return { rows: rect.rows, cols: rect.cols, cells };
}

export function cutRegion(doc: TuiDocument, layerId: string, rect: Rect): [TuiDocument, Clipboard] {
  const clip = copyRegion(doc, layerId, rect);
  const next = withLayerDraft(doc, layerId, (draft) => {
    const clipped = clipRect(doc, rect);
    if (clipped === null) return;
    for (let row = clipped.top; row < clipped.top + clipped.rows; row++) {
      for (let col = clipped.left; col < clipped.left + clipped.cols; col++) {
        draft.delete(row, col);
      }
    }
  });
  return [next, clip];
}

/**
 * Pastes at `at`, which becomes the clipboard's origin.
 *
 * Transparent cells in the clipboard do not overwrite: the clipboard is sparse,
 * so only recorded cells are written. Cells landing outside the document are
 * silently clipped.
 */
export function pasteRegion(
  doc: TuiDocument,
  layerId: string,
  at: { row: number; col: number },
  clip: Clipboard,
): TuiDocument {
  const entries = Object.entries(clip.cells);
  if (entries.length === 0) return doc;
  return withLayerDraft(doc, layerId, (draft) => {
    for (const [key, cell] of entries) {
      const offset = parseCellKey(key);
      if (offset === null) continue;
      const row = at.row + offset.row;
      const col = at.col + offset.col;
      if (!inBounds(doc, row, col)) continue;
      draft.set(row, col, cell);
    }
  });
}

/**
 * Moves a region by a delta, clearing the source.
 *
 * Source and destination may overlap: the region is read in full before anything
 * is written, so the overlap does not corrupt the result. Cells moved off-grid are
 * dropped.
 */
export function moveRegion(
  doc: TuiDocument,
  layerId: string,
  rect: Rect,
  dRow: number,
  dCol: number,
): TuiDocument {
  if (dRow === 0 && dCol === 0) return doc;
  const clipped = clipRect(doc, rect);
  const layer = doc.layers.find((l) => l.id === layerId);
  if (clipped === null || layer === undefined) return doc;

  // Snapshot the cells being moved before touching anything, so an overlapping
  // source and destination cannot corrupt the result. Note this reads absolute
  // positions directly rather than going through a Clipboard: the round trip
  // would add a key-parsing step whose failure case cannot occur here.
  const moving: { row: number; col: number; cell: Cell }[] = [];
  for (let row = clipped.top; row < clipped.top + clipped.rows; row++) {
    for (let col = clipped.left; col < clipped.left + clipped.cols; col++) {
      const cell = layer.cells[cellKey(row, col)];
      if (cell !== undefined) moving.push({ row, col, cell });
    }
  }

  return withLayerDraft(doc, layerId, (draft) => {
    for (let row = clipped.top; row < clipped.top + clipped.rows; row++) {
      for (let col = clipped.left; col < clipped.left + clipped.cols; col++) {
        draft.delete(row, col);
      }
    }
    for (const { row, col, cell } of moving) {
      const target = { row: row + dRow, col: col + dCol };
      if (!inBounds(doc, target.row, target.col)) continue;
      draft.set(target.row, target.col, cell);
    }
  });
}
