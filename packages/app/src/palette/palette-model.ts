/**
 * Pure model behind the palette editor.
 *
 * The panel's job is to make the *consequences* of each action legible before it
 * happens, because two of them are surprising:
 *
 * - **Delete keeps the design intact.** Every reference bakes to the colour it was
 *   already showing, so nothing changes visually — a user expecting "delete wipes
 *   the colour" needs telling otherwise.
 * - **Delete reaches locked layers.** The one mutation in the engine that ignores
 *   `locked`, because leaving a dangling reference behind would be worse.
 *
 * Both messages are built here rather than in the component so they can be
 * asserted on.
 */

import {
  type ColorMode,
  type ColorRef,
  colorModeLoss,
  danglingRefs,
  isPaletteRef,
  type PaletteEntry,
  type PaletteUsage,
  paletteNameConflict,
  paletteUsage,
  type TuiDocument,
} from "@tui-designer/core";

export interface PaletteRow {
  readonly entry: PaletteEntry;
  readonly usage: PaletteUsage;
  /** True when the brush currently paints with this entry. */
  readonly inBrushFg: boolean;
  readonly inBrushBg: boolean;
}

/** True when a stored ref points at this entry. */
const refsEntry = (ref: ColorRef, id: string): boolean => isPaletteRef(ref) && ref.id === id;

/**
 * Rows in palette order, joined with usage and with what the brush is holding.
 *
 * Palette order rather than usage order: the list is something the user arranges,
 * and re-sorting under them as usage changes would make it unnavigable.
 */
export function paletteRows(
  doc: TuiDocument,
  brush: { readonly fg: ColorRef; readonly bg: ColorRef },
): readonly PaletteRow[] {
  const usage = paletteUsage(doc);
  return doc.palette.map((entry, index) => ({
    entry,
    // paletteUsage returns one row per entry, in the same order.
    usage: usage[index] as PaletteUsage,
    inBrushFg: refsEntry(brush.fg, entry.id),
    inBrushBg: refsEntry(brush.bg, entry.id),
  }));
}

/**
 * What deleting an entry will do, always — there is no "nothing happens" case
 * worth staying silent about.
 *
 * Deliberately not phrased as a warning. Delete is safe here in a way users do
 * not expect, and saying so plainly prevents the hesitation that a scary
 * confirmation would cause.
 */
export function deleteNotice(doc: TuiDocument, id: string): string | null {
  const row = paletteRows(doc, { fg: { kind: "default" }, bg: { kind: "default" } }).find(
    (r) => r.entry.id === id,
  );
  if (row === undefined) return null;

  const { cells, layerIds } = row.usage;
  if (cells === 0) return `"${row.entry.name}" is unused. Deleting it changes nothing.`;

  const lockedTouched = layerIds.some(
    (layerId) => doc.layers.find((l) => l.id === layerId)?.locked === true,
  );
  const scope = lockedTouched ? ", including a locked layer" : "";
  return (
    `${cells} cell${cells === 1 ? "" : "s"} use "${row.entry.name}"${scope}. ` +
    `They keep the colour they are showing now, so nothing changes visually.`
  );
}

/**
 * Why a name cannot be used, or null.
 *
 * Names become design-token keys at M6, where a duplicate would collide — but the
 * check lives here rather than inside `addPaletteEntry`, so a half-typed name in
 * the editor does not throw.
 */
export function nameProblem(doc: TuiDocument, name: string, exceptId?: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A name is required.";
  if (paletteNameConflict(doc, trimmed, exceptId) !== null) {
    return `"${trimmed}" is already used. Token names must be unique.`;
  }
  return null;
}

/**
 * True when switching mode would approximate any colour.
 *
 * A separate predicate rather than reading {@link colorModeNotice}'s wording: a
 * caller deciding whether to confirm must not depend on a user-facing string,
 * which will be reworded sooner or later.
 */
export function colorModeIsLossy(doc: TuiDocument, mode: ColorMode): boolean {
  if (mode === doc.colorMode) return false;
  const { cellColors, paletteEntries } = colorModeLoss(doc, mode);
  return cellColors > 0 || paletteEntries > 0;
}

/**
 * What switching colour mode will cost, or null when it costs nothing.
 *
 * Shown before the change, like `cellsLostOnResize`: the loss is only recoverable
 * through undo, so stating it afterwards is useless.
 */
export function colorModeNotice(doc: TuiDocument, mode: ColorMode): string | null {
  if (mode === doc.colorMode) return null;
  const { cellColors, paletteEntries } = colorModeLoss(doc, mode);
  if (cellColors === 0 && paletteEntries === 0) {
    return `${mode} can express everything in this document. Nothing will change.`;
  }

  const parts: string[] = [];
  if (cellColors > 0) parts.push(`${cellColors} cell colour${cellColors === 1 ? "" : "s"}`);
  // Counted separately because one entry standing in for a thousand cells is a
  // very different sentence.
  if (paletteEntries > 0) {
    parts.push(`${paletteEntries} palette entr${paletteEntries === 1 ? "y" : "ies"}`);
  }
  return `${parts.join(" and ")} will be approximated. Undo is the only way back.`;
}

/** A repair offer when the document carries references to entries that are gone. */
export function danglingNotice(doc: TuiDocument): string | null {
  const count = danglingRefs(doc);
  if (count === 0) return null;
  return (
    `${count} reference${count === 1 ? "" : "s"} point at a palette entry that no longer ` +
    `exists. Repairing resets ${count === 1 ? "it" : "them"} to the terminal default.`
  );
}
