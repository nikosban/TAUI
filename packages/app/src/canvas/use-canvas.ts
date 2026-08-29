/**
 * React glue for the canvas. Impure, and deliberately the only place React and
 * the renderer meet.
 *
 * The painter subscribes to the document store **imperatively** inside the rAF
 * loop rather than through a hook. A hook here would route every pointer-driven
 * repaint through React's scheduler, which is the likeliest source of "the app
 * feels laggy while dragging". The canvas is one element; React has no business
 * in its update path.
 *
 * Repaint is decided by comparing input *identities* inside the frame, not by
 * effects that mark a dirty flag. `App` memoises `metrics`, `viewport`,
 * `overlays`, and `theme`, and core returns new documents with structural
 * sharing, so identity is a valid and very cheap cache key. The spec sanctions a
 * full repaint per frame; this just avoids burning one when nothing moved.
 */

import { composite, type TuiDocument } from "@tui-designer/core";
import { type RefObject, useEffect, useRef } from "react";
import type { CellMetrics, Viewport } from "./metrics.js";
import { buildPaintPlan, type Overlays, type Theme } from "./paint-plan.js";
import { createRenderer, type Renderer } from "./renderer.js";

export interface CanvasPainterOptions {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  /**
   * The document to paint, read fresh each frame.
   *
   * Returns the in-progress *scratch* document during a drag and the committed
   * present otherwise — which is why previews show real merged output rather than
   * an approximation. Read imperatively so pointer-driven repaints never enter
   * React's scheduler.
   */
  readonly getDoc: () => TuiDocument;
  readonly metrics: CellMetrics;
  readonly viewport: Viewport;
  readonly overlays: Overlays;
  readonly theme: Theme;
  /** Animate the selection marquee. Off when there is no selection. */
  readonly animate: boolean;
}

/** What the last painted frame was built from. */
interface PaintedFrom {
  metrics: CellMetrics;
  viewport: Viewport;
  overlays: Overlays;
  theme: Theme;
  doc: TuiDocument;
}

function unchanged(previous: PaintedFrom | null, next: PaintedFrom): boolean {
  return (
    previous !== null &&
    previous.metrics === next.metrics &&
    previous.viewport === next.viewport &&
    previous.overlays === next.overlays &&
    previous.theme === next.theme &&
    previous.doc === next.doc
  );
}

export function useCanvasPainter(opts: CanvasPainterOptions): void {
  // Latest props in a ref so the rAF loop reads them without re-subscribing.
  const latest = useRef(opts);
  latest.current = opts;

  const canvasRef = opts.canvasRef;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const renderer: Renderer = createRenderer(canvas);

    let raf = 0;
    let phase = 0;
    let painted: PaintedFrom | null = null;

    const frame = (): void => {
      const { metrics, viewport, overlays, theme, getDoc, animate } = latest.current;
      const next: PaintedFrom = { metrics, viewport, overlays, theme, doc: getDoc() };

      if (animate) phase = (phase + 0.5) % 7;
      if (animate || !unchanged(painted, next)) {
        renderer.resize(viewport.widthPx, viewport.heightPx, metrics.dpr);
        renderer.execute(
          buildPaintPlan({
            grid: composite(next.doc),
            size: { cols: next.doc.cols, rows: next.doc.rows },
            metrics,
            viewport,
            overlays: animate ? { ...overlays, marqueePhase: phase } : overlays,
            theme,
          }),
          // Glyphs scale with zoom, so the drawn font size is the base size times
          // zoom while the *geometry* stays base-metrics × zoom. Keeping geometry
          // off the measured-at-zoom path guarantees the grid and the glyph
          // columns cannot disagree. Safe because a monospace advance is linear in
          // size — Menlo's ratio is a constant 0.60205 across every size measured
          // in the G0 spike.
          { ...metrics.font, sizePx: metrics.font.sizePx * viewport.zoom },
        );
        painted = next;
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [canvasRef]);
}
