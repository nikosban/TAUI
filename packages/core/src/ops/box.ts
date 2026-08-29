/**
 * Box drawing.
 *
 * This file contains **pure geometry only** — it computes which arms belong at
 * which cell and hands them to `applyArmStamps`. It must never mention a
 * box-drawing character; a test enforces that by grepping the source.
 */

import type { CellStyle } from "../model/cell.js";
import { inBounds, type Rect, type TuiDocument } from "../model/document.js";
import { withLayerDraft } from "../model/draft.js";
import { type Arms, arms, type LineStyle } from "./arms.js";
import { type ArmStamp, applyArmStamps } from "./box-merge.js";

/**
 * Arms for a box perimeter.
 *
 * Corners get their two inward arms; edges get a collinear pair. Degenerate rects
 * fall out naturally: a 1-row box becomes a horizontal line, a 1-column box a
 * vertical one, and a 1x1 box a single cell with no arms (skipped by
 * `applyArmStamps`, since a box with no extent has no border).
 */
function boxStamps(rect: Rect, style: LineStyle): ArmStamp[] {
  const { top, left } = rect;
  const bottom = top + rect.rows - 1;
  const right = left + rect.cols - 1;
  const stamps: ArmStamp[] = [];

  const add = (row: number, col: number, spec: Partial<Arms>): void => {
    stamps.push({ row, col, arms: arms(spec) });
  };

  const hasHeight = rect.rows > 1;
  const hasWidth = rect.cols > 1;

  // Corners. When the box is degenerate in one axis, the "corner" arms collapse
  // to a single direction, which is exactly what a line endpoint needs.
  add(top, left, {
    ...(hasHeight ? { down: style } : {}),
    ...(hasWidth ? { right: style } : {}),
  });
  if (hasWidth) {
    add(top, right, {
      ...(hasHeight ? { down: style } : {}),
      left: style,
    });
  }
  if (hasHeight) {
    add(bottom, left, {
      up: style,
      ...(hasWidth ? { right: style } : {}),
    });
  }
  if (hasWidth && hasHeight) {
    add(bottom, right, { up: style, left: style });
  }

  // Top and bottom edges.
  for (let col = left + 1; col < right; col++) {
    add(top, col, { left: style, right: style });
    if (hasHeight) add(bottom, col, { left: style, right: style });
  }
  // Left and right edges.
  for (let row = top + 1; row < bottom; row++) {
    add(row, left, { up: style, down: style });
    if (hasWidth) add(row, right, { up: style, down: style });
  }

  return stamps;
}

/**
 * Draws a box border.
 *
 * With `merge`, each border cell's arms are unioned with any box character
 * already there, producing `├ ┤ ┬ ┴ ┼` at shared edges. Without it, the border
 * overwrites blindly.
 *
 * Cells outside the document are silently clipped; a rect entirely outside is a
 * no-op returning the same document.
 */
export function drawBox(
  doc: TuiDocument,
  layerId: string,
  rect: Rect,
  style: LineStyle,
  merge: boolean,
  cellStyle: CellStyle,
): TuiDocument {
  if (rect.rows <= 0 || rect.cols <= 0) return doc;
  const stamps = boxStamps(rect, style).filter((s) => inBounds(doc, s.row, s.col));
  if (stamps.length === 0) return doc;
  return withLayerDraft(doc, layerId, (draft) => {
    applyArmStamps(draft, stamps, cellStyle, merge);
  });
}
