import { describe, expect, it } from "vitest";
import { BOX_NAMES, buildTable, parseArmsFromName } from "../scripts/box-names.js";
import { type Arms, armsCode, DIRECTIONS, arms as mkArms } from "../src/ops/arms.js";
import { armsOf, BOX_TABLE_SIZE } from "../src/ops/box-merge.js";
import { BOX_TABLE } from "../src/ops/box-table.js";

describe("the committed table matches the generator", () => {
  it("is exactly what buildTable() derives from the Unicode names", () => {
    // This is what makes the generated file safe to commit: a stale or
    // hand-edited box-table.ts fails here.
    const derived = buildTable()
      .sort((a, b) => a.codePoint - b.codePoint)
      .map((e) => [e.code, e.char]);
    expect(BOX_TABLE.map(([code, char]) => [code, char])).toEqual(derived);
  });

  it("covers 109 of the 128 characters in the block", () => {
    expect(BOX_NAMES).toHaveLength(128);
    expect(BOX_TABLE_SIZE).toBe(109);
  });

  it("excludes exactly the dash, arc, and diagonal variants", () => {
    const excluded = BOX_NAMES.filter((name) => parseArmsFromName(name) === null);
    expect(excluded).toHaveLength(19);
    // 4 triple-dash + 4 quadruple-dash + 4 double-dash + 4 arc + 3 diagonal
    expect(excluded.filter((n) => n.includes("DASH"))).toHaveLength(12);
    expect(excluded.filter((n) => n.includes("ARC"))).toHaveLength(4);
    expect(excluded.filter((n) => n.includes("DIAGONAL"))).toHaveLength(3);
  });
});

describe("the Arms <-> char mapping is a bijection", () => {
  it("has no duplicate codes and no duplicate characters", () => {
    // This is why the reverse lookup needs no tie-breaking policy at all.
    const codes = new Set(BOX_TABLE.map(([code]) => code));
    const chars = new Set(BOX_TABLE.map(([, char]) => char));
    expect(codes.size).toBe(BOX_TABLE_SIZE);
    expect(chars.size).toBe(BOX_TABLE_SIZE);
  });

  it("round-trips every character through armsOf", () => {
    for (const [code, char] of BOX_TABLE) {
      const back = armsOf(char);
      expect(back, char).toBeDefined();
      expect(armsCode(back as Arms), `${char} (0x${code.toString(16)})`).toBe(code);
    }
  });

  it("reports undefined for characters outside the table", () => {
    for (const char of ["a", " ", "█", "░", "╭", "╱", "┄"]) {
      expect(armsOf(char), char).toBeUndefined();
    }
  });
});

describe("an independent hand-written oracle", () => {
  // Deliberately NOT derived from the names — these are typed from the Unicode
  // charts by hand, so a systematic parser bug that produced self-consistent
  // wrong answers would still be caught here.
  const CASES: readonly [string, Partial<Arms>][] = [
    ["─", { left: "light", right: "light" }],
    ["│", { up: "light", down: "light" }],
    ["┌", { down: "light", right: "light" }],
    ["┐", { down: "light", left: "light" }],
    ["└", { up: "light", right: "light" }],
    ["┘", { up: "light", left: "light" }],
    ["├", { up: "light", down: "light", right: "light" }],
    ["┤", { up: "light", down: "light", left: "light" }],
    ["┬", { down: "light", left: "light", right: "light" }],
    ["┴", { up: "light", left: "light", right: "light" }],
    ["┼", { up: "light", down: "light", left: "light", right: "light" }],
    ["━", { left: "heavy", right: "heavy" }],
    ["┃", { up: "heavy", down: "heavy" }],
    ["┏", { down: "heavy", right: "heavy" }],
    ["╋", { up: "heavy", down: "heavy", left: "heavy", right: "heavy" }],
    ["═", { left: "double", right: "double" }],
    ["║", { up: "double", down: "double" }],
    ["╔", { down: "double", right: "double" }],
    ["╬", { up: "double", down: "double", left: "double", right: "double" }],
    // Mixed light/double junctions, where Unicode does define a character.
    ["╪", { up: "light", down: "light", left: "double", right: "double" }],
    ["╫", { up: "double", down: "double", left: "light", right: "light" }],
    ["╞", { up: "light", down: "light", right: "double" }],
    ["╟", { up: "double", down: "double", right: "light" }],
    // Single-arm stubs.
    ["╴", { left: "light" }],
    ["╵", { up: "light" }],
    ["╶", { right: "light" }],
    ["╷", { down: "light" }],
    ["╸", { left: "heavy" }],
    // Asymmetric weights within one axis.
    ["╼", { left: "light", right: "heavy" }],
    ["╿", { up: "heavy", down: "light" }],
  ];

  it.each(CASES)("decodes %s correctly", (char, expected) => {
    expect(armsOf(char)).toEqual(mkArms(expected));
  });

  it("covers every direction and every weight", () => {
    // Guards the oracle itself against being accidentally narrow.
    const seen = new Set<string>();
    for (const [, spec] of CASES) {
      for (const dir of DIRECTIONS) {
        const weight = spec[dir];
        if (weight !== undefined) seen.add(`${dir}:${weight}`);
      }
    }
    for (const dir of DIRECTIONS) {
      for (const weight of ["light", "heavy", "double"]) {
        expect(seen, `${dir}:${weight} is untested`).toContain(`${dir}:${weight}`);
      }
    }
  });
});
