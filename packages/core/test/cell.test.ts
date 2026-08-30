import { describe, expect, it } from "vitest";
import {
  assertNarrowChar,
  charWidth,
  coerceNarrowChar,
  coerceToCells,
  InvalidCharError,
  isNarrowSingle,
  REPLACEMENT_CHAR,
} from "../src/model/cell.js";
import { isWideCodePoint, WIDE_RANGES } from "../src/model/width-table.js";

describe("charWidth", () => {
  it("reports 1 for ASCII and Latin-1", () => {
    for (const c of ["a", "Z", "0", " ", "~", "é", "ß"]) {
      expect(charWidth(c), c).toBe(1);
    }
  });

  it("reports 1 for every box-drawing and block-element character", () => {
    // The whole tool draws with these. If any were wide, every drawing op would
    // reject its own output.
    for (let cp = 0x2500; cp <= 0x259f; cp++) {
      expect(charWidth(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toBe(1);
    }
  });

  it("reports 2 for East Asian wide and fullwidth characters", () => {
    for (const c of ["你", "好", "あ", "한", "Ａ", "　", "🎉", "🚀"]) {
      expect(charWidth(c), c).toBe(2);
    }
  });

  it("reports 0 for a lone combining mark", () => {
    expect(charWidth("́")).toBe(0); // COMBINING ACUTE ACCENT
  });

  it("reports 0 for the empty string", () => {
    expect(charWidth("")).toBe(0);
  });
});

describe("width table", () => {
  it("is sorted, non-overlapping, and non-adjacent", () => {
    let previousEnd = -2;
    for (const [start, end] of WIDE_RANGES) {
      expect(start).toBeLessThanOrEqual(end);
      // Adjacent ranges would mean the generator failed to merge them.
      expect(start, `range starting 0x${start.toString(16)}`).toBeGreaterThan(previousEnd + 1);
      previousEnd = end;
    }
  });

  it("binary search agrees with a linear scan", () => {
    const linear = (cp: number) => WIDE_RANGES.some(([s, e]) => cp >= s && cp <= e);
    for (let cp = 0; cp < 0x3200; cp++) {
      expect(isWideCodePoint(cp), `U+${cp.toString(16)}`).toBe(linear(cp));
    }
  });

  it("excludes unassigned codepoints that some tooling misreports as fullwidth", () => {
    // Regression guard: the generator must filter category Cn. Without that filter
    // the table balloons from ~117k characters to ~948k and rejects most of Unicode.
    expect(isWideCodePoint(0x0378)).toBe(false); // unassigned, in the Greek block
    expect(isWideCodePoint(0xe0000)).toBe(false); // unassigned, plane 14
    expect(isWideCodePoint(0x1fbfa)).toBe(false); // unassigned
  });
});

describe("isNarrowSingle", () => {
  it("accepts exactly one narrow grapheme", () => {
    expect(isNarrowSingle("a")).toBe(true);
    expect(isNarrowSingle("┼")).toBe(true);
  });

  it("rejects multi-grapheme strings, wide chars, and zero-width marks", () => {
    expect(isNarrowSingle("ab")).toBe(false);
    expect(isNarrowSingle("你")).toBe(false);
    expect(isNarrowSingle("́")).toBe(false);
    expect(isNarrowSingle("")).toBe(false);
  });

  it("rejects terminal controls and invisible format characters", () => {
    for (const char of ["\x00", "\x07", "\x1b", "\x9b", "\u202e", "\u2066"]) {
      expect(isNarrowSingle(char), JSON.stringify(char)).toBe(false);
    }
  });

  it("treats a combining sequence as one grapheme", () => {
    expect(isNarrowSingle("é")).toBe(true); // e + combining acute = 1 grapheme, 1 column
  });
});

describe("assertNarrowChar — the editing-side policy: hard reject", () => {
  it("accepts a narrow single grapheme", () => {
    expect(() => assertNarrowChar("x")).not.toThrow();
  });

  it("rejects wide characters with an explanatory message", () => {
    expect(() => assertNarrowChar("你")).toThrow(InvalidCharError);
    expect(() => assertNarrowChar("你")).toThrow(/two columns/u);
  });

  it("rejects the empty string, multi-grapheme input, and zero-width marks", () => {
    expect(() => assertNarrowChar("")).toThrow(/empty string/u);
    expect(() => assertNarrowChar("ab")).toThrow(/expected exactly 1 grapheme, got 2/u);
    expect(() => assertNarrowChar("́")).toThrow(/zero-width/u);
  });

  it("rejects every control used to construct terminal escape sequences", () => {
    for (const char of ["\x07", "\x1b", "\x9b", "\r", "\n", "\t"]) {
      expect(() => assertNarrowChar(char), JSON.stringify(char)).toThrow(/control/u);
    }
  });
});

describe("coerceNarrowChar — the import-side policy: substitute and warn", () => {
  it("passes narrow characters through without a warning", () => {
    expect(coerceNarrowChar("a")).toEqual({ char: "a" });
  });

  it("substitutes wide characters and explains what happened", () => {
    const result = coerceNarrowChar("你");
    expect(result.char).toBe(REPLACEMENT_CHAR);
    expect(result.warning).toMatch(/wide character/u);
  });

  it("never throws, for any input the editing API would reject", () => {
    for (const bad of ["", "ab", "你", "🎉", "́"]) {
      expect(() => coerceNarrowChar(bad)).not.toThrow();
    }
  });

  it("maps the empty string to a space rather than U+FFFD", () => {
    expect(coerceNarrowChar("")).toEqual({ char: " " });
  });

  it("substitutes terminal controls instead of persisting active bytes", () => {
    for (const char of ["\x07", "\x1b", "\x9b", "\u202e"]) {
      const result = coerceNarrowChar(char);
      expect(result.char, JSON.stringify(char)).toBe(REPLACEMENT_CHAR);
      expect(result.warning).toMatch(/control or format/u);
    }
  });
});

describe("coerceToCells", () => {
  it("keeps one cell per grapheme so a wide char cannot shift the row", () => {
    const { chars, warnings } = coerceToCells("a你b");
    expect(chars).toEqual(["a", REPLACEMENT_CHAR, "b"]);
    expect(chars).toHaveLength(3);
    expect(warnings).toHaveLength(1);
  });

  it("collapses a combining sequence into a single cell", () => {
    const { chars } = coerceToCells("éx");
    expect(chars).toEqual(["é", "x"]);
  });
});
