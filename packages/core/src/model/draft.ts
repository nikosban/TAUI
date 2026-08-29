/**
 * INTERNAL — never exported from `index.ts`.
 *
 * The immutability-vs-performance contract. Every public op returns a new
 * document, but a naive `{...layer.cells}` per `setCell` makes a 30 000-cell
 * flood fill roughly 9e8 key writes — a multi-second hang.
 *
 * The convention: **public API immutable, internals mutate a draft they
 * exclusively own.** Exactly one shallow copy per public op, no matter how many
 * cells it touches.
 *
 * Two guarantees callers depend on:
 *
 * 1. **Referential-equality no-op.** If the layer is missing, locked, or nothing
 *    actually changed, the *same* document object comes back. The spec requires
 *    this ("ops are no-ops if the layer is locked") and zustand/React need it to
 *    skip re-renders.
 * 2. **Structural sharing.** Untouched layers are `===` across an op.
 *
 * A draft must never escape its callback.
 */

import type { Cell } from "./cell.js";
import type { TuiDocument } from "./document.js";
import { cellKey, parseCellKey } from "./layer.js";

/** A mutable, exclusively-owned view over one layer's sparse cell map. */
export interface LayerDraft {
  readonly layerId: string;
  get(row: number, col: number): Cell | undefined;
  set(row: number, col: number, cell: Cell): void;
  /** Makes the cell transparent by deleting its key. */
  delete(row: number, col: number): void;
  /** True once any `set`/`delete` actually changed something. */
  readonly dirty: boolean;
}

interface MutableDraft extends LayerDraft {
  readonly cells: Record<string, Cell>;
}

function createDraft(layerId: string, source: Readonly<Record<string, Cell>>): MutableDraft {
  const cells: Record<string, Cell> = { ...source }; // THE single copy
  let dirty = false;
  return {
    layerId,
    cells,
    get: (row, col) => cells[cellKey(row, col)],
    set: (row, col, cell) => {
      cells[cellKey(row, col)] = cell;
      dirty = true;
    },
    delete: (row, col) => {
      const key = cellKey(row, col);
      if (key in cells) {
        delete cells[key];
        dirty = true;
      }
    },
    get dirty() {
      return dirty;
    },
  };
}

export interface WithLayerDraftOptions {
  /**
   * Bypasses the `locked` check. The *only* legitimate user is
   * `deletePaletteEntry`, which must bake resolved colors into every referencing
   * cell — including on locked layers — or it would leave dangling refs and
   * violate the no-dangling-refs invariant. Documented as the sole exception.
   */
  readonly ignoreLock?: boolean;
}

/**
 * Runs `fn` against a mutable draft of one layer and returns a new document.
 *
 * Returns the same `doc` object if the layer is missing, locked, or `fn` made no
 * change.
 */
export function withLayerDraft(
  doc: TuiDocument,
  layerId: string,
  fn: (draft: LayerDraft) => void,
  opts: WithLayerDraftOptions = {},
): TuiDocument {
  const index = doc.layers.findIndex((l) => l.id === layerId);
  if (index === -1) return doc;
  const layer = doc.layers[index];
  if (layer === undefined) return doc;
  if (layer.locked && opts.ignoreLock !== true) return doc;

  const draft = createDraft(layerId, layer.cells);
  fn(draft);
  if (!draft.dirty) return doc;

  const layers = doc.layers.slice();
  layers[index] = { ...layer, cells: draft.cells };
  return { ...doc, layers };
}

/**
 * Rebuilds every layer's cell map through `remap`, for the canvas-geometry ops.
 *
 * Two things differ from {@link withLayerDraft}, both deliberate:
 *
 * 1. **Locked layers are remapped too.** Resizing or shifting a document must
 *    move every layer or the document becomes internally inconsistent — cells
 *    stranded outside the new bounds, layers disagreeing about where content is.
 *    This is document surgery, not a drawing operation, so the lock (which exists
 *    to protect against *edits*) does not apply.
 * 2. **The whole map is replaced**, not edited in place, because a key remap can
 *    move any cell anywhere and an in-place version would need a scratch copy
 *    regardless.
 *
 * `remap` returns the new position for a cell, or `null` to drop it — which is
 * how cells falling outside a shrunken document are discarded.
 */
export function remapAllLayers(
  doc: TuiDocument,
  remap: (pos: { row: number; col: number }) => { row: number; col: number } | null,
): TuiDocument {
  const layers = doc.layers.map((layer) => {
    const cells: Record<string, Cell> = {};
    for (const [key, cell] of Object.entries(layer.cells)) {
      const from = parseCellKey(key);
      if (from === null) continue; // malformed key from a hand-edited file
      const to = remap(from);
      if (to === null) continue;
      cells[cellKey(to.row, to.col)] = cell;
    }
    return { ...layer, cells };
  });
  return { ...doc, layers };
}

/**
 * Rewrites every cell of every layer through `map`, for the palette and
 * colour-mode ops.
 *
 * The colour analogue of {@link remapAllLayers}, and locked layers are included
 * for the same reason: deleting a palette entry or narrowing `colorMode` changes
 * what the document *means*, and leaving a locked layer behind would strand it
 * referencing an entry that no longer exists. A lock protects against edits, not
 * against the document's colour space changing underneath.
 *
 * `map` must return **the same object** when it changes nothing. That is what
 * lets this preserve referential equality — both for the whole document and for
 * each untouched layer — so a no-op conversion adds no history entry and React
 * skips the re-render.
 */
export function mapAllCells(doc: TuiDocument, map: (cell: Cell) => Cell): TuiDocument {
  let anyChanged = false;
  const layers = doc.layers.map((layer) => {
    let layerChanged = false;
    const cells: Record<string, Cell> = {};
    for (const [key, cell] of Object.entries(layer.cells)) {
      const next = map(cell);
      if (next !== cell) layerChanged = true;
      cells[key] = next;
    }
    if (!layerChanged) return layer;
    anyChanged = true;
    return { ...layer, cells };
  });
  return anyChanged ? { ...doc, layers } : doc;
}
