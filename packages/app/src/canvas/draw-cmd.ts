/**
 * The seam between the pure paint planner and the impure canvas executor.
 *
 * `paint-plan.ts` produces `DrawCmd[]` and is fully unit-tested; `renderer.ts`
 * executes them and is the only module that touches a canvas context. Tests then
 * assert on *what would be drawn* rather than on a sequence of mock `ctx` calls,
 * which is both less brittle and far more readable.
 *
 * Every coordinate is in **CSS pixels**. `renderer.ts` applies
 * `setTransform(dpr, …)` once, so the device pixel ratio never appears here.
 */

/** Clears the whole canvas to a single colour. Always the first command. */
interface ClearCmd {
  readonly t: "clear";
  readonly fill: string;
}

interface FillRectCmd {
  readonly t: "rect";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/**
 * A run of glyphs sharing one style, drawn left-to-right from `x`.
 *
 * `advance` is carried so the executor positions **each glyph explicitly** at
 * `x + i * advance` rather than handing the string to `fillText` and letting the
 * font's own advances decide. In a font whose box-drawing glyphs are substituted
 * from a fallback (Monaco, per the G0 spike) those advances differ and the row
 * drifts. Per-glyph positioning makes column position independent of the font.
 */
export interface TextRunCmd {
  readonly t: "text";
  readonly x: number;
  /** Baseline y. */
  readonly y: number;
  readonly text: string;
  readonly fill: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly advance: number;
}

interface UnderlineCmd {
  readonly t: "underline";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly stroke: string;
}

interface StrokeRectCmd {
  readonly t: "stroke";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly stroke: string;
  readonly lineWidth: number;
  readonly dash?: readonly number[];
  readonly dashOffset?: number;
}

/** Grid lines, batched into one command to avoid per-line state changes. */
interface LinesCmd {
  readonly t: "lines";
  readonly segments: readonly { x1: number; y1: number; x2: number; y2: number }[];
  readonly stroke: string;
  readonly lineWidth: number;
}

export type DrawCmd = ClearCmd | FillRectCmd | TextRunCmd | UnderlineCmd | StrokeRectCmd | LinesCmd;
