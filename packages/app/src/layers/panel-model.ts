/**
 * Pure model behind the layers panel.
 *
 * Exists mainly because of one inversion: `doc.layers` is ordered **bottom-up**
 * (index 0 composites first, so the last entry wins a contested cell), while the
 * panel lists layers **top-first** like every other design tool. Every index
 * crossing that boundary goes through {@link arrayIndexFromDisplay} rather than an
 * inline `length - 1 - i`, because an off-by-one here silently reorders a
 * document and is invisible in review.
 *
 * The confirmation strings live here too. They are decisions about destructiveness
 * — not presentation — and they are worth asserting on.
 */

import { findLayer, type Layer, type TuiDocument } from "@tui-designer/core";

/** One panel row: a layer plus the positional facts the UI would recompute. */
export interface LayerRow {
  readonly layer: Layer;
  /** Position in the panel, 0 = topmost. */
  readonly displayIndex: number;
  /** Position in `doc.layers`, 0 = bottom. */
  readonly arrayIndex: number;
  readonly isActive: boolean;
  /** True for the bottom layer, which has nothing to merge into. */
  readonly isBottom: boolean;
}

/** Maps a panel position to a `doc.layers` index, and vice versa — it is its own inverse. */
export const arrayIndexFromDisplay = (displayIndex: number, count: number): number =>
  count - 1 - displayIndex;

/** Rows in panel order: topmost first. */
export function layerRows(doc: TuiDocument): readonly LayerRow[] {
  const count = doc.layers.length;
  return doc.layers
    .map((layer, arrayIndex) => ({
      layer,
      arrayIndex,
      displayIndex: arrayIndexFromDisplay(arrayIndex, count),
      isActive: layer.id === doc.activeLayerId,
      isBottom: arrayIndex === 0,
    }))
    .sort((a, b) => a.displayIndex - b.displayIndex);
}

/**
 * The `toIndex` for `moveLayer` when panel row `fromDisplay` is dropped at
 * `toDisplay`.
 *
 * The display-to-array mapping is a reflection, so reflecting the target is
 * enough — `moveLayer`'s remove-then-insert lands correctly under it. Verified
 * against worked examples in the tests rather than argued from first principles.
 */
export const reorderTargetIndex = (toDisplay: number, count: number): number =>
  arrayIndexFromDisplay(toDisplay, count);

/** How many cells a layer has actually painted. */
export const paintedCount = (layer: Layer): number => Object.keys(layer.cells).length;

/**
 * The next active layer id for `[` / `]`.
 *
 * `delta` is in *display* terms: -1 moves up the panel (toward the top layer),
 * +1 moves down. Wraps, because the shortcut is a cycle — clamping would make the
 * key silently do nothing at the ends.
 */
export function cycleActiveId(doc: TuiDocument, delta: -1 | 1): string {
  const rows = layerRows(doc);
  const current = rows.findIndex((r) => r.isActive);
  // An activeLayerId naming no layer is repaired on load, but defaulting here
  // keeps the shortcut total rather than relying on that.
  const from = current === -1 ? 0 : current;
  const next = (from + delta + rows.length) % rows.length;
  return (rows[next] as LayerRow).layer.id;
}

/** False for the bottom layer, which has nothing beneath it to merge into. */
export function canMergeDown(doc: TuiDocument, layerId: string): boolean {
  const index = doc.layers.findIndex((l) => l.id === layerId);
  return index > 0;
}

/**
 * Why merging down needs confirming, or null when it does not.
 *
 * `mergeDown` deliberately ignores `visible` — a layer's cells are its content and
 * visibility is a view flag — so merging a hidden layer makes its content appear.
 * That is the one genuinely surprising outcome, and core's README says the GUI
 * must ask first.
 */
export function mergeDownConfirm(doc: TuiDocument, layerId: string): string | null {
  const layer = findLayer(doc, layerId);
  if (layer === undefined || !canMergeDown(doc, layerId)) return null;
  if (layer.visible) return null;
  return `"${layer.name}" is hidden. Merging keeps its cells, so its content will become visible. Continue?`;
}

/**
 * Why deleting needs confirming, or null when it does not.
 *
 * Undo covers it, but "undo" is a poor answer to losing a layer of work you
 * cannot see the extent of, so the count is shown first.
 */
export function deleteConfirm(doc: TuiDocument, layerId: string): string | null {
  const layer = findLayer(doc, layerId);
  if (layer === undefined) return null;
  const cells = paintedCount(layer);
  if (cells === 0) return null;
  return `Delete "${layer.name}" and its ${cells} painted cell${cells === 1 ? "" : "s"}?`;
}

/** False when only one layer remains; `removeLayer` refuses to delete the last. */
export const canDelete = (doc: TuiDocument): boolean => doc.layers.length > 1;

/**
 * A warning when the active layer cannot be seen, or null.
 *
 * Painting into a hidden or locked layer produces no visible change, which reads
 * as "the tool is broken". The lock case already flashes on an attempted edit;
 * this states it before the attempt.
 */
export function activeLayerNotice(doc: TuiDocument): string | null {
  const layer = findLayer(doc, doc.activeLayerId);
  if (layer === undefined) return null;
  if (!layer.visible) return `"${layer.name}" is hidden — edits will not be visible.`;
  if (layer.locked) return `"${layer.name}" is locked — edits are refused.`;
  return null;
}
