/**
 * Flattens layers into a dense grid, resolving palette references.
 *
 * This is the choke point that guarantees renderers never see an unresolved
 * `ColorRef`. It returns {@link ResolvedCell}, a type distinct from `Cell`, so a
 * renderer touching a palette ref is a *compile error* rather than a convention
 * someone has to remember.
 */

import type { Cell } from "../model/cell.js";
import { type Color, DEFAULT_COLOR, resolveColor } from "../model/color.js";
import type { TuiDocument } from "../model/document.js";
import { parseCellKey } from "../model/layer.js";

/** A Cell whose colors are guaranteed raw — no palette references. */
export interface ResolvedCell {
  readonly char: string;
  readonly fg: Color;
  readonly bg: Color;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
}

/** Dense `rows` × `cols` grid. */
export type ResolvedGrid = readonly (readonly ResolvedCell[])[];

/** A cell covered by no visible layer. Carries no style flags. */
const EMPTY_CELL: ResolvedCell = { char: " ", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR };

function resolveCell(doc: TuiDocument, cell: Cell): ResolvedCell {
  const resolved: {
    char: string;
    fg: Color;
    bg: Color;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
  } = {
    char: cell.char,
    fg: resolveColor(doc, cell.fg),
    bg: resolveColor(doc, cell.bg),
  };
  // Copy style flags only when present, so absent stays absent.
  if (cell.bold !== undefined) resolved.bold = cell.bold;
  if (cell.italic !== undefined) resolved.italic = cell.italic;
  if (cell.underline !== undefined) resolved.underline = cell.underline;
  if (cell.inverse !== undefined) resolved.inverse = cell.inverse;
  return resolved;
}

export interface CompositeOptions {
  /**
   * Skips layers flagged `excludeFromHandoff`. Used by panel detection (M6) so
   * decorative box characters aren't mistaken for panels.
   */
  readonly excludeHandoff?: boolean;
}

/**
 * Flattens to a dense grid. The topmost *visible* layer wins per cell; cells
 * covered by no layer become `{ char: " ", fg: default, bg: default }`.
 */
export function composite(doc: TuiDocument, opts: CompositeOptions = {}): ResolvedGrid {
  const grid: ResolvedCell[][] = Array.from({ length: doc.rows }, () =>
    Array.from({ length: doc.cols }, () => EMPTY_CELL),
  );

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    if (opts.excludeHandoff === true && layer.excludeFromHandoff === true) continue;
    // Iterate the sparse map, not the full grid: layers are mostly empty, so this
    // is proportional to painted cells rather than to rows*cols per layer.
    for (const [key, cell] of Object.entries(layer.cells)) {
      const pos = parseCellKey(key);
      if (pos === null) continue;
      const target = grid[pos.row];
      if (target === undefined) continue; // out-of-bounds key, e.g. hand-edited file
      if (pos.col < 0 || pos.col >= doc.cols) continue;
      target[pos.col] = resolveCell(doc, cell);
    }
  }

  return grid;
}
