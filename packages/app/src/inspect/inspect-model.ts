/**
 * Formatting for the inspector.
 *
 * Pure, because these are the numbers a developer copies into an implementation
 * and a wrong label is worse than no label. The measurements themselves come from
 * core's `inspectRegion` / `distance`; this module only decides how to say them.
 *
 * Every value is rendered as an **exact integer cell count**. That is the tool's
 * whole advantage over a pixel design tool — there is no "8px or is it 9px" here —
 * so nothing gets rounded or approximated on the way to the screen.
 */

import type { Color, Padding, RegionInfo } from "@tui-designer/core";

/**
 * Padding as a CSS-style shorthand: `1`, `1 2`, `1 2 3`, or `1 2 3 4`.
 *
 * Collapsed because that is the form a developer already reads fluently, and
 * because four separate numbers make the common symmetric case look asymmetric.
 * The order matches CSS: top, right, bottom, left.
 */
export function paddingShorthand(p: Padding): string {
  const { top, right, bottom, left } = p;
  if (top === right && right === bottom && bottom === left) return `${top}`;
  if (top === bottom && left === right) return `${top} ${right}`;
  if (left === right) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
}

/**
 * A colour as a short human label.
 *
 * `inspectRegion` resolves palette references before returning, so a name never
 * reaches here — naming the entry is `inspectCell`'s job at M6.
 */
export function colorLabel(color: Color): string {
  switch (color.kind) {
    case "default":
      return "default";
    case "ansi16":
      return `ansi ${color.index}`;
    case "ansi256":
      return `ansi256 ${color.index}`;
    case "rgb": {
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
    }
  }
}

export interface InspectRow {
  readonly label: string;
  readonly value: string;
  /** A colour to show as a swatch beside the value, when the row is about one. */
  readonly swatch?: Color;
}

/**
 * The rows the panel renders for a region.
 *
 * Ordered by what gets asked first: how big, then how much of it is painted, then
 * how it is styled. `border` is omitted rather than shown as "none" when the
 * perimeter is not a complete frame — an absent row reads as "not a panel", while
 * "border: none" reads as "a panel with no border".
 */
export function regionRows(info: RegionInfo): readonly InspectRow[] {
  if (info.rect === null) return [];

  const rows: InspectRow[] = [
    { label: "size", value: `${info.cols} × ${info.rows} cells` },
    { label: "origin", value: `row ${info.rect.top}, col ${info.rect.left}` },
    {
      label: "painted",
      // The proportion matters more than the raw count when judging whether a
      // region is mostly empty.
      value: `${info.painted} of ${info.area}`,
    },
  ];

  if (info.borderStyle !== null) {
    rows.push({ label: "border", value: info.borderStyle });
  }
  rows.push({ label: "padding", value: paddingShorthand(info.padding) });
  rows.push({ label: "fg", value: colorLabel(info.dominantFg), swatch: info.dominantFg });
  rows.push({ label: "bg", value: colorLabel(info.dominantBg), swatch: info.dominantBg });

  return rows;
}

/** Signed row/column offset, phrased with a direction rather than a sign. */
export function offsetLabel(dRows: number, dCols: number): string {
  const vertical = dRows === 0 ? null : `${Math.abs(dRows)} ${dRows > 0 ? "down" : "up"}`;
  const horizontal = dCols === 0 ? null : `${Math.abs(dCols)} ${dCols > 0 ? "right" : "left"}`;
  const parts = [vertical, horizontal].filter((part) => part !== null);
  // Both zero means the two points coincide, which "0 down, 0 right" obscures.
  return parts.length === 0 ? "same cell" : parts.join(", ");
}

/**
 * The JSON a developer copies out, as plain data.
 *
 * The spec requires results be plain JSON so the GUI can offer copy-verbatim.
 * Kept separate from {@link regionRows}: the display collapses padding to a
 * shorthand and drops an absent border, neither of which belongs in a machine
 * -readable payload.
 */
export function inspectPayload(info: RegionInfo): string {
  if (info.rect === null) return "{}";
  return `${JSON.stringify(
    {
      rect: info.rect,
      cells: { rows: info.rows, cols: info.cols, area: info.area, painted: info.painted },
      borderStyle: info.borderStyle,
      padding: info.padding,
      dominantFg: info.dominantFg,
      dominantBg: info.dominantBg,
    },
    null,
    2,
  )}\n`;
}
