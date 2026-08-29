/**
 * Colors, palette entries, and reference resolution.
 *
 * A `Cell` stores `ColorRef`s, which may point at a named palette entry. Every
 * renderer sees only raw `Color`s — `composite` is the choke point that resolves
 * refs, and it returns a distinct `ResolvedCell` type so that guarantee is a
 * compile error to violate rather than a convention to remember.
 */

export type Color =
  | { readonly kind: "ansi16"; readonly index: number } // 0–15
  | { readonly kind: "ansi256"; readonly index: number } // 0–255
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number }
  | { readonly kind: "default" }; // terminal default fg/bg

/** A reference to a named palette entry, resolved via {@link resolveColor}. */
export interface PaletteRef {
  readonly kind: "palette";
  readonly id: string;
}

/** What a `Cell` actually stores: either a raw color or a palette reference. */
export type ColorRef = Color | PaletteRef;

export interface PaletteEntry {
  readonly id: string;
  /** Semantic name, e.g. "statusbar.bg". Becomes the design-token key. */
  readonly name: string;
  readonly color: Color;
}

export type ColorMode = "ansi16" | "ansi256" | "rgb";

export const DEFAULT_COLOR: Color = { kind: "default" };

export const isPaletteRef = (ref: ColorRef): ref is PaletteRef => ref.kind === "palette";

/** Minimal shape {@link resolveColor} needs — avoids a circular import on TuiDocument. */
interface HasPalette {
  readonly palette: readonly PaletteEntry[];
}

/**
 * Resolves a `ColorRef` to a raw `Color`.
 *
 * A dangling reference resolves to `{kind:"default"}` rather than throwing:
 * renderers must be total, and a hand-edited file should render rather than
 * crash. `deserialize` reports dangling refs as warnings and bakes them, so a
 * document that came through the normal path never has any.
 */
export function resolveColor(doc: HasPalette, ref: ColorRef): Color {
  if (!isPaletteRef(ref)) return ref;
  const entry = doc.palette.find((p) => p.id === ref.id);
  return entry ? entry.color : DEFAULT_COLOR;
}

/**
 * Structural equality for resolved colors.
 *
 * Compares `Color`, not `ColorRef`: callers that care about equality — flood-fill
 * region membership, and minimal-diff ANSI encoding in M4 — are comparing what a
 * cell *renders as*, so they resolve palette references first.
 */
export function colorEquals(a: Color, b: Color): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "default":
      return true;
    case "ansi16":
    case "ansi256":
      return a.index === (b as typeof a).index;
    case "rgb": {
      const other = b as typeof a;
      return a.r === other.r && a.g === other.g && a.b === other.b;
    }
  }
}

/**
 * Structural equality for stored color *references*, palette refs included.
 *
 * The counterpart to {@link colorEquals}: that one compares what a cell renders
 * as, this one compares what it stores. Two cells referencing the same palette
 * entry are equal here even though the entry could later be recoloured.
 */
export function colorRefEquals(a: ColorRef, b: ColorRef): boolean {
  if (a.kind === "palette" || b.kind === "palette") {
    return a.kind === "palette" && b.kind === "palette" && a.id === b.id;
  }
  return colorEquals(a, b);
}

/**
 * Valid channel/index ranges per color kind. Enforced when *loading* a document:
 * an out-of-range index would survive into the renderers and emit a nonsense
 * escape sequence, so it is rejected at the boundary rather than clamped.
 */
export function isValidColor(color: Color): boolean {
  switch (color.kind) {
    case "default":
      return true;
    case "ansi16":
      return color.index >= 0 && color.index <= 15;
    case "ansi256":
      return color.index >= 0 && color.index <= 255;
    case "rgb":
      return [color.r, color.g, color.b].every((c) => c >= 0 && c <= 255);
  }
}

/** Human-readable bound, for validation messages. */
export function colorRangeHint(kind: Color["kind"]): string {
  switch (kind) {
    case "ansi16":
      return "index must be 0-15";
    case "ansi256":
      return "index must be 0-255";
    case "rgb":
      return "r/g/b must each be 0-255";
    case "default":
      return "no parameters";
  }
}

/**
 * RGB values for the 16 basic colours, and the 6 levels of the 256-colour cube.
 *
 * These are **xterm's defaults**, and every terminal theme overrides them — so
 * quantising *into* ansi16 is inherently approximate. That is why the downgrade
 * below is only ever applied on the way out, by `toAnsi` and `toSvg`, and never
 * to stored cells behind the user's back. A `convertColorMode` op that bakes the
 * downgrade into a document is a G4 addition, gated behind an explicit user
 * action for the same reason.
 */
const ANSI16_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/** Squared distance; the square root would not change any comparison. */
const rgbDistance = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** The RGB a terminal would show for an ansi256 index, using xterm's defaults. */
export function ansi256ToRgb(index: number): readonly [number, number, number] {
  if (index < 16) return ANSI16_RGB[index] ?? [0, 0, 0];
  if (index < 232) {
    const n = index - 16;
    return [
      CUBE_LEVELS[Math.floor(n / 36) % 6] ?? 0,
      CUBE_LEVELS[Math.floor(n / 6) % 6] ?? 0,
      CUBE_LEVELS[n % 6] ?? 0,
    ];
  }
  // 232–255: a 24-step grey ramp at 8, 18, … 238.
  const level = 8 + (index - 232) * 10;
  return [level, level, level];
}

const nearestCubeLevel = (v: number): number => {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i++) {
    const cur = CUBE_LEVELS[i] as number;
    if (Math.abs(cur - v) < Math.abs((CUBE_LEVELS[best] as number) - v)) best = i;
  }
  return best;
};

/**
 * Nearest ansi256 index to an RGB triple.
 *
 * Considers the 6×6×6 cube *and* the grey ramp and takes whichever is closer —
 * cube-only quantisation visibly banding near-greys is the classic bug here.
 */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  const cubeIndex = 16 + 36 * nearestCubeLevel(r) + 6 * nearestCubeLevel(g) + nearestCubeLevel(b);
  const cubeDist = rgbDistance([r, g, b], ansi256ToRgb(cubeIndex));

  // Grey ramp: round to the nearest of the 24 steps, clamped into range.
  const greyStep = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const greyIndex = 232 + greyStep;
  const greyDist = rgbDistance([r, g, b], ansi256ToRgb(greyIndex));

  return greyDist < cubeDist ? greyIndex : cubeIndex;
}

/** Nearest of the 16 basic colours to an RGB triple. */
export function rgbToAnsi16(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ANSI16_RGB.length; i++) {
    const dist = rgbDistance([r, g, b], ANSI16_RGB[i] as readonly [number, number, number]);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** How much colour depth a value needs; `default` needs none. */
const colorRank = (color: Color): number =>
  color.kind === "default" ? 0 : color.kind === "ansi16" ? 1 : color.kind === "ansi256" ? 2 : 3;

const modeRank = (mode: ColorMode): number => (mode === "ansi16" ? 1 : mode === "ansi256" ? 2 : 3);

/**
 * Reduces `color` to what `mode` can express, and returns it unchanged when it
 * already fits.
 *
 * A colour *poorer* than the mode is left alone rather than expanded: `ansi16`
 * red inside an rgb document stays `\x1b[31m`, which is both shorter and honours
 * the user's theme. Only the richer-than-the-mode direction loses information.
 */
export function downgradeColor(color: Color, mode: ColorMode): Color {
  if (colorRank(color) <= modeRank(mode)) return color;

  if (color.kind === "rgb") {
    return mode === "ansi256"
      ? { kind: "ansi256", index: rgbToAnsi256(color.r, color.g, color.b) }
      : { kind: "ansi16", index: rgbToAnsi16(color.r, color.g, color.b) };
  }
  // ansi256 into ansi16 is the only pairing the rank ordering leaves. Tested for
  // explicitly rather than reached by elimination, so the compiler can narrow and
  // a future fourth colour kind arrives here as a visible fallthrough instead of
  // a crash.
  if (color.kind === "ansi256") {
    const [r, g, b] = ansi256ToRgb(color.index);
    return { kind: "ansi16", index: rgbToAnsi16(r, g, b) };
  }
  return color;
}
