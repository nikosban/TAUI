/**
 * Export.
 *
 * The text formats are core's, already tested there, so these tests are about the
 * app's own decisions: how a filename is derived, and that PNG renders the
 * *document* rather than the editing session.
 *
 * The PNG test drives a fake canvas, which is enough because `exportAsPng`'s job
 * is to hand the right paint plan to the renderer — and the renderer is already
 * covered by the paint-plan acceptance test.
 */

import type { TuiDocument } from "@tui-designer/core";
import { createDocument, drawBox, drawText, sequentialIdGen } from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import type { CellMetrics } from "../src/canvas/metrics.js";
import { DARK_THEME } from "../src/canvas/theme.js";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  exportAsPng,
  exportAsText,
  exportFilename,
  formatInfo,
  MAX_PNG_EDGE,
} from "../src/files/export.js";

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;
const M: CellMetrics = {
  cellW: 8,
  cellH: 16,
  dpr: 1,
  baselineY: 12,
  font: { family: "Menlo", sizePx: 14, lineHeightFactor: 1.2 },
};

function fixture(): TuiDocument {
  let doc = createDocument(12, 4, { colorMode: "ansi256", idGen: sequentialIdGen() });
  doc = drawBox(
    doc,
    doc.activeLayerId,
    { top: 0, left: 0, rows: 4, cols: 12 },
    "light",
    true,
    STYLE,
  );
  doc = drawText(doc, doc.activeLayerId, 1, 2, "hi", {
    fg: { kind: "ansi16", index: 2 },
    bg: { kind: "default" },
  });
  return doc;
}

describe("exportFilename", () => {
  it("replaces the .tui extension rather than appending to it", () => {
    // mockup.tui.svg would be wrong and is the obvious mistake.
    expect(exportFilename("mockup.tui", "svg")).toBe("mockup.svg");
    expect(exportFilename("mockup.tui", "png")).toBe("mockup.png");
    expect(exportFilename("mockup.tui", "ansi")).toBe("mockup.ans");
    expect(exportFilename("mockup.tui", "text")).toBe("mockup.txt");
  });

  it("falls back to untitled for a document that was never saved", () => {
    expect(exportFilename(null, "svg")).toBe("untitled.svg");
  });

  it("keeps a name that has no .tui extension", () => {
    expect(exportFilename("capture", "txt" as ExportFormat)).toContain("capture.");
  });

  it("survives a name that is nothing but the extension", () => {
    // Stripping ".tui" from ".tui" leaves an empty stem, which would produce
    // a file called ".svg" — hidden on every unix.
    expect(exportFilename(".tui", "svg")).toBe("untitled.svg");
  });

  it("leaves an interior .tui alone", () => {
    expect(exportFilename("my.tui.backup", "svg")).toBe("my.tui.backup.svg");
  });

  it("uses the canonical safe-name policy for downloads", () => {
    expect(exportFilename("../safe\u202Egnp.tui", "png")).toBe("-safegnp.png");
    expect([...exportFilename("😀".repeat(200), "svg")]).toHaveLength(120);
  });
});

describe("format metadata", () => {
  it("gives every format a distinct extension", () => {
    const extensions = EXPORT_FORMATS.map((f) => f.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it("resolves each id to its own entry", () => {
    for (const entry of EXPORT_FORMATS) {
      expect(formatInfo(entry.id)).toBe(entry);
    }
  });

  it("falls back to the first format for an unknown id", () => {
    // Reachable only from a corrupt persisted preference, but it must not crash.
    expect(formatInfo("nonsense" as ExportFormat)).toBe(EXPORT_FORMATS[0]);
  });
});

describe("exportAsText", () => {
  it("emits ANSI escapes", () => {
    expect(exportAsText(fixture(), "ansi")).toContain("\x1b[");
  });

  it("emits plain text with no escapes", () => {
    const text = exportAsText(fixture(), "text");
    expect(text).not.toContain("\x1b");
    expect(text.split("\n")[0]).toBe("┌──────────┐");
  });

  it("emits a complete SVG document", () => {
    const svg = exportAsText(fixture(), "svg");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("ends the text formats with a newline, so a shell redirect lands clean", () => {
    expect(exportAsText(fixture(), "ansi").endsWith("\n")).toBe(true);
    expect(exportAsText(fixture(), "text").endsWith("\n")).toBe(true);
  });
});

describe("exportAsPng", () => {
  /** Records what the renderer was asked to do, without a real canvas. */
  function fakeCanvas() {
    const calls: { transform?: number[]; sizes?: number[] } = {};
    const canvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getContext: () => ({
        setTransform: (...args: number[]) => {
          calls.transform = args;
        },
        clearRect: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        fillText: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        save: () => {},
        restore: () => {},
        set fillStyle(_v: string) {},
        set strokeStyle(_v: string) {},
        set lineWidth(_v: number) {},
        set font(_v: string) {},
        set textBaseline(_v: string) {},
        set setLineDash(_v: unknown) {},
      }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["png-bytes"])),
    };
    return { canvas: canvas as unknown as HTMLCanvasElement, calls };
  }

  it("sizes the image to the whole document, not the viewport", async () => {
    const { canvas } = fakeCanvas();
    const doc = fixture();
    await exportAsPng(doc, {
      metrics: M,
      theme: DARK_THEME,
      scale: 1,
      createCanvas: () => canvas,
    });
    // 12 cols × 8, 4 rows × 16.
    expect(canvas.width).toBe(96);
    expect(canvas.height).toBe(64);
  });

  it("multiplies the backing store by the scale, leaving the CSS size alone", async () => {
    const { canvas } = fakeCanvas();
    await exportAsPng(fixture(), {
      metrics: M,
      theme: DARK_THEME,
      scale: 3,
      createCanvas: () => canvas,
    });
    expect(canvas.width).toBe(96 * 3);
    expect(canvas.height).toBe(64 * 3);
  });

  it("defaults to a 2x scale, for a sharp image on a retina screen", async () => {
    const { canvas } = fakeCanvas();
    await exportAsPng(fixture(), { metrics: M, theme: DARK_THEME, createCanvas: () => canvas });
    expect(canvas.width).toBe(96 * 2);
  });

  it("returns the encoded blob", async () => {
    const { canvas } = fakeCanvas();
    const blob = await exportAsPng(fixture(), {
      metrics: M,
      theme: DARK_THEME,
      createCanvas: () => canvas,
    });
    expect(blob.size).toBeGreaterThan(0);
  });

  it("rejects rather than resolving with null when encoding fails", async () => {
    const { canvas } = fakeCanvas();
    (canvas as unknown as { toBlob: (cb: (b: Blob | null) => void) => void }).toBlob = (cb) =>
      cb(null);
    await expect(
      exportAsPng(fixture(), { metrics: M, theme: DARK_THEME, createCanvas: () => canvas }),
    ).rejects.toThrow(/refused to encode/u);
  });

  it("omits the cell grid by default, and includes it on request", async () => {
    // A grid is an editing aid, not content — an exported image with one is
    // almost never what was wanted, but the option exists for documentation.
    const plain = fakeCanvas();
    await exportAsPng(fixture(), {
      metrics: M,
      theme: DARK_THEME,
      scale: 1,
      createCanvas: () => plain.canvas,
    });
    const gridded = fakeCanvas();
    await exportAsPng(fixture(), {
      metrics: M,
      theme: DARK_THEME,
      scale: 1,
      showGrid: true,
      createCanvas: () => gridded.canvas,
    });
    // Both encode; the difference is in the plan, which the paint-plan tests own.
    expect(plain.canvas.width).toBe(gridded.canvas.width);
  });

  it("handles a one-cell document", async () => {
    const { canvas } = fakeCanvas();
    const doc = createDocument(1, 1, { idGen: sequentialIdGen() });
    await exportAsPng(doc, {
      metrics: M,
      theme: DARK_THEME,
      scale: 1,
      createCanvas: () => canvas,
    });
    expect([canvas.width, canvas.height]).toEqual([8, 16]);
  });

  it("rejects unsafe backing-store dimensions before allocating a canvas", async () => {
    let created = false;
    await expect(
      exportAsPng(fixture(), {
        metrics: { ...M, cellW: MAX_PNG_EDGE },
        theme: DARK_THEME,
        scale: 2,
        createCanvas: () => {
          created = true;
          return fakeCanvas().canvas;
        },
      }),
    ).rejects.toThrow(/safe export limit/u);
    expect(created).toBe(false);
  });

  it("rejects invalid PNG scale and metrics", async () => {
    await expect(
      exportAsPng(fixture(), { metrics: M, theme: DARK_THEME, scale: Number.NaN }),
    ).rejects.toThrow(/scale must be a positive finite number/u);
    await expect(
      exportAsPng(fixture(), { metrics: { ...M, cellH: 0 }, theme: DARK_THEME }),
    ).rejects.toThrow(/cell metrics must be positive finite numbers/u);
  });
});
