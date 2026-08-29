/**
 * Read-only measurement queries.
 *
 * This is the tool's structural advantage over a pixel design tool: every answer
 * here is an **exact integer cell count**, not a measurement with a tolerance.
 * "8px or is it 9px" has no analogue.
 *
 * Pulled forward from M6 because G4's inspector needs it and nothing here depends
 * on panel detection. `inspectCell` stays in M6 — its `panelId` does.
 *
 * Every result is plain JSON, so the GUI can render it and offer copy-to-clipboard
 * verbatim.
 */

import { type Color, colorEquals, DEFAULT_COLOR, resolveColor } from "../model/color.js";
import { cellAt, clipRect, type Rect, type TuiDocument } from "../model/document.js";
import { DIRECTIONS, type LineStyle } from "../ops/arms.js";
import { armsOf } from "../ops/box-merge.js";

/** Blank space on each side, measured in cells. */
export interface Padding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface RegionInfo {
  /** The requested rect clipped to the document, or null if entirely outside. */
  readonly rect: Rect | null;
  readonly rows: number;
  readonly cols: number;
  /** Cells the region covers, `rows × cols`. */
  readonly area: number;
  /** Cells a visible layer has actually painted. */
  readonly painted: number;
  /** Most common foreground and background among painted cells. */
  readonly dominantFg: Color;
  readonly dominantBg: Color;
  /**
   * The line style of the region's perimeter, or null when the perimeter is not
   * a complete box-drawing frame.
   *
   * "Complete" means every perimeter cell is a box character. One gap and this is
   * null rather than a guess, because the caller uses it to decide whether the
   * region *is* a panel.
   */
  readonly borderStyle: LineStyle | null;
  /**
   * Uniform blank margin inside the region, per side.
   *
   * Measured inside the border when there is one, and inside the region itself
   * otherwise. This is the number designers actually ask for — "how much padding
   * does this panel have" — and on a grid it is exact.
   */
  readonly padding: Padding;
}

/**
 * The offset from `a` to `b`, **signed**.
 *
 * Signed rather than absolute because the useful handoff statement is "this sits
 * 3 rows below and 5 columns right", which needs direction. Take `Math.abs` for a
 * magnitude.
 */
export function distance(
  a: { readonly row: number; readonly col: number },
  b: { readonly row: number; readonly col: number },
): { readonly dRows: number; readonly dCols: number } {
  return { dRows: b.row - a.row, dCols: b.col - a.col };
}

/** The most frequent value, or `fallback` when there are none. */
function dominant(values: readonly Color[], fallback: Color): Color {
  const tally: { color: Color; count: number }[] = [];
  for (const value of values) {
    const found = tally.find((entry) => colorEquals(entry.color, value));
    if (found === undefined) tally.push({ color: value, count: 1 });
    else found.count++;
  }
  // First-seen wins a tie, which keeps the result stable for a given document
  // rather than depending on object iteration order.
  let best: { color: Color; count: number } | undefined;
  for (const entry of tally) {
    if (best === undefined || entry.count > best.count) best = entry;
  }
  return best?.color ?? fallback;
}

/**
 * The line style of the rect's perimeter, or null when it is not a frame.
 *
 * The rule is **all four corners are box-drawing characters, and every edge holds
 * at least one**. Deliberately not "every perimeter cell is a box character":
 * that rejects `┌─ system ───┐`, and a title set into the top edge is the single
 * most common TUI panel shape — the strict rule reported "not a panel" for the
 * app's own default template.
 *
 * The corners do most of the discriminating. A rectangle of prose fails on all
 * four, so admitting titles costs very little precision. The cost is that a badly
 * broken box with intact corners now reports a style, which for an inspector hint
 * is the better error: M6's `detectPanels` does rigorous connectivity tracing, and
 * this is the number a human reads while deciding what they are looking at.
 */
function perimeterStyle(doc: TuiDocument, rect: Rect): LineStyle | null {
  if (rect.rows < 2 || rect.cols < 2) return null;

  const styles: LineStyle[] = [];
  /** Records the arms of a box character, or reports that there was none. */
  const armsAt = (row: number, col: number): boolean => {
    const cell = cellAt(doc, row, col);
    if (cell === undefined) return false;
    const arms = armsOf(cell.char);
    if (arms === undefined) return false;
    for (const direction of DIRECTIONS) {
      const weight = arms[direction];
      if (weight !== "none") styles.push(weight);
    }
    return true;
  };

  const bottom = rect.top + rect.rows - 1;
  const right = rect.left + rect.cols - 1;

  // Corners first: cheap, and they reject almost everything that is not a frame.
  const corners =
    armsAt(rect.top, rect.left) &&
    armsAt(rect.top, right) &&
    armsAt(bottom, rect.left) &&
    armsAt(bottom, right);
  if (!corners) return null;

  /** True when at least one cell in the run is a box character. */
  const edgeHasBox = (cells: readonly [number, number][]): boolean => {
    let found = false;
    for (const [row, col] of cells) {
      if (armsAt(row, col)) found = true;
    }
    return found;
  };

  const along = (fixed: number, from: number, to: number, horizontal: boolean) => {
    const cells: [number, number][] = [];
    for (let i = from; i <= to; i++) cells.push(horizontal ? [fixed, i] : [i, fixed]);
    return cells;
  };

  // The corners already counted; an edge of width 2 has nothing between them, and
  // its corners alone are enough.
  if (rect.cols > 2) {
    if (!edgeHasBox(along(rect.top, rect.left + 1, right - 1, true))) return null;
    if (!edgeHasBox(along(bottom, rect.left + 1, right - 1, true))) return null;
  }
  if (rect.rows > 2) {
    if (!edgeHasBox(along(rect.left, rect.top + 1, bottom - 1, false))) return null;
    if (!edgeHasBox(along(right, rect.top + 1, bottom - 1, false))) return null;
  }

  // A frame drawn in mixed weights reports its most common one.
  return dominantStyle(styles);
}

function dominantStyle(styles: readonly LineStyle[]): LineStyle | null {
  const counts = new Map<LineStyle, number>();
  for (const style of styles) counts.set(style, (counts.get(style) ?? 0) + 1);
  let best: LineStyle | null = null;
  let bestCount = 0;
  for (const style of ["light", "heavy", "double"] as const) {
    const count = counts.get(style) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = style;
    }
  }
  return best;
}

/** True when a cell contributes no visible ink. */
const isBlank = (doc: TuiDocument, row: number, col: number): boolean => {
  const cell = cellAt(doc, row, col);
  if (cell === undefined) return true;
  // A space with a painted background is *not* blank — it is deliberate colour.
  return cell.char === " " && cell.bg.kind === "default";
};

function measurePadding(doc: TuiDocument, rect: Rect): Padding {
  const bottom = rect.top + rect.rows - 1;
  const right = rect.left + rect.cols - 1;

  const rowBlank = (row: number): boolean => {
    for (let col = rect.left; col <= right; col++) {
      if (!isBlank(doc, row, col)) return false;
    }
    return true;
  };
  const colBlank = (col: number): boolean => {
    for (let row = rect.top; row <= bottom; row++) {
      if (!isBlank(doc, row, col)) return false;
    }
    return true;
  };

  let top = 0;
  while (top < rect.rows && rowBlank(rect.top + top)) top++;
  // An entirely blank region has no meaningful padding; reporting the full size
  // on all four sides would double-count it.
  if (top === rect.rows) return { top: 0, right: 0, bottom: 0, left: 0 };

  let below = 0;
  while (below < rect.rows && rowBlank(bottom - below)) below++;
  let left = 0;
  while (left < rect.cols && colBlank(rect.left + left)) left++;
  let rightPad = 0;
  while (rightPad < rect.cols && colBlank(right - rightPad)) rightPad++;

  return { top, right: rightPad, bottom: below, left };
}

/** Shrinks a rect by one cell on every side, or null if nothing is left. */
function inset(rect: Rect): Rect | null {
  if (rect.rows <= 2 || rect.cols <= 2) return null;
  return {
    top: rect.top + 1,
    left: rect.left + 1,
    rows: rect.rows - 2,
    cols: rect.cols - 2,
  };
}

export function inspectRegion(doc: TuiDocument, rect: Rect): RegionInfo {
  const clipped = clipRect(doc, rect);
  if (clipped === null) {
    return {
      rect: null,
      rows: 0,
      cols: 0,
      area: 0,
      painted: 0,
      dominantFg: DEFAULT_COLOR,
      dominantBg: DEFAULT_COLOR,
      borderStyle: null,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    };
  }

  const fgs: Color[] = [];
  const bgs: Color[] = [];
  let painted = 0;
  for (let row = clipped.top; row < clipped.top + clipped.rows; row++) {
    for (let col = clipped.left; col < clipped.left + clipped.cols; col++) {
      const cell = cellAt(doc, row, col);
      if (cell === undefined) continue;
      painted++;
      // Palette refs are resolved so the caller compares like with like; naming
      // the reference is `inspectCell`'s business (M6).
      fgs.push(resolveColor(doc, cell.fg));
      bgs.push(resolveColor(doc, cell.bg));
    }
  }

  const borderStyle = perimeterStyle(doc, clipped);
  // Padding is measured inside the frame when there is one — the border is not
  // padding, and reporting 0 for a bordered panel would be useless.
  const paddingRect = borderStyle === null ? clipped : inset(clipped);

  return {
    rect: clipped,
    rows: clipped.rows,
    cols: clipped.cols,
    area: clipped.rows * clipped.cols,
    painted,
    dominantFg: dominant(fgs, DEFAULT_COLOR),
    dominantBg: dominant(bgs, DEFAULT_COLOR),
    borderStyle,
    padding:
      paddingRect === null
        ? { top: 0, right: 0, bottom: 0, left: 0 }
        : measurePadding(doc, paddingRect),
  };
}
