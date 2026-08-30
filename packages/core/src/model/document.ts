/**
 * The document: plain data, serializable with `JSON.stringify`, no classes.
 */

import type { Cell } from "./cell.js";
import type { ColorMode, PaletteEntry } from "./color.js";
import { cellKey, createLayer, type Layer } from "./layer.js";
import { assertDocumentDimensions } from "./resource-policy.js";

export const CURRENT_VERSION = 1 as const;

export interface TuiDocument {
  readonly version: typeof CURRENT_VERSION;
  /** Grid width in cells. */
  readonly cols: number;
  /** Grid height in cells. */
  readonly rows: number;
  readonly colorMode: ColorMode;
  /** Index 0 is the bottom layer. */
  readonly layers: readonly Layer[];
  readonly activeLayerId: string;
  /** Named colors for token export; may be empty. */
  readonly palette: readonly PaletteEntry[];
}

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly rows: number;
  readonly cols: number;
}

/**
 * Id generator. Injectable everywhere an id is minted so that snapshot tests can
 * supply a deterministic counter — random ids would make the inline-snapshot
 * strategy unusable.
 */
export type IdGen = () => string;

export const defaultIdGen: IdGen = () => crypto.randomUUID();

/** A counter-based generator for tests: `l1`, `l2`, … */
export function sequentialIdGen(prefix = "l"): IdGen {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export interface CreateDocumentOptions {
  readonly colorMode?: ColorMode;
  readonly idGen?: IdGen;
  readonly layerName?: string;
}

export function createDocument(
  cols: number,
  rows: number,
  opts: CreateDocumentOptions = {},
): TuiDocument {
  assertDocumentDimensions(cols, rows);
  const idGen = opts.idGen ?? defaultIdGen;
  const layer = createLayer(idGen(), opts.layerName ?? "Layer 1");
  return {
    version: CURRENT_VERSION,
    cols,
    rows,
    colorMode: opts.colorMode ?? "ansi256",
    layers: [layer],
    activeLayerId: layer.id,
    palette: [],
  };
}

export const inBounds = (doc: TuiDocument, row: number, col: number): boolean =>
  row >= 0 && row < doc.rows && col >= 0 && col < doc.cols;

export const findLayer = (doc: TuiDocument, layerId: string): Layer | undefined =>
  doc.layers.find((l) => l.id === layerId);

/**
 * The cell a viewer sees at `(row, col)`: the topmost **visible** layer's, or
 * `undefined` where no visible layer has painted.
 *
 * Deliberately returns the stored {@link Cell}, not a `ResolvedCell` — palette
 * references survive, which is what an eyedropper wants. Sampling from
 * `composite` instead would bake the colour and silently break the link to the
 * palette entry.
 *
 * Same stacking rule as `composite`, expressed as a reverse scan rather than a
 * bottom-up overwrite: identical outcome, but it stops at the first hit instead
 * of flattening the whole document to read one cell.
 */
export function cellAt(doc: TuiDocument, row: number, col: number): Cell | undefined {
  if (!inBounds(doc, row, col)) return undefined;
  const key = cellKey(row, col);
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i] as Layer;
    if (!layer.visible) continue;
    const cell = layer.cells[key];
    if (cell !== undefined) return cell;
  }
  return undefined;
}

/** Clips `rect` to the document, or returns null if it lies entirely outside. */
export function clipRect(doc: TuiDocument, rect: Rect): Rect | null {
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  const bottom = Math.min(doc.rows, rect.top + rect.rows);
  const right = Math.min(doc.cols, rect.left + rect.cols);
  if (bottom <= top || right <= left) return null;
  return { top, left, rows: bottom - top, cols: right - left };
}

/** Iterates every in-bounds cell of `rect` in row-major order. */
export function* rectCells(doc: TuiDocument, rect: Rect): Generator<{ row: number; col: number }> {
  const clipped = clipRect(doc, rect);
  if (clipped === null) return;
  for (let row = clipped.top; row < clipped.top + clipped.rows; row++) {
    for (let col = clipped.left; col < clipped.left + clipped.cols; col++) {
      yield { row, col };
    }
  }
}
