/**
 * ANSI import.
 *
 * The headline test is the round-trip: `parseAnsi(toAnsi(doc))` composited must
 * deep-equal `composite(doc)`. Layers are legitimately lost — a terminal capture
 * has none — but no cell may be.
 *
 * The rest of the file is mostly hostile input, because the contract is "never
 * throws" and that is only worth anything if it has been attacked.
 */

import { describe, expect, it } from "vitest";
import { parseAnsi } from "../src/io/ansi-import.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { RESOURCE_LIMITS } from "../src/model/resource-policy.js";
import { drawBox } from "../src/ops/box.js";
import { drawText, setCell } from "../src/ops/draw.js";
import { toAnsi } from "../src/render/ansi.js";
import { composite } from "../src/render/composite.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const parse = (input: string, opts = {}) => parseAnsi(input, { idGen: sequentialIdGen(), ...opts });

describe("plain text", () => {
  it("builds a grid sized to the content", () => {
    const { doc, warnings } = parse("ab\ncde");
    expect([doc.cols, doc.rows]).toEqual([3, 2]);
    expect(toText(doc)).toBe("ab\ncde");
    expect(warnings).toEqual([]);
  });

  it("names the single layer 'imported' and makes it active", () => {
    const { doc } = parse("x");
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]?.name).toBe("imported");
    // The invariant every op relies on.
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });

  it("honours an explicit width and reports cells that fall outside", () => {
    const { doc, warnings } = parse("abcdef", { cols: 3 });
    expect(doc.cols).toBe(3);
    expect(toText(doc)).toBe("abc");
    expect(warnings.join()).toContain("3 cells fell outside");
  });

  it("treats CR as a carriage return, overwriting the line", () => {
    const { doc } = parse("abc\rX");
    expect(toText(doc)).toBe("Xbc");
  });

  it("produces a 1×1 document from empty input rather than a 0×0 one", () => {
    const { doc } = parse("");
    expect([doc.cols, doc.rows]).toEqual([1, 1]);
  });
});

describe("SGR", () => {
  const first = (input: string) => {
    const { doc } = parse(input);
    return doc.layers[0]?.cells["0,0"];
  };

  it("reads the basic 8 and the bright 8 as ansi16", () => {
    expect(first("\x1b[31mx")?.fg).toEqual({ kind: "ansi16", index: 1 });
    expect(first("\x1b[94mx")?.fg).toEqual({ kind: "ansi16", index: 12 });
    expect(first("\x1b[41mx")?.bg).toEqual({ kind: "ansi16", index: 1 });
    expect(first("\x1b[104mx")?.bg).toEqual({ kind: "ansi16", index: 12 });
  });

  it("reads 256-colour and truecolour forms", () => {
    expect(first("\x1b[38;5;208mx")?.fg).toEqual({ kind: "ansi256", index: 208 });
    expect(first("\x1b[48;5;17mx")?.bg).toEqual({ kind: "ansi256", index: 17 });
    expect(first("\x1b[38;2;10;20;30mx")?.fg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
  });

  it("reads every style flag and its off-code", () => {
    expect(first("\x1b[1mx")?.bold).toBe(true);
    expect(first("\x1b[3mx")?.italic).toBe(true);
    expect(first("\x1b[4mx")?.underline).toBe(true);
    expect(first("\x1b[7mx")?.inverse).toBe(true);
    expect(first("\x1b[1m\x1b[22mx")?.bold).toBeUndefined();
    expect(first("\x1b[3m\x1b[23mx")?.italic).toBeUndefined();
    expect(first("\x1b[4m\x1b[24mx")?.underline).toBeUndefined();
    expect(first("\x1b[7m\x1b[27mx")?.inverse).toBeUndefined();
  });

  it("omits false flags entirely, so absent stays absent through serialize", () => {
    const cell = first("x");
    expect(Object.keys(cell ?? {}).sort()).toEqual(["bg", "char", "fg"]);
  });

  it("resets everything on 0, and treats a bare ESC[m as ESC[0m", () => {
    expect(first("\x1b[31;1m\x1b[0mx")?.fg).toEqual(DEFAULT_COLOR);
    expect(first("\x1b[31;1m\x1b[mx")?.bold).toBeUndefined();
  });

  it("returns to the terminal default on 39 and 49", () => {
    expect(first("\x1b[31m\x1b[39mx")?.fg).toEqual(DEFAULT_COLOR);
    expect(first("\x1b[41m\x1b[49mx")?.bg).toEqual(DEFAULT_COLOR);
  });

  it("applies several parameters from one sequence", () => {
    const cell = first("\x1b[1;4;32;44mx");
    expect(cell?.bold).toBe(true);
    expect(cell?.underline).toBe(true);
    expect(cell?.fg).toEqual({ kind: "ansi16", index: 2 });
    expect(cell?.bg).toEqual({ kind: "ansi16", index: 4 });
  });

  it("carries style across a newline, as a terminal would", () => {
    const { doc } = parse("\x1b[31ma\nb");
    expect(doc.layers[0]?.cells["1,0"]?.fg).toEqual({ kind: "ansi16", index: 1 });
  });
});

describe("cursor positioning", () => {
  it("moves the cursor with CUP, which is 1-based", () => {
    const { doc } = parse("\x1b[3;5HX");
    expect(doc.layers[0]?.cells["2,4"]?.char).toBe("X");
  });

  it("treats missing CUP parameters as 1", () => {
    const { doc } = parse("a\x1b[HX");
    expect(doc.layers[0]?.cells["0,0"]?.char).toBe("X");
  });

  it("accepts the HVP form (ESC[…f) as well", () => {
    const { doc } = parse("\x1b[2;2fX");
    expect(doc.layers[0]?.cells["1,1"]?.char).toBe("X");
  });

  it("erases to end of line with the current background when the width is known", () => {
    // EL is how full-screen apps paint a coloured bar, so it must fill rather
    // than be skipped.
    const { doc } = parse("\x1b[44m\x1b[K", { cols: 4 });
    for (const key of ["0,0", "0,1", "0,2", "0,3"]) {
      expect(doc.layers[0]?.cells[key]?.bg, key).toEqual({ kind: "ansi16", index: 4 });
    }
  });

  it("fills to the content width when no width was given", () => {
    // A status bar is the single most visually obvious thing in a capture, and
    // the caller pasting a capture does not know the width. Requiring `cols` to
    // get the bar would make the common case the broken one, so the input is
    // scanned twice: once to learn the width, once to apply EL against it.
    const { doc } = parse("\x1b[44m\x1b[K\n0123456789");
    expect(doc.cols).toBe(10);
    for (let c = 0; c < 10; c++) {
      expect(doc.layers[0]?.cells[`0,${c}`]?.bg, `col ${c}`).toEqual({
        kind: "ansi16",
        index: 4,
      });
    }
  });

  it("lets text written after an EL sit on top of the erase", () => {
    // Deferring EL to the end of parsing instead of re-scanning would paint over
    // this text, which is why the two-pass shape is necessary rather than tidy.
    const { doc } = parse("\x1b[44m\x1b[K\x1b[1;1HAB\n0123456789");
    expect(doc.layers[0]?.cells["0,0"]?.char).toBe("A");
    expect(doc.layers[0]?.cells["0,1"]?.char).toBe("B");
    // ...and the erase still shows beyond the text.
    expect(doc.layers[0]?.cells["0,5"]?.bg).toEqual({ kind: "ansi16", index: 4 });
  });

  it("still honours an explicit width, scanning only once", () => {
    const { doc } = parse("\x1b[44m\x1b[K", { cols: 4 });
    expect(doc.cols).toBe(4);
    expect(Object.keys(doc.layers[0]?.cells ?? {})).toHaveLength(4);
  });

  it("implements EL 0, 1, and 2 without moving the cursor", () => {
    const blue = { kind: "ansi16", index: 4 } as const;

    const el0 = parse("abc\x1b[1;3H\x1b[44m\x1b[0KX", { cols: 5 }).doc;
    expect(el0.layers[0]?.cells["0,1"]?.char).toBe("b");
    expect(el0.layers[0]?.cells["0,2"]?.char).toBe("X");
    expect(el0.layers[0]?.cells["0,4"]?.bg).toEqual(blue);

    const el1 = parse("abcde\x1b[1;3H\x1b[44m\x1b[1KX", { cols: 5 }).doc;
    expect(el1.layers[0]?.cells["0,0"]?.bg).toEqual(blue);
    expect(el1.layers[0]?.cells["0,2"]?.char).toBe("X");
    expect(el1.layers[0]?.cells["0,3"]?.char).toBe("d");

    const el2 = parse("abcde\x1b[1;3H\x1b[44m\x1b[2KX", { cols: 5 }).doc;
    expect(el2.layers[0]?.cells["0,0"]?.bg).toEqual(blue);
    expect(el2.layers[0]?.cells["0,2"]?.char).toBe("X");
    expect(el2.layers[0]?.cells["0,4"]?.char).toBe(" ");
    expect(el2.layers[0]?.cells["0,4"]?.bg).toEqual(blue);
  });

  it("clips hostile cursor coordinates without creating an enormous document", () => {
    const { doc, warnings } = parse("\x1b[999999999999;999999999999HX");
    expect(doc.cols).toBe(1);
    expect(doc.rows).toBe(1);
    expect(Object.keys(doc.layers[0]?.cells ?? {})).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/resource limits/u);
  });

  it("bounds explicit dimensions and total area without throwing", () => {
    const { doc, warnings } = parse("x", {
      cols: RESOURCE_LIMITS.documentCols + 1,
      rows: RESOURCE_LIMITS.documentRows + 1,
    });
    expect(doc.cols).toBe(RESOURCE_LIMITS.documentCols);
    expect(doc.cols * doc.rows).toBeLessThanOrEqual(RESOURCE_LIMITS.documentArea);
    expect(warnings.join("\n")).toMatch(/requested cols/u);
    expect(warnings.join("\n")).toMatch(/requested rows/u);
  });
});

describe("colorMode inference", () => {
  it("infers the richest colour actually seen", () => {
    expect(parse("x").doc.colorMode).toBe("ansi16");
    expect(parse("\x1b[31mx").doc.colorMode).toBe("ansi16");
    expect(parse("\x1b[38;5;9mx").doc.colorMode).toBe("ansi256");
    expect(parse("\x1b[38;2;1;2;3mx").doc.colorMode).toBe("rgb");
  });

  it("takes the richest across the whole input, not the last seen", () => {
    expect(parse("\x1b[38;2;1;2;3ma\x1b[31mb").doc.colorMode).toBe("rgb");
  });
});

describe("hostile input never throws", () => {
  const inputs: readonly [string, string][] = [
    ["lone ESC at end", "abc\x1b"],
    ["unterminated CSI", "abc\x1b[38;5"],
    ["truncated 38;5", "\x1b[38;5mx"],
    ["truncated 38;2", "\x1b[38;2;1mx"],
    ["unsupported colour form", "\x1b[38;9;1mx"],
    ["unknown SGR parameter", "\x1b[53mx"],
    ["private CSI", "\x1b[?25lx"],
    ["OSC with BEL", "\x1b]0;title\x07x"],
    ["OSC with ST", "\x1b]0;title\x1b\\x"],
    ["unterminated OSC", "\x1b]0;title"],
    ["DCS", "\x1bP1$r0m\x1b\\x"],
    ["two-byte escape", "\x1bcx"],
    ["cursor hide/show", "\x1b[?25h\x1b[?25lx"],
    ["scroll region", "\x1b[1;24rx"],
    ["unsupported erase mode", "a\x1b[3Kb"],
    ["mouse report", "\x1b[<0;10;10Mx"],
    ["sub-parameters", "\x1b[38:2::1:2:3mx"],
    ["bare control chars", "abc\x00\x01\x02"],
    ["wide character", "a你b"],
    ["emoji", "a🎉b"],
    ["lone surrogate half", `a${"\ud800"}b`],
    ["only escapes", "\x1b[0m\x1b[0m"],
    ["huge parameter", "\x1b[38;5;99999mx"],
    ["negative-looking parameter", "\x1b[38;5;-4mx"],
  ];

  it.each(inputs)("survives %s", (_label, input) => {
    expect(() => parse(input)).not.toThrow();
    const { doc } = parse(input);
    // Whatever happened, the result must be a usable document.
    expect(doc.cols).toBeGreaterThan(0);
    expect(doc.rows).toBeGreaterThan(0);
    expect(doc.layers).toHaveLength(1);
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });

  it("does not spill an OSC payload into the grid as literal cells", () => {
    // The bug this guards: measuring the sequence wrong turns "0;title" into
    // seven cells of garbage.
    const { doc } = parse("\x1b]0;my window title\x07AB");
    expect(toText(doc)).toBe("AB");
  });

  it("does not spill a private CSI into the grid", () => {
    const { doc } = parse("\x1b[?25lAB");
    expect(toText(doc)).toBe("AB");
  });

  it("substitutes a wide character rather than shifting the row", () => {
    const { doc, warnings } = parse("a你b");
    // Three cells, not two: the replacement occupies exactly one column.
    expect(doc.cols).toBe(3);
    expect(toText(doc)).toBe("a�b");
    expect(warnings.join()).toContain("wide character");
  });

  it("keeps an emoji to one cell, consuming the whole surrogate pair", () => {
    const { doc } = parse("a🎉b");
    expect(doc.cols).toBe(3);
    expect(toText(doc)).toBe("a�b");
  });

  it("clamps an out-of-range 256 index instead of storing it", () => {
    expect(parse("\x1b[38;5;99999mx").doc.layers[0]?.cells["0,0"]?.fg).toEqual({
      kind: "ansi256",
      index: 255,
    });
  });

  it("reports why it ignored something", () => {
    expect(parse("\x1b[53mx").warnings.join()).toContain("unsupported SGR parameter 53");
    expect(parse("abc\x1b").warnings.join()).toContain("unterminated escape");
    expect(parse("\x1b[38;5mx").warnings.join()).toContain("truncated 38;5");
    expect(parse("\x1b[48;2;1mx").warnings.join()).toContain("truncated 48;2");
    expect(parse("\x1b[38;9;1mx").warnings.join()).toContain("unsupported 38;9");
    expect(parse("a\x00b").warnings.join()).toContain("skipped control character");
  });

  it("caps repetitive parser warnings", () => {
    const { warnings } = parse("\u0000".repeat(1_000));
    expect(warnings).toHaveLength(RESOURCE_LIMITS.importWarnings + 1);
    expect(warnings.at(-1)).toMatch(/omitted .* warning/u);
  });
});

describe("the round trip", () => {
  /** Every feature that survives a terminal: colours, flags, box merging. */
  function richDoc(mode: "ansi16" | "ansi256" | "rgb"): TuiDocument {
    let d = createDocument(24, 6, { colorMode: mode, idGen: sequentialIdGen() });
    const id = d.activeLayerId;
    d = drawBox(d, id, { top: 0, left: 0, rows: 6, cols: 24 }, "light", true, STYLE);
    d = drawBox(d, id, { top: 0, left: 10, rows: 6, cols: 8 }, "light", true, STYLE);
    d = drawText(d, id, 1, 2, "OK", {
      fg: mode === "rgb" ? { kind: "rgb", r: 200, g: 30, b: 40 } : { kind: "ansi16", index: 2 },
      bg: DEFAULT_COLOR,
    });
    d = drawText(d, id, 2, 2, "warn", {
      fg: { kind: "ansi16", index: 15 },
      bg: mode === "ansi16" ? { kind: "ansi16", index: 3 } : { kind: "ansi256", index: 208 },
    });
    d = setCell(d, id, 3, 2, { char: "B", ...STYLE, bold: true });
    d = setCell(d, id, 3, 3, { char: "I", ...STYLE, italic: true });
    d = setCell(d, id, 3, 4, { char: "U", ...STYLE, underline: true });
    d = setCell(d, id, 3, 5, { char: "V", ...STYLE, inverse: true });
    return d;
  }

  it.each(["ansi16", "ansi256", "rgb"] as const)(
    "preserves every cell through toAnsi in %s mode",
    (mode) => {
      const original = richDoc(mode);
      const { doc: reparsed, warnings } = parseAnsi(toAnsi(original), {
        cols: original.cols,
        idGen: sequentialIdGen(),
      });
      expect(warnings).toEqual([]);
      expect(composite(reparsed)).toEqual(composite(original));
    },
  );

  it("preserves the rendered text as well as the cells", () => {
    const original = richDoc("ansi256");
    const { doc } = parseAnsi(toAnsi(original), {
      cols: original.cols,
      idGen: sequentialIdGen(),
    });
    expect(toText(doc)).toBe(toText(original));
  });

  it("flattens layers, which is the one thing it is allowed to lose", () => {
    let d = createDocument(6, 2, { idGen: sequentialIdGen() });
    d = {
      ...d,
      layers: [...d.layers, { id: "top", name: "top", visible: true, locked: false, cells: {} }],
    };
    d = drawText(d, d.layers[0]?.id ?? "", 0, 0, "low", STYLE);
    d = drawText(d, "top", 0, 0, "hi", STYLE);

    const { doc } = parseAnsi(toAnsi(d), { cols: d.cols, idGen: sequentialIdGen() });
    expect(doc.layers).toHaveLength(1);
    // The composite is identical even though the layering is gone.
    expect(composite(doc)).toEqual(composite(d));
  });

  it("survives a second trip unchanged, so the encoding is stable", () => {
    const once = parseAnsi(toAnsi(richDoc("rgb")), { cols: 24, idGen: sequentialIdGen() }).doc;
    const twice = parseAnsi(toAnsi(once), { cols: 24, idGen: sequentialIdGen() }).doc;
    expect(composite(twice)).toEqual(composite(once));
    expect(toAnsi(twice)).toBe(toAnsi(once));
  });
});

describe("id generation and grid trimming", () => {
  it("mints a real id when none is injected", () => {
    // Tests inject a counter; production uses crypto.randomUUID. Both paths must
    // yield an activeLayerId that names the layer.
    const { doc } = parseAnsi("x");
    expect(doc.layers[0]?.id).toMatch(/[0-9a-f-]{36}/u);
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });

  it("reports a single dropped cell in the singular", () => {
    const { warnings } = parse("abcd", { cols: 3 });
    expect(warnings.join()).toContain("1 cell fell outside 3×1");
  });

  it("drops cells below an explicit row limit too", () => {
    const { doc, warnings } = parse("a\nb\nc", { rows: 2 });
    expect(doc.rows).toBe(2);
    expect(toText(doc)).toBe("a\nb");
    expect(warnings.join()).toContain("1 cell fell outside");
  });
});
