/**
 * Transient interaction state. Never persisted, never in undo history.
 *
 * The separation from `documentStore` is deliberate: undoing a drawing operation
 * must not also revert which tool is selected or what colour the brush is.
 */

import type { Clipboard, Color, LineStyle, Rect } from "@tui-designer/core";
import { create } from "zustand";
import type { BrushState, ToolId } from "../gestures/gesture.js";

export interface ToolState {
  activeTool: ToolId;
  brush: BrushState;
  lineStyle: LineStyle;
  selection: Rect | null;
  clipboard: Clipboard | null;
  /** Set briefly when a paint lands on a locked layer, so the UI can flash. */
  lockFlashAt: number | null;

  setTool(tool: ToolId): void;
  setBrushChar(char: string): void;
  setBrush(patch: Partial<BrushState>): void;
  setLineStyle(style: LineStyle): void;
  setSelection(rect: Rect | null): void;
  setClipboard(clip: Clipboard | null): void;
  flashLock(at: number): void;
}

export const DEFAULT_BRUSH: BrushState = {
  char: "█",
  fg: { kind: "default" },
  bg: { kind: "default" },
};

/**
 * Colours offered in the fg/bg pickers.
 *
 * The 16 ANSI colours plus "default". Deliberately not ansi256 or rgb: ansi16 is
 * valid in *every* colour mode, so the picker never offers something the document
 * cannot represent. A mode-aware picker with the full 256 cube is G4 work.
 */
export const SWATCHES: readonly { label: string; color: Color }[] = [
  { label: "default", color: { kind: "default" } },
  ...Array.from({ length: 16 }, (_, index) => ({
    label: `ansi ${index}`,
    color: { kind: "ansi16" as const, index },
  })),
];

/** Characters offered in the palette grid. Box drawing first, then shading. */
export const BRUSH_CHARS: readonly string[] = [
  "█",
  "▓",
  "▒",
  "░",
  "▀",
  "▄",
  "▌",
  "▐",
  "─",
  "│",
  "┌",
  "┐",
  "└",
  "┘",
  "├",
  "┤",
  "┬",
  "┴",
  "┼",
  "━",
  "┃",
  "╋",
  "═",
  "║",
  "╬",
  "·",
  "•",
  "▪",
  "▸",
  "▾",
  "◉",
  "○",
  "✓",
  "✗",
  "#",
  "*",
  "+",
  "=",
  "-",
  "|",
  ".",
  " ",
];

export const useToolStore = create<ToolState>((set) => ({
  activeTool: "box",
  brush: DEFAULT_BRUSH,
  lineStyle: "light",
  selection: null,
  clipboard: null,
  lockFlashAt: null,

  setTool(tool) {
    set({ activeTool: tool });
  },
  setBrushChar(char) {
    set((s) => ({ brush: { ...s.brush, char } }));
  },
  setBrush(patch) {
    set((s) => ({ brush: { ...s.brush, ...patch } }));
  },
  setLineStyle(style) {
    set({ lineStyle: style });
  },
  setSelection(rect) {
    set({ selection: rect });
  },
  setClipboard(clip) {
    set({ clipboard: clip });
  },
  flashLock(at) {
    set({ lockFlashAt: at });
  },
}));
