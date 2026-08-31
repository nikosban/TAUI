/**
 * Central resource limits for every untrusted or allocation-heavy core path.
 *
 * These are product safety limits, not terminal-format limits. Keeping them in
 * one module prevents the file loader, importers, editor operations, and
 * renderers from slowly acquiring incompatible ideas of a "reasonable" file.
 */

import type { ResolvedGrid } from "../render/composite.js";
import { assertNarrowChar } from "./cell.js";
import type { TuiDocument } from "./document.js";

export const RESOURCE_LIMITS = {
  documentCols: 1_000,
  documentRows: 1_000,
  documentArea: 250_000,
  layers: 128,
  storedCells: 1_000_000,
  paletteEntries: 4_096,
  documentTextChars: 16 * 1024 * 1024,
  importTextChars: 1024 * 1024,
  importWarnings: 100,
  idChars: 256,
  nameChars: 1_024,
} as const;

export class ResourceLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

/** A hard-capped warning sink so hostile input cannot allocate one message per byte. */
export class BoundedWarnings {
  readonly #messages: string[] = [];
  #omitted = 0;

  add(message: string): void {
    if (this.#messages.length < RESOURCE_LIMITS.importWarnings) this.#messages.push(message);
    else this.#omitted++;
  }

  append(messages: readonly string[]): void {
    for (const message of messages) this.add(message);
  }

  finish(): readonly string[] {
    return this.#omitted === 0
      ? this.#messages
      : [...this.#messages, `omitted ${this.#omitted} additional warning(s)`];
  }
}

function storedCoordinate(key: string): { row: number; col: number } | null {
  const comma = key.indexOf(",");
  if (comma <= 0) return null;
  const row = Number(key.slice(0, comma));
  const col = Number(key.slice(comma + 1));
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  // Reject aliases such as `00,0` and `0e0,0`: all editor paths generate the
  // canonical spelling, and accepting aliases makes sparse-cell identity
  // ambiguous at serialization and composition boundaries.
  return key === `${row},${col}` ? { row, col } : null;
}

export function assertBoundedString(value: string, label: string, max: number): void {
  if (value.length > max) {
    throw new ResourceLimitError(`${label} exceeds the ${max}-character limit`);
  }
}

export function assertDocumentDimensions(cols: number, rows: number): void {
  if (!Number.isSafeInteger(cols) || cols <= 0) {
    throw new RangeError(`cols must be a positive integer, got ${cols}`);
  }
  if (!Number.isSafeInteger(rows) || rows <= 0) {
    throw new RangeError(`rows must be a positive integer, got ${rows}`);
  }
  if (cols > RESOURCE_LIMITS.documentCols) {
    throw new ResourceLimitError(`cols exceeds the limit of ${RESOURCE_LIMITS.documentCols}`);
  }
  if (rows > RESOURCE_LIMITS.documentRows) {
    throw new ResourceLimitError(`rows exceeds the limit of ${RESOURCE_LIMITS.documentRows}`);
  }
  if (cols * rows > RESOURCE_LIMITS.documentArea) {
    throw new ResourceLimitError(
      `document area ${cols * rows} exceeds the limit of ${RESOURCE_LIMITS.documentArea} cells`,
    );
  }
}

/**
 * Validates the limits and character invariant needed before serializing or
 * allocating a dense render grid. Structural and colour validation remains the
 * responsibility of the file decoder.
 */
export interface DocumentResourceOptions {
  /** Reject invalid sparse keys. Renderers may safely ignore them. Default true. */
  readonly strictCoordinates?: boolean;
}

export function assertDocumentResources(
  doc: TuiDocument,
  opts: DocumentResourceOptions = {},
): void {
  assertDocumentDimensions(doc.cols, doc.rows);
  if (doc.layers.length === 0) throw new ResourceLimitError("document must contain a layer");
  if (doc.layers.length > RESOURCE_LIMITS.layers) {
    throw new ResourceLimitError(`layers exceeds the limit of ${RESOURCE_LIMITS.layers}`);
  }
  if (doc.palette.length > RESOURCE_LIMITS.paletteEntries) {
    throw new ResourceLimitError(
      `palette exceeds the limit of ${RESOURCE_LIMITS.paletteEntries} entries`,
    );
  }

  assertBoundedString(doc.activeLayerId, "activeLayerId", RESOURCE_LIMITS.idChars);
  const paletteIds = new Set<string>();
  const paletteNames = new Set<string>();
  for (const [index, entry] of doc.palette.entries()) {
    assertBoundedString(entry.id, `palette[${index}].id`, RESOURCE_LIMITS.idChars);
    assertBoundedString(entry.name, `palette[${index}].name`, RESOURCE_LIMITS.nameChars);
    if (paletteIds.has(entry.id)) {
      throw new ResourceLimitError(`palette id ${JSON.stringify(entry.id)} is not unique`);
    }
    if (paletteNames.has(entry.name)) {
      throw new ResourceLimitError(`palette name ${JSON.stringify(entry.name)} is not unique`);
    }
    paletteIds.add(entry.id);
    paletteNames.add(entry.name);
  }

  let storedCells = 0;
  for (const [index, layer] of doc.layers.entries()) {
    assertBoundedString(layer.id, `layers[${index}].id`, RESOURCE_LIMITS.idChars);
    assertBoundedString(layer.name, `layers[${index}].name`, RESOURCE_LIMITS.nameChars);
    for (const [key, cell] of Object.entries(layer.cells)) {
      storedCells++;
      if (storedCells > RESOURCE_LIMITS.storedCells) {
        throw new ResourceLimitError(
          `stored cells exceeds the limit of ${RESOURCE_LIMITS.storedCells}`,
        );
      }
      const position = storedCoordinate(key);
      if (
        position === null ||
        position.row < 0 ||
        position.row >= doc.rows ||
        position.col < 0 ||
        position.col >= doc.cols
      ) {
        if (opts.strictCoordinates !== false) {
          throw new ResourceLimitError(`layers[${index}] contains invalid cell coordinate ${key}`);
        }
        continue;
      }
      assertNarrowChar(cell.char);
      for (const [field, color] of [
        ["fg", cell.fg],
        ["bg", cell.bg],
      ] as const) {
        if (color.kind === "palette") {
          assertBoundedString(
            color.id,
            `layers[${index}].cells[${key}].${field}.id`,
            RESOURCE_LIMITS.idChars,
          );
        }
      }
    }
  }
}

/** Validates the public pre-composited renderer input before any output work. */
export function assertGridResources(grid: ResolvedGrid): void {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows === 0 || cols === 0) {
    if (rows === 0 && cols === 0) return;
    throw new ResourceLimitError("render grid must be rectangular");
  }
  assertDocumentDimensions(cols, rows);
  for (const [rowIndex, row] of grid.entries()) {
    if (row.length !== cols) {
      throw new ResourceLimitError(`render grid row ${rowIndex} is not ${cols} cells wide`);
    }
    for (const cell of row) assertNarrowChar(cell.char);
  }
}

/** Truncates hostile import input while preserving the importers' no-throw API. */
export function boundImportInput(input: string, warnings: BoundedWarnings): string {
  if (input.length <= RESOURCE_LIMITS.importTextChars) return input;
  warnings.add(
    `truncated input from ${input.length} to ${RESOURCE_LIMITS.importTextChars} characters`,
  );
  return input.slice(0, RESOURCE_LIMITS.importTextChars);
}

/**
 * Import-side dimension policy. Invalid and excessive options are clipped and
 * reported rather than thrown, matching the importers' hostile-input contract.
 */
export function boundImportDimension(
  value: number,
  axis: "cols" | "rows",
  warnings: BoundedWarnings,
): number {
  const max = axis === "cols" ? RESOURCE_LIMITS.documentCols : RESOURCE_LIMITS.documentRows;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    warnings.add(`invalid requested ${axis} ${JSON.stringify(value)}; used 1`);
    return 1;
  }
  if (value > max) {
    warnings.add(`clipped requested ${axis} ${value} to the limit ${max}`);
    return max;
  }
  return value;
}
