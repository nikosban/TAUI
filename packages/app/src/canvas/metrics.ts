/**
 * Cell geometry. Pure — no DOM, no canvas.
 *
 * Every tool routes pointer input through {@link cellFromPoint}, and the paint
 * plan derives every coordinate from the functions here, so this module is the
 * single place where the grid↔pixel mapping lives.
 *
 * ## The G0 constraint: never accumulate
 *
 * `cellW` is *always* fractional — the G0 spike swept every installed font at
 * every size from 10–40px and found no integral value anywhere (Menlo's advance
 * ratio is 1233/2048 em ≈ 0.60205). Accumulating a rounded per-cell width drifts
 * 51px — six whole columns — over 120 columns.
 *
 * So positions are always computed as `col × cellW`, never by summing. Asserted
 * in `test/metrics.test.ts`.
 */

/** Font identity. Metrics are memoised on this tuple. */
export interface FontSpec {
  readonly family: string;
  readonly sizePx: number;
  readonly lineHeightFactor: number;
}

/**
 * Cell geometry in CSS pixels, plus the device ratio used to size the backing
 * store. Plain data: produced by `measure.ts` from a real canvas, or written by
 * hand in tests.
 */
export interface CellMetrics {
  /** `measureText("M").width`, CSS px. Fractional in practice. */
  readonly cellW: number;
  /** `sizePx × lineHeightFactor`, CSS px. */
  readonly cellH: number;
  readonly dpr: number;
  /** Baseline offset within the cell box, CSS px, for `textBaseline: "alphabetic"`. */
  readonly baselineY: number;
  readonly font: FontSpec;
}

/** Scroll and zoom state of the canvas viewport. */
export interface Viewport {
  /** CSS px, ≥ 0. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** Visible canvas size, CSS px. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** 0.5 – 4.0. */
  readonly zoom: number;
}

export interface GridSize {
  readonly cols: number;
  readonly rows: number;
}

export interface CellPos {
  readonly row: number;
  readonly col: number;
}

export interface RectPx {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface CellRect {
  readonly top: number;
  readonly left: number;
  readonly rows: number;
  readonly cols: number;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

/**
 * Top-left of the document in canvas CSS pixels.
 *
 * When the document is smaller than the viewport it is **centred**, which is what
 * a design surface should do — otherwise a small mockup clings to the top-left
 * corner with all the void on one side. When it is larger, the origin is simply
 * the negated scroll offset.
 *
 * Every coordinate transform goes through this, so `cellFromPoint` and
 * `pointFromCell` stay exact inverses regardless of which regime applies.
 */
export function contentOrigin(
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): { x: number; y: number } {
  const extent = documentExtentPx(m, v, size);
  // `|| 0` normalises -0, which would otherwise leak into every downstream
  // coordinate and compare unequal to 0 in tests and snapshots.
  return {
    x: (extent.w < v.widthPx ? (v.widthPx - extent.w) / 2 : -v.scrollX) || 0,
    y: (extent.h < v.heightPx ? (v.heightPx - extent.h) / 2 : -v.scrollY) || 0,
  };
}

/** Effective cell size at the current zoom. */
export function scaledCell(m: CellMetrics, v: Viewport): { w: number; h: number } {
  return { w: m.cellW * v.zoom, h: m.cellH * v.zoom };
}

/**
 * Maps a pointer position (CSS px, relative to the canvas element's top-left) to
 * a cell, or `null` when the point falls in the void outside the document.
 *
 * Boundary semantics, pinned here rather than left to the implementation: a point
 * exactly on a cell boundary belongs to the **higher-index** cell (plain
 * `Math.floor`), and a point above or left of the document returns `null` rather
 * than a negative index.
 */
export function cellFromPoint(
  px: number,
  py: number,
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): CellPos | null {
  const { w, h } = scaledCell(m, v);
  const origin = contentOrigin(m, v, size);
  const col = Math.floor((px - origin.x) / w);
  const row = Math.floor((py - origin.y) / h);
  if (row < 0 || col < 0 || row >= size.rows || col >= size.cols) return null;
  return { row, col };
}

/**
 * Like {@link cellFromPoint} but clamps into bounds instead of returning `null`.
 *
 * Drags use this: pulling the pointer off-canvas must extend the rubber band to
 * the edge, not cancel the gesture.
 */
export function cellFromPointClamped(
  px: number,
  py: number,
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): CellPos {
  const { w, h } = scaledCell(m, v);
  const origin = contentOrigin(m, v, size);
  const col = Math.floor((px - origin.x) / w);
  const row = Math.floor((py - origin.y) / h);
  return {
    row: Math.max(0, Math.min(size.rows - 1, row)),
    col: Math.max(0, Math.min(size.cols - 1, col)),
  };
}

/** Top-left corner of a cell, in canvas CSS px. Multiplication, never accumulation. */
export function pointFromCell(
  pos: CellPos,
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): { x: number; y: number } {
  const { w, h } = scaledCell(m, v);
  const origin = contentOrigin(m, v, size);
  return { x: origin.x + pos.col * w, y: origin.y + pos.row * h };
}

/** Centre of a cell. Used by tests and by Playwright to click a known cell. */
export function cellCenter(
  pos: CellPos,
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): { x: number; y: number } {
  const { w, h } = scaledCell(m, v);
  const { x, y } = pointFromCell(pos, m, v, size);
  return { x: x + w / 2, y: y + h / 2 };
}

/** Pixel rect covering a cell rect. */
export function rectPxFromCellRect(
  r: CellRect,
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): RectPx {
  const { w, h } = scaledCell(m, v);
  const { x, y } = pointFromCell({ row: r.top, col: r.left }, m, v, size);
  return { x, y, w: r.cols * w, h: r.rows * h };
}

/**
 * The inclusive cell range currently on screen — the paint loop's bounds.
 *
 * This is *not* the dirty-rect tracking the spec forbids. "Don't track which
 * cells changed" and "don't paint cells that aren't visible" are different
 * things: a 300×100 document at 400% zoom is 30k cells of which ~2k are visible.
 * Returns an empty range (rowEnd < rowStart) when nothing is visible.
 */
export function visibleCellRange(
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): { rowStart: number; rowEnd: number; colStart: number; colEnd: number } {
  const { w, h } = scaledCell(m, v);
  const origin = contentOrigin(m, v, size);
  const colStart = Math.max(0, Math.floor(-origin.x / w));
  const rowStart = Math.max(0, Math.floor(-origin.y / h));
  const colEnd = Math.min(size.cols - 1, Math.ceil((v.widthPx - origin.x) / w) - 1);
  const rowEnd = Math.min(size.rows - 1, Math.ceil((v.heightPx - origin.y) / h) - 1);
  return { rowStart, rowEnd, colStart, colEnd };
}

/** Full document extent in CSS px, for scrollbar sizing. */
export function documentExtentPx(
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
): { w: number; h: number } {
  const { w, h } = scaledCell(m, v);
  return { w: size.cols * w, h: size.rows * h };
}

/**
 * Clamps scroll so the document cannot be pushed entirely out of view, and zoom
 * into its supported range.
 *
 * Scroll pins to 0 when the document fits, because {@link contentOrigin} centres
 * it in that case and a non-zero scroll would have no meaning.
 */
export function clampViewport(v: Viewport, m: CellMetrics, size: GridSize): Viewport {
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom));
  const extent = documentExtentPx(m, { ...v, zoom }, size);
  const maxScrollX = Math.max(0, extent.w - v.widthPx);
  const maxScrollY = Math.max(0, extent.h - v.heightPx);
  return {
    ...v,
    zoom,
    scrollX: Math.max(0, Math.min(maxScrollX, v.scrollX)),
    scrollY: Math.max(0, Math.min(maxScrollY, v.scrollY)),
  };
}

/** Zoom steps offered by the `+` / `-` shortcuts. */
const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function zoomIn(zoom: number): number {
  return ZOOM_STEPS.find((z) => z > zoom + 1e-9) ?? ZOOM_MAX;
}

export function zoomOut(zoom: number): number {
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-9) ?? ZOOM_MIN;
}

/**
 * Zooms while keeping the point under the cursor fixed.
 *
 * Without this, zooming appears to drag the document sideways — the thing you
 * were looking at slides away from the pointer. The fractional cell under the
 * cursor is computed before the change and re-pinned after.
 *
 * Pure, so the anchoring maths is unit-testable without a canvas.
 */
export function zoomAt(
  m: CellMetrics,
  v: Viewport,
  size: GridSize,
  nextZoom: number,
  pointer: { x: number; y: number },
): Viewport {
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
  if (zoom === v.zoom) return v;

  // Fractional cell under the cursor, before the zoom.
  const before = contentOrigin(m, v, size);
  const cellX = (pointer.x - before.x) / (m.cellW * v.zoom);
  const cellY = (pointer.y - before.y) / (m.cellH * v.zoom);

  // Solve for the scroll that puts that same cell back under the cursor. When the
  // document fits at the new zoom, `contentOrigin` centres it and scroll is
  // irrelevant, so clampViewport pinning it to 0 is correct.
  const scrollX = cellX * m.cellW * zoom - pointer.x;
  const scrollY = cellY * m.cellH * zoom - pointer.y;

  return clampViewport({ ...v, zoom, scrollX, scrollY }, m, size);
}
