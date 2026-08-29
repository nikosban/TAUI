/**
 * Palette operations.
 *
 * The payoff of storing `ColorRef` rather than `Color` shows up here: **rename and
 * recolour touch no cells at all.** Restyling a whole document is a one-entry
 * change to the palette array, which is why the format uses references in the
 * first place. Tests assert that by referential equality on `doc.layers`.
 *
 * Delete is the exception, and the only mutation in the codebase that
 * deliberately **ignores `locked`** — see {@link removePaletteEntry}.
 */

import type { PaletteEntry } from "../model/color.js";
import {
  type Color,
  type ColorRef,
  colorEquals,
  colorRangeHint,
  DEFAULT_COLOR,
  isPaletteRef,
  isValidColor,
} from "../model/color.js";
import { defaultIdGen, type IdGen, type TuiDocument } from "../model/document.js";
import { mapAllCells } from "../model/draft.js";

export interface AddPaletteEntryOptions {
  readonly idGen?: IdGen;
}

export const findPaletteEntry = (doc: TuiDocument, id: string): PaletteEntry | undefined =>
  doc.palette.find((entry) => entry.id === id);

/** Throws on an out-of-range colour, matching `setCell`'s treatment of a bad char. */
function assertValidColor(color: Color): void {
  if (!isValidColor(color)) {
    throw new RangeError(
      `invalid palette colour ${JSON.stringify(color)}: ${colorRangeHint(color.kind)}`,
    );
  }
}

/**
 * Adds an entry and returns the new document.
 *
 * A palette entry's colour is a raw {@link Color}, never a reference — the format
 * validator rejects a palette entry pointing at another entry, so there is no
 * chain to resolve and no cycle to detect.
 */
export function addPaletteEntry(
  doc: TuiDocument,
  name: string,
  color: Color,
  opts: AddPaletteEntryOptions = {},
): TuiDocument {
  assertValidColor(color);
  const id = (opts.idGen ?? defaultIdGen)();
  return { ...doc, palette: [...doc.palette, { id, name, color }] };
}

/** Renames an entry. **Touches no cells.** */
export function renamePaletteEntry(doc: TuiDocument, id: string, name: string): TuiDocument {
  const entry = findPaletteEntry(doc, id);
  if (entry === undefined || entry.name === name) return doc;
  return {
    ...doc,
    palette: doc.palette.map((p) => (p.id === id ? { ...p, name } : p)),
  };
}

/** Recolours an entry. **Touches no cells** — every referencing cell follows. */
export function setPaletteColor(doc: TuiDocument, id: string, color: Color): TuiDocument {
  assertValidColor(color);
  const entry = findPaletteEntry(doc, id);
  if (entry === undefined || colorEquals(entry.color, color)) return doc;
  return {
    ...doc,
    palette: doc.palette.map((p) => (p.id === id ? { ...p, color } : p)),
  };
}

/**
 * Removes an entry, baking every reference to it into the colour it resolved to.
 *
 * **The one mutation that ignores `locked`.** A lock protects a layer from
 * *edits*; this is not an edit but a change to what the document can express.
 * Skipping locked layers would leave them holding references to an entry that no
 * longer exists, and then every reader — renderers, exporters, the inspector —
 * would have to defend against a dangling ref forever. Better to have the
 * invariant "a stored palette ref always resolves" hold unconditionally.
 *
 * Cells keep the colour they were *showing*, not the terminal default, so
 * deleting an entry is visually invisible. That is the behaviour a user expects
 * from "delete this palette entry" — the swatch goes away, the design does not
 * change.
 */
export function removePaletteEntry(doc: TuiDocument, id: string): TuiDocument {
  const entry = findPaletteEntry(doc, id);
  if (entry === undefined) return doc;

  const baked = entry.color;
  const withoutEntry = { ...doc, palette: doc.palette.filter((p) => p.id !== id) };

  return mapAllCells(withoutEntry, (cell) => {
    const fgHit = isPaletteRef(cell.fg) && cell.fg.id === id;
    const bgHit = isPaletteRef(cell.bg) && cell.bg.id === id;
    if (!fgHit && !bgHit) return cell;
    return {
      ...cell,
      ...(fgHit ? { fg: baked } : {}),
      ...(bgHit ? { bg: baked } : {}),
    };
  });
}

/** True when a stored ref points at no palette entry. */
const isDangling = (doc: TuiDocument, ref: ColorRef): boolean =>
  isPaletteRef(ref) && findPaletteEntry(doc, ref.id) === undefined;

/**
 * How many stored references point at a missing entry.
 *
 * Counted per *reference*, not per cell: a cell whose fg and bg both dangle
 * contributes 2, because two pieces of information were lost.
 */
export function danglingRefs(doc: TuiDocument): number {
  let count = 0;
  for (const layer of doc.layers) {
    for (const cell of Object.values(layer.cells)) {
      if (isDangling(doc, cell.fg)) count++;
      if (isDangling(doc, cell.bg)) count++;
    }
  }
  return count;
}

/**
 * Replaces every dangling reference with the terminal default.
 *
 * Unlike {@link removePaletteEntry} there is no colour to preserve — the entry is
 * already gone, so what the cell was showing is unrecoverable. Reached by
 * `deserialize` for hand-edited files, and available to the palette editor as a
 * repair action.
 *
 * Ignores `locked` for the same reason as `removePaletteEntry`.
 */
export function bakeDanglingRefs(doc: TuiDocument): TuiDocument {
  return mapAllCells(doc, (cell) => {
    const fgBad = isDangling(doc, cell.fg);
    const bgBad = isDangling(doc, cell.bg);
    if (!fgBad && !bgBad) return cell;
    return {
      ...cell,
      ...(fgBad ? { fg: DEFAULT_COLOR } : {}),
      ...(bgBad ? { bg: DEFAULT_COLOR } : {}),
    };
  });
}

export interface PaletteUsage {
  readonly id: string;
  readonly name: string;
  /**
   * Distinct cells referencing this entry.
   *
   * Distinct *cells*, not references: a cell using the entry for both foreground
   * and background counts once, because "used by 47 cells" is what a designer
   * reads it as.
   */
  readonly cells: number;
  /** Layers containing at least one reference, in document order. */
  readonly layerIds: readonly string[];
}

/** Usage for every entry, in palette order. Entries with no uses report zero. */
export function paletteUsage(doc: TuiDocument): readonly PaletteUsage[] {
  // Tally by id in one document pass, then project onto the palette. Seeding the
  // tallies from the palette first would make the "entry has no uses" lookup
  // unreachable, and a permanently-uncovered branch is a smell rather than
  // something to test around.
  const cellCounts = new Map<string, number>();
  const layerHits = new Map<string, Set<string>>();

  for (const layer of doc.layers) {
    for (const cell of Object.values(layer.cells)) {
      // Per cell, not per reference: a cell using the entry for both fg and bg
      // counts once.
      const ids = new Set<string>();
      if (isPaletteRef(cell.fg)) ids.add(cell.fg.id);
      if (isPaletteRef(cell.bg)) ids.add(cell.bg.id);
      for (const id of ids) {
        cellCounts.set(id, (cellCounts.get(id) ?? 0) + 1);
        const hits = layerHits.get(id) ?? new Set<string>();
        hits.add(layer.id);
        layerHits.set(id, hits);
      }
    }
  }

  // Projecting onto the palette also drops dangling ids for free — they match no
  // entry, so no explicit filter is needed. `danglingRefs` reports those.
  return doc.palette.map((entry) => {
    const hits = layerHits.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      cells: cellCounts.get(entry.id) ?? 0,
      // Ordered by the document's layer order rather than by first reference, so
      // the GUI can list them beside the layers panel without re-sorting.
      layerIds: doc.layers.filter((l) => hits?.has(l.id) === true).map((l) => l.id),
    };
  });
}

/**
 * The id of an existing entry with the same name, or null.
 *
 * A "check before acting" helper in the same spirit as `cellsLostOnResize`: names
 * become design-token keys at M6, where duplicates would collide, but rejecting
 * them inside `addPaletteEntry` would make a half-typed name in the editor throw.
 * The GUI calls this and decides.
 *
 * `exceptId` lets a rename ignore the entry being renamed.
 */
export function paletteNameConflict(
  doc: TuiDocument,
  name: string,
  exceptId?: string,
): string | null {
  const found = doc.palette.find((entry) => entry.name === name && entry.id !== exceptId);
  return found?.id ?? null;
}
