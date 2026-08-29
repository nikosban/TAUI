import { describe, expect, it } from "vitest";
import {
  type CellMetrics,
  cellCenter,
  cellFromPoint,
  cellFromPointClamped,
  clampViewport,
  contentOrigin,
  documentExtentPx,
  type GridSize,
  pointFromCell,
  rectPxFromCellRect,
  scaledCell,
  type Viewport,
  visibleCellRange,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
  zoomIn,
  zoomOut,
} from "../src/canvas/metrics.js";

/**
 * Deliberately round numbers so every expected value is computable in your head.
 * Off-by-one errors at Math.floor boundaries are obvious at 8 and easy to miss at
 * 7.2265625 — which is what a real font actually gives.
 */
const M: CellMetrics = {
  cellW: 8,
  cellH: 16,
  dpr: 1,
  baselineY: 12,
  font: { family: "Menlo", sizePx: 14, lineHeightFactor: 1.2 },
};

const SIZE: GridSize = { cols: 20, rows: 10 };

/**
 * A viewport exactly the size of the document (20×8 by 10×16), so the content
 * origin is (0, 0) and every expected pixel value below stays computable by hand.
 * Centring — which kicks in only when the document is *smaller* than the viewport
 * — is covered separately in its own block.
 */
const V: Viewport = { scrollX: 0, scrollY: 0, widthPx: 160, heightPx: 160, zoom: 1 };

describe("scaledCell", () => {
  it("scales both axes by zoom", () => {
    expect(scaledCell(M, V)).toEqual({ w: 8, h: 16 });
    expect(scaledCell(M, { ...V, zoom: 2 })).toEqual({ w: 16, h: 32 });
    expect(scaledCell(M, { ...V, zoom: 0.5 })).toEqual({ w: 4, h: 8 });
  });
});

describe("cellFromPoint", () => {
  it("maps points inside the document", () => {
    expect(cellFromPoint(0, 0, M, V, SIZE)).toEqual({ row: 0, col: 0 });
    expect(cellFromPoint(7, 15, M, V, SIZE)).toEqual({ row: 0, col: 0 });
    expect(cellFromPoint(8, 16, M, V, SIZE)).toEqual({ row: 1, col: 1 });
    expect(cellFromPoint(20, 40, M, V, SIZE)).toEqual({ row: 2, col: 2 });
  });

  it("assigns a point exactly on a boundary to the higher-index cell", () => {
    // Pinned semantics: plain Math.floor. A pixel at x=8 is column 1, not 0.
    expect(cellFromPoint(7.999, 0, M, V, SIZE)?.col).toBe(0);
    expect(cellFromPoint(8, 0, M, V, SIZE)?.col).toBe(1);
    expect(cellFromPoint(15.999, 0, M, V, SIZE)?.col).toBe(1);
    expect(cellFromPoint(16, 0, M, V, SIZE)?.col).toBe(2);
  });

  it("returns null in the void rather than a negative index", () => {
    expect(cellFromPoint(-1, 0, M, V, SIZE)).toBeNull();
    expect(cellFromPoint(0, -1, M, V, SIZE)).toBeNull();
    expect(cellFromPoint(-0.001, -0.001, M, V, SIZE)).toBeNull();
  });

  it("returns null past the last row or column", () => {
    // 20 cols × 8 = 160; 10 rows × 16 = 160.
    expect(cellFromPoint(159, 159, M, V, SIZE)).toEqual({ row: 9, col: 19 });
    expect(cellFromPoint(160, 0, M, V, SIZE)).toBeNull();
    expect(cellFromPoint(0, 160, M, V, SIZE)).toBeNull();
  });

  it("accounts for scroll", () => {
    const scrolled = { ...V, scrollX: 80, scrollY: 32 };
    expect(cellFromPoint(0, 0, M, scrolled, SIZE)).toEqual({ row: 2, col: 10 });
    expect(cellFromPoint(8, 16, M, scrolled, SIZE)).toEqual({ row: 3, col: 11 });
  });

  it("accounts for zoom", () => {
    const zoomed = { ...V, zoom: 2 };
    expect(cellFromPoint(0, 0, M, zoomed, SIZE)).toEqual({ row: 0, col: 0 });
    expect(cellFromPoint(15, 31, M, zoomed, SIZE)).toEqual({ row: 0, col: 0 });
    expect(cellFromPoint(16, 32, M, zoomed, SIZE)).toEqual({ row: 1, col: 1 });
  });
});

describe("cellFromPointClamped", () => {
  it("clamps instead of returning null, so a drag off-canvas keeps going", () => {
    expect(cellFromPointClamped(-50, -50, M, V, SIZE)).toEqual({ row: 0, col: 0 });
    expect(cellFromPointClamped(9999, 9999, M, V, SIZE)).toEqual({ row: 9, col: 19 });
    expect(cellFromPointClamped(-50, 40, M, V, SIZE)).toEqual({ row: 2, col: 0 });
  });

  it("agrees with cellFromPoint inside the document", () => {
    for (const [px, py] of [
      [0, 0],
      [8, 16],
      [100, 100],
      [159, 159],
    ] as const) {
      expect(cellFromPointClamped(px, py, M, V, SIZE)).toEqual(cellFromPoint(px, py, M, V, SIZE));
    }
  });
});

describe("pointFromCell", () => {
  it("is the inverse of cellFromPoint at cell origins", () => {
    for (const pos of [
      { row: 0, col: 0 },
      { row: 3, col: 7 },
      { row: 9, col: 19 },
    ]) {
      const { x, y } = pointFromCell(pos, M, V, SIZE);
      expect(cellFromPoint(x, y, M, V, SIZE)).toEqual(pos);
    }
  });

  it("computes position by multiplication, never by accumulation", () => {
    // The G0 finding: cellW is always fractional, and summing a rounded per-cell
    // width drifts six columns over 120. Multiplication cannot drift.
    const fractional: CellMetrics = { ...M, cellW: 8.4287, cellH: 16.8 };
    // Larger than the viewport in both axes, so the origin is scroll-based (0)
    // rather than centred — isolating the multiplication under test.
    const wide: GridSize = { cols: 120, rows: 40 };
    const last = pointFromCell({ row: 39, col: 119 }, fractional, V, wide);
    expect(last.x).toBeCloseTo(119 * 8.4287, 10);
    expect(last.y).toBeCloseTo(39 * 16.8, 10);

    // An accumulating implementation would land here instead — 51px, six columns short.
    let accumulated = 0;
    for (let i = 0; i < 119; i++) accumulated += Math.round(fractional.cellW);
    expect(Math.abs(accumulated - last.x)).toBeGreaterThan(50);
    expect(documentExtentPx(fractional, V, wide).w).toBeCloseTo(120 * 8.4287, 10);
  });

  it("offsets by scroll", () => {
    expect(pointFromCell({ row: 1, col: 1 }, M, { ...V, scrollX: 8, scrollY: 16 }, SIZE)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("cellCenter", () => {
  it("returns the middle of the cell box", () => {
    expect(cellCenter({ row: 0, col: 0 }, M, V, SIZE)).toEqual({ x: 4, y: 8 });
    expect(cellCenter({ row: 2, col: 3 }, M, V, SIZE)).toEqual({ x: 28, y: 40 });
  });

  it("round-trips through cellFromPoint for every cell", () => {
    // This is what makes Playwright tests non-brittle: click the centre, land in
    // the cell, regardless of font or zoom.
    for (const zoom of [0.5, 1, 2.5]) {
      const v = { ...V, zoom };
      for (let row = 0; row < SIZE.rows; row++) {
        for (let col = 0; col < SIZE.cols; col++) {
          const { x, y } = cellCenter({ row, col }, M, v, SIZE);
          expect(cellFromPoint(x, y, M, v, SIZE), `${row},${col} @ ${zoom}`).toEqual({ row, col });
        }
      }
    }
  });
});

describe("rectPxFromCellRect", () => {
  it("covers exactly the cells in the rect", () => {
    expect(rectPxFromCellRect({ top: 1, left: 2, rows: 3, cols: 4 }, M, V, SIZE)).toEqual({
      x: 16,
      y: 16,
      w: 32,
      h: 48,
    });
  });

  it("scales with zoom", () => {
    expect(
      rectPxFromCellRect({ top: 0, left: 0, rows: 1, cols: 1 }, M, { ...V, zoom: 2 }, SIZE),
    ).toEqual({
      x: 0,
      y: 0,
      w: 16,
      h: 32,
    });
  });
});

describe("visibleCellRange", () => {
  it("covers the whole document when it fits", () => {
    expect(visibleCellRange(M, V, SIZE)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 19,
    });
  });

  it("culls to the viewport when scrolled", () => {
    const v = { ...V, scrollX: 80, scrollY: 32, widthPx: 40, heightPx: 32 };
    expect(visibleCellRange(M, v, SIZE)).toEqual({
      rowStart: 2,
      rowEnd: 3,
      colStart: 10,
      colEnd: 14,
    });
  });

  it("never exceeds the document bounds", () => {
    const v = { ...V, widthPx: 100_000, heightPx: 100_000 };
    const r = visibleCellRange(M, v, SIZE);
    expect(r.colEnd).toBe(SIZE.cols - 1);
    expect(r.rowEnd).toBe(SIZE.rows - 1);
  });

  it("culls hard at high zoom — the reason culling exists", () => {
    const big: GridSize = { cols: 300, rows: 100 };
    const v = { ...V, zoom: 4, widthPx: 800, heightPx: 600 };
    const r = visibleCellRange(M, v, big);
    const visible = (r.rowEnd - r.rowStart + 1) * (r.colEnd - r.colStart + 1);
    expect(visible).toBeLessThan((big.cols * big.rows) / 10);
  });
});

describe("documentExtentPx", () => {
  it("is cols × cellW by rows × cellH, scaled by zoom", () => {
    expect(documentExtentPx(M, V, SIZE)).toEqual({ w: 160, h: 160 });
    expect(documentExtentPx(M, { ...V, zoom: 2 }, SIZE)).toEqual({ w: 320, h: 320 });
  });
});

describe("clampViewport", () => {
  it("pins scroll to zero when the document is smaller than the viewport", () => {
    // The void then appears right and below, rather than surrounding the document.
    const v = clampViewport({ ...V, scrollX: 50, scrollY: 50 }, M, SIZE);
    expect(v.scrollX).toBe(0);
    expect(v.scrollY).toBe(0);
  });

  it("stops scroll at the document edge", () => {
    const v = { ...V, widthPx: 80, heightPx: 80, scrollX: 9999, scrollY: 9999 };
    const clamped = clampViewport(v, M, SIZE);
    expect(clamped.scrollX).toBe(80); // 160 extent - 80 viewport
    expect(clamped.scrollY).toBe(80);
  });

  it("never allows negative scroll", () => {
    const clamped = clampViewport({ ...V, scrollX: -100, scrollY: -100 }, M, SIZE);
    expect(clamped.scrollX).toBe(0);
    expect(clamped.scrollY).toBe(0);
  });

  it("clamps zoom into range", () => {
    expect(clampViewport({ ...V, zoom: 99 }, M, SIZE).zoom).toBe(ZOOM_MAX);
    expect(clampViewport({ ...V, zoom: 0.01 }, M, SIZE).zoom).toBe(ZOOM_MIN);
  });

  it("recomputes the scroll limit using the clamped zoom", () => {
    // Zooming out must not leave scroll stranded past the new, smaller extent.
    const v = { ...V, widthPx: 80, heightPx: 80, scrollX: 200, scrollY: 200, zoom: 0.1 };
    const clamped = clampViewport(v, M, SIZE);
    expect(clamped.zoom).toBe(ZOOM_MIN);
    expect(clamped.scrollX).toBe(0); // 160 × 0.5 = 80 extent = viewport
  });
});

describe("zoom steps", () => {
  it("steps up and down through the ladder", () => {
    expect(zoomIn(1)).toBe(1.25);
    expect(zoomIn(1.5)).toBe(2);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomOut(2)).toBe(1.5);
  });

  it("saturates at the ends", () => {
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(zoomIn(99)).toBe(ZOOM_MAX);
    expect(zoomOut(0.01)).toBe(ZOOM_MIN);
  });

  it("handles a zoom that is not on the ladder", () => {
    expect(zoomIn(1.1)).toBe(1.25);
    expect(zoomOut(1.1)).toBe(1);
  });
});

describe("contentOrigin — centring", () => {
  /** Viewport roomier than the 160×160 document in both axes. */
  const roomy: Viewport = { ...V, widthPx: 400, heightPx: 300 };

  it("centres a document smaller than the viewport", () => {
    // A small mockup should sit in the middle, not cling to the top-left corner.
    expect(contentOrigin(M, roomy, SIZE)).toEqual({ x: 120, y: 70 });
  });

  it("centres each axis independently", () => {
    // Wide but short viewport: centred horizontally, scroll-based vertically.
    const wideShort: Viewport = { ...V, widthPx: 400, heightPx: 100, scrollY: 24 };
    expect(contentOrigin(M, wideShort, SIZE)).toEqual({ x: 120, y: -24 });
  });

  it("uses the negated scroll once the document outgrows the viewport", () => {
    const tight: Viewport = { ...V, widthPx: 80, heightPx: 80, scrollX: 30, scrollY: 40 };
    expect(contentOrigin(M, tight, SIZE)).toEqual({ x: -30, y: -40 });
  });

  it("accounts for zoom when deciding whether to centre", () => {
    // At 50% the document is 80×80 and fits in a 160×160 viewport, so it centres.
    const half = { ...V, zoom: 0.5 };
    expect(contentOrigin(M, half, SIZE)).toEqual({ x: 40, y: 40 });
    // At 200% it is 320×320 and does not.
    expect(contentOrigin(M, { ...V, zoom: 2 }, SIZE)).toEqual({ x: 0, y: 0 });
  });

  it("keeps cellFromPoint and pointFromCell exact inverses while centred", () => {
    // The whole reason centring lives in one function: the mapping must stay
    // invertible or clicks land on the wrong cell.
    for (const v of [roomy, { ...roomy, zoom: 2 }, { ...roomy, zoom: 0.5 }]) {
      for (let row = 0; row < SIZE.rows; row++) {
        for (let col = 0; col < SIZE.cols; col++) {
          const { x, y } = cellCenter({ row, col }, M, v, SIZE);
          expect(cellFromPoint(x, y, M, v, SIZE), `${row},${col} @ ${v.zoom}`).toEqual({
            row,
            col,
          });
        }
      }
    }
  });

  it("reports null in the void around a centred document", () => {
    // Left of and above the centred content is void, not row/col 0.
    expect(cellFromPoint(119, 70, M, roomy, SIZE)).toBeNull();
    expect(cellFromPoint(120, 69, M, roomy, SIZE)).toBeNull();
    expect(cellFromPoint(120, 70, M, roomy, SIZE)).toEqual({ row: 0, col: 0 });
    // And past the right/bottom edge.
    expect(cellFromPoint(280, 70, M, roomy, SIZE)).toBeNull();
  });

  it("culls correctly against a centred origin", () => {
    // Nothing is off-screen when the document fits, however it is positioned.
    expect(visibleCellRange(M, roomy, SIZE)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 19,
    });
  });
});

describe("zoomAt — pointer-anchored zoom", () => {
  const big: GridSize = { cols: 200, rows: 100 };
  const v: Viewport = { scrollX: 0, scrollY: 0, widthPx: 400, heightPx: 300, zoom: 1 };

  it("keeps the cell under the cursor fixed", () => {
    // Without anchoring, zooming appears to yank the document sideways.
    const pointer = { x: 250, y: 180 };
    const before = cellFromPoint(pointer.x, pointer.y, M, v, big);
    const zoomed = zoomAt(M, v, big, 2, pointer);
    expect(zoomed.zoom).toBe(2);
    expect(cellFromPoint(pointer.x, pointer.y, M, zoomed, big)).toEqual(before);
  });

  it("holds for zooming out as well as in", () => {
    const pointer = { x: 300, y: 200 };
    const start = { ...v, zoom: 4, scrollX: 900, scrollY: 600 };
    const before = cellFromPoint(pointer.x, pointer.y, M, start, big);
    const zoomed = zoomAt(M, start, big, 2, pointer);
    expect(cellFromPoint(pointer.x, pointer.y, M, zoomed, big)).toEqual(before);
  });

  it("holds across a sweep of zoom levels and pointer positions", () => {
    for (const pointer of [
      { x: 0, y: 0 },
      { x: 137, y: 91 },
      { x: 399, y: 299 },
    ]) {
      for (const target of [0.5, 0.75, 1.25, 2, 3, 4]) {
        const start = { ...v, zoom: 1.5, scrollX: 200, scrollY: 150 };
        const before = cellFromPoint(pointer.x, pointer.y, M, start, big);
        const zoomed = zoomAt(M, start, big, target, pointer);
        const after = cellFromPoint(pointer.x, pointer.y, M, zoomed, big);
        // Only compare where the anchor stays inside the document; clamping at the
        // edges legitimately shifts it.
        if (before !== null && after !== null && zoomed.scrollX > 0 && zoomed.scrollY > 0) {
          expect(after, `pointer ${pointer.x},${pointer.y} -> ${target}`).toEqual(before);
        }
      }
    }
  });

  it("clamps the target zoom into range", () => {
    expect(zoomAt(M, v, big, 99, { x: 0, y: 0 }).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(M, v, big, 0.01, { x: 0, y: 0 }).zoom).toBe(ZOOM_MIN);
  });

  it("is a no-op when the zoom would not change", () => {
    expect(zoomAt(M, v, big, 1, { x: 100, y: 100 })).toBe(v);
    // Also when the request clamps back to the current value.
    expect(zoomAt(M, { ...v, zoom: ZOOM_MAX }, big, 99, { x: 0, y: 0 }).zoom).toBe(ZOOM_MAX);
  });

  it("never leaves scroll out of range", () => {
    const zoomed = zoomAt(M, v, big, 0.5, { x: 399, y: 299 });
    expect(zoomed.scrollX).toBeGreaterThanOrEqual(0);
    expect(zoomed.scrollY).toBeGreaterThanOrEqual(0);
    const extent = documentExtentPx(M, zoomed, big);
    expect(zoomed.scrollX).toBeLessThanOrEqual(Math.max(0, extent.w - zoomed.widthPx));
  });
});
