/**
 * Builds a whole frame as data. Pure — no DOM, no canvas, no `dpr` arithmetic.
 *
 * Painting order: void → document background → cell backgrounds → glyph runs →
 * underlines → grid → drag rect → selection marquee → cursor.
 *
 * The void shade comes free from clearing to `voidFill` and painting the document
 * rect over it, which satisfies the spec's "the boundary must always be visible"
 * with no extra geometry.
 */

import type { Color, ResolvedCell, ResolvedGrid } from "@tui-designer/core";
import type { DrawCmd } from "./draw-cmd.js";
import {
  type CellMetrics,
  type CellPos,
  type CellRect,
  type GridSize,
  pointFromCell,
  scaledCell,
  type Viewport,
  visibleCellRange,
} from "./metrics.js";

export interface Theme {
  readonly voidFill: string;
  readonly defaultFg: string;
  readonly defaultBg: string;
  readonly gridLine: string;
  readonly selectionStroke: string;
  readonly cursorStroke: string;
  /** Inverse-video text caret: block fill and the glyph drawn over it. */
  readonly caretFill: string;
  readonly caretText: string;
  /** ansi16 index → CSS colour. ansi256 is derived algorithmically. */
  readonly ansi16: readonly string[];
}

export interface Overlays {
  readonly showGrid: boolean;
  readonly selection: CellRect | null;
  readonly cursor: CellPos | null;
  /** Marquee dash animation phase, from the rAF clock. */
  readonly marqueePhase: number;
  /** Outline shown while rubber-banding, when there is no scratch document yet. */
  readonly dragRect: CellRect | null;
  /** Text caret, drawn as an inverse-video block per the spec. */
  readonly caret: CellPos | null;
}

export interface PaintInput {
  /** Already composited — the scratch document during a drag. */
  readonly grid: ResolvedGrid;
  readonly size: GridSize;
  readonly metrics: CellMetrics;
  readonly viewport: Viewport;
  readonly overlays: Overlays;
  readonly theme: Theme;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number): string => clamp255(n).toString(16).padStart(2, "0");

/**
 * One axis of the 6×6×6 colour cube.
 *
 * A switch rather than an array lookup so there is no "index might be undefined"
 * branch left permanently uncovered — every arm is exercised by sweeping all 216
 * cube indices in the tests.
 */
function cubeLevel(step: number): number {
  switch (step % 6) {
    case 0:
      return 0;
    case 1:
      return 95;
    case 2:
      return 135;
    case 3:
      return 175;
    case 4:
      return 215;
    default:
      return 255;
  }
}

/** The 6×6×6 cube plus 24 greys that make up ANSI 256 above index 15. */
function ansi256ToCss(index: number, theme: Theme): string {
  if (index < 16) return theme.ansi16[index] ?? theme.defaultFg;
  if (index < 232) {
    const n = index - 16;
    const r = cubeLevel(Math.floor(n / 36));
    const g = cubeLevel(Math.floor(n / 6));
    const b = cubeLevel(n);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const level = 8 + (index - 232) * 10;
  return `#${hex2(level)}${hex2(level)}${hex2(level)}`;
}

/**
 * Visible rows, paired with their cells.
 *
 * Yielding the row array here rather than re-indexing per row means the paint
 * loops carry no `=== undefined` guards at all. The one guard that remains is
 * genuinely reachable — a grid shorter than the declared `size`, which a caller
 * can produce by passing a stale composite — and is covered by a test.
 */
function visibleRows(
  grid: ResolvedGrid,
  rowStart: number,
  rowEnd: number,
): { row: number; cells: readonly ResolvedCell[] }[] {
  const out: { row: number; cells: readonly ResolvedCell[] }[] = [];
  for (let row = rowStart; row <= rowEnd; row++) {
    const cells = grid[row];
    if (cells !== undefined) out.push({ row, cells });
  }
  return out;
}

/** The visible cells of a row, with absolute column indices. */
function visibleCells(
  cells: readonly ResolvedCell[],
  colStart: number,
  colEnd: number,
): { col: number; cell: ResolvedCell }[] {
  return cells.slice(colStart, colEnd + 1).map((cell, i) => ({ col: colStart + i, cell }));
}

export function cssColor(color: Color, role: "fg" | "bg", theme: Theme): string {
  switch (color.kind) {
    case "default":
      return role === "fg" ? theme.defaultFg : theme.defaultBg;
    case "ansi16":
      return theme.ansi16[color.index] ?? (role === "fg" ? theme.defaultFg : theme.defaultBg);
    case "ansi256":
      return ansi256ToCss(color.index, theme);
    case "rgb":
      return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  }
}

/** True when the cell needs no background rect drawn over the document base. */
function isDefaultBg(cell: ResolvedCell): boolean {
  return cell.bg.kind === "default" && cell.inverse !== true;
}

/** Resolves a cell's colours, honouring the inverse flag. */
function cellColors(cell: ResolvedCell, theme: Theme): { fg: string; bg: string } {
  const fg = cssColor(cell.fg, "fg", theme);
  const bg = cssColor(cell.bg, "bg", theme);
  return cell.inverse === true ? { fg: bg, bg: fg } : { fg, bg };
}

/** Background rects, one per horizontal run of equal colour. */
export function planCellBackgrounds(input: PaintInput): DrawCmd[] {
  const { grid, metrics, viewport, theme, size } = input;
  const { w, h } = scaledCell(metrics, viewport);
  const range = visibleCellRange(metrics, viewport, size);
  const out: DrawCmd[] = [];

  for (const { row, cells } of visibleRows(grid, range.rowStart, range.rowEnd)) {
    let runStart = -1;
    let runFill = "";
    const flush = (endExclusive: number): void => {
      if (runStart === -1) return;
      const { x, y } = pointFromCell({ row, col: runStart }, metrics, viewport, size);
      out.push({ t: "rect", x, y, w: (endExclusive - runStart) * w, h, fill: runFill });
      runStart = -1;
    };
    for (const { col, cell } of visibleCells(cells, range.colStart, range.colEnd)) {
      if (isDefaultBg(cell)) {
        flush(col);
        continue;
      }
      const { bg } = cellColors(cell, theme);
      if (runStart === -1) {
        runStart = col;
        runFill = bg;
      } else if (bg !== runFill) {
        flush(col);
        runStart = col;
        runFill = bg;
      }
    }
    flush(range.colEnd + 1);
  }
  return out;
}

/**
 * Glyph runs, batched by style.
 *
 * Runs exist to avoid `fillStyle`/`font` state changes — the actually expensive
 * part — not to let the font position glyphs. Spaces break a run so no command
 * carries invisible trailing content.
 */
export function planGlyphs(input: PaintInput): DrawCmd[] {
  const { grid, metrics, viewport, theme, size } = input;
  const { w } = scaledCell(metrics, viewport);
  const range = visibleCellRange(metrics, viewport, size);
  const scale = viewport.zoom;
  const out: DrawCmd[] = [];

  for (const { row, cells } of visibleRows(grid, range.rowStart, range.rowEnd)) {
    const { y: cellTop } = pointFromCell({ row, col: 0 }, metrics, viewport, size);
    const baseline = cellTop + metrics.baselineY * scale;

    let start = -1;
    let text = "";
    let key = "";
    let fill = "";
    let bold = false;
    let italic = false;

    const flush = (): void => {
      if (start === -1 || text.length === 0) {
        start = -1;
        text = "";
        return;
      }
      const { x } = pointFromCell({ row, col: start }, metrics, viewport, size);
      out.push({ t: "text", x, y: baseline, text, fill, bold, italic, advance: w });
      start = -1;
      text = "";
    };

    for (const { col, cell } of visibleCells(cells, range.colStart, range.colEnd)) {
      if (cell.char === " ") {
        flush();
        continue;
      }
      const colors = cellColors(cell, theme);
      const thisKey = `${colors.fg}|${cell.bold === true}|${cell.italic === true}`;
      if (start === -1) {
        start = col;
        text = cell.char;
        key = thisKey;
        fill = colors.fg;
        bold = cell.bold === true;
        italic = cell.italic === true;
      } else if (thisKey === key) {
        text += cell.char;
      } else {
        flush();
        start = col;
        text = cell.char;
        key = thisKey;
        fill = colors.fg;
        bold = cell.bold === true;
        italic = cell.italic === true;
      }
    }
    flush();
  }
  return out;
}

export function planUnderlines(input: PaintInput): DrawCmd[] {
  const { grid, metrics, viewport, theme, size } = input;
  const { w, h } = scaledCell(metrics, viewport);
  const range = visibleCellRange(metrics, viewport, size);
  const out: DrawCmd[] = [];

  for (const { row, cells } of visibleRows(grid, range.rowStart, range.rowEnd)) {
    for (const { col, cell } of visibleCells(cells, range.colStart, range.colEnd)) {
      if (cell.underline !== true) continue;
      const { x, y } = pointFromCell({ row, col }, metrics, viewport, size);
      out.push({ t: "underline", x, y: y + h - 1, w, stroke: cellColors(cell, theme).fg });
    }
  }
  return out;
}

/** Grid lines, only at zoom ≥ 100% per the spec. */
export function planGrid(input: PaintInput): DrawCmd[] {
  const { metrics, viewport, theme, size, overlays } = input;
  if (!overlays.showGrid || viewport.zoom < 1) return [];
  const range = visibleCellRange(metrics, viewport, size);
  const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];

  const top = pointFromCell({ row: range.rowStart, col: 0 }, metrics, viewport, size).y;
  const bottom = pointFromCell({ row: range.rowEnd + 1, col: 0 }, metrics, viewport, size).y;
  const left = pointFromCell({ row: 0, col: range.colStart }, metrics, viewport, size).x;
  const right = pointFromCell({ row: 0, col: range.colEnd + 1 }, metrics, viewport, size).x;

  for (let col = range.colStart; col <= range.colEnd + 1; col++) {
    const x = pointFromCell({ row: 0, col }, metrics, viewport, size).x;
    segments.push({ x1: x, y1: top, x2: x, y2: bottom });
  }
  for (let row = range.rowStart; row <= range.rowEnd + 1; row++) {
    const y = pointFromCell({ row, col: 0 }, metrics, viewport, size).y;
    segments.push({ x1: left, y1: y, x2: right, y2: y });
  }
  return [{ t: "lines", segments, stroke: theme.gridLine, lineWidth: 1 / metrics.dpr }];
}

export function planSelection(input: PaintInput): DrawCmd[] {
  const { overlays, theme } = input;
  const out: DrawCmd[] = [];
  if (overlays.dragRect !== null) {
    const r = rectOf(overlays.dragRect, input);
    out.push({ ...r, t: "stroke", stroke: theme.selectionStroke, lineWidth: 1 });
  }
  if (overlays.selection !== null) {
    const r = rectOf(overlays.selection, input);
    out.push({
      ...r,
      t: "stroke",
      stroke: theme.selectionStroke,
      lineWidth: 1,
      dash: [4, 3],
      // Normalised so a zero phase yields 0 rather than -0, which would otherwise
      // leak a value that compares unequal to 0 into every snapshot.
      dashOffset: overlays.marqueePhase === 0 ? 0 : -overlays.marqueePhase,
    });
  }
  return out;
}

export function planCursor(input: PaintInput): DrawCmd[] {
  const { overlays, metrics, viewport, theme, size } = input;
  if (overlays.cursor === null) return [];
  const { w, h } = scaledCell(metrics, viewport);
  const { x, y } = pointFromCell(overlays.cursor, metrics, viewport, size);
  return [{ t: "stroke", x, y, w, h, stroke: theme.cursorStroke, lineWidth: 1 }];
}

/**
 * The text caret, as an inverse-video block.
 *
 * Drawn after everything else and *over* the cell's own glyph, so the character
 * under the caret stays readable rather than being hidden by a solid rectangle.
 */
export function planCaret(input: PaintInput): DrawCmd[] {
  const { overlays, metrics, viewport, size, theme, grid } = input;
  if (overlays.caret === null) return [];
  const { w, h } = scaledCell(metrics, viewport);
  const { x, y } = pointFromCell(overlays.caret, metrics, viewport, size);
  const out: DrawCmd[] = [{ t: "rect", x, y, w, h, fill: theme.caretFill }];
  const cell = grid[overlays.caret.row]?.[overlays.caret.col];
  if (cell !== undefined && cell.char !== " ") {
    out.push({
      t: "text",
      x,
      y: y + metrics.baselineY * viewport.zoom,
      text: cell.char,
      fill: theme.caretText,
      bold: cell.bold === true,
      italic: cell.italic === true,
      advance: w,
    });
  }
  return out;
}

function rectOf(rect: CellRect, input: PaintInput): { x: number; y: number; w: number; h: number } {
  const { w, h } = scaledCell(input.metrics, input.viewport);
  const { x, y } = pointFromCell(
    { row: rect.top, col: rect.left },
    input.metrics,
    input.viewport,
    input.size,
  );
  return { x, y, w: rect.cols * w, h: rect.rows * h };
}

/** The whole frame, as data. */
export function buildPaintPlan(input: PaintInput): DrawCmd[] {
  const { metrics, viewport, size, theme } = input;
  const extent = {
    w: size.cols * scaledCell(metrics, viewport).w,
    h: size.rows * scaledCell(metrics, viewport).h,
  };
  const origin = pointFromCell({ row: 0, col: 0 }, metrics, viewport, size);

  return [
    { t: "clear", fill: theme.voidFill },
    { t: "rect", x: origin.x, y: origin.y, w: extent.w, h: extent.h, fill: theme.defaultBg },
    ...planCellBackgrounds(input),
    ...planGlyphs(input),
    ...planUnderlines(input),
    ...planGrid(input),
    ...planSelection(input),
    ...planCursor(input),
    ...planCaret(input),
  ];
}
