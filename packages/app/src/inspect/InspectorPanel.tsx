/**
 * The inspect panel.
 *
 * Markup only; every number and label comes from core's `inspectRegion` /
 * `distance` via `inspect-model.ts`.
 *
 * Shown for the **selection** rather than the hovered cell, because a measurement
 * needs to hold still to be read — a panel that changed on every pointer move
 * would be unreadable. The hovered cell contributes only the offset row, which is
 * the one measurement that is *about* movement.
 */

import { distance, inspectRegion, type Rect, type TuiDocument } from "@tui-designer/core";
import type { CellPos } from "../canvas/metrics.js";
import type { Theme } from "../canvas/paint-plan.js";
import { cssColor } from "../canvas/paint-plan.js";
import { inspectPayload, offsetLabel, regionRows } from "./inspect-model.js";

export interface InspectorPanelProps {
  readonly doc: TuiDocument;
  readonly selection: Rect | null;
  readonly hover: CellPos | null;
  readonly theme: Theme;
  readonly onCopy: (payload: string) => void;
}

export function InspectorPanel({
  doc,
  selection,
  hover,
  theme,
  onCopy,
}: InspectorPanelProps): React.JSX.Element {
  if (selection === null) {
    return (
      <section>
        <h2>Inspect</h2>
        <p className="muted small">
          Select a region to measure it. Every number is an exact cell count.
        </p>
      </section>
    );
  }

  const info = inspectRegion(doc, selection);
  const rows = regionRows(info);
  // From the selection's own corner, so the reader has a fixed reference point.
  const offset =
    hover === null || info.rect === null
      ? null
      : distance({ row: info.rect.top, col: info.rect.left }, hover);

  return (
    <section>
      <div className="section-head">
        <h2>Inspect</h2>
        <button
          type="button"
          className="chip"
          title="Copy these measurements as JSON"
          onClick={() => onCopy(inspectPayload(info))}
        >
          copy
        </button>
      </div>

      <dl className="inspect-rows">
        {rows.map((row) => (
          <div className="inspect-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              {row.swatch !== undefined && (
                <span
                  className="inspect-swatch"
                  style={{
                    background: cssColor(row.swatch, row.label === "fg" ? "fg" : "bg", theme),
                  }}
                />
              )}
              {row.value}
            </dd>
          </div>
        ))}
        {offset !== null && (
          <div className="inspect-row">
            <dt>to cursor</dt>
            <dd>{offsetLabel(offset.dRows, offset.dCols)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
