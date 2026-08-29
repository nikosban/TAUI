/**
 * Junction merging — the key algorithm of the project.
 *
 * `applyArmStamps` is the **only** function in this package that writes a
 * box-drawing character. `drawBox` and `drawLine` both reduce to a list of
 * `(row, col, Arms)` requests and call it, which is how the spec's requirement of
 * "no line-specific junction code" is actually guaranteed rather than merely
 * intended. `scripts/check-arch.ts` greps `ops/line.ts` and `ops/box.ts` for
 * box-char literals and fails the build if either contains one.
 *
 * ## Weight fallback
 *
 * Only 109 of the 4^4 = 256 possible Arms sets have a Unicode character — so
 * **147 of them, more than half, need a fallback.** The spec's "some heavy/double
 * mixes don't exist" undersells this considerably: falling back is the common
 * path, not an edge case.
 *
 * Resolution is therefore two steps, and two steps are *provably* enough:
 *
 *   1. exact match          — 109 sets
 *   2. double -> heavy      — the remaining 146
 *
 * The proof is a counting argument. Of the 109 characters, the 29 in U+2550–U+256C
 * are exactly those with a double arm, leaving 80 whose arms use only
 * none/light/heavy. The light/heavy sublattice has 3^4 - 1 = 80 non-empty members,
 * so it is *complete* — every combination exists. Replacing every double arm with
 * a heavy one lands in that complete space and can never miss. See
 * "rests on the light/heavy sublattice being complete" in test/box-merge.test.ts.
 *
 * Two consequences. There is no deeper ladder, because further rungs
 * (double->light, heavy->light) would be dead code. And the substitution changes
 * *weight only*, never setting an arm to `none` or creating one — so a junction
 * never loses a branch. A heavy-up + double-left corner renders as `┛`, still a
 * corner pointing the same two ways. Verified over all 255 non-empty Arms sets.
 */

import type { Cell, CellStyle } from "../model/cell.js";
import type { LayerDraft } from "../model/draft.js";
import { type Arms, type ArmsCode, armsCode, decodeArms, unionArms, WEIGHT } from "./arms.js";
import { BOX_TABLE } from "./box-table.js";

const CHAR_BY_CODE = new Map<ArmsCode, string>(BOX_TABLE.map(([code, char]) => [code, char]));
const CODE_BY_CHAR = new Map<string, ArmsCode>(BOX_TABLE.map(([code, char]) => [char, code]));

/** Number of characters in the table. Exposed so tests can pin it. */
export const BOX_TABLE_SIZE = BOX_TABLE.length;

/** The Arms of an existing character, or `undefined` if it is not a box char. */
export function armsOf(char: string): Arms | undefined {
  const code = CODE_BY_CHAR.get(char);
  return code === undefined ? undefined : decodeArms(code);
}

export const isBoxChar = (char: string): boolean => CODE_BY_CHAR.has(char);

/** Replaces every arm of weight `from` with weight `to`. Bit-parallel. */
function substitute(code: ArmsCode, from: number, to: number): ArmsCode {
  let out = 0;
  for (const shift of [0, 2, 4, 6]) {
    const weight = (code >> shift) & 3;
    out |= (weight === from ? to : weight) << shift;
  }
  return out;
}

/**
 * The character for an Arms set, degrading weight as needed.
 *
 * Returns `undefined` only for the empty arm set, which callers must handle
 * (there is no "box character with no arms"). Provably total otherwise —
 * asserted exhaustively for all 255 non-empty codes.
 */
export function charForArms(a: Arms): string | undefined {
  const code = armsCode(a);
  if (code === 0) return undefined;

  const exact = CHAR_BY_CODE.get(code);
  if (exact !== undefined) return exact;

  // One substitution suffices, and provably so. Of the 109 characters, the 29 in
  // U+2550–U+256C are exactly those involving a double arm, leaving 80 whose arms
  // are only none/light/heavy. The light/heavy sublattice has 3^4 - 1 = 80
  // non-empty members — so it is *complete*. Replacing every double arm with a
  // heavy one therefore lands in a fully-populated space and can never miss.
  //
  // This is why there is no deeper ladder: rungs like double->light or
  // heavy->light would be unreachable code. The invariant is enforced by
  // "resolves all 255 non-empty Arms sets" and the sublattice-size assertion in
  // test/box-merge.test.ts, which fail loudly if the table ever changes.
  return CHAR_BY_CODE.get(substitute(code, WEIGHT.double, WEIGHT.heavy));
}

/** A request to place arms at one cell. Pure geometry — carries no character. */
export interface ArmStamp {
  readonly row: number;
  readonly col: number;
  readonly arms: Arms;
}

/**
 * Writes box characters for a list of arm stamps. The sole writer.
 *
 * With `merge`, the existing cell's arms (if it holds a box character) are unioned
 * with the incoming ones. Without it, the incoming arms overwrite blindly.
 *
 * A stamp whose merged arms are empty is skipped rather than clearing the cell:
 * callers construct stamps with at least one arm, and silently erasing would make
 * a degenerate gesture destructive.
 */
export function applyArmStamps(
  draft: LayerDraft,
  stamps: readonly ArmStamp[],
  style: CellStyle,
  merge: boolean,
): void {
  for (const { row, col, arms: incoming } of stamps) {
    let final = incoming;
    if (merge) {
      const existing = draft.get(row, col);
      const prior = existing === undefined ? undefined : armsOf(existing.char);
      if (prior !== undefined) final = unionArms(prior, incoming);
    }
    const char = charForArms(final);
    if (char === undefined) continue;
    const cell: Cell = { ...style, char };
    draft.set(row, col, cell);
  }
}
