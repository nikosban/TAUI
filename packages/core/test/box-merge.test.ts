import { describe, expect, it } from "vitest";
import {
  type Arms,
  armsCode,
  DIRECTIONS,
  decodeArms,
  type LineStyle,
  arms as mkArms,
  strongest,
  unionArms,
} from "../src/ops/arms.js";
import { armsOf, BOX_TABLE_SIZE, charForArms, isBoxChar } from "../src/ops/box-merge.js";
import { BOX_TABLE } from "../src/ops/box-table.js";

const ALL_STYLES: readonly LineStyle[] = ["none", "light", "heavy", "double"];
/** Every non-empty Arms set: codes 1..255. */
const ALL_CODES = Array.from({ length: 255 }, (_, i) => i + 1);

const CODES_IN_TABLE = new Set(BOX_TABLE.map(([code]) => code));

/** Replaces every arm of weight `from` with `to`. Mirrors the implementation. */
function substitute(code: number, from: number, to: number): number {
  let out = 0;
  for (const shift of [0, 2, 4, 6]) {
    const weight = (code >> shift) & 3;
    out |= (weight === from ? to : weight) << shift;
  }
  return out;
}

/**
 * How many substitution steps an Arms set needs: 1 = exact, 2 = after
 * double->heavy, null = unresolvable. A test-side diagnostic, deliberately not
 * shipped — `charForArms` needs only the two steps this measures.
 */
function ladderDepth(a: Arms): number | null {
  const code = armsCode(a);
  if (code === 0) return null;
  if (CODES_IN_TABLE.has(code)) return 1;
  if (CODES_IN_TABLE.has(substitute(code, 3, 2))) return 2;
  return null;
}

describe("unionArms algebra", () => {
  it("takes the stronger weight per direction", () => {
    expect(unionArms(mkArms({ up: "light" }), mkArms({ up: "heavy" }))).toEqual(
      mkArms({ up: "heavy" }),
    );
    expect(unionArms(mkArms({ left: "double" }), mkArms({ left: "light" }))).toEqual(
      mkArms({ left: "double" }),
    );
  });

  it("is commutative", () => {
    // This is why draw order does not affect the resulting junction.
    for (const a of ALL_CODES) {
      for (const b of [1, 5, 0x55, 0xaa, 0xff, 0x5f, 0xf5]) {
        const x = decodeArms(a);
        const y = decodeArms(b);
        expect(armsCode(unionArms(x, y)), `0x${a.toString(16)} u 0x${b.toString(16)}`).toBe(
          armsCode(unionArms(y, x)),
        );
      }
    }
  });

  it("is associative", () => {
    const samples = [0x05, 0x50, 0x11, 0x55, 0xaa, 0xff, 0x5f, 0xf5, 0x92, 0x1c];
    for (const a of samples) {
      for (const b of samples) {
        for (const c of samples) {
          const [x, y, z] = [decodeArms(a), decodeArms(b), decodeArms(c)];
          expect(armsCode(unionArms(unionArms(x, y), z))).toBe(
            armsCode(unionArms(x, unionArms(y, z))),
          );
        }
      }
    }
  });

  it("is idempotent, with `none` as the identity", () => {
    for (const code of ALL_CODES) {
      const a = decodeArms(code);
      expect(armsCode(unionArms(a, a))).toBe(code);
      expect(armsCode(unionArms(a, mkArms({})))).toBe(code);
    }
  });

  it("orders weights none < light < heavy < double", () => {
    for (const [i, weaker] of ALL_STYLES.entries()) {
      for (const stronger of ALL_STYLES.slice(i)) {
        expect(strongest(weaker, stronger)).toBe(stronger);
        expect(strongest(stronger, weaker)).toBe(stronger);
      }
    }
  });
});

describe("isBoxChar", () => {
  it("recognizes table characters and rejects everything else", () => {
    for (const char of ["┼", "╬", "╴", "─", "┏"]) {
      expect(isBoxChar(char), char).toBe(true);
    }
    for (const char of ["a", " ", "█", "░", "你"]) {
      expect(isBoxChar(char), char).toBe(false);
    }
  });

  it("excludes the arc and dash variants, so merging never rewrites them", () => {
    // A rounded corner is a corner, but LineStyle has no "rounded" weight; if
    // these were mergeable, a merge would silently square off a rounded box.
    for (const char of ["╭", "╮", "╯", "╰", "┄", "╌"]) {
      expect(isBoxChar(char), char).toBe(false);
    }
  });
});

describe("charForArms totality", () => {
  it("resolves all 255 non-empty Arms sets", () => {
    for (const code of ALL_CODES) {
      const char = charForArms(decodeArms(code));
      expect(char, `0x${code.toString(16).padStart(2, "0")}`).toBeDefined();
    }
  });

  it("returns undefined only for the empty arm set", () => {
    expect(charForArms(mkArms({}))).toBeUndefined();
    expect(ladderDepth(mkArms({}))).toBeNull();
  });

  it("preserves arm topology — a junction never loses or gains a branch", () => {
    // The invariant that makes the ladder safe: only weight degrades. A
    // heavy-up + double-left corner is still a corner pointing up and left.
    for (const code of ALL_CODES) {
      const want = decodeArms(code);
      const char = charForArms(want) as string;
      const got = armsOf(char) as Arms;
      for (const dir of DIRECTIONS) {
        expect(
          got[dir] === "none",
          `0x${code.toString(16)} -> ${char}: ${dir} presence changed`,
        ).toBe(want[dir] === "none");
      }
    }
  });

  it("never strengthens a weight", () => {
    const rank: Record<LineStyle, number> = { none: 0, light: 1, heavy: 2, double: 3 };
    for (const code of ALL_CODES) {
      const want = decodeArms(code);
      const got = armsOf(charForArms(want) as string) as Arms;
      for (const dir of DIRECTIONS) {
        expect(rank[got[dir]], `0x${code.toString(16)} ${dir}`).toBeLessThanOrEqual(
          rank[want[dir]],
        );
      }
    }
  });
});

describe("the fallback ladder", () => {
  it("resolves 109 sets exactly and the remaining 146 at rung 2", () => {
    // Locks in the measured shape of the problem. If someone edits the table and
    // breaks a mixed junction, this histogram shifts and names the regression.
    const histogram: Record<number, number> = {};
    for (const code of ALL_CODES) {
      const depth = ladderDepth(decodeArms(code)) as number;
      histogram[depth] = (histogram[depth] ?? 0) + 1;
    }
    expect(histogram).toEqual({ 1: 109, 2: 146 });
    expect(histogram[1]).toBe(BOX_TABLE_SIZE);
  });

  it("needs a fallback for more than half of the Arms space", () => {
    // The spec says "some heavy/double mixes don't exist". It is 147 of 256.
    const exact = ALL_CODES.filter((c) => ladderDepth(decodeArms(c)) === 1).length;
    expect(255 - exact).toBe(146);
  });

  it("rests on the light/heavy sublattice being complete", () => {
    // This is *why* a single double->heavy substitution is always enough, and so
    // why charForArms needs no deeper ladder. If a future table change broke this
    // completeness, the substitution could miss — and this test says so directly
    // rather than letting it surface as a missing glyph.
    const lightHeavyCodes = ALL_CODES.filter((code) => {
      for (const shift of [0, 2, 4, 6]) {
        if (((code >> shift) & 3) === 3) return false; // has a double arm
      }
      return true;
    });
    expect(lightHeavyCodes).toHaveLength(80); // 3^4 - 1

    const missing = lightHeavyCodes.filter((code) => !CODES_IN_TABLE.has(code));
    expect(missing, "light/heavy sublattice has a hole").toEqual([]);

    // And the remaining table entries are exactly the double-involving ones.
    expect(BOX_TABLE_SIZE - lightHeavyCodes.length).toBe(29);
  });

  it("substitutes double with heavy where no double form exists", () => {
    // No Unicode character has heavy-up + double-left, so it degrades to `┛`.
    expect(charForArms(mkArms({ up: "heavy", left: "double" }))).toBe("┛");
    // Heavy cross with double horizontal: no such char, degrades to the heavy cross.
    expect(
      charForArms(mkArms({ up: "heavy", down: "heavy", left: "double", right: "double" })),
    ).toBe("╋");
  });

  it("prefers an exact mixed-style character when Unicode defines one", () => {
    // These must NOT hit the ladder — Unicode has them.
    expect(
      charForArms(mkArms({ up: "light", down: "light", left: "double", right: "double" })),
    ).toBe("╪");
    expect(
      charForArms(mkArms({ up: "double", down: "double", left: "light", right: "light" })),
    ).toBe("╫");
    expect(
      ladderDepth(mkArms({ up: "light", down: "light", left: "double", right: "double" })),
    ).toBe(1);
  });

  it("degrades a double single-arm stub to heavy, since no double stub exists", () => {
    // Directly relevant to the 1-cell drawLine case.
    expect(charForArms(mkArms({ left: "double" }))).toBe("╸");
    expect(ladderDepth(mkArms({ left: "double" }))).toBe(2);
    // Light and heavy stubs do exist.
    expect(charForArms(mkArms({ left: "light" }))).toBe("╴");
    expect(charForArms(mkArms({ left: "heavy" }))).toBe("╸");
  });

  it("resolves the documented fallback table", () => {
    // Human-reviewable contract for mixed junctions.
    const cases: readonly [Partial<Arms>, string][] = [
      [{ up: "double", left: "light" }, "╜"],
      [{ up: "light", left: "double" }, "╛"],
      [{ down: "double", right: "light" }, "╓"],
      [{ down: "heavy", right: "double" }, "┏"],
      // double->heavy keeps up heavy and down light: U+2547 DOWN LIGHT AND UP
      // HORIZONTAL HEAVY. Its mirror ╈ would be wrong.
      [{ up: "heavy", down: "light", left: "double", right: "double" }, "╇"],
      [{ up: "light", down: "heavy", left: "double", right: "double" }, "╈"],
      [{ up: "double", down: "double", left: "heavy", right: "heavy" }, "╋"],
    ];
    for (const [spec, expected] of cases) {
      expect(charForArms(mkArms(spec)), JSON.stringify(spec)).toBe(expected);
    }
  });
});
