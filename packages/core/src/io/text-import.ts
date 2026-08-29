/**
 * Plain-text import.
 *
 * Pulled forward from M4 because it is how every test fixture and bundled
 * template gets authored: hand-writing `.tui` JSON is miserable, hand-writing
 * ASCII art is pleasant.
 *
 * Never throws. Unsupported characters are substituted and reported, so one wide
 * character can't shift an entire row out of alignment.
 */

import { type Cell, coerceToCells } from "../model/cell.js";
import { type ColorMode, DEFAULT_COLOR } from "../model/color.js";
import { defaultIdGen, type IdGen, type TuiDocument } from "../model/document.js";
import { cellKey } from "../model/layer.js";

export interface ImportResult {
  readonly doc: TuiDocument;
  readonly warnings: readonly string[];
}

export interface ParseTextOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly colorMode?: ColorMode;
  readonly idGen?: IdGen;
  readonly layerName?: string;
  /**
   * Store spaces as painted cells rather than leaving them transparent.
   * Default `false` — transparent whitespace is almost always what you want, and
   * it keeps fixtures small.
   */
  readonly paintSpaces?: boolean;
}

/** Splits on CRLF, LF, or CR, dropping a single trailing newline. */
function splitLines(input: string): string[] {
  const lines = input.split(/\r\n|\n|\r/u);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseText(input: string, opts: ParseTextOptions = {}): ImportResult {
  const warnings: string[] = [];
  const lines = splitLines(input);

  // Coerce first: grid width must be measured in *cells*, not code units, or a
  // substituted character would throw the width off.
  const rowChars = lines.map((line) => {
    const { chars, warnings: lineWarnings } = coerceToCells(line);
    warnings.push(...lineWarnings);
    return chars;
  });

  const widest = rowChars.reduce((max, chars) => Math.max(max, chars.length), 0);
  const cols = opts.cols ?? Math.max(1, widest);
  const rows = opts.rows ?? Math.max(1, rowChars.length);

  if (opts.cols !== undefined && widest > opts.cols) {
    warnings.push(
      `clipped ${widest - opts.cols} column(s) beyond the requested width ${opts.cols}`,
    );
  }
  if (opts.rows !== undefined && rowChars.length > opts.rows) {
    warnings.push(`clipped ${rowChars.length - opts.rows} row(s) beyond the requested height`);
  }

  const cells: Record<string, Cell> = {};
  for (const [row, chars] of rowChars.entries()) {
    if (row >= rows) break;
    for (const [col, char] of chars.entries()) {
      if (col >= cols) break;
      if (char === " " && opts.paintSpaces !== true) continue;
      cells[cellKey(row, col)] = { char, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR };
    }
  }

  const id = (opts.idGen ?? defaultIdGen)();
  return {
    doc: {
      version: 1,
      cols,
      rows,
      colorMode: opts.colorMode ?? "ansi256",
      layers: [
        {
          id,
          name: opts.layerName ?? "imported",
          visible: true,
          locked: false,
          cells,
        },
      ],
      activeLayerId: id,
      palette: [],
    },
    warnings,
  };
}
