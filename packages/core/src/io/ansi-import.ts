/**
 * ANSI import — the inverse of `render/ansi.ts`.
 *
 * This is what lets a user start from **real terminal output**: a capture of a
 * running Ratatui app, `htop`, a `git log --graph`, anything.
 *
 * **It never throws.** Captures are full of sequences no one anticipated, and a
 * parser that rejects input is useless for the job. Everything unrecognised is
 * skipped and, where it could have changed the result, reported in `warnings`.
 *
 * Scope is deliberately narrow — SGR plus the cursor motions that actually appear
 * in captured frames (CUP, EL, CR, LF). Implementing more of the terminal state
 * machine would mean implementing a terminal.
 */

import { type Cell, coerceNarrowChar } from "../model/cell.js";
import { type Color, type ColorMode, DEFAULT_COLOR } from "../model/color.js";
import { defaultIdGen, type IdGen } from "../model/document.js";
import { cellKey } from "../model/layer.js";
import {
  BoundedWarnings,
  boundImportDimension,
  boundImportInput,
  RESOURCE_LIMITS,
} from "../model/resource-policy.js";
import type { ImportResult } from "./text-import.js";

export interface ParseAnsiOptions {
  /** Grid width. Defaults to the widest line reached. */
  readonly cols?: number;
  readonly rows?: number;
  readonly idGen?: IdGen;
  readonly layerName?: string;
}

/** Mutable pen state while scanning. */
interface Pen {
  fg: Color;
  bg: Color;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const freshPen = (): Pen => ({
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
});

/** Builds a Cell, omitting false flags so absent stays absent through serialize. */
function cellFrom(char: string, pen: Pen): Cell {
  const cell: {
    char: string;
    fg: Color;
    bg: Color;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
  } = { char, fg: pen.fg, bg: pen.bg };
  if (pen.bold) cell.bold = true;
  if (pen.italic) cell.italic = true;
  if (pen.underline) cell.underline = true;
  if (pen.inverse) cell.inverse = true;
  return cell;
}

/**
 * Applies one SGR parameter list to the pen.
 *
 * Bails out of the whole list on a malformed extended colour, so `38;5` with no
 * index is dropped rather than swallowing the following parameter as an index.
 */
function applySgr(pen: Pen, params: readonly number[], warnings: BoundedWarnings): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i] as number;
    switch (p) {
      case 0:
        Object.assign(pen, freshPen());
        break;
      case 1:
        pen.bold = true;
        break;
      case 3:
        pen.italic = true;
        break;
      case 4:
        pen.underline = true;
        break;
      case 7:
        pen.inverse = true;
        break;
      case 22:
        pen.bold = false;
        break;
      case 23:
        pen.italic = false;
        break;
      case 24:
        pen.underline = false;
        break;
      case 27:
        pen.inverse = false;
        break;
      case 39:
        pen.fg = DEFAULT_COLOR;
        break;
      case 49:
        pen.bg = DEFAULT_COLOR;
        break;
      case 38:
      case 48: {
        const layer = p === 38 ? "fg" : "bg";
        const form = params[i + 1];
        if (form === 5) {
          const index = params[i + 2];
          if (index === undefined) {
            warnings.add(`truncated ${p};5 sequence, ignored`);
            return;
          }
          pen[layer] = { kind: "ansi256", index: Math.min(255, Math.max(0, index)) };
          i += 2;
        } else if (form === 2) {
          const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
          if (r === undefined || g === undefined || b === undefined) {
            warnings.add(`truncated ${p};2 sequence, ignored`);
            return;
          }
          const clamp = (v: number) => Math.min(255, Math.max(0, v));
          pen[layer] = { kind: "rgb", r: clamp(r), g: clamp(g), b: clamp(b) };
          i += 4;
        } else {
          warnings.add(`unsupported ${p};${form ?? "?"} colour form, ignored`);
          return;
        }
        break;
      }
      default:
        // 30–37 / 90–97 and their background equivalents.
        if (p >= 30 && p <= 37) pen.fg = { kind: "ansi16", index: p - 30 };
        else if (p >= 90 && p <= 97) pen.fg = { kind: "ansi16", index: p - 90 + 8 };
        else if (p >= 40 && p <= 47) pen.bg = { kind: "ansi16", index: p - 40 };
        else if (p >= 100 && p <= 107) pen.bg = { kind: "ansi16", index: p - 100 + 8 };
        else warnings.add(`unsupported SGR parameter ${p}, ignored`);
        break;
    }
  }
}

/** Rank used to infer `colorMode`: the richest colour actually seen wins. */
const rankOf = (color: Color): number =>
  color.kind === "rgb" ? 3 : color.kind === "ansi256" ? 2 : color.kind === "ansi16" ? 1 : 0;

const MODE_BY_RANK: readonly ColorMode[] = ["ansi16", "ansi16", "ansi256", "rgb"];

/** What one scan of the input produced. */
interface Scan {
  readonly cells: Map<string, Cell>;
  readonly maxRow: number;
  readonly maxCol: number;
  readonly richest: number;
  readonly clippedCells: number;
}

/**
 * Walks the input once, painting into a fresh cell map.
 *
 * `width` is the column count erase-to-EOL should fill to, or `undefined` to skip
 * EL entirely. {@link parseAnsi} runs this twice when the caller gave no `cols`:
 * once to learn the natural width, once to apply EL against it.
 */
function scan(input: string, width: number | undefined, warnings: BoundedWarnings): Scan {
  const pen = freshPen();
  const cells = new Map<string, Cell>();

  let row = 0;
  let col = 0;
  let maxRow = 0;
  let maxCol = 0;
  let richest = 0;
  let clippedCells = 0;

  /** Records a cell and tracks the extent the grid must cover. */
  const put = (char: string, at: { row: number; col: number }, p: Pen): void => {
    if (
      at.row < 0 ||
      at.row >= RESOURCE_LIMITS.documentRows ||
      at.col < 0 ||
      at.col >= RESOURCE_LIMITS.documentCols
    ) {
      clippedCells++;
      return;
    }
    cells.set(cellKey(at.row, at.col), cellFrom(char, p));
    maxRow = Math.max(maxRow, at.row);
    maxCol = Math.max(maxCol, at.col);
    richest = Math.max(richest, rankOf(p.fg), rankOf(p.bg));
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;

    if (ch === "\x1b") {
      const consumed = readEscape(input, i);
      if (consumed === null) {
        // A lone ESC at the very end, or a sequence that never terminates.
        warnings.add("unterminated escape sequence at end of input, ignored");
        break;
      }
      i += consumed.length;
      if (consumed.kind === "sgr") {
        applySgr(pen, consumed.params, warnings);
      } else if (consumed.kind === "cup") {
        // CUP is 1-based; a missing parameter means 1.
        row = Math.max(0, Math.min(RESOURCE_LIMITS.documentRows, (consumed.params[0] ?? 1) - 1));
        col = Math.max(0, Math.min(RESOURCE_LIMITS.documentCols, (consumed.params[1] ?? 1) - 1));
      } else if (consumed.kind === "el" && width !== undefined) {
        // Erase-to-EOL paints the current background across the rest of the row.
        // This is how full-screen apps draw a status bar, so skipping it would
        // silently drop the most visually obvious part of a capture.
        for (let c = col; c < width; c++) put(" ", { row, col: c }, pen);
      }
      continue;
    }

    if (ch === "\n") {
      row = Math.min(RESOURCE_LIMITS.documentRows, row + 1);
      col = 0;
      i++;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i++;
      continue;
    }
    // Control characters other than those handled above carry no cell.
    if (ch < " " && ch !== "\t") {
      warnings.add(`skipped control character U+${ch.codePointAt(0)?.toString(16)}`);
      i++;
      continue;
    }

    // A surrogate pair is one code point; take the whole thing before coercing,
    // or the halves would become two replacement characters.
    const codePoint = String.fromCodePoint(input.codePointAt(i) as number);
    const { char, warning } = coerceNarrowChar(codePoint);
    if (warning !== undefined) warnings.add(warning);
    put(char, { row, col }, pen);
    col = Math.min(RESOURCE_LIMITS.documentCols, col + 1);
    i += codePoint.length;
  }

  return { cells, maxRow, maxCol, richest, clippedCells };
}

/**
 * Parses ANSI-escaped text into a single-layer document named "imported".
 *
 * Layers are legitimately lost — a terminal capture has no layers — but no cell
 * is. That asymmetry is what the round-trip test asserts.
 *
 * When `cols` is omitted the input is scanned **twice**: erase-to-EOL needs to
 * know the row width, and the width is itself derived from the content. One pass
 * would mean either dropping EL (losing every status bar) or deferring it to the
 * end (where it would paint over the text written after it). The second pass is
 * cheap — captures are a screen, not a file.
 *
 * The width EL fills to is the *content* width, not the terminal's. A capture
 * does not record how wide the terminal was, so a bar that ran to column 200 of
 * an 80-column window is unrecoverable either way; content width is the closest
 * honest guess.
 */
export function parseAnsi(input: string, opts: ParseAnsiOptions = {}): ImportResult {
  const warnings = new BoundedWarnings();
  const boundedInput = boundImportInput(input, warnings);
  const explicitCols =
    opts.cols === undefined ? undefined : boundImportDimension(opts.cols, "cols", warnings);
  // The inference pass must not duplicate user-facing warnings when the input is
  // scanned again to apply erase-to-EOL.
  const firstWarnings = explicitCols === undefined ? new BoundedWarnings() : warnings;
  const first = scan(boundedInput, explicitCols, firstWarnings);
  const naturalCols = explicitCols ?? Math.max(1, first.maxCol + 1);
  // Re-scan only when EL could not have been applied on the first pass.
  const final = explicitCols === undefined ? scan(boundedInput, naturalCols, warnings) : first;

  const { cells, maxRow, maxCol, richest } = final;
  let cols = explicitCols ?? Math.max(1, maxCol + 1);
  let rows = boundImportDimension(opts.rows ?? Math.max(1, maxRow + 1), "rows", warnings);
  if (cols * rows > RESOURCE_LIMITS.documentArea) {
    const boundedRows = Math.max(1, Math.floor(RESOURCE_LIMITS.documentArea / cols));
    warnings.add(
      `clipped rows from ${rows} to ${boundedRows} to fit the ${RESOURCE_LIMITS.documentArea}-cell document limit`,
    );
    rows = boundedRows;
  }
  cols = boundImportDimension(cols, "cols", warnings);
  if (final.clippedCells > 0) {
    warnings.add(`${final.clippedCells} cell(s) fell outside the import resource limits`);
  }

  const kept: Record<string, Cell> = {};
  let dropped = 0;
  for (const [key, cell] of cells) {
    const comma = key.indexOf(",");
    const r = Number(key.slice(0, comma));
    const c = Number(key.slice(comma + 1));
    if (r >= rows || c >= cols) {
      dropped++;
      continue;
    }
    kept[key] = cell;
  }
  if (dropped > 0) {
    warnings.add(`${dropped} cell${dropped === 1 ? "" : "s"} fell outside ${cols}×${rows}`);
  }

  const layerId = (opts.idGen ?? defaultIdGen)();
  return {
    doc: {
      version: 1,
      cols,
      rows,
      colorMode: MODE_BY_RANK[richest] as ColorMode,
      layers: [
        {
          id: layerId,
          name: opts.layerName ?? "imported",
          visible: true,
          locked: false,
          cells: kept,
        },
      ],
      // The invariant every op relies on: activeLayerId always names a real layer.
      activeLayerId: layerId,
      palette: [],
    },
    warnings: warnings.finish(),
  };
}

/** What a recognised escape sequence turned out to be. */
type Escape =
  | { readonly kind: "sgr"; readonly params: number[]; readonly length: number }
  | { readonly kind: "cup"; readonly params: number[]; readonly length: number }
  | { readonly kind: "el"; readonly length: number }
  | { readonly kind: "skip"; readonly length: number };

/**
 * Measures and classifies the escape sequence starting at `start`.
 *
 * Returns null only when the sequence never terminates, which can happen at the
 * end of a truncated capture. Anything terminated but unrecognised comes back as
 * `skip` with its true length, which is what keeps a stray OSC from spilling its
 * payload into the grid as literal cells.
 */
function readEscape(input: string, start: number): Escape | null {
  const next = input[start + 1];
  if (next === undefined) return null;

  // CSI: ESC [ params intermediates final
  if (next === "[") {
    let i = start + 2;
    let digits = "";
    let isPrivate = false;
    if (input[i] === "?" || input[i] === "<" || input[i] === "=" || input[i] === ">") {
      isPrivate = true;
      i++;
    }
    while (i < input.length) {
      const c = input[i] as string;
      if ((c >= "0" && c <= "9") || c === ";" || c === ":") {
        digits += c;
        i++;
        continue;
      }
      // Final byte in @–~ terminates the sequence.
      if (c >= "@" && c <= "~") {
        const length = i - start + 1;
        if (isPrivate) return { kind: "skip", length };
        // ":" is a sub-parameter separator this parser does not interpret.
        const params = digits
          .split(";")
          .map((part) => (part === "" ? Number.NaN : Number(part.split(":")[0])))
          .map((n) => (Number.isNaN(n) ? 0 : n));
        if (c === "m") {
          // A bare ESC[m means ESC[0m.
          return { kind: "sgr", params: digits === "" ? [0] : params, length };
        }
        if (c === "H" || c === "f") {
          return { kind: "cup", params: digits === "" ? [] : params, length };
        }
        if (c === "K") return { kind: "el", length };
        return { kind: "skip", length };
      }
      // Any other byte (an intermediate like " " or "!") — keep scanning.
      i++;
    }
    return null;
  }

  // OSC / DCS / APC / PM run until BEL or ST (ESC \).
  if (next === "]" || next === "P" || next === "_" || next === "^") {
    for (let i = start + 2; i < input.length; i++) {
      if (input[i] === "\x07") return { kind: "skip", length: i - start + 1 };
      if (input[i] === "\x1b" && input[i + 1] === "\\")
        return { kind: "skip", length: i - start + 2 };
    }
    return null;
  }

  // Two-byte escapes (ESC c, ESC =, …) and anything else: consume both bytes.
  return { kind: "skip", length: 2 };
}
