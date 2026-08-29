/**
 * The Arms model — the foundation of every box-drawing operation.
 *
 * Each box-drawing character decomposes into four directional "arms", each with a
 * line weight. Junction merging is then set union over arms plus a reverse
 * lookup, which is why `drawBox` and `drawLine` can share one code path and why
 * panel detection (M6) can recover structure from a flat grid.
 */

export type LineStyle = "none" | "light" | "heavy" | "double";

export interface Arms {
  readonly up: LineStyle;
  readonly down: LineStyle;
  readonly left: LineStyle;
  readonly right: LineStyle;
}

export const DIRECTIONS = ["up", "down", "left", "right"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Weight codes. The 2-bit values and their order in {@link armsCode} are load-bearing. */
export const WEIGHT = { none: 0, light: 1, heavy: 2, double: 3 } as const;

/**
 * Total map from a 2-bit weight code to its `LineStyle`.
 *
 * Written as a switch rather than an array lookup so there is no
 * "index might be undefined" branch to leave permanently uncovered — every arm
 * of this function is exercised by the exhaustive 255-code tests.
 */
function styleOf(bits: number): LineStyle {
  switch (bits & 3) {
    case 0:
      return "none";
    case 1:
      return "light";
    case 2:
      return "heavy";
    default:
      return "double";
  }
}

/**
 * An `Arms` packed into one byte: `up << 6 | down << 4 | left << 2 | right`.
 * Compact enough that the whole table is a flat array and the fallback ladder is
 * bit arithmetic rather than object rewriting.
 */
export type ArmsCode = number;

export const armsCode = (a: Arms): ArmsCode =>
  (WEIGHT[a.up] << 6) | (WEIGHT[a.down] << 4) | (WEIGHT[a.left] << 2) | WEIGHT[a.right];

export function decodeArms(code: ArmsCode): Arms {
  return {
    up: styleOf(code >> 6),
    down: styleOf(code >> 4),
    left: styleOf(code >> 2),
    right: styleOf(code),
  };
}

/** Builds an `Arms` from a partial spec; omitted directions are `"none"`. */
export function arms(spec: Partial<Arms>): Arms {
  return {
    up: spec.up ?? "none",
    down: spec.down ?? "none",
    left: spec.left ?? "none",
    right: spec.right ?? "none",
  };
}

/** Ranking used by {@link strongest}. A fixed total order, not draw order. */
const RANK: Record<LineStyle, number> = { none: 0, light: 1, heavy: 2, double: 3 };

/**
 * The heavier of two weights.
 *
 * Deliberately *not* "prefer the incoming style": a fixed total order makes
 * {@link unionArms} commutative and associative, which is what lets draw order
 * stop mattering for the resulting junction.
 */
export const strongest = (a: LineStyle, b: LineStyle): LineStyle => (RANK[b] > RANK[a] ? b : a);

export function unionArms(a: Arms, b: Arms): Arms {
  return {
    up: strongest(a.up, b.up),
    down: strongest(a.down, b.down),
    left: strongest(a.left, b.left),
    right: strongest(a.right, b.right),
  };
}
