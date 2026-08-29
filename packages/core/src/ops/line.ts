/**
 * Straight line drawing.
 *
 * Horizontal or vertical only — the GUI snaps a drag to the dominant axis, and
 * diagonal input is a programming error rather than something to approximate.
 *
 * Like `box.ts`, this file is **pure geometry**: it never names a box-drawing
 * character. Crossing a perpendicular line produces `┼` (and `╪ ╫` for mixed
 * styles) purely because `applyArmStamps` unions the arms — there is no
 * line-specific junction code, which a source-grep test enforces.
 */

import type { CellStyle } from "../model/cell.js";
import { inBounds, type TuiDocument } from "../model/document.js";
import { withLayerDraft } from "../model/draft.js";
import { type Arms, arms, type LineStyle } from "./arms.js";
import { type ArmStamp, applyArmStamps } from "./box-merge.js";

export interface Point {
  readonly row: number;
  readonly col: number;
}

export class DiagonalLineError extends RangeError {
  constructor(from: Point, to: Point) {
    super(
      `drawLine requires a horizontal or vertical line, got (${from.row},${from.col}) -> (${to.row},${to.col})`,
    );
    this.name = "DiagonalLineError";
  }
}

/**
 * Arms for a straight line.
 *
 * Interior cells get a collinear pair; endpoints get only their *inward* arm, so
 * a line end is a stub (`╴╵╶╷`) and touching another line forms a T rather than
 * a crossing.
 *
 * A 1-cell line has two coincident endpoints and therefore no inward direction.
 * It stamps a single light-left arm so the gesture produces a visible mark rather
 * than nothing. The direction is arbitrary but fixed; note that a *double*-style
 * 1-cell line has no Unicode character and resolves to the heavy stub `╸` through
 * the normal fallback ladder.
 */
function lineStamps(from: Point, to: Point, style: LineStyle): ArmStamp[] {
  const horizontal = from.row === to.row;
  const vertical = from.col === to.col;
  if (!horizontal && !vertical) throw new DiagonalLineError(from, to);

  const stamps: ArmStamp[] = [];
  const add = (row: number, col: number, spec: Partial<Arms>): void => {
    stamps.push({ row, col, arms: arms(spec) });
  };

  if (horizontal && vertical) {
    // Degenerate single cell: no inward direction exists.
    add(from.row, from.col, { left: style });
    return stamps;
  }

  if (horizontal) {
    const [start, end] = from.col <= to.col ? [from.col, to.col] : [to.col, from.col];
    for (let col = start; col <= end; col++) {
      const spec: Partial<Arms> = {
        ...(col > start ? { left: style } : {}),
        ...(col < end ? { right: style } : {}),
      };
      add(from.row, col, spec);
    }
    return stamps;
  }

  const [start, end] = from.row <= to.row ? [from.row, to.row] : [to.row, from.row];
  for (let row = start; row <= end; row++) {
    const spec: Partial<Arms> = {
      ...(row > start ? { up: style } : {}),
      ...(row < end ? { down: style } : {}),
    };
    add(row, from.col, spec);
  }
  return stamps;
}

export function drawLine(
  doc: TuiDocument,
  layerId: string,
  from: Point,
  to: Point,
  style: LineStyle,
  merge: boolean,
  cellStyle: CellStyle,
): TuiDocument {
  const stamps = lineStamps(from, to, style).filter((s) => inBounds(doc, s.row, s.col));
  if (stamps.length === 0) return doc;
  return withLayerDraft(doc, layerId, (draft) => {
    applyArmStamps(draft, stamps, cellStyle, merge);
  });
}
