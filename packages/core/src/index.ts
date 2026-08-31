/**
 * Public API surface of `@tui-designer/core`.
 *
 * Everything not exported here is internal. Both CLI modules import engine
 * behavior solely from this module, which doubles as a completeness check on the
 * public surface.
 *
 * Deliberately NOT exported: `model/draft.ts` (the mutable draft must never
 * escape an op) and `model/width-table.ts` (generated data).
 */

// ---- handoff ----
export type { Padding, RegionInfo } from "./handoff/inspect.js";
export { distance, inspectRegion } from "./handoff/inspect.js";
// ---- history ----
export type { History } from "./history/history.js";
export {
  canRedo,
  canUndo,
  createHistory,
  MAX_HISTORY,
  push,
  redo,
  replacePresent,
  resetHistory,
  undo,
} from "./history/history.js";
export type { ParseAnsiOptions } from "./io/ansi-import.js";
export { parseAnsi } from "./io/ansi-import.js";
// ---- io ----
export type { DeserializeResult } from "./io/file.js";
export { canonical, deserialize, migrations, serialize, TuiParseError } from "./io/file.js";
export type { ImportResult, ParseTextOptions } from "./io/text-import.js";
export { parseText } from "./io/text-import.js";
export type { Cell, CellStyle } from "./model/cell.js";
export {
  assertNarrowChar,
  charWidth,
  coerceNarrowChar,
  InvalidCharError,
  isNarrowSingle,
  REPLACEMENT_CHAR,
} from "./model/cell.js";
// ---- model ----
export type {
  Color,
  ColorMode,
  ColorRef,
  PaletteEntry,
  PaletteRef,
} from "./model/color.js";
export {
  ansi256ToRgb,
  colorEquals,
  colorRefEquals,
  DEFAULT_COLOR,
  downgradeColor,
  isPaletteRef,
  isValidColor,
  resolveColor,
  rgbToAnsi16,
  rgbToAnsi256,
} from "./model/color.js";
export type { CreateDocumentOptions, IdGen, Rect, TuiDocument } from "./model/document.js";
export {
  CURRENT_VERSION,
  cellAt,
  clipRect,
  createDocument,
  defaultIdGen,
  findLayer,
  inBounds,
  rectCells,
  sequentialIdGen,
} from "./model/document.js";
export type { Layer } from "./model/layer.js";
export { cellKey, createLayer, parseCellKey } from "./model/layer.js";
export type { DocumentResourceOptions } from "./model/resource-policy.js";
export {
  assertBoundedString,
  assertDocumentDimensions,
  assertDocumentResources,
  assertGridResources,
  BoundedWarnings,
  RESOURCE_LIMITS,
  ResourceLimitError,
} from "./model/resource-policy.js";
// ---- ops ----
export type { Arms, ArmsCode, Direction, LineStyle } from "./ops/arms.js";
export {
  arms,
  armsCode,
  DIRECTIONS,
  decodeArms,
  strongest,
  unionArms,
} from "./ops/arms.js";
export { drawBox } from "./ops/box.js";
export type { ArmStamp } from "./ops/box-merge.js";
export { armsOf, charForArms, isBoxChar } from "./ops/box-merge.js";
export type { ResizeAnchor } from "./ops/canvas.js";
export {
  cellsLostOnCrop,
  cellsLostOnResize,
  cropToRect,
  resizeDocument,
  resizeOffset,
  shiftAll,
} from "./ops/canvas.js";
export { colorModeLoss, convertColorMode } from "./ops/color-mode.js";
export { clearRect, drawText, fillRect, setCell } from "./ops/draw.js";
export type { FillTarget } from "./ops/fill.js";
export { floodFill } from "./ops/fill.js";
export type { AddLayerOptions, DuplicateLayerOptions } from "./ops/layers.js";
export {
  addLayer,
  duplicateLayer,
  mergeDown,
  moveLayer,
  removeLayer,
  renameLayer,
  setActiveLayer,
  setExcludeFromHandoff,
  setLayerLocked,
  setLayerVisible,
} from "./ops/layers.js";
export type { Point } from "./ops/line.js";
export { DiagonalLineError, drawLine } from "./ops/line.js";
export type { AddPaletteEntryOptions, PaletteUsage } from "./ops/palette.js";
export {
  addPaletteEntry,
  bakeDanglingRefs,
  danglingRefs,
  findPaletteEntry,
  paletteNameConflict,
  paletteUsage,
  removePaletteEntry,
  renamePaletteEntry,
  setPaletteColor,
} from "./ops/palette.js";
export type { Clipboard } from "./ops/region.js";
export {
  copyRegion,
  cutRegion,
  EMPTY_CLIPBOARD,
  moveRegion,
  pasteRegion,
} from "./ops/region.js";
// ---- render ----
export type { ToAnsiOptions } from "./render/ansi.js";
export { gridToAnsi, toAnsi } from "./render/ansi.js";
export type { CompositeOptions, ResolvedCell, ResolvedGrid } from "./render/composite.js";
export { composite } from "./render/composite.js";
export type { SvgTheme, ToSvgOptions } from "./render/svg.js";
export { colorToCss, DEFAULT_SVG_THEME, gridToSvg, toSvg } from "./render/svg.js";
export type { ToTextOptions } from "./render/text.js";
export { gridToText, toText } from "./render/text.js";
