/**
 * Grid → plain string. Characters only, no styling.
 *
 * This is the primary verification surface for the entire engine: every
 * box-merge behavior is asserted as an inline `toText` snapshot. The spec never
 * gave it a contract, so the decisions are pinned here.
 *
 * `trimTrailingWhitespace` defaults to **true**. Without it every inline snapshot
 * in every test accumulates invisible trailing spaces that no reviewer can see in
 * a diff — and a snapshot nobody can read is a snapshot nobody checks.
 */

import type { TuiDocument } from "../model/document.js";
import { composite, type ResolvedGrid } from "./composite.js";

export interface ToTextOptions {
  /** Strip trailing whitespace per line. Default `true`. */
  readonly trimTrailingWhitespace?: boolean;
  /** Default `"\n"`. */
  readonly lineEnding?: "\n" | "\r\n";
  /** Emit a line ending after the final row. Default `false`. */
  readonly trailingNewline?: boolean;
}

/** Renders a pre-composited grid. Always emits exactly one line per row. */
export function gridToText(grid: ResolvedGrid, opts: ToTextOptions = {}): string {
  const trim = opts.trimTrailingWhitespace ?? true;
  const eol = opts.lineEnding ?? "\n";
  const lines = grid.map((row) => {
    const line = row.map((cell) => cell.char).join("");
    return trim ? line.replace(/\s+$/u, "") : line;
  });
  return lines.join(eol) + (opts.trailingNewline === true ? eol : "");
}

export function toText(doc: TuiDocument, opts: ToTextOptions = {}): string {
  return gridToText(composite(doc), opts);
}
