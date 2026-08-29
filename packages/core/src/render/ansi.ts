/**
 * ANSI export.
 *
 * Minimal-diff encoding: an SGR sequence is emitted only where the style differs
 * from the previous cell, which is what makes the output readable in a diff and
 * small enough to paste into a terminal.
 *
 * **Style state resets at every row boundary.** Each row ends with `\x1b[0m` and a
 * newline, and the tracker starts each row from "everything default". That costs a
 * few bytes per row and buys two things: a row can be cut out of the output and
 * still render correctly, and a truncated capture cannot bleed colour into
 * whatever the terminal prints next.
 */

import { type Color, type ColorMode, downgradeColor } from "../model/color.js";
import type { TuiDocument } from "../model/document.js";
import { composite, type ResolvedCell, type ResolvedGrid } from "./composite.js";

export interface ToAnsiOptions {
  /**
   * Append a final `\x1b[0m` after the last row. Default `true`.
   *
   * Only worth turning off when concatenating fragments, since every row already
   * ends in a reset.
   */
  readonly trailingReset?: boolean;
}

/** The style half of a cell — everything an SGR sequence controls. */
interface Style {
  readonly fg: Color;
  readonly bg: Color;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
}

const DEFAULT_STYLE: Style = {
  fg: { kind: "default" },
  bg: { kind: "default" },
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
};

const styleOf = (cell: ResolvedCell, mode: ColorMode): Style => ({
  fg: downgradeColor(cell.fg, mode),
  bg: downgradeColor(cell.bg, mode),
  bold: cell.bold ?? false,
  italic: cell.italic ?? false,
  underline: cell.underline ?? false,
  inverse: cell.inverse ?? false,
});

const sameColor = (a: Color, b: Color): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "rgb" && b.kind === "rgb") return a.r === b.r && a.g === b.g && a.b === b.b;
  if (a.kind === "ansi16" && b.kind === "ansi16") return a.index === b.index;
  if (a.kind === "ansi256" && b.kind === "ansi256") return a.index === b.index;
  return true; // both default
};

/**
 * SGR parameters setting `color` as foreground or background.
 *
 * ansi16 uses the compact 30–37 / 90–97 (and 40–47 / 100–107) forms rather than
 * `38;5;n`, because that is what a 16-colour terminal understands and what lets
 * the user's theme apply.
 */
function colorParams(color: Color, layer: "fg" | "bg"): number[] {
  const base = layer === "fg" ? 30 : 40;
  switch (color.kind) {
    case "default":
      return [base + 9]; // 39 / 49
    case "ansi16":
      // 0–7 are the base range; 8–15 are the bright range at +60.
      return [color.index < 8 ? base + color.index : base + 60 + (color.index - 8)];
    case "ansi256":
      return [base + 8, 5, color.index];
    case "rgb":
      return [base + 8, 2, color.r, color.g, color.b];
  }
}

/** The SGR parameters taking `from` to `to`, or an empty array if identical. */
function transition(from: Style, to: Style): number[] {
  const params: number[] = [];
  // Flags first: turning bold off is 22, which must not clobber a colour set in
  // the same sequence, and ordering params this way keeps output stable.
  if (from.bold !== to.bold) params.push(to.bold ? 1 : 22);
  if (from.italic !== to.italic) params.push(to.italic ? 3 : 23);
  if (from.underline !== to.underline) params.push(to.underline ? 4 : 24);
  if (from.inverse !== to.inverse) params.push(to.inverse ? 7 : 27);
  if (!sameColor(from.fg, to.fg)) params.push(...colorParams(to.fg, "fg"));
  if (!sameColor(from.bg, to.bg)) params.push(...colorParams(to.bg, "bg"));
  return params;
}

const sgr = (params: readonly number[]): string =>
  params.length === 0 ? "" : `\x1b[${params.join(";")}m`;

/**
 * Renders `doc` as an ANSI-escaped string, one line per row.
 *
 * Trailing whitespace is **not** trimmed: a run of styled spaces is the only way
 * to express a coloured background, so trimming would silently drop paint. That
 * is the opposite of `toText`, which trims because its output is a snapshot read
 * by humans.
 */
export function toAnsi(doc: TuiDocument, opts: ToAnsiOptions = {}): string {
  return gridToAnsi(composite(doc), doc.colorMode, opts);
}

/** `toAnsi` over an already-composited grid, so a caller can reuse one. */
export function gridToAnsi(grid: ResolvedGrid, mode: ColorMode, opts: ToAnsiOptions = {}): string {
  const out: string[] = [];

  for (const row of grid) {
    let current = DEFAULT_STYLE;
    let line = "";
    for (const cell of row) {
      const next = styleOf(cell, mode);
      line += sgr(transition(current, next));
      line += cell.char;
      current = next;
    }
    // Reset unconditionally: cheaper to reason about than tracking whether the
    // row happened to end in the default style.
    out.push(`${line}\x1b[0m`);
  }

  const body = out.join("\n");
  return opts.trailingReset === false ? body : `${body}\x1b[0m`;
}
