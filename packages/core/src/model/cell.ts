/**
 * The Cell type and character validation.
 *
 * Two deliberately different policies for unsupported characters, because the
 * two entry points have incompatible obligations:
 *
 * - Editing APIs (`setCell`, `drawText`) **hard-reject** via
 *   {@link assertNarrowChar}. A wide character would silently break column
 *   alignment for every cell to its right, so failing loudly is correct.
 * - Import APIs (`parseAnsi`, `parseText`) **substitute** via
 *   {@link coerceNarrowChar} and collect warnings. Parsing real terminal
 *   captures must never throw on weird input.
 */

import { type ColorRef, colorRefEquals } from "./color.js";
import { isWideCodePoint } from "./width-table.js";

export interface Cell {
  /** Exactly one narrow grapheme. `" "` means empty-but-painted. */
  readonly char: string;
  readonly fg: ColorRef;
  readonly bg: ColorRef;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
}

/** A Cell without its character — exactly the shape of the GUI's brush. */
export type CellStyle = Omit<Cell, "char">;

/**
 * True when two cells are indistinguishable.
 *
 * Used to skip writes that would change nothing, so an op that alters no cell
 * returns the identical document rather than dirtying the draft — which would
 * otherwise push an empty entry onto the undo stack.
 */
export function cellEquals(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    colorRefEquals(a.fg, b.fg) &&
    colorRefEquals(a.bg, b.bg) &&
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.inverse ?? false) === (b.inverse ?? false)
  );
}

/** The substitute written for an unsupported character on import. */
export const REPLACEMENT_CHAR = "�";

/** Thrown by {@link assertNarrowChar}. */
export class InvalidCharError extends RangeError {
  constructor(
    readonly char: string,
    reason: string,
  ) {
    super(`invalid cell character ${JSON.stringify(char)}: ${reason}`);
    this.name = "InvalidCharError";
  }
}

let cachedSegmenter: Intl.Segmenter | undefined;

/**
 * Lazily built grapheme segmenter, or `undefined` where `Intl.Segmenter` is
 * unavailable — in which case callers fall back to code-point iteration, which
 * differs only for combining sequences.
 */
function getSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl?.Segmenter !== "function") return undefined;
  if (cachedSegmenter === undefined) {
    cachedSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  }
  return cachedSegmenter;
}

/** Splits text into graphemes, falling back to code points. */
function graphemes(text: string): string[] {
  const seg = getSegmenter();
  if (seg === undefined) return Array.from(text);
  return Array.from(seg.segment(text), (s) => s.segment);
}

function graphemeCount(text: string): number {
  const seg = getSegmenter();
  if (seg === undefined) return Array.from(text).length;
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}

/**
 * Terminal column count for a single grapheme: 0 for a lone combining mark,
 * 2 for East Asian Wide/Fullwidth, otherwise 1.
 *
 * Emoji sequences (ZWJ families, flags, skin-tone modifiers) are one grapheme
 * whose first code point is wide, so they report 2 and are rejected in v1.
 */
export function charWidth(char: string): 0 | 1 | 2 {
  if (char.length === 0) return 0;
  const cp = char.codePointAt(0);
  if (cp === undefined) return 0;
  if (isWideCodePoint(cp)) return 2;
  // A lone combining mark occupies no column of its own.
  if (/^\p{Mn}|^\p{Me}/u.test(char)) return 0;
  return 1;
}

/** True if `char` is exactly one grapheme occupying exactly one column. */
export function isNarrowSingle(char: string): boolean {
  return graphemeCount(char) === 1 && charWidth(char) === 1;
}

/**
 * Throws unless `char` is a single narrow grapheme. Used by every editing op —
 * the GUI is expected to prevent this, so reaching here is a programming error.
 */
export function assertNarrowChar(char: string): void {
  if (char.length === 0) throw new InvalidCharError(char, "empty string");
  const graphemes = graphemeCount(char);
  if (graphemes !== 1) {
    throw new InvalidCharError(char, `expected exactly 1 grapheme, got ${graphemes}`);
  }
  const width = charWidth(char);
  if (width === 2) {
    throw new InvalidCharError(
      char,
      "wide (East Asian) characters occupy two columns and are not supported in v1",
    );
  }
  if (width === 0) {
    throw new InvalidCharError(char, "zero-width characters cannot occupy a cell");
  }
}

/**
 * Import-side counterpart to {@link assertNarrowChar}: never throws. Returns
 * the character to store plus a warning when substitution occurred.
 */
export function coerceNarrowChar(char: string): { char: string; warning?: string } {
  if (char.length === 0) return { char: " " };
  if (isNarrowSingle(char)) return { char };
  const width = charWidth(char);
  const reason =
    width === 2
      ? "wide character"
      : width === 0
        ? "zero-width character"
        : "multi-grapheme cluster";
  return {
    char: REPLACEMENT_CHAR,
    warning: `replaced ${reason} ${JSON.stringify(char)} with U+FFFD`,
  };
}

/**
 * Splits text into per-cell characters, substituting anything unsupported.
 * Used by the text/ANSI importers so one wide character can't shift a whole row.
 */
export function coerceToCells(text: string): { chars: string[]; warnings: string[] } {
  const chars: string[] = [];
  const warnings: string[] = [];
  for (const part of graphemes(text)) {
    const { char, warning } = coerceNarrowChar(part);
    chars.push(char);
    if (warning !== undefined) warnings.push(warning);
  }
  return { chars, warnings };
}
