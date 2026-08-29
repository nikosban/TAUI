/**
 * Layer structure operations.
 *
 * These change the layer *list* rather than cell contents, so they do not go
 * through `withLayerDraft`. They keep the same two guarantees as the drawing ops:
 * a no-op returns the identical document object, and untouched layers stay `===`.
 *
 * Two invariants hold across every function here:
 *
 * 1. **A document always has at least one layer.** `removeLayer` refuses to
 *    delete the last one, so `layers[0]` is always safe and the GUI never has to
 *    render an empty layer list.
 * 2. **`activeLayerId` always names an existing layer.** Deleting the active
 *    layer reassigns it to the one below, or above when it was the bottom.
 */

import type { Cell } from "../model/cell.js";
import { defaultIdGen, type IdGen, type TuiDocument } from "../model/document.js";
import { createLayer, type Layer } from "../model/layer.js";

interface Located {
  readonly index: number;
  readonly layer: Layer;
}

/**
 * Finds a layer with its index, or `null`.
 *
 * Returning both together rather than calling `findIndex` and then indexing keeps
 * the layer non-nullable: an `if (layer === undefined)` guard after a successful
 * `findIndex` is unreachable, and unreachable guards are permanently uncovered
 * code that hides real gaps in the coverage report.
 */
function locate(doc: TuiDocument, layerId: string): Located | null {
  for (const [index, layer] of doc.layers.entries()) {
    if (layer.id === layerId) return { index, layer };
  }
  return null;
}

/**
 * Applies `update` to the named layer. Returns the same document if the layer is
 * missing or `update` produces no change.
 */
function updateLayer(
  doc: TuiDocument,
  layerId: string,
  update: (layer: Layer) => Layer,
): TuiDocument {
  const found = locate(doc, layerId);
  if (found === null) return doc;
  const next = update(found.layer);
  if (next === found.layer) return doc;
  const layers = doc.layers.slice();
  layers[found.index] = next;
  return { ...doc, layers };
}

export interface AddLayerOptions {
  readonly name?: string;
  readonly idGen?: IdGen;
  /** Insert position; defaults to the top. Clamped into range. */
  readonly index?: number;
  /** Make the new layer active. Default `true`. */
  readonly activate?: boolean;
}

export function addLayer(doc: TuiDocument, opts: AddLayerOptions = {}): TuiDocument {
  const idGen = opts.idGen ?? defaultIdGen;
  const name = opts.name ?? `Layer ${doc.layers.length + 1}`;
  const layer = createLayer(idGen(), name);
  const at =
    opts.index === undefined ? doc.layers.length : clampIndex(opts.index, doc.layers.length);
  const layers = doc.layers.slice();
  layers.splice(at, 0, layer);
  return {
    ...doc,
    layers,
    activeLayerId: opts.activate === false ? doc.activeLayerId : layer.id,
  };
}

const clampIndex = (index: number, max: number): number => Math.max(0, Math.min(max, index));

export interface DuplicateLayerOptions {
  readonly idGen?: IdGen;
  readonly name?: string;
  readonly activate?: boolean;
}

/**
 * Copies a layer, inserting the copy directly above the original.
 *
 * The cell map is shared by reference: layers are immutable, so a copy that is
 * never edited costs nothing, and the first edit goes through `withLayerDraft`
 * which clones before writing.
 */
export function duplicateLayer(
  doc: TuiDocument,
  layerId: string,
  opts: DuplicateLayerOptions = {},
): TuiDocument {
  const found = locate(doc, layerId);
  if (found === null) return doc;

  const idGen = opts.idGen ?? defaultIdGen;
  const copy: Layer = {
    ...found.layer,
    id: idGen(),
    name: opts.name ?? `${found.layer.name} copy`,
  };
  const layers = doc.layers.slice();
  layers.splice(found.index + 1, 0, copy);
  return {
    ...doc,
    layers,
    activeLayerId: opts.activate === false ? doc.activeLayerId : copy.id,
  };
}

/**
 * Deletes a layer.
 *
 * A no-op when the layer is unknown or is the only one — a document with no
 * layers has no valid `activeLayerId` and nothing to draw on. The GUI is expected
 * to disable the delete control rather than rely on this, but the engine holds
 * the invariant regardless.
 */
export function removeLayer(doc: TuiDocument, layerId: string): TuiDocument {
  if (doc.layers.length <= 1) return doc;
  const found = locate(doc, layerId);
  if (found === null) return doc;

  const layers = doc.layers.filter((l) => l.id !== layerId);
  let activeLayerId = doc.activeLayerId;
  if (doc.activeLayerId === layerId) {
    // Prefer the layer below; fall back to the one above when deleting the bottom.
    // `layers` is non-empty here (length was > 1), so this index always resolves.
    const fallbackIndex = Math.max(0, found.index - 1);
    activeLayerId = (layers[fallbackIndex] as Layer).id;
  }
  return { ...doc, layers, activeLayerId };
}

/**
 * Moves a layer to `toIndex` (0 = bottom). The index is clamped, and a move that
 * would not change the order is a no-op.
 */
export function moveLayer(doc: TuiDocument, layerId: string, toIndex: number): TuiDocument {
  const found = locate(doc, layerId);
  if (found === null) return doc;
  const to = clampIndex(toIndex, doc.layers.length - 1);
  if (to === found.index) return doc;

  const layers = doc.layers.slice();
  layers.splice(found.index, 1);
  layers.splice(to, 0, found.layer);
  return { ...doc, layers };
}

export function renameLayer(doc: TuiDocument, layerId: string, name: string): TuiDocument {
  return updateLayer(doc, layerId, (layer) => (layer.name === name ? layer : { ...layer, name }));
}

export function setLayerVisible(doc: TuiDocument, layerId: string, visible: boolean): TuiDocument {
  return updateLayer(doc, layerId, (layer) =>
    layer.visible === visible ? layer : { ...layer, visible },
  );
}

export function setLayerLocked(doc: TuiDocument, layerId: string, locked: boolean): TuiDocument {
  return updateLayer(doc, layerId, (layer) =>
    layer.locked === locked ? layer : { ...layer, locked },
  );
}

/**
 * Sets or clears the handoff-exclusion flag (M6 panel detection).
 *
 * Clearing it *deletes* the property rather than writing `false`, so a document
 * that has never used the flag serializes byte-identically to one where it was
 * toggled on and off again.
 */
export function setExcludeFromHandoff(
  doc: TuiDocument,
  layerId: string,
  exclude: boolean,
): TuiDocument {
  return updateLayer(doc, layerId, (layer) => {
    const current = layer.excludeFromHandoff ?? false;
    if (current === exclude) return layer;
    if (!exclude) {
      const { excludeFromHandoff: _dropped, ...rest } = layer;
      return rest;
    }
    return { ...layer, excludeFromHandoff: true };
  });
}

/** Sets the active layer. A no-op if the layer does not exist. */
export function setActiveLayer(doc: TuiDocument, layerId: string): TuiDocument {
  if (doc.activeLayerId === layerId) return doc;
  if (!doc.layers.some((l) => l.id === layerId)) return doc;
  return { ...doc, activeLayerId: layerId };
}

/**
 * Merges a layer into the one directly below it, then removes it.
 *
 * The upper layer's cells win where both are painted; the lower layer's
 * transparent cells show through. The surviving layer keeps the *lower* layer's
 * id, name, and flags, so `activeLayerId` and any handoff exclusion are stable.
 *
 * A no-op when the layer is unknown, is already the bottom layer, or when either
 * layer is locked.
 *
 * Visibility is deliberately **not** consulted: a layer's cells are its content
 * and `visible` is a view flag. Merging a hidden layer down therefore makes its
 * content visible, which is why the GUI should confirm before merging a hidden
 * layer rather than relying on the engine to refuse.
 */
export function mergeDown(doc: TuiDocument, layerId: string): TuiDocument {
  const found = locate(doc, layerId);
  if (found === null) return doc;
  // Undefined exactly when the layer is already at the bottom — a real case, not
  // a defensive guard.
  const lower = doc.layers[found.index - 1];
  if (lower === undefined) return doc;

  const upper = found.layer;
  if (upper.locked || lower.locked) return doc;

  const cells: Record<string, Cell> = { ...lower.cells, ...upper.cells };
  const merged: Layer = { ...lower, cells };
  const layers = doc.layers.slice();
  layers.splice(found.index - 1, 2, merged);

  return {
    ...doc,
    layers,
    activeLayerId: doc.activeLayerId === upper.id ? merged.id : doc.activeLayerId,
  };
}
