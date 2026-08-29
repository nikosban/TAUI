import type { Theme } from "./paint-plan.js";

/**
 * Canvas theme. The `void` shade is deliberately distinct from the document
 * background: in a terminal there is no off-canvas, so the boundary must always
 * be visible.
 */
export const DARK_THEME: Theme = {
  voidFill: "#0d0f12",
  defaultBg: "#1a1d23",
  defaultFg: "#d8dee9",
  gridLine: "#252a33",
  selectionStroke: "#6fa8ff",
  cursorStroke: "#ffcc66",
  caretFill: "#ffcc66",
  caretText: "#1a1d23",
  // Standard xterm palette.
  ansi16: [
    "#000000",
    "#cd0000",
    "#00cd00",
    "#cdcd00",
    "#0000ee",
    "#cd00cd",
    "#00cdcd",
    "#e5e5e5",
    "#7f7f7f",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#5c5cff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ],
};
