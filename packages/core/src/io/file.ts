/**
 * The `.tui` file format.
 *
 * Designers commit these files, so the format is optimized for clean git diffs:
 * pretty-printed, recursively key-sorted, trailing newline, and byte-identical
 * for semantically-equal documents.
 *
 * That last guarantee is why {@link canonical} exists instead of the usual
 * `JSON.stringify(v, sortedKeyArray, 2)` trick. A replacer *array* applies at
 * every depth and silently drops any key not listed — which would delete the
 * entire `cells` map, whose keys are dynamic `"row,col"` strings.
 */

import type { Cell } from "../model/cell.js";
import {
  type Color,
  type ColorMode,
  type ColorRef,
  colorRangeHint,
  isPaletteRef,
  isValidColor,
} from "../model/color.js";
import { CURRENT_VERSION, type TuiDocument } from "../model/document.js";
import { type Layer, parseCellKey } from "../model/layer.js";
import { bakeDanglingRefs, danglingRefs } from "../ops/palette.js";

export class TuiParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TuiParseError";
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Recursively sorts object keys and drops `undefined`-valued keys.
 *
 * Note on key order: sorting is lexicographic, so cell keys order as
 * `"10,0" < "2,0"`. That is deliberate — the requirement is *determinism*, not
 * numeric ordering. Do not "fix" this into a numeric sort; it would break
 * byte-identity against every committed fixture.
 */
export function canonical(value: unknown): Json {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) continue; // never write defaults
      out[key] = canonical(inner);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TuiParseError(`cannot serialize non-finite number ${value}`);
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  throw new TuiParseError(`cannot serialize value of type ${typeof value}`);
}

export function serialize(doc: TuiDocument): string {
  return `${JSON.stringify(canonical(doc), null, 2)}\n`;
}

export interface DeserializeResult {
  readonly doc: TuiDocument;
  /** Migrations applied, dangling palette refs baked, fields dropped. */
  readonly warnings: readonly string[];
}

/** Migrates a document from the keyed version to the next one. */
type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/**
 * Keyed by the version being migrated **from**, applied in ascending order.
 *
 * v0 is a real historical shape, not a stub: `colorMode` and `palette` were
 * absent. Shipping a genuine transformation is the only way to know the
 * mechanism works — an identity map would throw on the v0 fixture the spec asks
 * for, since a missing key is indistinguishable from an unmigratable version.
 */
export const migrations: Record<number, Migration> = {
  0: (old) => ({
    ...old,
    version: 1,
    colorMode: typeof old["colorMode"] === "string" ? old["colorMode"] : "ansi256",
    palette: Array.isArray(old["palette"]) ? old["palette"] : [],
  }),
};

const COLOR_MODES: readonly string[] = ["ansi16", "ansi256", "rgb"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateColorRef(ref: unknown, where: string): ColorRef {
  if (!isRecord(ref)) throw new TuiParseError(`${where}: color must be an object`);
  const kind = ref["kind"];

  /** Rejects out-of-range values rather than clamping — see isValidColor. */
  const checked = (color: Color): Color => {
    if (!isValidColor(color)) {
      throw new TuiParseError(
        `${where}: ${color.kind} out of range (${colorRangeHint(color.kind)})`,
      );
    }
    return color;
  };

  switch (kind) {
    case "default":
      return { kind: "default" };
    case "ansi16":
    case "ansi256": {
      const index = ref["index"];
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw new TuiParseError(`${where}: ${kind} requires an integer index`);
      }
      return checked({ kind, index });
    }
    case "rgb": {
      const { r, g, b } = ref as Record<string, unknown>;
      if ([r, g, b].some((c) => typeof c !== "number" || !Number.isInteger(c))) {
        throw new TuiParseError(`${where}: rgb requires integer r/g/b`);
      }
      return checked({ kind: "rgb", r: r as number, g: g as number, b: b as number });
    }
    case "palette": {
      const id = ref["id"];
      if (typeof id !== "string") throw new TuiParseError(`${where}: palette ref requires an id`);
      return { kind: "palette", id };
    }
    default:
      throw new TuiParseError(`${where}: unknown color kind ${JSON.stringify(kind)}`);
  }
}

function validateCell(raw: unknown, where: string): Cell {
  if (!isRecord(raw)) throw new TuiParseError(`${where}: cell must be an object`);
  const char = raw["char"];
  if (typeof char !== "string") throw new TuiParseError(`${where}: cell.char must be a string`);
  const cell: {
    char: string;
    fg: ColorRef;
    bg: ColorRef;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
  } = {
    char,
    fg: validateColorRef(raw["fg"], `${where}.fg`),
    bg: validateColorRef(raw["bg"], `${where}.bg`),
  };
  for (const flag of ["bold", "italic", "underline", "inverse"] as const) {
    const v = raw[flag];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new TuiParseError(`${where}.${flag} must be a boolean`);
    cell[flag] = v;
  }
  return cell;
}

function validateLayer(raw: unknown, index: number, warnings: string[]): Layer {
  const where = `layers[${index}]`;
  if (!isRecord(raw)) throw new TuiParseError(`${where} must be an object`);
  const { id, name, visible, locked, cells } = raw;
  if (typeof id !== "string" || id.length === 0) {
    throw new TuiParseError(`${where}.id must be a non-empty string`);
  }
  if (typeof name !== "string") throw new TuiParseError(`${where}.name must be a string`);
  if (typeof visible !== "boolean") throw new TuiParseError(`${where}.visible must be a boolean`);
  if (typeof locked !== "boolean") throw new TuiParseError(`${where}.locked must be a boolean`);
  if (!isRecord(cells)) throw new TuiParseError(`${where}.cells must be an object`);

  const validated: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(cells)) {
    if (parseCellKey(key) === null) {
      warnings.push(`${where}: dropped malformed cell key ${JSON.stringify(key)}`);
      continue;
    }
    validated[key] = validateCell(value, `${where}.cells[${key}]`);
  }

  const layer: {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    cells: Record<string, Cell>;
    excludeFromHandoff?: boolean;
  } = { id, name, visible, locked, cells: validated };
  const exclude = raw["excludeFromHandoff"];
  if (exclude !== undefined) {
    if (typeof exclude !== "boolean") {
      throw new TuiParseError(`${where}.excludeFromHandoff must be a boolean`);
    }
    layer.excludeFromHandoff = exclude;
  }
  return layer;
}

function validateDocument(raw: Record<string, unknown>, warnings: string[]): TuiDocument {
  const { cols, rows, colorMode, layers, activeLayerId, palette } = raw;
  if (typeof cols !== "number" || !Number.isInteger(cols) || cols <= 0) {
    throw new TuiParseError("cols must be a positive integer");
  }
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0) {
    throw new TuiParseError("rows must be a positive integer");
  }
  if (typeof colorMode !== "string" || !COLOR_MODES.includes(colorMode)) {
    throw new TuiParseError(`colorMode must be one of ${COLOR_MODES.join(", ")}`);
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    // Documents always have at least one layer; `removeLayer` no-ops on the last.
    throw new TuiParseError("layers must be a non-empty array");
  }
  const validatedLayers = layers.map((l, i) => validateLayer(l, i, warnings));

  const ids = new Set(validatedLayers.map((l) => l.id));
  if (ids.size !== validatedLayers.length) throw new TuiParseError("layer ids must be unique");

  const validatedPalette = (() => {
    if (palette === undefined) return [];
    if (!Array.isArray(palette)) throw new TuiParseError("palette must be an array");
    return palette.map((entry, i) => {
      if (!isRecord(entry)) throw new TuiParseError(`palette[${i}] must be an object`);
      const { id, name, color } = entry;
      if (typeof id !== "string" || id.length === 0) {
        throw new TuiParseError(`palette[${i}].id must be a non-empty string`);
      }
      if (typeof name !== "string") throw new TuiParseError(`palette[${i}].name must be a string`);
      const resolved = validateColorRef(color, `palette[${i}].color`);
      if (isPaletteRef(resolved)) {
        throw new TuiParseError(`palette[${i}].color cannot itself be a palette ref`);
      }
      return { id, name, color: resolved };
    });
  })();

  // activeLayerId integrity: repair rather than reject, so a hand-edited file opens.
  let active = typeof activeLayerId === "string" ? activeLayerId : "";
  const firstLayer = validatedLayers[0];
  if (!ids.has(active) && firstLayer !== undefined) {
    warnings.push(
      `activeLayerId ${JSON.stringify(active)} does not exist; defaulted to ${firstLayer.id}`,
    );
    active = firstLayer.id;
  }

  return {
    version: CURRENT_VERSION,
    cols,
    rows,
    colorMode: colorMode as ColorMode,
    layers: validatedLayers,
    activeLayerId: active,
    palette: validatedPalette,
  };
}

/**
 * Bakes dangling palette references, reporting how many there were.
 *
 * The logic lives in `ops/palette.ts` — this is the same repair the palette
 * editor offers, and two implementations of "what counts as dangling" would
 * eventually disagree. The count comes from a separate pass because ops return a
 * document, not a report; `deserialize` is not hot enough for that to matter.
 */
function bakeDangling(doc: TuiDocument, warnings: string[]): TuiDocument {
  const count = danglingRefs(doc);
  if (count === 0) return doc;
  warnings.push(`baked ${count} dangling palette reference(s) to the terminal default`);
  return bakeDanglingRefs(doc);
}

export function deserialize(text: string): DeserializeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new TuiParseError("not valid JSON", { cause });
  }
  if (!isRecord(raw)) throw new TuiParseError("document root must be an object");

  const rawVersion = raw["version"];
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    throw new TuiParseError("missing or non-integer version");
  }
  if (rawVersion > CURRENT_VERSION) {
    throw new TuiParseError(
      `document version ${rawVersion} is newer than the supported version ${CURRENT_VERSION}`,
    );
  }
  if (rawVersion < 0) throw new TuiParseError(`invalid version ${rawVersion}`);

  const warnings: string[] = [];
  let current = raw;
  let version = rawVersion;
  while (version < CURRENT_VERSION) {
    const migration = migrations[version];
    if (migration === undefined) {
      throw new TuiParseError(`no migration path from version ${version}`);
    }
    current = migration(current);
    warnings.push(`migrated document from v${version} to v${version + 1}`);
    version += 1;
  }

  const doc = validateDocument(current, warnings);
  return { doc: bakeDangling(doc, warnings), warnings };
}
