/**
 * Inspector formatting.
 *
 * These are numbers a developer copies into an implementation, so a wrong label is
 * worse than no label. The shorthand collapse is the part with real edge cases —
 * CSS's own rules are easy to get subtly wrong in the three-value case.
 */

import type { Color, Padding, RegionInfo } from "@tui-designer/core";
import {
  createDocument,
  drawText,
  inspectRegion,
  parseText,
  sequentialIdGen,
} from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import {
  colorLabel,
  inspectPayload,
  offsetLabel,
  paddingShorthand,
  regionRows,
} from "../src/inspect/inspect-model.js";

const pad = (top: number, right: number, bottom: number, left: number): Padding => ({
  top,
  right,
  bottom,
  left,
});

const whole = (doc: { rows: number; cols: number }) => ({
  top: 0,
  left: 0,
  rows: doc.rows,
  cols: doc.cols,
});

const art = (...lines: string[]) => parseText(lines.join("\n"), { idGen: sequentialIdGen() }).doc;

describe("paddingShorthand", () => {
  it("collapses four equal sides to one value", () => {
    expect(paddingShorthand(pad(2, 2, 2, 2))).toBe("2");
    expect(paddingShorthand(pad(0, 0, 0, 0))).toBe("0");
  });

  it("collapses a symmetric pair to two values", () => {
    expect(paddingShorthand(pad(1, 3, 1, 3))).toBe("1 3");
  });

  it("uses three values when only the horizontals match", () => {
    // CSS order: top, horizontal, bottom.
    expect(paddingShorthand(pad(1, 2, 5, 2))).toBe("1 2 5");
  });

  it("uses four values when nothing matches", () => {
    expect(paddingShorthand(pad(1, 2, 3, 4))).toBe("1 2 3 4");
  });

  it("does not collapse when only the verticals match", () => {
    // top === bottom but left !== right: the two-value form would be a lie, and
    // the three-value form assumes matching horizontals. Four is correct.
    expect(paddingShorthand(pad(1, 2, 1, 4))).toBe("1 2 1 4");
  });

  it("round-trips through CSS's own reading of the shorthand", () => {
    // Expands the shorthand back the way a browser would and checks it matches.
    const expand = (s: string): Padding => {
      const n = s.split(" ").map(Number);
      if (n.length === 1)
        return pad(n[0] as number, n[0] as number, n[0] as number, n[0] as number);
      if (n.length === 2)
        return pad(n[0] as number, n[1] as number, n[0] as number, n[1] as number);
      if (n.length === 3)
        return pad(n[0] as number, n[1] as number, n[2] as number, n[1] as number);
      return pad(n[0] as number, n[1] as number, n[2] as number, n[3] as number);
    };
    for (const p of [
      pad(0, 0, 0, 0),
      pad(2, 2, 2, 2),
      pad(1, 3, 1, 3),
      pad(1, 2, 5, 2),
      pad(1, 2, 3, 4),
      pad(1, 2, 1, 4),
      pad(0, 7, 0, 7),
      pad(9, 0, 0, 0),
    ]) {
      expect(expand(paddingShorthand(p)), paddingShorthand(p)).toEqual(p);
    }
  });
});

describe("colorLabel", () => {
  it("names each colour kind", () => {
    expect(colorLabel({ kind: "default" })).toBe("default");
    expect(colorLabel({ kind: "ansi16", index: 4 })).toBe("ansi 4");
    expect(colorLabel({ kind: "ansi256", index: 208 })).toBe("ansi256 208");
    expect(colorLabel({ kind: "rgb", r: 255, g: 0, b: 128 })).toBe("#ff0080");
  });

  it("zero-pads hex components, so a dark colour is still six digits", () => {
    expect(colorLabel({ kind: "rgb", r: 1, g: 2, b: 3 })).toBe("#010203");
  });
});

describe("offsetLabel", () => {
  it("phrases a direction rather than a sign", () => {
    // "-3" makes the reader work out which way is negative.
    expect(offsetLabel(3, 5)).toBe("3 down, 5 right");
    expect(offsetLabel(-3, -5)).toBe("3 up, 5 left");
    expect(offsetLabel(-2, 4)).toBe("2 up, 4 right");
  });

  it("drops an axis with no offset", () => {
    expect(offsetLabel(0, 4)).toBe("4 right");
    expect(offsetLabel(4, 0)).toBe("4 down");
  });

  it("says 'same cell' rather than a pair of zeroes", () => {
    expect(offsetLabel(0, 0)).toBe("same cell");
  });
});

describe("regionRows", () => {
  const bordered = (): RegionInfo => {
    const doc = art("┌────────┐", "│        │", "│  text  │", "│        │", "└────────┘");
    return inspectRegion(doc, whole(doc));
  };

  it("leads with the size, then the origin, then the coverage", () => {
    const rows = regionRows(bordered());
    expect(rows.slice(0, 3).map((r) => r.label)).toEqual(["size", "origin", "painted"]);
    expect(rows[0]?.value).toBe("10 × 5 cells");
    expect(rows[1]?.value).toBe("row 0, col 0");
  });

  it("shows coverage as a proportion, not a bare count", () => {
    // "12 painted" says nothing without the area to compare it against.
    expect(regionRows(bordered()).find((r) => r.label === "painted")?.value).toMatch(
      /^\d+ of 50$/u,
    );
  });

  it("reports the border style and the padding inside it", () => {
    const rows = regionRows(bordered());
    expect(rows.find((r) => r.label === "border")?.value).toBe("light");
    expect(rows.find((r) => r.label === "padding")?.value).toBe("1 2");
  });

  it("omits the border row entirely when the region is not a frame", () => {
    // An absent row reads as "not a panel"; "border: none" reads as "a panel with
    // no border", which is a different claim.
    const doc = art("hello", "world");
    const rows = regionRows(inspectRegion(doc, whole(doc)));
    expect(rows.some((r) => r.label === "border")).toBe(false);
    expect(rows.some((r) => r.label === "padding")).toBe(true);
  });

  it("attaches a swatch to the colour rows and to nothing else", () => {
    const rows = regionRows(bordered());
    expect(rows.filter((r) => r.swatch !== undefined).map((r) => r.label)).toEqual(["fg", "bg"]);
  });

  it("labels the dominant colours", () => {
    let doc = createDocument(6, 1, { idGen: sequentialIdGen() });
    doc = drawText(doc, doc.activeLayerId, 0, 0, "aaaa", {
      fg: { kind: "ansi16", index: 2 },
      bg: { kind: "default" },
    });
    const rows = regionRows(inspectRegion(doc, whole(doc)));
    expect(rows.find((r) => r.label === "fg")?.value).toBe("ansi 2");
  });

  it("returns nothing for a region outside the document", () => {
    const doc = createDocument(4, 4, { idGen: sequentialIdGen() });
    expect(regionRows(inspectRegion(doc, { top: 40, left: 40, rows: 2, cols: 2 }))).toEqual([]);
  });
});

describe("inspectPayload", () => {
  it("is valid JSON a developer can paste", () => {
    const doc = art("┌──┐", "│ab│", "└──┘");
    const payload = inspectPayload(inspectRegion(doc, whole(doc)));
    expect(() => JSON.parse(payload)).not.toThrow();
  });

  it("carries the raw numbers, not the display shorthand", () => {
    // The shorthand is for reading; a machine-readable payload keeps four sides.
    const doc = art("┌────────┐", "│        │", "│  text  │", "│        │", "└────────┘");
    const parsed = JSON.parse(inspectPayload(inspectRegion(doc, whole(doc))));
    expect(parsed.padding).toEqual({ top: 1, right: 2, bottom: 1, left: 2 });
    expect(parsed.rect).toEqual({ top: 0, left: 0, rows: 5, cols: 10 });
    expect(parsed.borderStyle).toBe("light");
  });

  it("keeps a null border rather than omitting the key", () => {
    // Unlike the display, which drops the row: a consumer reading JSON needs the
    // key to exist so it can distinguish "not a frame" from "old payload".
    const doc = art("ab", "cd");
    const parsed = JSON.parse(inspectPayload(inspectRegion(doc, whole(doc))));
    expect(parsed.borderStyle).toBeNull();
  });

  it("ends with a newline, so pasting into a file lands clean", () => {
    const doc = art("ab");
    expect(inspectPayload(inspectRegion(doc, whole(doc))).endsWith("\n")).toBe(true);
  });

  it("is an empty object for a region outside the document", () => {
    const doc = createDocument(4, 4, { idGen: sequentialIdGen() });
    const payload = inspectPayload(inspectRegion(doc, { top: 40, left: 40, rows: 2, cols: 2 }));
    expect(JSON.parse(payload)).toEqual({});
  });

  it("includes the resolved colours as data, not as labels", () => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = drawText(doc, doc.activeLayerId, 0, 0, "ab", {
      fg: { kind: "rgb", r: 10, g: 20, b: 30 } as Color,
      bg: { kind: "default" },
    });
    const parsed = JSON.parse(inspectPayload(inspectRegion(doc, whole(doc))));
    expect(parsed.dominantFg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
  });
});
