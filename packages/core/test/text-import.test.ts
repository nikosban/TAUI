import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "../src/io/file.js";
import { parseText } from "../src/io/text-import.js";
import { REPLACEMENT_CHAR } from "../src/model/cell.js";
import { sequentialIdGen } from "../src/model/document.js";
import { RESOURCE_LIMITS } from "../src/model/resource-policy.js";
import { toText } from "../src/render/text.js";

const ids = () => sequentialIdGen();

describe("parseText", () => {
  it("round-trips ASCII art through toText", () => {
    const art = ["┌────┐", "│ hi │", "└────┘"].join("\n");
    const { doc, warnings } = parseText(art, { idGen: ids() });
    expect(doc.cols).toBe(6);
    expect(doc.rows).toBe(3);
    expect(toText(doc)).toBe(art);
    expect(warnings).toEqual([]);
  });

  it("sizes the grid to the widest line", () => {
    const { doc } = parseText("ab\nabcdef\nabc", { idGen: ids() });
    expect(doc.cols).toBe(6);
    expect(doc.rows).toBe(3);
  });

  it("leaves spaces transparent by default and paints them on request", () => {
    const bare = parseText("a b", { idGen: ids() }).doc;
    expect(Object.keys(bare.layers[0]?.cells ?? {})).toEqual(["0,0", "0,2"]);

    const painted = parseText("a b", { idGen: ids(), paintSpaces: true }).doc;
    expect(Object.keys(painted.layers[0]?.cells ?? {})).toEqual(["0,0", "0,1", "0,2"]);
  });

  it("names the layer 'imported' and makes it active", () => {
    const { doc } = parseText("x", { idGen: ids() });
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]?.name).toBe("imported");
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });

  it("handles LF, CRLF, and CR line endings", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const { doc } = parseText(`ab${eol}cd`, { idGen: ids() });
      expect(toText(doc), JSON.stringify(eol)).toBe("ab\ncd");
    }
  });

  it("drops a single trailing newline without adding a phantom row", () => {
    expect(parseText("ab\ncd\n", { idGen: ids() }).doc.rows).toBe(2);
    // But a blank line the user actually typed is preserved.
    expect(parseText("ab\ncd\n\n", { idGen: ids() }).doc.rows).toBe(3);
  });

  it("substitutes wide characters and keeps every later column aligned", () => {
    // The point of coercing per grapheme: "你" must not shift "|" leftward.
    const { doc, warnings } = parseText("a你b|", { idGen: ids() });
    expect(toText(doc)).toBe(`a${REPLACEMENT_CHAR}b|`);
    expect(doc.cols).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wide character/u);
  });

  it("neutralizes terminal escape payloads when importing plain text", () => {
    const { doc, warnings } = parseText("a\x1b[31mb\x07c", { idGen: ids() });
    expect(toText(doc)).toBe(`a${REPLACEMENT_CHAR}[31mb${REPLACEMENT_CHAR}c`);
    expect(warnings.filter((warning) => /control or format/u.test(warning))).toHaveLength(2);
  });

  // This deliberately exercises the maximum accepted input and area. GitHub's
  // shared Linux runners can take just over Vitest's 5s default under load.
  it("truncates excessive input and dimensions without throwing", () => {
    const input = "x".repeat(RESOURCE_LIMITS.importTextChars + 5);
    const { doc, warnings } = parseText(input, {
      idGen: ids(),
      cols: RESOURCE_LIMITS.documentCols + 1,
      rows: RESOURCE_LIMITS.documentRows + 1,
    });
    expect(doc.cols).toBe(RESOURCE_LIMITS.documentCols);
    expect(doc.cols * doc.rows).toBeLessThanOrEqual(RESOURCE_LIMITS.documentArea);
    expect(warnings.join("\n")).toMatch(/truncated input/u);
    expect(warnings.join("\n")).toMatch(/requested cols/u);
    expect(warnings.join("\n")).toMatch(/document limit/u);
  }, 15_000);

  it("clips natural rows and columns at the resource boundary", () => {
    const tall = parseText("x\n".repeat(RESOURCE_LIMITS.documentRows + 2), { idGen: ids() });
    expect(tall.doc.rows).toBe(RESOURCE_LIMITS.documentRows);
    expect(tall.warnings.join("\n")).toMatch(/row\(s\) beyond the limit/u);

    const wide = parseText("x".repeat(RESOURCE_LIMITS.documentCols + 1), { idGen: ids() });
    expect(wide.doc.cols).toBe(RESOURCE_LIMITS.documentCols);
    expect(wide.warnings.join("\n")).toMatch(/column\(s\) beyond the limit/u);
  });

  it("summarizes repetitive warnings at a fixed budget", () => {
    const { warnings } = parseText("\u0000".repeat(1_000), { idGen: ids() });
    expect(warnings).toHaveLength(RESOURCE_LIMITS.importWarnings + 1);
    expect(warnings.at(-1)).toMatch(/omitted .* warning/u);
  });

  it("never throws on adversarial input", () => {
    for (const input of ["", "\n", "\u0000\x1b[31m", "🎉🎉🎉", "á́b"]) {
      expect(() => parseText(input, { idGen: ids() }), JSON.stringify(input)).not.toThrow();
    }
  });

  it("produces a valid document even from empty input", () => {
    const { doc } = parseText("", { idGen: ids() });
    expect(doc.cols).toBe(1);
    expect(doc.rows).toBe(1);
    expect(() => deserialize(serialize(doc))).not.toThrow();
  });

  it("clips to an explicit size and reports what was lost", () => {
    const { doc, warnings } = parseText("abcdef\nghijkl\nmnopqr", {
      idGen: ids(),
      cols: 3,
      rows: 2,
    });
    expect(toText(doc)).toBe("abc\nghi");
    expect(warnings).toEqual([
      expect.stringMatching(/clipped 3 column\(s\)/u),
      expect.stringMatching(/clipped 1 row\(s\)/u),
    ]);
  });

  it("pads to an explicit size larger than the content", () => {
    const { doc, warnings } = parseText("ab", { idGen: ids(), cols: 5, rows: 3 });
    expect(doc.cols).toBe(5);
    expect(doc.rows).toBe(3);
    expect(warnings).toEqual([]);
    expect(toText(doc, { trimTrailingWhitespace: false })).toBe("ab   \n     \n     ");
  });

  it("produces documents that survive the file round-trip", () => {
    const { doc } = parseText("┌─┐\n│x│\n└─┘", { idGen: ids() });
    expect(deserialize(serialize(doc)).doc).toEqual(doc);
  });
});

describe("id generation", () => {
  it("mints a real id when none is injected", () => {
    // The production path: tests inject a counter, so this branch is otherwise
    // never taken.
    const { doc } = parseText("x");
    expect(doc.layers[0]?.id).toMatch(/[0-9a-f-]{36}/u);
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });
});
