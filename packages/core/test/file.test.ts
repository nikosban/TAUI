import { describe, expect, it } from "vitest";
import { canonical, deserialize, serialize, TuiParseError } from "../src/io/file.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { RESOURCE_LIMITS, ResourceLimitError } from "../src/model/resource-policy.js";
import { drawText, fillRect, setCell } from "../src/ops/draw.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

/** A document exercising every feature of the format. */
function richDocument(): TuiDocument {
  const base = createDocument(10, 4, { colorMode: "rgb", idGen: sequentialIdGen() });
  const withPalette: TuiDocument = {
    ...base,
    palette: [
      { id: "p1", name: "statusbar.bg", color: { kind: "ansi256", index: 24 } },
      { id: "p2", name: "accent.fg", color: { kind: "rgb", r: 255, g: 128, b: 0 } },
    ],
    layers: [
      ...base.layers,
      {
        id: "l-top",
        name: "top",
        visible: false,
        locked: true,
        cells: {},
        excludeFromHandoff: true,
      },
    ],
  };
  let doc = drawText(withPalette, base.activeLayerId, 0, 0, "Hello", {
    fg: { kind: "palette", id: "p2" },
    bg: { kind: "palette", id: "p1" },
    bold: true,
    underline: true,
  });
  doc = setCell(doc, base.activeLayerId, 2, 3, {
    char: "┼",
    fg: { kind: "rgb", r: 1, g: 2, b: 3 },
    bg: { kind: "ansi16", index: 7 },
    italic: true,
    inverse: true,
  });
  return doc;
}

describe("canonical", () => {
  it("preserves JSON null", () => {
    expect(canonical(null)).toBeNull();
  });

  it("sorts keys recursively", () => {
    const json = canonical({ b: 1, a: { d: 2, c: 3 } });
    expect(JSON.stringify(json)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("drops undefined-valued keys rather than emitting null", () => {
    expect(JSON.stringify(canonical({ a: 1, b: undefined }))).toBe('{"a":1}');
  });

  it("preserves array order", () => {
    expect(JSON.stringify(canonical([3, 1, 2]))).toBe("[3,1,2]");
  });

  it("refuses non-finite numbers and unserializable values", () => {
    expect(() => canonical({ a: Number.NaN })).toThrow(TuiParseError);
    expect(() => canonical({ a: Number.POSITIVE_INFINITY })).toThrow(TuiParseError);
    expect(() => canonical({ a: () => 1 })).toThrow(TuiParseError);
  });

  it("handles prototype-related keys as inert data", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"data","prototype":{"safe":true}}',
    );
    const output = canonical(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(Object.hasOwn(output, "constructor")).toBe(true);
    expect(Object.hasOwn(output, "prototype")).toBe(true);
    expect(JSON.stringify(output)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"data","prototype":{"safe":true}}',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("serialize", () => {
  it("produces sorted, pretty-printed JSON with a trailing newline", () => {
    const doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    expect(serialize(doc)).toBe(`{
  "activeLayerId": "l1",
  "colorMode": "ansi256",
  "cols": 2,
  "layers": [
    {
      "cells": {},
      "id": "l1",
      "locked": false,
      "name": "Layer 1",
      "visible": true
    }
  ],
  "palette": [],
  "rows": 1,
  "version": 1
}
`);
  });

  it("omits absent optional style flags", () => {
    const doc = createDocument(1, 1, { idGen: sequentialIdGen() });
    const next = setCell(doc, doc.activeLayerId, 0, 0, { char: "x", ...STYLE });
    const text = serialize(next);
    expect(text).not.toContain("bold");
    expect(text).not.toContain("italic");
    expect(text).not.toContain("excludeFromHandoff");
  });

  it("writes a false style flag when it is explicitly present", () => {
    // Ops must never *set* a flag to false, but if a caller does, the format is
    // faithful rather than silently lossy.
    const doc = createDocument(1, 1, { idGen: sequentialIdGen() });
    const next = setCell(doc, doc.activeLayerId, 0, 0, { char: "x", ...STYLE, bold: false });
    expect(serialize(next)).toContain('"bold": false');
  });

  it("is byte-identical for semantically-equal documents built in different orders", () => {
    const make = (reverse: boolean) => {
      let doc = createDocument(4, 2, { idGen: sequentialIdGen() });
      const id = doc.activeLayerId;
      const writes: [number, number, string][] = [
        [0, 0, "a"],
        [0, 1, "b"],
        [1, 2, "c"],
      ];
      for (const [row, col, char] of reverse ? [...writes].reverse() : writes) {
        doc = setCell(doc, id, row, col, { char, ...STYLE });
      }
      return doc;
    };
    expect(serialize(make(false))).toBe(serialize(make(true)));
  });

  it("is stable across a serialize -> deserialize -> serialize cycle", () => {
    const once = serialize(richDocument());
    expect(serialize(deserialize(once).doc)).toBe(once);
  });
});

describe("deserialize", () => {
  it("round-trips a feature-complete document to a deep-equal value", () => {
    const doc = richDocument();
    const { doc: back, warnings } = deserialize(serialize(doc));
    expect(back).toEqual(doc);
    expect(warnings).toEqual([]);
  });

  it("preserves the palette, activeLayerId, and excludeFromHandoff", () => {
    const { doc } = deserialize(serialize(richDocument()));
    expect(doc.palette.map((p) => p.name)).toEqual(["statusbar.bg", "accent.fg"]);
    expect(doc.activeLayerId).toBe("l1");
    expect(doc.layers[1]?.excludeFromHandoff).toBe(true);
  });

  it("defaults an omitted palette without warning", () => {
    const raw = JSON.parse(serialize(createDocument(2, 1, { idGen: sequentialIdGen() })));
    delete raw.palette;
    const result = deserialize(JSON.stringify(raw));
    expect(result.doc.palette).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects malformed input with a TuiParseError", () => {
    expect(() => deserialize("not json")).toThrow(/not valid JSON/u);
    expect(() => deserialize("[]")).toThrow(/root must be an object/u);
    expect(() => deserialize("{}")).toThrow(/missing or non-integer version/u);
    expect(() => deserialize('{"version":99}')).toThrow(/newer than the supported version/u);
    expect(() => deserialize('{"version":-1}')).toThrow(/invalid version/u);
  });

  it("rejects structurally invalid documents", () => {
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(serialize(richDocument())), ...patch });
    expect(() => deserialize(bad({ cols: 0 }))).toThrow(/cols must be a positive integer/u);
    expect(() => deserialize(bad({ rows: 1.5 }))).toThrow(/rows must be a positive integer/u);
    expect(() => deserialize(bad({ colorMode: "cmyk" }))).toThrow(/colorMode must be one of/u);
    expect(() => deserialize(bad({ layers: [] }))).toThrow(/non-empty array/u);
  });

  it("rejects duplicate layer ids", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.layers[1].id = doc.layers[0].id;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/layer ids must be unique/u);
  });

  it("rejects duplicate palette ids and names", () => {
    const duplicateId = JSON.parse(serialize(richDocument()));
    duplicateId.palette[1].id = duplicateId.palette[0].id;
    expect(() => deserialize(JSON.stringify(duplicateId))).toThrow(/palette ids must be unique/u);

    const duplicateName = JSON.parse(serialize(richDocument()));
    duplicateName.palette[1].name = duplicateName.palette[0].name;
    expect(() => deserialize(JSON.stringify(duplicateName))).toThrow(
      /palette names must be unique/u,
    );
  });

  it("repairs an activeLayerId that points at nothing and warns", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.activeLayerId = "ghost";
    const result = deserialize(JSON.stringify(doc));
    expect(result.doc.activeLayerId).toBe("l1");
    expect(result.warnings).toEqual([expect.stringMatching(/does not exist/u)]);
  });

  it("repairs a non-string activeLayerId and warns", () => {
    const raw = JSON.parse(serialize(richDocument()));
    raw.activeLayerId = null;
    const result = deserialize(JSON.stringify(raw));
    expect(result.doc.activeLayerId).toBe("l1");
    expect(result.warnings).toEqual([expect.stringMatching(/activeLayerId/u)]);
  });

  it("repairs malformed cell keys by dropping them and warns", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.layers[0].cells["not-a-key"] = {
      char: "x",
      fg: { kind: "default" },
      bg: { kind: "default" },
    };
    const result = deserialize(JSON.stringify(doc));
    expect(result.warnings).toEqual([expect.stringMatching(/malformed cell key/u)]);
  });

  it("repairs non-canonical coordinate aliases by dropping them and warns", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.layers[0].cells["00,0"] = doc.layers[0].cells["0,0"];
    const result = deserialize(JSON.stringify(doc));
    expect(result.warnings).toEqual([expect.stringMatching(/malformed cell key/u)]);
    expect(result.doc.layers[0]?.cells["00,0"]).toBeUndefined();
  });

  it("bounds repair warnings from hostile sparse cell maps", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.layers[0].cells = Object.fromEntries(
      Array.from({ length: RESOURCE_LIMITS.importWarnings + 5 }, (_, index) => [
        `malformed-${index}`,
        { char: "x", fg: { kind: "default" }, bg: { kind: "default" } },
      ]),
    );
    const result = deserialize(JSON.stringify(doc));
    expect(result.warnings).toHaveLength(RESOURCE_LIMITS.importWarnings + 1);
    expect(result.warnings.at(-1)).toBe("omitted 5 additional warning(s)");
  });

  it("repairs dangling palette references by baking them and warns", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.palette = []; // every ref is now dangling
    const result = deserialize(JSON.stringify(doc));
    expect(result.warnings).toEqual([expect.stringMatching(/baked 10 dangling/u)]);
    // No ref survives, so renderers never see one.
    expect(JSON.stringify(result.doc)).not.toContain('"kind":"palette"');
    expect(result.doc.layers[0]?.cells["0,0"]?.fg).toEqual({ kind: "default" });
    expect(result.doc.layers[0]?.cells["0,0"]?.bg).toEqual({ kind: "default" });
  });

  it("rejects a palette entry whose color is itself a palette ref", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.palette[0].color = { kind: "palette", id: "p2" };
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/cannot itself be a palette ref/u);
  });

  it("rejects out-of-range color values rather than loading them", () => {
    // An out-of-range index would survive into toAnsi and emit a nonsense escape
    // sequence, so the boundary rejects it instead of clamping.
    const withColor = (color: unknown) => {
      const doc = JSON.parse(serialize(richDocument()));
      doc.layers[0].cells["0,0"].fg = color;
      return JSON.stringify(doc);
    };
    expect(() => deserialize(withColor({ kind: "ansi16", index: 16 }))).toThrow(
      /ansi16 out of range \(index must be 0-15\)/u,
    );
    expect(() => deserialize(withColor({ kind: "ansi16", index: -1 }))).toThrow(/out of range/u);
    expect(() => deserialize(withColor({ kind: "ansi256", index: 256 }))).toThrow(
      /index must be 0-255/u,
    );
    expect(() => deserialize(withColor({ kind: "rgb", r: 256, g: 0, b: 0 }))).toThrow(
      /r\/g\/b must each be 0-255/u,
    );
    expect(() => deserialize(withColor({ kind: "rgb", r: 0, g: 0, b: -5 }))).toThrow(
      /out of range/u,
    );
    // Boundary values are valid.
    expect(() => deserialize(withColor({ kind: "ansi16", index: 15 }))).not.toThrow();
    expect(() => deserialize(withColor({ kind: "ansi256", index: 255 }))).not.toThrow();
    expect(() => deserialize(withColor({ kind: "rgb", r: 255, g: 0, b: 0 }))).not.toThrow();
  });

  it("range-checks palette entry colors too", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.palette[0].color = { kind: "ansi256", index: 999 };
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/palette\[0\].color: ansi256 out of/u);
  });

  it("rejects unknown color kinds and bad flag types", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.layers[0].cells["0,0"].fg = { kind: "hsl" };
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/unknown color kind/u);

    const doc2 = JSON.parse(serialize(richDocument()));
    doc2.layers[0].cells["0,0"].bold = "yes";
    expect(() => deserialize(JSON.stringify(doc2))).toThrow(/bold must be a boolean/u);
  });

  it("rejects terminal-control injection and unsafe multi-character cells", () => {
    const withChar = (char: string) => {
      const doc = JSON.parse(serialize(richDocument()));
      doc.layers[0].cells["0,0"].char = char;
      return JSON.stringify(doc);
    };
    for (const char of ["\x1b", "\x9b", "\x07", "\x1b[31m", "ab", "\u202e"]) {
      expect(() => deserialize(withChar(char)), JSON.stringify(char)).toThrow(TuiParseError);
    }
  });

  it("repairs out-of-bounds coordinates before validating their payload and warns", () => {
    const doc = JSON.parse(serialize(richDocument()));
    doc.layers[0].cells["-1,0"] = { char: "\x1b", fg: {}, bg: {} };
    doc.layers[0].cells["999999999999,0"] = { char: "\x1b", fg: {}, bg: {} };
    const result = deserialize(JSON.stringify(doc));
    expect(result.warnings).toEqual([
      expect.stringMatching(/out-of-bounds cell key/u),
      expect.stringMatching(/out-of-bounds cell key/u),
    ]);
    expect(result.doc.layers[0]?.cells["-1,0"]).toBeUndefined();
  });

  it("rejects oversized dimensions, layer counts, palettes, strings, and source text", () => {
    const raw = JSON.parse(serialize(richDocument()));
    expect(() =>
      deserialize(JSON.stringify({ ...raw, cols: RESOURCE_LIMITS.documentCols + 1 })),
    ).toThrow(/cols exceeds/u);
    expect(() => deserialize(JSON.stringify({ ...raw, cols: 501, rows: 500 }))).toThrow(
      /document area/u,
    );
    expect(() =>
      deserialize(
        JSON.stringify({
          ...raw,
          layers: Array.from({ length: RESOURCE_LIMITS.layers + 1 }, (_, index) => ({
            ...raw.layers[0],
            id: `l${index}`,
          })),
        }),
      ),
    ).toThrow(/layers exceeds/u);
    expect(() =>
      deserialize(
        JSON.stringify({
          ...raw,
          palette: Array.from({ length: RESOURCE_LIMITS.paletteEntries + 1 }, (_, index) => ({
            id: `p${index}`,
            name: "p",
            color: { kind: "default" },
          })),
        }),
      ),
    ).toThrow(/palette exceeds/u);
    raw.layers[0].name = "n".repeat(RESOURCE_LIMITS.nameChars + 1);
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/name exceeds/u);
    raw.layers[0].name = "Layer 1";
    raw.activeLayerId = "a".repeat(RESOURCE_LIMITS.idChars + 1);
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/activeLayerId exceeds/u);
    expect(() => deserialize(" ".repeat(RESOURCE_LIMITS.documentTextChars + 1))).toThrow(
      /document text exceeds/u,
    );
  });

  it("rejects malformed nested field types at the persisted-file boundary", () => {
    const rejects = (mutate: (raw: ReturnType<typeof JSON.parse>) => void, message: RegExp) => {
      const raw = JSON.parse(serialize(richDocument()));
      mutate(raw);
      expect(() => deserialize(JSON.stringify(raw))).toThrow(message);
    };

    rejects((raw) => (raw.cols = "10"), /cols and rows must be numbers/u);
    rejects((raw) => (raw.rows = null), /cols and rows must be numbers/u);
    rejects((raw) => (raw.layers[0] = null), /layers\[0\] must be an object/u);
    rejects((raw) => (raw.layers[0].id = ""), /id must be a non-empty string/u);
    rejects((raw) => (raw.layers[0].id = 1), /id must be a non-empty string/u);
    rejects((raw) => (raw.layers[0].name = null), /name must be a string/u);
    rejects((raw) => (raw.layers[0].visible = "yes"), /visible must be a boolean/u);
    rejects((raw) => (raw.layers[0].locked = 0), /locked must be a boolean/u);
    rejects((raw) => (raw.layers[0].cells = []), /cells must be an object/u);
    rejects(
      (raw) => (raw.layers[0].excludeFromHandoff = "yes"),
      /excludeFromHandoff must be a boolean/u,
    );
    rejects((raw) => (raw.layers[0].cells["0,0"] = null), /cell must be an object/u);
    rejects((raw) => (raw.layers[0].cells["0,0"].char = 1), /cell.char must be a string/u);
    rejects((raw) => (raw.layers[0].cells["0,0"].fg = null), /color must be an object/u);
    rejects(
      (raw) => (raw.layers[0].cells["0,0"].fg = { kind: "ansi256", index: 1.5 }),
      /requires an integer index/u,
    );
    rejects(
      (raw) => (raw.layers[0].cells["0,0"].fg = { kind: "rgb", r: 1, g: "2", b: 3 }),
      /requires integer r\/g\/b/u,
    );
    rejects(
      (raw) => (raw.layers[0].cells["0,0"].fg = { kind: "palette", id: 1 }),
      /palette ref requires an id/u,
    );
    rejects((raw) => (raw.palette = {}), /palette must be an array/u);
    rejects((raw) => (raw.palette = [null]), /palette\[0\] must be an object/u);
    rejects((raw) => (raw.palette[0].id = ""), /id must be a non-empty string/u);
    rejects((raw) => (raw.palette[0].id = 1), /id must be a non-empty string/u);
    rejects((raw) => (raw.palette[0].name = null), /name must be a string/u);
  });

  it("rejects unsafe integers and accepts exact string limits", () => {
    const unsafeCols = JSON.parse(serialize(richDocument()));
    unsafeCols.cols = Number.MAX_SAFE_INTEGER + 1;
    expect(() => deserialize(JSON.stringify(unsafeCols))).toThrow(/positive integer/u);

    const unsafeRows = JSON.parse(serialize(richDocument()));
    unsafeRows.rows = Number.MAX_SAFE_INTEGER + 1;
    expect(() => deserialize(JSON.stringify(unsafeRows))).toThrow(/positive integer/u);

    const raw = JSON.parse(serialize(richDocument()));
    const layerId = "l".repeat(RESOURCE_LIMITS.idChars);
    const paletteId = "p".repeat(RESOURCE_LIMITS.idChars);
    raw.layers[0].id = layerId;
    raw.layers[0].name = "n".repeat(RESOURCE_LIMITS.nameChars);
    raw.activeLayerId = layerId;
    raw.palette.push({
      id: paletteId,
      name: "p".repeat(RESOURCE_LIMITS.nameChars),
      color: { kind: "default" },
    });
    raw.layers[0].cells["0,0"].bg = { kind: "palette", id: paletteId };
    expect(deserialize(JSON.stringify(raw)).warnings).toEqual([]);
  });

  it("ignores unknown fields without preserving executable or ambiguous data", () => {
    const raw = JSON.parse(serialize(richDocument()));
    raw.futureRoot = { command: "run-me" };
    raw.layers[0].futureLayer = true;
    raw.layers[0].cells["0,0"].futureCell = "ignored";
    raw.layers[0].cells["0,0"].fg.futureColor = 123;
    raw.palette[0].futurePaletteEntry = ["ignored"];

    const result = deserialize(JSON.stringify(raw));
    const canonicalText = serialize(result.doc);
    expect(result.warnings).toEqual([]);
    expect(canonicalText).not.toMatch(
      /futureRoot|futureLayer|futureCell|futureColor|futurePalette/u,
    );
  });

  it("repairs all recoverable corruption with warnings and serializes deterministically", () => {
    const raw = JSON.parse(serialize(richDocument()));
    raw.activeLayerId = "missing";
    raw.palette = [];
    raw.layers[0].cells["not-a-key"] = { char: "x", ...STYLE };
    raw.layers[0].cells["99,99"] = { char: "x", ...STYLE };

    const repaired = deserialize(JSON.stringify(raw));
    expect(repaired.warnings).toEqual([
      expect.stringMatching(/malformed cell key/u),
      expect.stringMatching(/out-of-bounds cell key/u),
      expect.stringMatching(/activeLayerId/u),
      expect.stringMatching(/dangling palette/u),
    ]);

    const once = serialize(repaired.doc);
    const cleanReload = deserialize(once);
    expect(cleanReload.warnings).toEqual([]);
    expect(serialize(cleanReload.doc)).toBe(once);
  });

  it("guards serialization of unsafe hand-constructed documents", () => {
    const unsafe: TuiDocument = {
      ...richDocument(),
      layers: [
        {
          ...richDocument().layers[0]!,
          cells: {
            "0,0": { char: "\x1b", fg: DEFAULT_COLOR, bg: DEFAULT_COLOR },
          },
        },
      ],
    };
    expect(() => serialize(unsafe)).toThrow(/control/u);
    expect(() => serialize(createDocument(501, 500))).toThrow(ResourceLimitError);

    const aliased = richDocument();
    const first = aliased.layers[0]!;
    expect(() =>
      serialize({
        ...aliased,
        layers: [{ ...first, cells: { ...first.cells, "00,0": first.cells["0,0"]! } }],
      }),
    ).toThrow(/invalid cell coordinate/u);
  });
});

describe("migrations", () => {
  // Hand-written v0 literal. Deliberately not generated from current code — a
  // regenerated fixture would always "pass" by matching whatever serialize()
  // happens to emit, which tests nothing.
  const V0_LEGACY = `{
  "activeLayerId": "legacy-layer",
  "cols": 8,
  "layers": [
    {
      "cells": {
        "0,0": { "bg": { "kind": "default" }, "char": "v", "fg": { "index": 3, "kind": "ansi16" } },
        "0,1": { "bg": { "kind": "default" }, "char": "0", "fg": { "index": 3, "kind": "ansi16" } },
        "1,0": { "bg": { "kind": "default" }, "bold": true, "char": "o", "fg": { "kind": "default" } },
        "1,1": { "bg": { "kind": "default" }, "bold": true, "char": "k", "fg": { "kind": "default" } }
      },
      "id": "legacy-layer",
      "locked": false,
      "name": "legacy",
      "visible": true
    }
  ],
  "rows": 2,
  "version": 0
}`;

  it("migrates a v0 document, supplying the fields it lacked", () => {
    const { doc, warnings } = deserialize(V0_LEGACY);
    expect(doc.version).toBe(1);
    expect(doc.colorMode).toBe("ansi256"); // absent in v0
    expect(doc.palette).toEqual([]); // absent in v0
    expect(warnings).toEqual(["migrated document from v0 to v1"]);
  });

  it("preserves valid fields already present on a v0 document", () => {
    const raw = JSON.parse(V0_LEGACY);
    raw.colorMode = "rgb";
    raw.palette = [{ id: "legacy", name: "legacy", color: { kind: "default" } }];
    const { doc } = deserialize(JSON.stringify(raw));
    expect(doc.colorMode).toBe("rgb");
    expect(doc.palette).toEqual(raw.palette);
  });

  it("preserves v0 cell content through the migration", () => {
    const { doc } = deserialize(V0_LEGACY);
    expect(toText(doc)).toBe("v0\nok");
    expect(doc.layers[0]?.cells["1,0"]?.bold).toBe(true);
  });

  it("produces a document that serializes as valid v1", () => {
    const { doc } = deserialize(V0_LEGACY);
    expect(deserialize(serialize(doc)).doc).toEqual(doc);
  });
});

describe("large documents", () => {
  it("round-trips a fully painted grid", () => {
    const big = createDocument(120, 40, { idGen: sequentialIdGen() });
    const filled = fillRect(
      big,
      big.activeLayerId,
      { top: 0, left: 0, rows: 40, cols: 120 },
      { char: "▒", ...STYLE },
    );
    expect(deserialize(serialize(filled)).doc).toEqual(filled);
  });
});
