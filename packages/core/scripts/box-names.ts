/**
 * Source of truth for the Arms table: the Unicode character names themselves.
 *
 * Hand-writing 109 Arms records means ~436 hand-typed weights, every one a silent
 * wrong-glyph bug no type check would catch. The names, by contrast, are
 * self-describing and machine-parseable — `DOWN HEAVY AND UP HORIZONTAL LIGHT`
 * decodes deterministically — and a reviewer can check a name against its glyph
 * at a glance.
 *
 * This module is **pure** (no filesystem, no Node) so that `test/box-table.test.ts`
 * can import it and re-derive the committed table. `gen-box-table.ts` is the only
 * part that writes files.
 *
 * The grammar has exactly two forms:
 *
 *   Form A — leading weight:  `LIGHT DOWN AND RIGHT`      (light applies to both)
 *   Form B — per-clause:      `DOWN LIGHT AND RIGHT HEAVY` (each clause its own)
 *
 * plus two rewrites (`VERTICAL` → up+down, `HORIZONTAL` → left+right) and one
 * synonym (`SINGLE` ≡ `LIGHT`). A clause with no weight of its own inherits the
 * first clause's weight, which is what makes Form A work.
 */

import { type Arms, armsCode, type LineStyle } from "../src/ops/arms.js";

/** The first codepoint of the box-drawing block. */
export const BLOCK_START = 0x2500;

/**
 * Names of U+2500–U+257F with the `BOX DRAWINGS ` prefix stripped, indexed by
 * offset from {@link BLOCK_START}. The block is contiguous and fully assigned, so
 * the codepoint is implicit in the index.
 */
export const BOX_NAMES: readonly string[] = [
  "LIGHT HORIZONTAL", // U+2500  ─
  "HEAVY HORIZONTAL", // U+2501  ━
  "LIGHT VERTICAL", // U+2502  │
  "HEAVY VERTICAL", // U+2503  ┃
  "LIGHT TRIPLE DASH HORIZONTAL", // U+2504  ┄
  "HEAVY TRIPLE DASH HORIZONTAL", // U+2505  ┅
  "LIGHT TRIPLE DASH VERTICAL", // U+2506  ┆
  "HEAVY TRIPLE DASH VERTICAL", // U+2507  ┇
  "LIGHT QUADRUPLE DASH HORIZONTAL", // U+2508  ┈
  "HEAVY QUADRUPLE DASH HORIZONTAL", // U+2509  ┉
  "LIGHT QUADRUPLE DASH VERTICAL", // U+250A  ┊
  "HEAVY QUADRUPLE DASH VERTICAL", // U+250B  ┋
  "LIGHT DOWN AND RIGHT", // U+250C  ┌
  "DOWN LIGHT AND RIGHT HEAVY", // U+250D  ┍
  "DOWN HEAVY AND RIGHT LIGHT", // U+250E  ┎
  "HEAVY DOWN AND RIGHT", // U+250F  ┏
  "LIGHT DOWN AND LEFT", // U+2510  ┐
  "DOWN LIGHT AND LEFT HEAVY", // U+2511  ┑
  "DOWN HEAVY AND LEFT LIGHT", // U+2512  ┒
  "HEAVY DOWN AND LEFT", // U+2513  ┓
  "LIGHT UP AND RIGHT", // U+2514  └
  "UP LIGHT AND RIGHT HEAVY", // U+2515  ┕
  "UP HEAVY AND RIGHT LIGHT", // U+2516  ┖
  "HEAVY UP AND RIGHT", // U+2517  ┗
  "LIGHT UP AND LEFT", // U+2518  ┘
  "UP LIGHT AND LEFT HEAVY", // U+2519  ┙
  "UP HEAVY AND LEFT LIGHT", // U+251A  ┚
  "HEAVY UP AND LEFT", // U+251B  ┛
  "LIGHT VERTICAL AND RIGHT", // U+251C  ├
  "VERTICAL LIGHT AND RIGHT HEAVY", // U+251D  ┝
  "UP HEAVY AND RIGHT DOWN LIGHT", // U+251E  ┞
  "DOWN HEAVY AND RIGHT UP LIGHT", // U+251F  ┟
  "VERTICAL HEAVY AND RIGHT LIGHT", // U+2520  ┠
  "DOWN LIGHT AND RIGHT UP HEAVY", // U+2521  ┡
  "UP LIGHT AND RIGHT DOWN HEAVY", // U+2522  ┢
  "HEAVY VERTICAL AND RIGHT", // U+2523  ┣
  "LIGHT VERTICAL AND LEFT", // U+2524  ┤
  "VERTICAL LIGHT AND LEFT HEAVY", // U+2525  ┥
  "UP HEAVY AND LEFT DOWN LIGHT", // U+2526  ┦
  "DOWN HEAVY AND LEFT UP LIGHT", // U+2527  ┧
  "VERTICAL HEAVY AND LEFT LIGHT", // U+2528  ┨
  "DOWN LIGHT AND LEFT UP HEAVY", // U+2529  ┩
  "UP LIGHT AND LEFT DOWN HEAVY", // U+252A  ┪
  "HEAVY VERTICAL AND LEFT", // U+252B  ┫
  "LIGHT DOWN AND HORIZONTAL", // U+252C  ┬
  "LEFT HEAVY AND RIGHT DOWN LIGHT", // U+252D  ┭
  "RIGHT HEAVY AND LEFT DOWN LIGHT", // U+252E  ┮
  "DOWN LIGHT AND HORIZONTAL HEAVY", // U+252F  ┯
  "DOWN HEAVY AND HORIZONTAL LIGHT", // U+2530  ┰
  "RIGHT LIGHT AND LEFT DOWN HEAVY", // U+2531  ┱
  "LEFT LIGHT AND RIGHT DOWN HEAVY", // U+2532  ┲
  "HEAVY DOWN AND HORIZONTAL", // U+2533  ┳
  "LIGHT UP AND HORIZONTAL", // U+2534  ┴
  "LEFT HEAVY AND RIGHT UP LIGHT", // U+2535  ┵
  "RIGHT HEAVY AND LEFT UP LIGHT", // U+2536  ┶
  "UP LIGHT AND HORIZONTAL HEAVY", // U+2537  ┷
  "UP HEAVY AND HORIZONTAL LIGHT", // U+2538  ┸
  "RIGHT LIGHT AND LEFT UP HEAVY", // U+2539  ┹
  "LEFT LIGHT AND RIGHT UP HEAVY", // U+253A  ┺
  "HEAVY UP AND HORIZONTAL", // U+253B  ┻
  "LIGHT VERTICAL AND HORIZONTAL", // U+253C  ┼
  "LEFT HEAVY AND RIGHT VERTICAL LIGHT", // U+253D  ┽
  "RIGHT HEAVY AND LEFT VERTICAL LIGHT", // U+253E  ┾
  "VERTICAL LIGHT AND HORIZONTAL HEAVY", // U+253F  ┿
  "UP HEAVY AND DOWN HORIZONTAL LIGHT", // U+2540  ╀
  "DOWN HEAVY AND UP HORIZONTAL LIGHT", // U+2541  ╁
  "VERTICAL HEAVY AND HORIZONTAL LIGHT", // U+2542  ╂
  "LEFT UP HEAVY AND RIGHT DOWN LIGHT", // U+2543  ╃
  "RIGHT UP HEAVY AND LEFT DOWN LIGHT", // U+2544  ╄
  "LEFT DOWN HEAVY AND RIGHT UP LIGHT", // U+2545  ╅
  "RIGHT DOWN HEAVY AND LEFT UP LIGHT", // U+2546  ╆
  "DOWN LIGHT AND UP HORIZONTAL HEAVY", // U+2547  ╇
  "UP LIGHT AND DOWN HORIZONTAL HEAVY", // U+2548  ╈
  "RIGHT LIGHT AND LEFT VERTICAL HEAVY", // U+2549  ╉
  "LEFT LIGHT AND RIGHT VERTICAL HEAVY", // U+254A  ╊
  "HEAVY VERTICAL AND HORIZONTAL", // U+254B  ╋
  "LIGHT DOUBLE DASH HORIZONTAL", // U+254C  ╌
  "HEAVY DOUBLE DASH HORIZONTAL", // U+254D  ╍
  "LIGHT DOUBLE DASH VERTICAL", // U+254E  ╎
  "HEAVY DOUBLE DASH VERTICAL", // U+254F  ╏
  "DOUBLE HORIZONTAL", // U+2550  ═
  "DOUBLE VERTICAL", // U+2551  ║
  "DOWN SINGLE AND RIGHT DOUBLE", // U+2552  ╒
  "DOWN DOUBLE AND RIGHT SINGLE", // U+2553  ╓
  "DOUBLE DOWN AND RIGHT", // U+2554  ╔
  "DOWN SINGLE AND LEFT DOUBLE", // U+2555  ╕
  "DOWN DOUBLE AND LEFT SINGLE", // U+2556  ╖
  "DOUBLE DOWN AND LEFT", // U+2557  ╗
  "UP SINGLE AND RIGHT DOUBLE", // U+2558  ╘
  "UP DOUBLE AND RIGHT SINGLE", // U+2559  ╙
  "DOUBLE UP AND RIGHT", // U+255A  ╚
  "UP SINGLE AND LEFT DOUBLE", // U+255B  ╛
  "UP DOUBLE AND LEFT SINGLE", // U+255C  ╜
  "DOUBLE UP AND LEFT", // U+255D  ╝
  "VERTICAL SINGLE AND RIGHT DOUBLE", // U+255E  ╞
  "VERTICAL DOUBLE AND RIGHT SINGLE", // U+255F  ╟
  "DOUBLE VERTICAL AND RIGHT", // U+2560  ╠
  "VERTICAL SINGLE AND LEFT DOUBLE", // U+2561  ╡
  "VERTICAL DOUBLE AND LEFT SINGLE", // U+2562  ╢
  "DOUBLE VERTICAL AND LEFT", // U+2563  ╣
  "DOWN SINGLE AND HORIZONTAL DOUBLE", // U+2564  ╤
  "DOWN DOUBLE AND HORIZONTAL SINGLE", // U+2565  ╥
  "DOUBLE DOWN AND HORIZONTAL", // U+2566  ╦
  "UP SINGLE AND HORIZONTAL DOUBLE", // U+2567  ╧
  "UP DOUBLE AND HORIZONTAL SINGLE", // U+2568  ╨
  "DOUBLE UP AND HORIZONTAL", // U+2569  ╩
  "VERTICAL SINGLE AND HORIZONTAL DOUBLE", // U+256A  ╪
  "VERTICAL DOUBLE AND HORIZONTAL SINGLE", // U+256B  ╫
  "DOUBLE VERTICAL AND HORIZONTAL", // U+256C  ╬
  "LIGHT ARC DOWN AND RIGHT", // U+256D  ╭
  "LIGHT ARC DOWN AND LEFT", // U+256E  ╮
  "LIGHT ARC UP AND LEFT", // U+256F  ╯
  "LIGHT ARC UP AND RIGHT", // U+2570  ╰
  "LIGHT DIAGONAL UPPER RIGHT TO LOWER LEFT", // U+2571  ╱
  "LIGHT DIAGONAL UPPER LEFT TO LOWER RIGHT", // U+2572  ╲
  "LIGHT DIAGONAL CROSS", // U+2573  ╳
  "LIGHT LEFT", // U+2574  ╴
  "LIGHT UP", // U+2575  ╵
  "LIGHT RIGHT", // U+2576  ╶
  "LIGHT DOWN", // U+2577  ╷
  "HEAVY LEFT", // U+2578  ╸
  "HEAVY UP", // U+2579  ╹
  "HEAVY RIGHT", // U+257A  ╺
  "HEAVY DOWN", // U+257B  ╻
  "LIGHT LEFT AND HEAVY RIGHT", // U+257C  ╼
  "LIGHT UP AND HEAVY DOWN", // U+257D  ╽
  "HEAVY LEFT AND LIGHT RIGHT", // U+257E  ╾
  "HEAVY UP AND LIGHT DOWN", // U+257F  ╿
];

/**
 * Name fragments marking a glyph as carrying no junction semantics.
 *
 * `DASH` covers the triple/quadruple/double-dash line variants. `ARC` excludes
 * the rounded corners `╭╮╯╰` — they *are* corners, but `LineStyle` has no
 * "rounded" weight in v1, so admitting them would let a merge silently convert a
 * rounded corner to a square one. `DIAGONAL` covers `╱╲╳`, which have no
 * axis-aligned arms at all.
 */
const NON_JUNCTION = ["DASH", "ARC", "DIAGONAL"] as const;

const WEIGHT_WORDS: Record<string, LineStyle> = {
  LIGHT: "light",
  SINGLE: "light",
  HEAVY: "heavy",
  DOUBLE: "double",
};

/** Returns the parsed Arms, or `null` if the glyph carries no arms. */
export function parseArmsFromName(name: string): Arms | null {
  if (NON_JUNCTION.some((fragment) => name.includes(fragment))) return null;

  const clauses = name.split(" AND ").map((clause) => clause.split(" "));

  // Each clause carries its own weight, leading or trailing. A clause with none
  // inherits the first clause's — that is what makes `LIGHT DOWN AND RIGHT` work.
  const weightOf = (tokens: string[]): { weight: LineStyle | null; dirs: string[] } => {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (first !== undefined && WEIGHT_WORDS[first] !== undefined) {
      return { weight: WEIGHT_WORDS[first] ?? null, dirs: tokens.slice(1) };
    }
    if (last !== undefined && WEIGHT_WORDS[last] !== undefined) {
      return { weight: WEIGHT_WORDS[last] ?? null, dirs: tokens.slice(0, -1) };
    }
    return { weight: null, dirs: tokens };
  };

  const parsed = clauses.map(weightOf);
  const fallback = parsed[0]?.weight ?? null;

  // Mutable Arms rather than a Record, so every write is a checked property.
  const result: { -readonly [K in keyof Arms]: LineStyle } = {
    up: "none",
    down: "none",
    left: "none",
    right: "none",
  };
  let assigned = false;

  for (const { weight, dirs } of parsed) {
    const effective = weight ?? fallback;
    if (effective === null) return null;
    for (const token of dirs) {
      switch (token) {
        case "VERTICAL":
          result.up = effective;
          result.down = effective;
          break;
        case "HORIZONTAL":
          result.left = effective;
          result.right = effective;
          break;
        case "UP":
          result.up = effective;
          break;
        case "DOWN":
          result.down = effective;
          break;
        case "LEFT":
          result.left = effective;
          break;
        case "RIGHT":
          result.right = effective;
          break;
        default:
          return null; // unrecognized token: refuse rather than guess
      }
      assigned = true;
    }
  }

  if (!assigned) return null;
  return result;
}

export interface TableEntry {
  readonly code: number;
  readonly char: string;
  readonly codePoint: number;
  readonly name: string;
  readonly arms: Arms;
}

/** Derives the full table from {@link BOX_NAMES}. Pure. */
export function buildTable(): TableEntry[] {
  const entries: TableEntry[] = [];
  for (const [index, name] of BOX_NAMES.entries()) {
    const parsed = parseArmsFromName(name);
    if (parsed === null) continue;
    const codePoint = BLOCK_START + index;
    entries.push({
      code: armsCode(parsed),
      char: String.fromCodePoint(codePoint),
      codePoint,
      name,
      arms: parsed,
    });
  }
  return entries;
}
