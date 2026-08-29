import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COLOR } from "../src/model/color.js";
import { createDocument, sequentialIdGen, type TuiDocument } from "../src/model/document.js";
import { drawBox } from "../src/ops/box.js";
import { drawText } from "../src/ops/draw.js";
import { DiagonalLineError, drawLine } from "../src/ops/line.js";
import { toText } from "../src/render/text.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

let doc: TuiDocument;
let id: string;

beforeEach(() => {
  doc = createDocument(14, 8, { idGen: sequentialIdGen() });
  id = doc.activeLayerId;
});

const box = (
  d: TuiDocument,
  top: number,
  left: number,
  rows: number,
  cols: number,
  style: Parameters<typeof drawBox>[3] = "light",
  merge = true,
) => drawBox(d, id, { top, left, rows, cols }, style, merge, STYLE);

describe("drawBox basics", () => {
  it("draws a simple light box", () => {
    expect(toText(box(doc, 0, 0, 4, 6))).toMatchInlineSnapshot(`
      "┌────┐
      │    │
      │    │
      └────┘



      "
    `);
  });

  it("draws heavy and double variants", () => {
    expect(toText(box(doc, 0, 0, 3, 5, "heavy"))).toMatchInlineSnapshot(`
      "┏━━━┓
      ┃   ┃
      ┗━━━┛




      "
    `);
    expect(toText(box(doc, 0, 0, 3, 5, "double"))).toMatchInlineSnapshot(`
      "╔═══╗
      ║   ║
      ╚═══╝




      "
    `);
  });

  it("collapses a 1-row box to a horizontal line", () => {
    expect(toText(box(doc, 0, 0, 1, 5))).toMatchInlineSnapshot(`
      "╶───╴






      "
    `);
  });

  it("collapses a 1-column box to a vertical line", () => {
    expect(toText(box(doc, 0, 0, 4, 1))).toMatchInlineSnapshot(`
      "╷
      │
      │
      ╵



      "
    `);
  });

  it("is a no-op for a zero-extent or fully off-grid rect", () => {
    expect(box(doc, 0, 0, 0, 5)).toBe(doc);
    expect(box(doc, 0, 0, 3, 0)).toBe(doc);
    expect(box(doc, 40, 40, 3, 3)).toBe(doc);
  });

  it("is a no-op for a 1x1 box, which has no border to draw", () => {
    // A box with no extent in either axis yields a stamp with no arms. Writing
    // some arbitrary glyph would be wrong, and clearing the cell would make a
    // stray click destructive, so the stamp is skipped and the doc is unchanged.
    expect(box(doc, 2, 2, 1, 1)).toBe(doc);
  });

  it("does not erase an existing character under a 1x1 box", () => {
    const withText = drawText(doc, id, 2, 2, "X", STYLE);
    expect(box(withText, 2, 2, 1, 1)).toBe(withText);
    expect(toText(box(withText, 2, 2, 1, 1))).toContain("X");
  });

  it("clips a box that hangs off the edge", () => {
    expect(toText(box(doc, -1, 10, 4, 8))).toMatchInlineSnapshot(`
      "          │
                │
                └───




      "
    `);
  });
});

describe("junction merging — the four required cases", () => {
  it("two boxes sharing a full vertical edge produce T-junctions", () => {
    let d = box(doc, 0, 0, 4, 6);
    d = box(d, 0, 5, 4, 6);
    expect(toText(d)).toMatchInlineSnapshot(`
      "┌────┬────┐
      │    │    │
      │    │    │
      └────┴────┘



      "
    `);
  });

  it("two boxes sharing a full horizontal edge produce T-junctions", () => {
    let d = box(doc, 0, 0, 4, 6);
    d = box(d, 3, 0, 4, 6);
    expect(toText(d)).toMatchInlineSnapshot(`
      "┌────┐
      │    │
      │    │
      ├────┤
      │    │
      │    │
      └────┘
      "
    `);
  });

  it("four boxes meeting at one corner produce a cross", () => {
    let d = box(doc, 0, 0, 4, 6);
    d = box(d, 0, 5, 4, 6);
    d = box(d, 3, 0, 4, 6);
    d = box(d, 3, 5, 4, 6);
    expect(toText(d)).toMatchInlineSnapshot(`
      "┌────┬────┐
      │    │    │
      │    │    │
      ├────┼────┤
      │    │    │
      │    │    │
      └────┴────┘
      "
    `);
  });

  it("a light box overlapping a double box degrades per the documented ladder", () => {
    let d = box(doc, 0, 0, 4, 6, "double");
    d = box(d, 0, 5, 4, 6, "light");
    // The shared corners are the interesting cells. At (0,5) the double box
    // contributes {down:double, left:double} and the light box {down:light,
    // right:light}; the union {down:double, left:double, right:light} has no
    // Unicode character, so rung 2 degrades double->heavy giving ┱. Note the
    // topology survives — still a three-way junction pointing down/left/right —
    // and only the weight drops. The shared wall itself stays ║ because both
    // boxes contribute vertical arms and double wins.
    expect(toText(d)).toMatchInlineSnapshot(`
      "╔════┱────┐
      ║    ║    │
      ║    ║    │
      ╚════┹────┘



      "
    `);
  });

  it("merge: false overwrites blindly instead of joining", () => {
    let d = box(doc, 0, 0, 4, 6, "light");
    d = box(d, 0, 5, 4, 6, "light", false);
    // Column 5 is overwritten by the second box's left edge — no T-junctions.
    expect(toText(d)).toMatchInlineSnapshot(`
      "┌────┌────┐
      │    │    │
      │    │    │
      └────└────┘



      "
    `);
  });
});

describe("drawLine", () => {
  it("draws horizontal and vertical lines with stub endpoints", () => {
    expect(
      toText(drawLine(doc, id, { row: 1, col: 1 }, { row: 1, col: 6 }, "light", true, STYLE)),
    ).toMatchInlineSnapshot(`
        "
         ╶────╴





        "
      `);
    expect(
      toText(drawLine(doc, id, { row: 0, col: 2 }, { row: 4, col: 2 }, "light", true, STYLE)),
    ).toMatchInlineSnapshot(`
        "  ╷
          │
          │
          │
          ╵


        "
      `);
  });

  it("is direction-agnostic horizontally — a leftward drag matches a rightward one", () => {
    const forward = drawLine(doc, id, { row: 2, col: 1 }, { row: 2, col: 8 }, "light", true, STYLE);
    const backward = drawLine(
      doc,
      id,
      { row: 2, col: 8 },
      { row: 2, col: 1 },
      "light",
      true,
      STYLE,
    );
    expect(toText(forward)).toBe(toText(backward));
  });

  it("is direction-agnostic vertically — an upward drag matches a downward one", () => {
    const down = drawLine(doc, id, { row: 1, col: 3 }, { row: 5, col: 3 }, "light", true, STYLE);
    const up = drawLine(doc, id, { row: 5, col: 3 }, { row: 1, col: 3 }, "light", true, STYLE);
    expect(toText(up)).toBe(toText(down));
    expect(toText(up)).toMatchInlineSnapshot(`
      "
         ╷
         │
         │
         │
         ╵

      "
    `);
  });

  it("produces a cross where perpendicular lines meet — via shared arm union only", () => {
    let d = drawLine(doc, id, { row: 2, col: 0 }, { row: 2, col: 8 }, "light", true, STYLE);
    d = drawLine(d, id, { row: 0, col: 4 }, { row: 5, col: 4 }, "light", true, STYLE);
    expect(toText(d)).toMatchInlineSnapshot(`
      "    ╷
          │
      ╶───┼───╴
          │
          │
          ╵

      "
    `);
  });

  it("produces the mixed-style crossings ╪ and ╫", () => {
    let d = drawLine(doc, id, { row: 2, col: 0 }, { row: 2, col: 8 }, "double", true, STYLE);
    d = drawLine(d, id, { row: 0, col: 4 }, { row: 5, col: 4 }, "light", true, STYLE);
    expect(toText(d)).toContain("╪");

    let e = drawLine(doc, id, { row: 2, col: 0 }, { row: 2, col: 8 }, "light", true, STYLE);
    e = drawLine(e, id, { row: 0, col: 4 }, { row: 5, col: 4 }, "double", true, STYLE);
    expect(toText(e)).toContain("╫");
  });

  it("forms a T where a line ends on another line", () => {
    let d = drawLine(doc, id, { row: 2, col: 0 }, { row: 2, col: 8 }, "light", true, STYLE);
    d = drawLine(d, id, { row: 2, col: 4 }, { row: 5, col: 4 }, "light", true, STYLE);
    expect(toText(d)).toMatchInlineSnapshot(`
      "

      ╶───┬───╴
          │
          │
          ╵

      "
    `);
  });

  it("writes a light stub for a 1-cell line", () => {
    const d = drawLine(doc, id, { row: 1, col: 1 }, { row: 1, col: 1 }, "light", true, STYLE);
    expect(toText(d)).toMatchInlineSnapshot(`
      "
       ╴





      "
    `);
  });

  it("degrades a 1-cell double line to the heavy stub, since no double stub exists", () => {
    const d = drawLine(doc, id, { row: 1, col: 1 }, { row: 1, col: 1 }, "double", true, STYLE);
    expect(toText(d)).toContain("╸");
  });

  it("throws on diagonal input", () => {
    expect(() =>
      drawLine(doc, id, { row: 0, col: 0 }, { row: 3, col: 3 }, "light", true, STYLE),
    ).toThrow(DiagonalLineError);
  });

  it("is a no-op entirely off-grid, and clips partially", () => {
    expect(drawLine(doc, id, { row: 40, col: 0 }, { row: 40, col: 5 }, "light", true, STYLE)).toBe(
      doc,
    );
    const clipped = drawLine(
      doc,
      id,
      { row: 0, col: 10 },
      { row: 0, col: 30 },
      "light",
      true,
      STYLE,
    );
    expect(toText(clipped).split("\n")[0]).toBe("          ╶───");
  });

  it("respects the layer lock", () => {
    const locked: TuiDocument = { ...doc, layers: doc.layers.map((l) => ({ ...l, locked: true })) };
    expect(drawLine(locked, id, { row: 0, col: 0 }, { row: 0, col: 5 }, "light", true, STYLE)).toBe(
      locked,
    );
  });
});

describe("lines and boxes merge with each other", () => {
  it("a line crossing a box wall produces the right junctions", () => {
    let d = drawBox(doc, id, { top: 0, left: 0, rows: 5, cols: 10 }, "light", true, STYLE);
    d = drawLine(d, id, { row: 2, col: 0 }, { row: 2, col: 9 }, "light", true, STYLE);
    expect(toText(d)).toMatchInlineSnapshot(`
      "┌────────┐
      │        │
      ├────────┤
      │        │
      └────────┘


      "
    `);
  });
});

// The "no box-char literals in box.ts / line.ts" constraint is checked by
// `scripts/check-arch.ts` (`pnpm check:arch`) rather than here, because verifying
// it requires reading source files and no test in this package may touch the
// filesystem.
