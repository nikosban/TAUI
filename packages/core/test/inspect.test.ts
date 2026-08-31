/**
 * Measurement queries.
 *
 * Fixtures are built as ASCII art via `parseText` wherever possible, because a
 * padding assertion is only reviewable next to the picture it describes.
 */

import { describe, expect, it } from "vitest";
import { distance, inspectRegion } from "../src/handoff/inspect.js";
import { parseText } from "../src/io/text-import.js";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { drawBox } from "../src/ops/box.js";
import { drawText, fillRect } from "../src/ops/draw.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;
const art = (...lines: string[]): TuiDocument =>
  parseText(lines.join("\n"), { idGen: sequentialIdGen() }).doc;
const whole = (doc: TuiDocument) => ({
  top: 0,
  left: 0,
  rows: doc.rows,
  cols: doc.cols,
});

describe("distance", () => {
  it("is signed, so direction survives", () => {
    expect(distance({ row: 2, col: 3 }, { row: 5, col: 8 })).toEqual({ dRows: 3, dCols: 5 });
    expect(distance({ row: 5, col: 8 }, { row: 2, col: 3 })).toEqual({ dRows: -3, dCols: -5 });
  });

  it("is zero to itself", () => {
    expect(distance({ row: 4, col: 4 }, { row: 4, col: 4 })).toEqual({ dRows: 0, dCols: 0 });
  });

  it("is antisymmetric for every pair it is given", () => {
    for (const [a, b] of [
      [
        { row: 0, col: 0 },
        { row: 9, col: 4 },
      ],
      [
        { row: 7, col: 2 },
        { row: 1, col: 30 },
      ],
    ] as const) {
      const forward = distance(a, b);
      const back = distance(b, a);
      expect(forward.dRows).toBe(-back.dRows);
      expect(forward.dCols).toBe(-back.dCols);
    }
  });
});

describe("size and coverage", () => {
  it("reports the rect, its dimensions, and its area", () => {
    const doc = createDocument(20, 10, { idGen: sequentialIdGen() });
    const info = inspectRegion(doc, { top: 2, left: 3, rows: 4, cols: 5 });
    expect(info.rect).toEqual({ top: 2, left: 3, rows: 4, cols: 5 });
    expect([info.rows, info.cols, info.area]).toEqual([4, 5, 20]);
  });

  it("clips to the document and reports the clipped size", () => {
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    const info = inspectRegion(doc, { top: 1, left: 4, rows: 10, cols: 10 });
    expect(info.rect).toEqual({ top: 1, left: 4, rows: 2, cols: 2 });
    expect(info.area).toBe(4);
  });

  it("returns a null rect for a region entirely outside the document", () => {
    const doc = createDocument(4, 4, { idGen: sequentialIdGen() });
    const info = inspectRegion(doc, { top: 50, left: 50, rows: 2, cols: 2 });
    expect(info.rect).toBeNull();
    expect([info.rows, info.cols, info.area, info.painted]).toEqual([0, 0, 0, 0]);
    expect(info.borderStyle).toBeNull();
  });

  it("counts painted cells, not the area", () => {
    const doc = art("ab", "  ", "cd");
    const info = inspectRegion(doc, whole(doc));
    expect(info.area).toBe(6);
    // Transparent whitespace is not painted.
    expect(info.painted).toBe(4);
  });

  it("counts a cell once even when layers stack", () => {
    let doc = createDocument(4, 1, { idGen: sequentialIdGen() });
    doc = {
      ...doc,
      layers: [...doc.layers, { id: "top", name: "top", visible: true, locked: false, cells: {} }],
    };
    doc = drawText(doc, doc.layers[0]?.id ?? "", 0, 0, "ab", STYLE);
    doc = drawText(doc, "top", 0, 0, "cd", STYLE);
    // Two columns are covered, on two layers each — the viewer sees two cells.
    expect(inspectRegion(doc, whole(doc)).painted).toBe(2);
  });

  it("ignores a hidden layer, matching what the viewer sees", () => {
    let doc = art("abcd");
    doc = { ...doc, layers: doc.layers.map((l) => ({ ...l, visible: false })) };
    expect(inspectRegion(doc, whole(doc)).painted).toBe(0);
  });
});

describe("dominant colours", () => {
  const red = { kind: "ansi16", index: 1 } as const;
  const blue = { kind: "ansi16", index: 4 } as const;

  it("reports the most common foreground", () => {
    let doc = createDocument(6, 1, { idGen: sequentialIdGen() });
    doc = drawText(doc, "l1", 0, 0, "aaaa", { fg: red, bg: DEFAULT_COLOR });
    doc = drawText(doc, "l1", 0, 4, "bb", { fg: blue, bg: DEFAULT_COLOR });
    expect(inspectRegion(doc, whole(doc)).dominantFg).toEqual(red);
  });

  it("compares ansi256 and RGB colours deterministically", () => {
    const ansi256 = { kind: "ansi256", index: 208 } as const;
    const rgb = { kind: "rgb", r: 1, g: 2, b: 3 } as const;
    let doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    doc = drawText(doc, "l1", 0, 0, "a", { fg: ansi256, bg: DEFAULT_COLOR });
    doc = drawText(doc, "l1", 0, 1, "b", { fg: rgb, bg: DEFAULT_COLOR });
    // First-seen wins a tie, so the result is stable rather than map-order dependent.
    expect(inspectRegion(doc, whole(doc)).dominantFg).toEqual(ansi256);
  });

  it("reports the most common background", () => {
    let doc = createDocument(6, 1, { idGen: sequentialIdGen() });
    doc = fillRect(
      doc,
      "l1",
      { top: 0, left: 0, rows: 1, cols: 2 },
      {
        char: "x",
        fg: DEFAULT_COLOR,
        bg: red,
      },
    );
    doc = fillRect(
      doc,
      "l1",
      { top: 0, left: 2, rows: 1, cols: 4 },
      {
        char: "x",
        fg: DEFAULT_COLOR,
        bg: blue,
      },
    );
    expect(inspectRegion(doc, whole(doc)).dominantBg).toEqual(blue);
  });

  it("falls back to the terminal default for an empty region", () => {
    const doc = createDocument(4, 2, { idGen: sequentialIdGen() });
    const info = inspectRegion(doc, whole(doc));
    expect(info.dominantFg).toEqual(DEFAULT_COLOR);
    expect(info.dominantBg).toEqual(DEFAULT_COLOR);
  });

  it("resolves a palette reference rather than reporting the reference", () => {
    // The caller compares colours; naming the palette entry is inspectCell's job.
    let doc = createDocument(3, 1, { idGen: sequentialIdGen() });
    doc = { ...doc, palette: [{ id: "p1", name: "brand", color: red }] };
    doc = drawText(doc, "l1", 0, 0, "abc", {
      fg: { kind: "palette", id: "p1" },
      bg: DEFAULT_COLOR,
    });
    expect(inspectRegion(doc, whole(doc)).dominantFg).toEqual(red);
  });

  it("resolves a dangling palette reference to the default instead of throwing", () => {
    let doc = createDocument(2, 1, { idGen: sequentialIdGen() });
    doc = drawText(doc, "l1", 0, 0, "ab", {
      fg: { kind: "palette", id: "gone" },
      bg: DEFAULT_COLOR,
    });
    expect(inspectRegion(doc, whole(doc)).dominantFg).toEqual(DEFAULT_COLOR);
  });
});

describe("border detection", () => {
  it("recognises a light frame", () => {
    const doc = art("┌────┐", "│    │", "└────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("light");
  });

  it("recognises a heavy frame", () => {
    const doc = art("┏━━━━┓", "┃    ┃", "┗━━━━┛");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("heavy");
  });

  it("recognises a double frame", () => {
    const doc = art("╔════╗", "║    ║", "╚════╝");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("double");
  });

  it("recognises a TITLED panel, the commonest TUI shape of all", () => {
    // The case a stricter rule got wrong: requiring every perimeter cell to be a
    // box character reported "not a panel" for this, which is what most real
    // panels look like.
    const doc = art("┌─ system ─┐", "│          │", "└──────────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("light");
  });

  it("recognises a panel titled on the bottom edge too", () => {
    const doc = art("┌──────────┐", "│          │", "└─ status ─┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("light");
  });

  it("returns null when a corner is not a box character", () => {
    // Corners do the discriminating, which is what lets titles through without
    // admitting arbitrary rectangles.
    for (const lines of [
      ["X────┐", "│    │", "└────┘"],
      ["┌────X", "│    │", "└────┘"],
      ["┌────┐", "│    │", "X────┘"],
      ["┌────┐", "│    │", "└────X"],
    ]) {
      const doc = art(...lines);
      expect(inspectRegion(doc, whole(doc)).borderStyle, lines[0]).toBeNull();
    }
  });

  it("returns null when an edge has no box character at all", () => {
    // Corners intact but the whole top edge blank: not a frame in any reading.
    const doc = art("┌    ┐", "│    │", "└────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBeNull();
  });

  it("returns null when the bottom edge is blank", () => {
    // Each of the four edges is checked separately, so each needs its own case.
    const doc = art("┌────┐", "│    │", "└    ┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBeNull();
  });

  it("returns null when a side wall is entirely gone", () => {
    const doc = art("┌────┐", "     │", "└────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBeNull();
  });

  it("returns null when the right wall is entirely gone", () => {
    const doc = art("┌────┐", "│     ", "└────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBeNull();
  });

  it("tolerates a partly broken edge, which an inspector hint should", () => {
    // The cost of admitting titles: a single gap no longer disqualifies. M6's
    // detectPanels does the rigorous connectivity tracing; this is a human hint.
    const doc = art("┌─ ──┐", "│    │", "└────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("light");
  });

  it("returns null for a region with no border at all", () => {
    const doc = art("hello", "world");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBeNull();
  });

  it("reports the dominant weight for a mixed frame", () => {
    // A light box whose top was overdrawn heavy: mostly light, so light.
    const doc = art("┍━━━━┑", "│    │", "└────┘");
    expect(inspectRegion(doc, whole(doc)).borderStyle).toBe("light");
  });

  it("returns null for a region too small to have a perimeter", () => {
    const doc = art("┌┐", "└┘");
    // 2x2 is a perimeter with no inside; still a frame.
    expect(inspectRegion(doc, { top: 0, left: 0, rows: 2, cols: 2 }).borderStyle).toBe("light");
    // A single row cannot enclose anything.
    expect(inspectRegion(doc, { top: 0, left: 0, rows: 1, cols: 2 }).borderStyle).toBeNull();
    expect(inspectRegion(doc, { top: 0, left: 0, rows: 2, cols: 1 }).borderStyle).toBeNull();
  });

  it("detects a sub-region's frame, not just the whole document", () => {
    const doc = art(
      "                ",
      "  ┌────┐        ",
      "  │ hi │        ",
      "  └────┘        ",
      "                ",
    );
    expect(inspectRegion(doc, { top: 1, left: 2, rows: 3, cols: 6 }).borderStyle).toBe("light");
  });
});

describe("padding", () => {
  it("measures inside the border, not from the border", () => {
    // The border is not padding; reporting 0 for a bordered panel would be
    // useless to the caller asking "how much padding does this panel have".
    const doc = art("┌────────┐", "│        │", "│  text  │", "│        │", "└────────┘");
    const info = inspectRegion(doc, whole(doc));
    expect(info.borderStyle).toBe("light");
    expect(info.padding).toEqual({ top: 1, right: 2, bottom: 1, left: 2 });
  });

  it("measures asymmetric padding per side", () => {
    const doc = art("┌────────┐", "│x       │", "│        │", "└────────┘");
    expect(inspectRegion(doc, whole(doc)).padding).toEqual({
      top: 0,
      right: 7,
      bottom: 1,
      left: 0,
    });
  });

  it("measures from the region itself when there is no border", () => {
    const doc = art("      ", "  ab  ", "      ");
    expect(inspectRegion(doc, whole(doc)).padding).toEqual({
      top: 1,
      right: 2,
      bottom: 1,
      left: 2,
    });
  });

  it("reports zero padding for a fully packed region", () => {
    const doc = art("abcd", "efgh");
    expect(inspectRegion(doc, whole(doc)).padding).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("reports zero rather than the full size for an entirely blank region", () => {
    // Every side is blank, so counting inward from each would double-count the
    // whole region and report nonsense like top:3, bottom:3 in a 3-row block.
    const doc = createDocument(6, 3, { idGen: sequentialIdGen() });
    expect(inspectRegion(doc, whole(doc)).padding).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("treats a coloured space as content, not as padding", () => {
    // A painted background is deliberate; skipping it would report a status bar
    // as empty padding.
    let doc = createDocument(4, 3, { idGen: sequentialIdGen() });
    doc = fillRect(
      doc,
      "l1",
      { top: 1, left: 0, rows: 1, cols: 4 },
      {
        char: " ",
        fg: DEFAULT_COLOR,
        bg: { kind: "ansi16", index: 4 },
      },
    );
    expect(inspectRegion(doc, whole(doc)).padding).toEqual({
      top: 1,
      right: 0,
      bottom: 1,
      left: 0,
    });
  });

  it("reports zero padding when the border leaves no interior", () => {
    const doc = art("┌┐", "└┘");
    const info = inspectRegion(doc, whole(doc));
    expect(info.borderStyle).toBe("light");
    expect(info.padding).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe("a realistic panel", () => {
  it("measures a bordered panel drawn with drawBox", () => {
    let doc = createDocument(24, 7, { idGen: sequentialIdGen() });
    doc = drawBox(doc, "l1", { top: 0, left: 0, rows: 7, cols: 24 }, "light", true, STYLE);
    doc = drawText(doc, "l1", 2, 3, "requests/sec", STYLE);

    const info = inspectRegion(doc, whole(doc));
    expect(info.borderStyle).toBe("light");
    expect([info.rows, info.cols]).toEqual([7, 24]);
    // Content sits on interior row 1 (document row 2), 2 columns in.
    expect(info.padding.top).toBe(1);
    expect(info.padding.left).toBe(2);
    expect(info.padding.bottom).toBe(3);
  });
});
