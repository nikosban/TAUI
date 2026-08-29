/**
 * Colour-mode conversion.
 *
 * `colorMode` records what the target terminal can display. `toAnsi` and `toSvg`
 * already downgrade on the way out, so changing the mode is *not* required to get
 * correct output — which is exactly why this op exists separately and is never
 * applied implicitly. It **bakes** the downgrade into stored cells, losing
 * information permanently (undo aside), and that has to be a deliberate act.
 *
 * The elegance of storing `ColorRef`: a cell holding a palette reference is not
 * touched here at all. The palette *entry* is downgraded once, and every cell
 * referencing it follows.
 */

import {
  type ColorMode,
  type ColorRef,
  colorEquals,
  downgradeColor,
  isPaletteRef,
} from "../model/color.js";
import type { TuiDocument } from "../model/document.js";
import { mapAllCells } from "../model/draft.js";

/** Downgrades a stored ref, leaving palette references alone. */
const convertRef = (ref: ColorRef, mode: ColorMode): ColorRef =>
  isPaletteRef(ref) ? ref : downgradeColor(ref, mode);

/**
 * Rewrites every colour to what `mode` can express, and sets `doc.colorMode`.
 *
 * Ignores `locked`, like the palette-delete it resembles: this changes what the
 * document can express rather than editing a drawing, and leaving one layer in a
 * richer colour space would make the document internally inconsistent.
 *
 * A widening conversion (ansi16 → rgb) changes no cell — `downgradeColor` leaves a
 * colour poorer than the mode alone rather than expanding it, so ansi16 red stays
 * ansi16 red and keeps honouring the user's theme.
 */
export function convertColorMode(doc: TuiDocument, mode: ColorMode): TuiDocument {
  const palette = doc.palette.map((entry) => {
    const next = downgradeColor(entry.color, mode);
    return colorEquals(next, entry.color) ? entry : { ...entry, color: next };
  });
  const paletteChanged = palette.some((entry, i) => entry !== doc.palette[i]);

  const withCells = mapAllCells(doc, (cell) => {
    const fg = convertRef(cell.fg, mode);
    const bg = convertRef(cell.bg, mode);
    if (fg === cell.fg && bg === cell.bg) return cell;
    return { ...cell, fg, bg };
  });

  if (withCells === doc && !paletteChanged && doc.colorMode === mode) return doc;
  return { ...withCells, colorMode: mode, palette: paletteChanged ? palette : doc.palette };
}

/**
 * How many stored colours {@link convertColorMode} would change.
 *
 * The GUI shows this before converting, in the same spirit as
 * `cellsLostOnResize` — the loss is only recoverable through undo, so it should
 * be stated before it happens, not after.
 *
 * Counted per *colour*, not per cell: a cell whose foreground and background both
 * quantise contributes 2. Palette entries are counted separately, because one
 * entry standing in for a thousand cells is a very different sentence.
 */
export function colorModeLoss(
  doc: TuiDocument,
  mode: ColorMode,
): { readonly cellColors: number; readonly paletteEntries: number } {
  let cellColors = 0;
  for (const layer of doc.layers) {
    for (const cell of Object.values(layer.cells)) {
      for (const ref of [cell.fg, cell.bg]) {
        // A palette reference is unaffected; its entry is counted below.
        if (isPaletteRef(ref)) continue;
        if (!colorEquals(downgradeColor(ref, mode), ref)) cellColors++;
      }
    }
  }

  let paletteEntries = 0;
  for (const entry of doc.palette) {
    if (!colorEquals(downgradeColor(entry.color, mode), entry.color)) paletteEntries++;
  }

  return { cellColors, paletteEntries };
}
