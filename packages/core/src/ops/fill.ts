/**
 * Flood fill.
 *
 * Four-connected over the *active layer's* cells, not the composite: filling is
 * an edit to one layer, so what you can reach is what that layer contains.
 *
 * "Same region" means **equal character and equal resolved background**. The
 * common case is filling contiguous whitespace inside a box, which works because
 * a transparent cell is treated as `" "` with the default background — exactly
 * what it composites to. Without that equivalence, a fill would stop dead at the
 * boundary between "never painted" and "painted with a space".
 *
 * The implementation uses an **explicit stack**: a recursive flood over a 300×100
 * grid blows the call stack.
 */

import { type Cell, cellEquals } from "../model/cell.js";
import {
  type Color,
  type ColorRef,
  colorEquals,
  DEFAULT_COLOR,
  resolveColor,
} from "../model/color.js";
import { findLayer, inBounds, type TuiDocument } from "../model/document.js";
import { withLayerDraft } from "../model/draft.js";
import { cellKey } from "../model/layer.js";

/**
 * What to change in the filled region.
 *
 * - `{ bg }` — recolour the background, keeping each cell's character and
 *   foreground. Transparent cells become explicit spaces.
 * - `{ fg }` — recolour the foreground of cells that *have* a glyph. Transparent
 *   cells are traversed but not written: colouring the foreground of nothing
 *   would create an invisible cell.
 * - `{ cell }` — replace each cell wholesale.
 */
export type FillTarget =
  | { readonly bg: ColorRef }
  | { readonly fg: ColorRef }
  | { readonly cell: Cell };

/** The identity a cell contributes to region membership. */
interface Signature {
  readonly char: string;
  readonly bg: Color;
}

/** A transparent cell reads as a default-background space — what it composites to. */
const TRANSPARENT: Signature = { char: " ", bg: DEFAULT_COLOR };

function signatureOf(doc: TuiDocument, cell: Cell | undefined): Signature {
  if (cell === undefined) return TRANSPARENT;
  return { char: cell.char, bg: resolveColor(doc, cell.bg) };
}

const sameSignature = (a: Signature, b: Signature): boolean =>
  a.char === b.char && colorEquals(a.bg, b.bg);

/**
 * The cell to write, or `undefined` to leave the position alone.
 *
 * Returning `undefined` still lets the traversal continue through the position —
 * membership and mutation are separate decisions.
 */
function fillCell(existing: Cell | undefined, target: FillTarget): Cell | undefined {
  if ("cell" in target) return target.cell;
  if ("bg" in target) {
    if (existing !== undefined) return { ...existing, bg: target.bg };
    // Materialising a transparent cell as a default-background space would add a
    // cell indistinguishable from the transparency it replaced — invisible, and
    // one wasted entry per cell in the region. A caller who genuinely wants a
    // painted space (to occlude a lower layer) passes `{ cell }` with an explicit
    // space instead.
    if (target.bg.kind === "default") return undefined;
    return { char: " ", fg: DEFAULT_COLOR, bg: target.bg };
  }
  // { fg }: only meaningful where there is already a glyph.
  return existing === undefined ? undefined : { ...existing, fg: target.fg };
}

/**
 * Fills the region connected to `(row, col)` on `layerId`.
 *
 * A no-op returning the same document if the layer is missing or locked, the
 * seed is out of bounds, or nothing would change.
 */
export function floodFill(
  doc: TuiDocument,
  layerId: string,
  row: number,
  col: number,
  target: FillTarget,
): TuiDocument {
  if (!inBounds(doc, row, col)) return doc;
  const layer = findLayer(doc, layerId);
  if (layer === undefined) return doc;

  const seed = signatureOf(doc, layer.cells[cellKey(row, col)]);

  return withLayerDraft(doc, layerId, (draft) => {
    const stack: { row: number; col: number }[] = [{ row, col }];
    const seen = new Set<string>([cellKey(row, col)]);

    // The pop is the loop condition: a separate `stack.length > 0` check would
    // make this `undefined` branch unreachable and permanently uncovered.
    for (let pos = stack.pop(); pos !== undefined; pos = stack.pop()) {
      // Read from the *original* layer, never the draft. Membership must be
      // decided against the pre-fill state, or recolouring a cell would let the
      // fill escape its own region through the cells it just wrote.
      const existing = layer.cells[cellKey(pos.row, pos.col)];
      if (!sameSignature(signatureOf(doc, existing), seed)) continue;

      const next = fillCell(existing, target);
      // Skip writes that change nothing, so filling default-over-default returns
      // the identical document instead of pushing an empty undo entry.
      if (next !== undefined && !(existing !== undefined && cellEquals(existing, next))) {
        draft.set(pos.row, pos.col, next);
      }

      for (const [dRow, dCol] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const neighbour = { row: pos.row + dRow, col: pos.col + dCol };
        if (!inBounds(doc, neighbour.row, neighbour.col)) continue;
        const key = cellKey(neighbour.row, neighbour.col);
        if (seen.has(key)) continue;
        seen.add(key);
        stack.push(neighbour);
      }
    }
  });
}
