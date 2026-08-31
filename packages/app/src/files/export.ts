/**
 * Export.
 *
 * The three text formats come straight from core. **PNG is the GUI's job by
 * design** — rasterising needs font rendering, which is a few lines here (reuse
 * the paint pipeline, read the canvas) and a dependency tarpit headlessly. Core's
 * README says so and the CLI deliberately omits it.
 *
 * The PNG path reuses `buildPaintPlan` and `renderer.ts` rather than drawing
 * again: whatever the exported image shows is by construction what the canvas
 * shows, because the same planner produced both.
 */

import { composite, type TuiDocument, toAnsi, toSvg, toText } from "@tui-designer/core";
import type { CellMetrics, GridSize, Viewport } from "../canvas/metrics.js";
import type { Theme } from "../canvas/paint-plan.js";
import { buildPaintPlan } from "../canvas/paint-plan.js";
import { createRenderer } from "../canvas/renderer.js";
import { safeFilename } from "../safe-filename.js";

/**
 * A conservative cross-browser ceiling for a temporary PNG backing store.
 * RGBA alone costs four bytes per pixel, so this caps the uncompressed buffer at
 * roughly 64 MB before browser/encoder overhead.
 */
const MAX_PNG_PIXELS = 16_000_000;
export const MAX_PNG_EDGE = 16_384;

export type ExportFormat = "ansi" | "text" | "svg" | "png";

export interface FormatInfo {
  readonly id: ExportFormat;
  readonly label: string;
  readonly extension: string;
  readonly mime: string;
  /** One line on what it is for, shown in the dialog. */
  readonly note: string;
}

export const EXPORT_FORMATS: readonly FormatInfo[] = [
  {
    id: "ansi",
    label: "ANSI",
    extension: "ans",
    mime: "text/plain",
    note: "Escape sequences. cat it in a terminal, or paste into a README code block.",
  },
  {
    id: "text",
    label: "Plain text",
    extension: "txt",
    mime: "text/plain",
    note: "Characters only, no colour. Trailing whitespace trimmed.",
  },
  {
    id: "svg",
    label: "SVG",
    extension: "svg",
    mime: "image/svg+xml",
    note: "Vector, with every column pinned so it cannot drift on another machine.",
  },
  {
    id: "png",
    label: "PNG",
    extension: "png",
    mime: "image/png",
    note: "Raster, rendered with the current font at 1:1. Good for pasting into a ticket.",
  },
];

export const formatInfo = (format: ExportFormat): FormatInfo =>
  EXPORT_FORMATS.find((f) => f.id === format) ?? (EXPORT_FORMATS[0] as FormatInfo);

/**
 * Filename for an export, derived from the document's own name.
 *
 * Strips a trailing `.tui` rather than appending to it, so `mockup.tui` exports as
 * `mockup.svg` and not `mockup.tui.svg`.
 */
export function exportFilename(documentLabel: string | null, format: ExportFormat): string {
  const base = (documentLabel ?? "untitled").replace(/\.tui$/iu, "");
  return safeFilename(base, formatInfo(format).extension);
}

/** The three text formats. PNG is not a string, so it is not here. */
export function exportAsText(doc: TuiDocument, format: Exclude<ExportFormat, "png">): string {
  switch (format) {
    case "ansi":
      return `${toAnsi(doc)}\n`;
    case "svg":
      return toSvg(doc);
    case "text":
      return `${toText(doc)}\n`;
  }
}

export interface PngOptions {
  readonly metrics: CellMetrics;
  readonly theme: Theme;
  /** Pixel scale. 2 gives a retina-sharp image at the same cell size. */
  readonly scale?: number;
  /** Include the cell grid. Default false — a grid is an editing aid, not content. */
  readonly showGrid?: boolean;
  /** Injected in tests; defaults to a real canvas element. */
  readonly createCanvas?: () => HTMLCanvasElement;
}

/**
 * Renders the whole document to a PNG blob.
 *
 * Deliberately renders the **document**, not the viewport: no pan, no zoom, no
 * selection, no caret. An export is the artefact, not a screenshot of the editing
 * session — a marquee left visible in an exported image is a bug report waiting to
 * happen.
 */
export async function exportAsPng(doc: TuiDocument, opts: PngOptions): Promise<Blob> {
  const scale = opts.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`PNG scale must be a positive finite number, got ${scale}`);
  }
  if (
    !Number.isFinite(opts.metrics.cellW) ||
    !Number.isFinite(opts.metrics.cellH) ||
    opts.metrics.cellW <= 0 ||
    opts.metrics.cellH <= 0
  ) {
    throw new RangeError("PNG cell metrics must be positive finite numbers");
  }
  const size: GridSize = { cols: doc.cols, rows: doc.rows };

  // A viewport exactly the size of the document at zoom 1: `contentOrigin` then
  // centres nothing and the whole grid is in frame.
  const widthCss = doc.cols * opts.metrics.cellW;
  const heightCss = doc.rows * opts.metrics.cellH;
  const backingWidth = Math.max(1, Math.round(widthCss * scale));
  const backingHeight = Math.max(1, Math.round(heightCss * scale));
  const backingPixels = backingWidth * backingHeight;
  if (
    !Number.isSafeInteger(backingWidth) ||
    !Number.isSafeInteger(backingHeight) ||
    backingWidth > MAX_PNG_EDGE ||
    backingHeight > MAX_PNG_EDGE ||
    !Number.isSafeInteger(backingPixels) ||
    backingPixels > MAX_PNG_PIXELS
  ) {
    throw new RangeError(
      `PNG backing store ${backingWidth}×${backingHeight} exceeds the safe export limit`,
    );
  }
  const viewport: Viewport = {
    scrollX: 0,
    scrollY: 0,
    widthPx: widthCss,
    heightPx: heightCss,
    zoom: 1,
  };

  /* c8 ignore next -- the DOM default; tests inject a canvas, node has no document. */
  const canvas = (opts.createCanvas ?? (() => document.createElement("canvas")))();
  const renderer = createRenderer(canvas);
  // `scale` goes in as the device pixel ratio, which is exactly what it is here:
  // backing-store pixels per CSS pixel.
  renderer.resize(widthCss, heightCss, scale);

  const plan = buildPaintPlan({
    grid: composite(doc),
    size,
    metrics: opts.metrics,
    viewport,
    theme: opts.theme,
    overlays: {
      showGrid: opts.showGrid ?? false,
      selection: null,
      cursor: null,
      marqueePhase: 0,
      dragRect: null,
      caret: null,
    },
  });
  renderer.execute(plan, opts.metrics.font);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("the browser refused to encode the canvas as a PNG"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}
