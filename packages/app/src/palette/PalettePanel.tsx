/**
 * The palette editor.
 *
 * Markup and event wiring only; every op is core's and every message comes from
 * `palette-model.ts`.
 *
 * The panel's centre of gravity is **applying** an entry, not creating one. A
 * palette is only worth having if painting through it is as easy as picking a raw
 * colour, so each row's swatch sets the brush foreground and its `bg` chip sets
 * the background — one click, same as the raw swatch grid above.
 */

import {
  addPaletteEntry,
  bakeDanglingRefs,
  type Color,
  type ColorMode,
  convertColorMode,
  removePaletteEntry,
  renamePaletteEntry,
  setPaletteColor,
  type TuiDocument,
} from "@tui-designer/core";
import { useState } from "react";
import type { Theme } from "../canvas/paint-plan.js";
import { cssColor } from "../canvas/paint-plan.js";
import type { BrushState } from "../gestures/gesture.js";
import { SWATCHES } from "../stores/tool-store.js";
import {
  colorModeIsLossy,
  colorModeNotice,
  danglingNotice,
  deleteNotice,
  nameProblem,
  paletteRows,
} from "./palette-model.js";

const COLOR_MODES: readonly ColorMode[] = ["ansi16", "ansi256", "rgb"];

export interface PalettePanelProps {
  readonly doc: TuiDocument;
  readonly brush: BrushState;
  readonly theme: Theme;
  /** Applies a document edit as one history entry. */
  readonly onEdit: (next: TuiDocument) => void;
  readonly onBrush: (patch: Partial<BrushState>) => void;
  readonly confirm: (message: string) => boolean;
}

export function PalettePanel({
  doc,
  brush,
  theme,
  onEdit,
  onBrush,
  confirm,
}: PalettePanelProps): React.JSX.Element {
  const rows = paletteRows(doc, brush);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  /** Which entry has its swatch picker open. */
  const [recolouring, setRecolouring] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const dangling = danglingNotice(doc);

  const commitRename = (): void => {
    if (editing === null) return;
    if (nameProblem(doc, editing.value, editing.id) === null) {
      onEdit(renamePaletteEntry(doc, editing.id, editing.value.trim()));
    }
    setEditing(null);
  };

  const commitAdd = (): void => {
    if (adding === null) return;
    if (nameProblem(doc, adding) === null) {
      // Seeded from the brush's own foreground when it is a raw colour: naming the
      // colour you are already painting with is the common reason to add an entry.
      const seed: Color = brush.fg.kind === "palette" ? { kind: "default" } : brush.fg;
      onEdit(addPaletteEntry(doc, adding.trim(), seed));
    }
    setAdding(null);
  };

  const remove = (id: string): void => {
    const message = deleteNotice(doc, id);
    if (message !== null && !confirm(message)) return;
    onEdit(removePaletteEntry(doc, id));
  };

  const changeMode = (mode: ColorMode): void => {
    // Only a lossy change is worth a confirmation; a widening one is not. Asked of
    // a predicate rather than by matching the notice's wording.
    if (colorModeIsLossy(doc, mode)) {
      const notice = colorModeNotice(doc, mode);
      if (notice !== null && !confirm(notice)) return;
    }
    onEdit(convertColorMode(doc, mode));
  };

  const addProblem = adding === null ? null : nameProblem(doc, adding);
  const editProblem = editing === null ? null : nameProblem(doc, editing.value, editing.id);

  return (
    <section>
      <div className="section-head">
        <h2>Palette</h2>
        <button
          type="button"
          className="chip"
          title="Name the brush colour as a reusable entry"
          onClick={() => setAdding("")}
        >
          + add
        </button>
      </div>

      {adding !== null && (
        <div className="row">
          <input
            className="layer-name-input"
            // biome-ignore lint/a11y/noAutofocus: the field only exists in response to a click
            autoFocus
            placeholder="token name, e.g. statusbar.bg"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAdd();
              if (e.key === "Escape") setAdding(null);
              e.stopPropagation();
            }}
          />
          {addProblem !== null && <p className="notice small">{addProblem}</p>}
        </div>
      )}

      {rows.length === 0 && adding === null && (
        <p className="muted small">
          No named colours yet. An entry can be recoloured later and every cell using it follows —
          which is the point.
        </p>
      )}

      <ul className="palette-list">
        {rows.map(({ entry, usage, inBrushFg, inBrushBg }) => (
          <li key={entry.id} className="palette-row">
            <button
              type="button"
              className={inBrushFg ? "swatch active" : "swatch"}
              title={`Paint foreground with "${entry.name}"`}
              style={{ background: cssColor(entry.color, "bg", theme) }}
              onClick={() => onBrush({ fg: { kind: "palette", id: entry.id } })}
            />

            {editing?.id === entry.id ? (
              <input
                className="layer-name-input"
                // biome-ignore lint/a11y/noAutofocus: the field only exists in response to a click
                autoFocus
                value={editing.value}
                onChange={(e) => setEditing({ id: entry.id, value: e.target.value })}
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
                className="palette-name"
                title="Double-click to rename"
                onDoubleClick={() => setEditing({ id: entry.id, value: entry.name })}
                onClick={() => setRecolouring(recolouring === entry.id ? null : entry.id)}
              >
                {entry.name}
                <span className="layer-count" title={`${usage.cells} cells`}>
                  {usage.cells}
                </span>
              </button>
            )}

            <button
              type="button"
              className={inBrushBg ? "chip tiny active" : "chip tiny"}
              title={`Paint background with "${entry.name}"`}
              onClick={() => onBrush({ bg: { kind: "palette", id: entry.id } })}
            >
              bg
            </button>
            <button
              type="button"
              className="chip tiny danger"
              title="Delete this entry"
              onClick={() => remove(entry.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {editProblem !== null && <p className="notice small">{editProblem}</p>}

      {recolouring !== null && (
        <div className="swatchRow">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch.label}
              type="button"
              className="swatch"
              title={`Recolour to ${swatch.label}`}
              style={{ background: cssColor(swatch.color, "bg", theme) }}
              onClick={() => {
                onEdit(setPaletteColor(doc, recolouring, swatch.color));
                setRecolouring(null);
              }}
            >
              {swatch.color.kind === "default" ? "×" : ""}
            </button>
          ))}
        </div>
      )}

      {dangling !== null && (
        <div className="notice small">
          {dangling}
          <button type="button" className="chip tiny" onClick={() => onEdit(bakeDanglingRefs(doc))}>
            repair
          </button>
        </div>
      )}

      <h2>Colour mode</h2>
      <div className="row">
        {COLOR_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={doc.colorMode === mode ? "chip wide active" : "chip wide"}
            title={colorModeNotice(doc, mode) ?? `Already ${mode}`}
            onClick={() => changeMode(mode)}
          >
            {mode}
          </button>
        ))}
      </div>
      <p className="muted small">
        The mode records what the target terminal can show. Exports downgrade on the way out anyway
        — converting bakes it into the document.
      </p>
    </section>
  );
}
