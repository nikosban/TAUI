/**
 * Layers use *sparse* cell storage: only occupied cells are stored, keyed
 * `"row,col"`. A missing key means the layer is transparent there, which makes
 * "transparent" a natural concept for compositing instead of a sentinel value.
 */

import type { Cell } from "./cell.js";
import { assertBoundedString, RESOURCE_LIMITS } from "./resource-policy.js";

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  /** Sparse map keyed by {@link cellKey}. Absent key = transparent. */
  readonly cells: Readonly<Record<string, Cell>>;
  /**
   * Excludes this layer from handoff panel detection (M6). Optional so that
   * absent stays absent through serialization — decorative box characters would
   * otherwise be detected as panels.
   */
  readonly excludeFromHandoff?: boolean;
}

export const cellKey = (row: number, col: number): string => `${row},${col}`;

/** Inverse of {@link cellKey}. Returns null for a malformed key. */
export function parseCellKey(key: string): { row: number; col: number } | null {
  const comma = key.indexOf(",");
  if (comma <= 0) return null;
  const row = Number(key.slice(0, comma));
  const col = Number(key.slice(comma + 1));
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  return { row, col };
}

export function createLayer(id: string, name: string): Layer {
  if (id.length === 0) throw new RangeError("layer id must be non-empty");
  assertBoundedString(id, "layer id", RESOURCE_LIMITS.idChars);
  assertBoundedString(name, "layer name", RESOURCE_LIMITS.nameChars);
  // Note: `locked: false` and `visible: true` are written explicitly because they
  // are required fields. `excludeFromHandoff` is omitted — optional flags must stay
  // absent so semantically-equal documents serialize byte-identically.
  return { id, name, visible: true, locked: false, cells: {} };
}
