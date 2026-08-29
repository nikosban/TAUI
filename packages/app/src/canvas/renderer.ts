/**
 * Executes a paint plan against a canvas context.
 *
 * The only module that calls `ctx` drawing methods. Deliberately a plain switch
 * with no logic of its own — everything decidable lives in `paint-plan.ts`, which
 * is pure and tested. Roughly 80 lines of mechanical code is the whole untested
 * surface of the renderer.
 */

import type { DrawCmd } from "./draw-cmd.js";
import { fontString } from "./measure.js";
import type { FontSpec } from "./metrics.js";

export interface Renderer {
  /** Resizes the backing store to `size × dpr` and sets the transform. Idempotent. */
  resize(widthCss: number, heightCss: number, dpr: number): void;
  execute(plan: readonly DrawCmd[], font: FontSpec): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (ctx === null) throw new Error("2d canvas context unavailable");

  let cssWidth = 0;
  let cssHeight = 0;

  return {
    resize(widthCss, heightCss, dpr) {
      const backingW = Math.max(1, Math.round(widthCss * dpr));
      const backingH = Math.max(1, Math.round(heightCss * dpr));
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
      canvas.style.width = `${widthCss}px`;
      canvas.style.height = `${heightCss}px`;
      cssWidth = widthCss;
      cssHeight = heightCss;

      // Set once, here. Every DrawCmd is then in CSS pixels, so `dpr` does not
      // enter the paint plan's geometry at all — asserted by "dpr affects only
      // grid hairline width" in test/paint-plan.test.ts. (Hairline width is the
      // one legitimate exception: a 1-device-pixel line is 1/dpr CSS px.)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textBaseline = "alphabetic";
      if ("textRendering" in ctx) {
        (ctx as CanvasRenderingContext2D & { textRendering: string }).textRendering =
          "geometricPrecision";
      }
    },

    execute(plan, font) {
      let currentFont = "";
      for (const cmd of plan) {
        switch (cmd.t) {
          case "clear":
            ctx.fillStyle = cmd.fill;
            ctx.fillRect(0, 0, cssWidth, cssHeight);
            break;

          case "rect":
            ctx.fillStyle = cmd.fill;
            ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h);
            break;

          case "text": {
            const wanted = fontString(font, { bold: cmd.bold, italic: cmd.italic });
            if (wanted !== currentFont) {
              ctx.font = wanted;
              currentFont = wanted;
            }
            ctx.fillStyle = cmd.fill;
            // Per-glyph positioning: the font can be wrong about a glyph's width
            // but never about where its column starts.
            let i = 0;
            for (const glyph of cmd.text) {
              ctx.fillText(glyph, cmd.x + i * cmd.advance, cmd.y);
              i++;
            }
            break;
          }

          case "underline":
            ctx.fillStyle = cmd.stroke;
            ctx.fillRect(cmd.x, cmd.y, cmd.w, 1);
            break;

          case "stroke":
            ctx.strokeStyle = cmd.stroke;
            ctx.lineWidth = cmd.lineWidth;
            ctx.setLineDash(cmd.dash === undefined ? [] : [...cmd.dash]);
            ctx.lineDashOffset = cmd.dashOffset ?? 0;
            // Half-pixel inset so a 1px stroke lands on the pixel grid.
            ctx.strokeRect(cmd.x + 0.5, cmd.y + 0.5, cmd.w - 1, cmd.h - 1);
            ctx.setLineDash([]);
            break;

          case "lines":
            ctx.strokeStyle = cmd.stroke;
            ctx.lineWidth = cmd.lineWidth;
            ctx.beginPath();
            for (const s of cmd.segments) {
              ctx.moveTo(s.x1, s.y1);
              ctx.lineTo(s.x2, s.y2);
            }
            ctx.stroke();
            break;
        }
      }
    },
  };
}
