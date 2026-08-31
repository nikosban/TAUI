/**
 * The layers panel.
 *
 * Every decision that could be wrong lives in `panel-model.ts`; this file is
 * markup plus event wiring. In particular the display/array index inversion is
 * never done inline here — see {@link reorderTargetIndex}.
 *
 * Reordering uses native HTML5 drag-and-drop rather than a drag library. That
 * costs touch support and some polish, which is the tradeoff to revisit if
 * reordering becomes a common operation.
 */

import {
  addLayer,
  duplicateLayer,
  mergeDown,
  moveLayer,
  removeLayer,
  renameLayer,
  setActiveLayer,
  setExcludeFromHandoff,
  setLayerLocked,
  setLayerVisible,
  type TuiDocument,
} from "@tui-designer/core";
import { useRef, useState } from "react";
import {
  canDelete,
  canMergeDown,
  deleteConfirm,
  layerRows,
  mergeDownConfirm,
  paintedCount,
  reorderTargetIndex,
} from "./panel-model.js";

export interface LayersPanelProps {
  readonly doc: TuiDocument;
  /** Applies a layer edit as one history entry. */
  readonly onEdit: (next: TuiDocument) => void;
  /** Asks the user to confirm a destructive action. Injected so it is testable. */
  readonly confirm: (message: string) => boolean;
}

export function LayersPanel({ doc, onEdit, confirm }: LayersPanelProps): React.JSX.Element {
  const rows = layerRows(doc);
  /** The layer being renamed, plus its in-progress text. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  /**
   * The layer being dragged, in a ref rather than state.
   *
   * `dragstart` and `drop` can arrive without a render between them, and a state
   * value would still read `null` in the drop handler's closure — the reorder then
   * silently does nothing. A ref is read at call time, so it cannot go stale.
   * `dropDisplay` stays state because it only drives the drop indicator, which
   * *needs* a re-render to appear.
   */
  const dragIdRef = useRef<string | null>(null);
  const [dropDisplay, setDropDisplay] = useState<number | null>(null);

  const commitRename = (): void => {
    if (editing === null) return;
    const name = editing.value.trim();
    // An empty name would leave an unclickable blank row.
    if (name !== "") onEdit(renameLayer(doc, editing.id, name));
    setEditing(null);
  };

  const onDrop = (toDisplay: number): void => {
    const dragId = dragIdRef.current;
    if (dragId !== null) {
      onEdit(moveLayer(doc, dragId, reorderTargetIndex(toDisplay, doc.layers.length)));
    }
    dragIdRef.current = null;
    setDropDisplay(null);
  };

  const remove = (id: string): void => {
    const message = deleteConfirm(doc, id);
    if (message !== null && !confirm(message)) return;
    onEdit(removeLayer(doc, id));
  };

  const merge = (id: string): void => {
    const message = mergeDownConfirm(doc, id);
    if (message !== null && !confirm(message)) return;
    onEdit(mergeDown(doc, id));
  };

  return (
    <section className="layers" aria-labelledby="layers-heading">
      <div className="section-head">
        <h2 id="layers-heading">Layers</h2>
        <button
          type="button"
          className="chip"
          title="Add a layer above the active one"
          onClick={() => onEdit(addLayer(doc))}
        >
          + add
        </button>
      </div>

      <ul className="layer-list">
        {rows.map((row) => {
          const { layer, displayIndex, isActive, isBottom } = row;
          const cells = paintedCount(layer);
          return (
            <li
              key={layer.id}
              className={[
                "layer-row",
                isActive ? "active" : "",
                layer.visible ? "" : "hidden-layer",
                dropDisplay === displayIndex ? "drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable={editing?.id !== layer.id}
              onDragStart={() => {
                dragIdRef.current = layer.id;
              }}
              onDragEnd={() => {
                dragIdRef.current = null;
                setDropDisplay(null);
              }}
              onDragOver={(e) => {
                // Without preventDefault the browser refuses the drop outright.
                e.preventDefault();
                setDropDisplay(displayIndex);
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(displayIndex);
              }}
            >
              <button
                type="button"
                className="layer-eye"
                title={layer.visible ? "Hide layer" : "Show layer"}
                aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
                aria-pressed={layer.visible}
                onClick={() => onEdit(setLayerVisible(doc, layer.id, !layer.visible))}
              >
                {layer.visible ? "◉" : "◌"}
              </button>
              <button
                type="button"
                className="layer-lock"
                title={layer.locked ? "Unlock layer" : "Lock layer"}
                aria-label={`${layer.locked ? "Unlock" : "Lock"} ${layer.name}`}
                aria-pressed={layer.locked}
                onClick={() => onEdit(setLayerLocked(doc, layer.id, !layer.locked))}
              >
                {layer.locked ? "🔒" : "🔓"}
              </button>

              {editing?.id === layer.id ? (
                <input
                  className="layer-name-input"
                  // biome-ignore lint/a11y/noAutofocus: the field only exists in response to a rename click
                  autoFocus
                  aria-label={`Rename ${layer.name}`}
                  value={editing.value}
                  onChange={(e) => setEditing({ id: layer.id, value: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditing(null);
                    e.stopPropagation();
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="layer-name"
                  title="Click to select, double-click to rename"
                  aria-label={`${layer.name}, layer ${displayIndex + 1} of ${rows.length}, ${cells} painted cells`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onEdit(setActiveLayer(doc, layer.id))}
                  onDoubleClick={() => setEditing({ id: layer.id, value: layer.name })}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      setEditing({ id: layer.id, value: layer.name });
                    } else if (event.key === "ArrowUp" && displayIndex > 0) {
                      event.preventDefault();
                      onEdit(
                        moveLayer(
                          doc,
                          layer.id,
                          reorderTargetIndex(displayIndex - 1, doc.layers.length),
                        ),
                      );
                    } else if (event.key === "ArrowDown" && displayIndex < rows.length - 1) {
                      event.preventDefault();
                      onEdit(
                        moveLayer(
                          doc,
                          layer.id,
                          reorderTargetIndex(displayIndex + 1, doc.layers.length),
                        ),
                      );
                    }
                    event.stopPropagation();
                  }}
                >
                  {layer.name}
                  <span className="layer-count">{cells}</span>
                </button>
              )}

              <button
                type="button"
                className={layer.excludeFromHandoff === true ? "chip tiny active" : "chip tiny"}
                title="Exclude from handoff panel detection (M6)"
                aria-label={`${layer.excludeFromHandoff === true ? "Include" : "Exclude"} ${layer.name} in handoff panel detection`}
                aria-pressed={layer.excludeFromHandoff === true}
                onClick={() =>
                  onEdit(setExcludeFromHandoff(doc, layer.id, layer.excludeFromHandoff !== true))
                }
              >
                ⊘
              </button>
              <button
                type="button"
                className="chip tiny"
                title="Duplicate layer"
                aria-label={`Duplicate ${layer.name}`}
                onClick={() => onEdit(duplicateLayer(doc, layer.id))}
              >
                ⧉
              </button>
              <button
                type="button"
                className="chip tiny"
                title={isBottom ? "Nothing below to merge into" : "Merge into the layer below"}
                aria-label={`Merge ${layer.name} into the layer below`}
                disabled={!canMergeDown(doc, layer.id)}
                onClick={() => merge(layer.id)}
              >
                ⤓
              </button>
              <button
                type="button"
                className="chip tiny danger"
                title={canDelete(doc) ? "Delete layer" : "A document keeps at least one layer"}
                aria-label={`Delete ${layer.name}`}
                disabled={!canDelete(doc)}
                onClick={() => remove(layer.id)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        Topmost row wins a contested cell. Drag or use ↑/↓ on a focused layer to reorder; press
        <kbd>F2</kbd> to rename; <kbd>[</kbd> / <kbd>]</kbd> cycle the active layer. The number is
        painted cells.
      </p>
    </section>
  );
}
